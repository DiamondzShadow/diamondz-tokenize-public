// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {TokenAdmin} from "../utils/TokenAdmin.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title AssetOracle
/// @notice Proof of asset for tokenized real-world assets. Independent verifiers (title companies, appraisers,
///         custodians, fund administrators, registries...) attest to facts about the asset behind a token. A token is
///         "verified" while every check its asset class requires has a current, passing attestation from an active
///         verifier. Sales read `isVerified` and stop selling when it is false.
/// @dev Trust model:
///      - Verifiers are added by the platform (DEFAULT_ADMIN_ROLE = platform multisig) after it checks who they are,
///        and only for the kinds of check they are qualified for. Issuers cannot add verifiers, so an issuer can never
///        vouch for its own asset. Removing a verifier voids all of its attestations at once.
///      - Each asset class has a platform-set minimum checklist. An issuer registers its token once (must be the
///        token's admin: DEFAULT_ADMIN_ROLE, or owner() for ERC-3643 tokens) and may add extra checks, but can never
///        drop below the class minimum or remove checks later.
///      - v2: a one-time migration window lets the platform copy registrations from a previous oracle; it closes for
///        good with `closeMigration()` and can never reopen. Attestations are never imported: verifiers re-sign.
///      - Every attestation expires; the platform caps how long each kind of check may stay valid.
contract AssetOracle is AccessControl, EIP712 {
    enum Result {
        None,
        Pass,
        Fail
    }

    struct Verifier {
        bool active;
        string name; // legal name shown on listings, e.g. "First American Title Insurance Company"
    }

    struct Attestation {
        address verifier;
        Result result;
        uint64 attestedAt;
        uint64 validUntil;
        int256 value; // optional figure in the check's own unit (e.g. appraised value in USD cents); 0 if none
        bytes32 evidenceHash; // sha256 of the evidence document
        string evidenceURI; // where the document (or a redacted copy) can be fetched
    }

    struct Registration {
        bytes32 assetClass;
        bytes32[] kinds;
    }

    /// @dev verifier => active + name
    mapping(address => Verifier) public verifiers;
    /// @dev verifier => kind => may attest
    mapping(address => mapping(bytes32 => bool)) public canAttest;
    /// @dev asset class => minimum required kinds
    mapping(bytes32 => bytes32[]) private _classKinds;
    /// @dev kind => longest an attestation may stay valid (seconds); 0 = kind not enabled
    mapping(bytes32 => uint64) public maxValidity;
    /// @dev token => registration
    mapping(address => Registration) private _reg;
    /// @dev token => kind => latest attestation
    mapping(address => mapping(bytes32 => Attestation)) private _latest;
    /// @dev verifier => next signature nonce
    mapping(address => uint256) public nonces;
    /// @notice True once the platform has closed the one-time migration window.
    bool public migrationClosed;

    bytes32 public constant ATTEST_TYPEHASH = keccak256(
        "Attest(address token,bytes32 kind,uint8 result,uint64 validUntil,int256 value,bytes32 evidenceHash,string evidenceURI,uint256 nonce,uint256 deadline)"
    );

    event VerifierSet(address indexed verifier, bool active, string name);
    event MigrationClosedForGood();
    event VerifierKindSet(address indexed verifier, bytes32 indexed kind, bool allowed);
    event ClassRequirementsSet(bytes32 indexed assetClass, bytes32[] kinds);
    event MaxValiditySet(bytes32 indexed kind, uint64 seconds_);
    event Registered(address indexed token, bytes32 indexed assetClass, bytes32[] kinds);
    event KindAdded(address indexed token, bytes32 indexed kind);
    event Attested(
        address indexed token,
        bytes32 indexed kind,
        address indexed verifier,
        Result result,
        uint64 validUntil,
        int256 value,
        bytes32 evidenceHash,
        string evidenceURI
    );

    error ZeroAddress();
    error MigrationClosed();
    error UnknownClass(bytes32 assetClass);
    error UnknownKind(bytes32 kind);
    error AlreadyRegistered(address token);
    error NotRegistered(address token);
    error NotTokenAdmin(address caller);
    error MissingRequiredKind(bytes32 kind);
    error DuplicateKind(bytes32 kind);
    error KindNotRequired(address token, bytes32 kind);
    error NotAllowedVerifier(address verifier, bytes32 kind);
    error BadResult();
    error BadValidity(uint64 validUntil, uint64 maxUntil);
    error NoEvidence();
    error Expired();
    error BadSignature();
    error FailStandsUntil(address verifier, uint64 validUntil);

    constructor(address admin) EIP712("DiamondzAssetOracle", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ platform admin

    /// @notice Add, rename or (with active=false) remove a verifier. Removal voids its attestations everywhere.
    function setVerifier(address verifier, bool active, string calldata name) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (verifier == address(0)) revert ZeroAddress();
        verifiers[verifier] = Verifier(active, name);
        emit VerifierSet(verifier, active, name);
    }

    function setVerifierKind(address verifier, bytes32 kind, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (allowed && maxValidity[kind] == 0) revert UnknownKind(kind);
        canAttest[verifier][kind] = allowed;
        emit VerifierKindSet(verifier, kind, allowed);
    }

    /// @notice Enable a kind of check and cap how long one attestation of it stays valid.
    function setMaxValidity(bytes32 kind, uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxValidity[kind] = seconds_;
        emit MaxValiditySet(kind, seconds_);
    }

    /// @notice Minimum checklist for an asset class. Applies to tokens registered after the change.
    function setClassRequirements(bytes32 assetClass, bytes32[] calldata kinds) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (kinds.length == 0) revert UnknownClass(assetClass);
        for (uint256 i; i < kinds.length; ++i) {
            if (maxValidity[kinds[i]] == 0) revert UnknownKind(kinds[i]);
            for (uint256 j; j < i; ++j) if (kinds[j] == kinds[i]) revert DuplicateKind(kinds[i]);
        }
        _classKinds[assetClass] = kinds;
        emit ClassRequirementsSet(assetClass, kinds);
    }

    // ------------------------------------------------------------------ issuer

    /// @notice Register `token` under `assetClass`. `kinds` must contain the class minimum and may add more.
    ///         Caller must administer the token (DEFAULT_ADMIN_ROLE, or owner() for ERC-3643 tokens).
    function register(address token, bytes32 assetClass, bytes32[] calldata kinds) external {
        _onlyTokenAdmin(token);
        _register(token, assetClass, kinds);
    }

    /// @notice Platform only, while the migration window is open: copy a registration from a previous oracle. Same
    ///         validation as `register`. Closes for good with `closeMigration`.
    function importRegistration(address token, bytes32 assetClass, bytes32[] calldata kinds)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (migrationClosed) revert MigrationClosed();
        if (token == address(0)) revert ZeroAddress();
        _register(token, assetClass, kinds);
    }

    /// @notice Platform only: end the migration window forever.
    function closeMigration() external onlyRole(DEFAULT_ADMIN_ROLE) {
        migrationClosed = true;
        emit MigrationClosedForGood();
    }

    function _register(address token, bytes32 assetClass, bytes32[] calldata kinds) internal {
        if (_reg[token].assetClass != bytes32(0)) revert AlreadyRegistered(token);
        bytes32[] storage min = _classKinds[assetClass];
        if (min.length == 0) revert UnknownClass(assetClass);
        for (uint256 i; i < kinds.length; ++i) {
            if (maxValidity[kinds[i]] == 0) revert UnknownKind(kinds[i]);
            for (uint256 j; j < i; ++j) if (kinds[j] == kinds[i]) revert DuplicateKind(kinds[i]);
        }
        for (uint256 i; i < min.length; ++i) {
            bool found;
            for (uint256 j; j < kinds.length; ++j) {
                if (kinds[j] == min[i]) {
                    found = true;
                    break;
                }
            }
            if (!found) revert MissingRequiredKind(min[i]);
        }
        _reg[token].assetClass = assetClass;
        _reg[token].kinds = kinds;
        emit Registered(token, assetClass, kinds);
    }

    /// @notice Add one more required check to a registered token. Checks can never be removed.
    function addKind(address token, bytes32 kind) external {
        _onlyTokenAdmin(token);
        Registration storage r = _reg[token];
        if (r.assetClass == bytes32(0)) revert NotRegistered(token);
        if (maxValidity[kind] == 0) revert UnknownKind(kind);
        for (uint256 i; i < r.kinds.length; ++i) if (r.kinds[i] == kind) revert DuplicateKind(kind);
        r.kinds.push(kind);
        emit KindAdded(token, kind);
    }

    // ------------------------------------------------------------------ verifiers

    /// @notice What a verifier attests to. `validUntil` is a unix time; `value` is optional (0 if none).
    struct AttestInput {
        address token;
        bytes32 kind;
        Result result;
        uint64 validUntil;
        int256 value;
        bytes32 evidenceHash;
        string evidenceURI;
    }

    /// @notice Attest directly from the verifier's own wallet.
    function attest(AttestInput calldata a) external {
        _attest(msg.sender, a);
    }

    /// @notice Attest with the verifier's EIP-712 signature, relayed by anyone (so verifiers need no gas).
    ///         Supports EOAs and contract wallets (ERC-1271).
    function attestBySig(address verifier, AttestInput calldata a, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(_structHash(a, nonces[verifier]++, deadline));
        if (!SignatureChecker.isValidSignatureNow(verifier, digest, signature)) revert BadSignature();
        _attest(verifier, a);
    }

    /// @notice EIP-712 digest a verifier signs for `attestBySig` (for wallets/tools that sign raw digests).
    function attestDigest(AttestInput calldata a, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(_structHash(a, nonce, deadline));
    }

    // ------------------------------------------------------------------ views

    /// @notice True while every required check has a current Pass from a verifier that is still active and allowed.
    function isVerified(address token) public view returns (bool) {
        Registration storage r = _reg[token];
        if (r.assetClass == bytes32(0)) return false;
        for (uint256 i; i < r.kinds.length; ++i) {
            if (!_current(token, r.kinds[i])) return false;
        }
        return true;
    }

    /// @notice Whether the latest attestation for one check is a current, valid Pass.
    function isCurrent(address token, bytes32 kind) external view returns (bool) {
        return _current(token, kind);
    }

    function registration(address token) external view returns (bytes32 assetClass, bytes32[] memory kinds) {
        Registration storage r = _reg[token];
        return (r.assetClass, r.kinds);
    }

    function classRequirements(bytes32 assetClass) external view returns (bytes32[] memory) {
        return _classKinds[assetClass];
    }

    function latest(address token, bytes32 kind) external view returns (Attestation memory) {
        return _latest[token][kind];
    }

    // ------------------------------------------------------------------ internal

    function _current(address token, bytes32 kind) internal view returns (bool) {
        Attestation storage a = _latest[token][kind];
        return a.result == Result.Pass && block.timestamp <= a.validUntil && verifiers[a.verifier].active
            && canAttest[a.verifier][kind];
    }

    function _structHash(AttestInput calldata a, uint256 nonce, uint256 deadline) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATTEST_TYPEHASH,
                a.token,
                a.kind,
                uint8(a.result),
                a.validUntil,
                a.value,
                a.evidenceHash,
                keccak256(bytes(a.evidenceURI)),
                nonce,
                deadline
            )
        );
    }

    function _attest(address verifier, AttestInput calldata a) internal {
        address token = a.token;
        bytes32 kind = a.kind;
        if (!verifiers[verifier].active || !canAttest[verifier][kind]) revert NotAllowedVerifier(verifier, kind);
        Registration storage r = _reg[token];
        if (r.assetClass == bytes32(0)) revert NotRegistered(token);
        bool required;
        for (uint256 i; i < r.kinds.length; ++i) {
            if (r.kinds[i] == kind) {
                required = true;
                break;
            }
        }
        if (!required) revert KindNotRequired(token, kind);
        if (a.result != Result.Pass && a.result != Result.Fail) revert BadResult();
        uint64 maxUntil = uint64(block.timestamp) + maxValidity[kind];
        if (a.validUntil <= block.timestamp || a.validUntil > maxUntil) revert BadValidity(a.validUntil, maxUntil);
        if (a.evidenceHash == bytes32(0) || bytes(a.evidenceURI).length == 0) revert NoEvidence();
        // No verifier shopping: a current Fail can only be cleared by the verifier that issued it (or by the
        // platform removing that verifier, or by it expiring).
        Attestation storage prev = _latest[token][kind];
        if (
            prev.result == Result.Fail && prev.verifier != verifier && block.timestamp <= prev.validUntil
                && verifiers[prev.verifier].active && canAttest[prev.verifier][kind]
        ) revert FailStandsUntil(prev.verifier, prev.validUntil);
        _latest[token][kind] =
            Attestation(verifier, a.result, uint64(block.timestamp), a.validUntil, a.value, a.evidenceHash, a.evidenceURI);
        emit Attested(token, kind, verifier, a.result, a.validUntil, a.value, a.evidenceHash, a.evidenceURI);
    }

    function _onlyTokenAdmin(address token) internal view {
        if (token == address(0)) revert ZeroAddress();
        if (!TokenAdmin.isAdmin(token, msg.sender)) revert NotTokenAdmin(msg.sender);
    }
}
