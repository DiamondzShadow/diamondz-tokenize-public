// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AssetRegistry} from "./AssetRegistry.sol";

/// @title LicenseRegistry
/// @notice Licenses of registered assets (designs F1–F5): the asset's holder publishes license types, each pointing
///         at a counsel-drafted template by its sha256 fingerprint; a verified licensee accepts the exact fingerprint
///         and pays; the licensee receives a license NFT that can't be transferred. Negotiated deals ("by request")
///         are offers made to one licensee. Revenue-share licensees report and pay through `reportRevenue`.
///         Revoked or expired licenses show as such to anyone checking a certificate.
///         Card payments (paid to the issuer's own processor account, off chain): the licensee still sends the
///         transaction accepting the exact terms, with a receipt signed by a verifier the asset's holder allowed.
/// @dev One registry per network. The platform (DEFAULT_ADMIN_ROLE) only sets its own fee and the metadata base URL;
///      it can't issue, revoke or change anyone's licenses. Payments go straight to the asset's payee.
contract LicenseRegistry is ERC721, AccessControl, EIP712 {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_PLATFORM_FEE_BPS = 1_000;
    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "CardReceipt(uint256 typeId,address licensee,bytes32 termsHash,bytes32 paymentRef,uint256 amount,uint64 deadline)"
    );

    struct LicenseType {
        uint256 assetId;
        bytes32 termsHash; // sha256 of the template the licensee signs
        address feeToken; // e.g. USDC
        uint256 fee; // one-time fee
        uint16 revShareBps; // share of the licensee's gross revenue, 0 = none
        uint32 durationDays; // 0 = perpetual
        bool byRequest; // only through an offer (distribution deals)
        bool active;
        string name; // "Clip & promo"
        string territory; // "Worldwide"
        string termsURI; // where the template text can be read
    }

    struct License {
        uint256 assetId;
        uint256 typeId;
        address licensee;
        bytes32 termsHash;
        address feeToken;
        uint256 feePaid;
        uint16 revShareBps;
        uint64 start;
        uint64 end; // 0 = perpetual
        bool revoked;
        uint256 revenueReported;
        string work; // what the licensee makes, shown in the asset's lineage
        string territory;
    }

    struct Offer {
        uint256 typeId;
        address licensee;
        uint256 fee;
        uint16 revShareBps;
        uint32 durationDays;
        bytes32 termsHash;
        uint64 expiresAt;
        bool used;
        string territory;
    }

    enum Status {
        None,
        Active,
        Expired,
        Revoked
    }

    AssetRegistry public immutable assets;
    string public baseURI;
    uint16 public platformFeeBps;
    address public platformFeeRecipient;

    uint256 public typeCount;
    uint256 public licenseCount;
    uint256 public offerCount;
    mapping(uint256 => LicenseType) private _types;
    mapping(uint256 => License) private _licenses;
    mapping(uint256 => Offer) private _offers;
    /// @notice Licensees verified for an asset (business/identity check passed), until this time.
    mapping(uint256 => mapping(address => uint64)) public verifiedUntil;
    /// @notice Accounts the asset's holder lets verify licensees (e.g. the platform's KYB relayer).
    mapping(uint256 => mapping(address => bool)) public verifier;
    /// @notice Card payment references already used (one license per payment).
    mapping(bytes32 => bool) public receiptUsed;

    event LicenseTypePublished(uint256 indexed assetId, uint256 indexed typeId, string name, bytes32 termsHash, address feeToken, uint256 fee, uint16 revShareBps, uint32 durationDays, bool byRequest);
    event LicenseTypeActive(uint256 indexed typeId, bool active);
    event VerifierSet(uint256 indexed assetId, address indexed account, bool allowed);
    event LicenseeVerified(uint256 indexed assetId, address indexed licensee, uint64 until);
    event OfferMade(uint256 indexed offerId, uint256 indexed typeId, address indexed licensee, uint256 fee, uint16 revShareBps, uint64 expiresAt);
    event LicenseIssued(uint256 indexed licenseId, uint256 indexed assetId, address indexed licensee, uint256 typeId, bytes32 termsHash, uint256 fee, uint64 start, uint64 end, string work);
    event RevenueReported(uint256 indexed licenseId, uint256 gross, uint256 paid, string period);
    event LicenseRevoked(uint256 indexed licenseId, string reason);
    event PlatformFeeSet(uint16 bps, address recipient);
    event PaidByCard(uint256 indexed licenseId, bytes32 indexed paymentRef, address signer, uint256 amount);

    error NotAssetOwner(uint256 assetId);
    error NotVerifier(uint256 assetId);
    error Inactive(uint256 typeId);
    error ByRequestOnly(uint256 typeId);
    error TermsMismatch(bytes32 expected, bytes32 got);
    error NotVerified(address licensee);
    error BadOffer(uint256 offerId);
    error NotLicensee(uint256 licenseId);
    error NotActive(uint256 licenseId);
    error Soulbound();
    error BadInput();
    error BadReceipt();

    constructor(AssetRegistry assets_, address admin, string memory baseURI_)
        ERC721("Diamondz License", "LIC")
        EIP712("Diamondz License", "1")
    {
        if (address(assets_) == address(0) || admin == address(0)) revert BadInput();
        assets = assets_;
        baseURI = baseURI_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    modifier onlyAssetOwner(uint256 assetId) {
        if (assets.ownerOf(assetId) != msg.sender) revert NotAssetOwner(assetId);
        _;
    }

    // ---------------------------------------------------------------- platform

    function setPlatformFee(uint16 bps, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_PLATFORM_FEE_BPS || (bps > 0 && recipient == address(0))) revert BadInput();
        platformFeeBps = bps;
        platformFeeRecipient = recipient;
        emit PlatformFeeSet(bps, recipient);
    }

    function setBaseURI(string calldata u) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseURI = u;
    }

    // ---------------------------------------------------------------- the asset holder

    /// @notice Publish a license type. Changing a template means publishing a new type and retiring the old one, so a
    ///         signed license always points at the exact text its licensee accepted.
    function publishType(LicenseType calldata t) external onlyAssetOwner(t.assetId) returns (uint256 typeId) {
        if (t.termsHash == bytes32(0) || t.revShareBps > 10_000 || bytes(t.name).length == 0) revert BadInput();
        if ((t.fee > 0 || t.revShareBps > 0) && t.feeToken == address(0)) revert BadInput();
        typeId = ++typeCount;
        _types[typeId] = t;
        _types[typeId].active = true;
        emit LicenseTypePublished(t.assetId, typeId, t.name, t.termsHash, t.feeToken, t.fee, t.revShareBps, t.durationDays, t.byRequest);
    }

    function setTypeActive(uint256 typeId, bool active) external onlyAssetOwner(_types[typeId].assetId) {
        _types[typeId].active = active;
        emit LicenseTypeActive(typeId, active);
    }

    function setVerifier(uint256 assetId, address account, bool allowed) external onlyAssetOwner(assetId) {
        verifier[assetId][account] = allowed;
        emit VerifierSet(assetId, account, allowed);
    }

    /// @notice Record that a licensee passed verification (by the asset holder or a verifier they allowed).
    function verifyLicensee(uint256 assetId, address licensee, uint64 until) external {
        if (assets.ownerOf(assetId) != msg.sender && !verifier[assetId][msg.sender]) revert NotVerifier(assetId);
        verifiedUntil[assetId][licensee] = until;
        emit LicenseeVerified(assetId, licensee, until);
    }

    /// @notice A negotiated deal for one licensee (distribution, or custom terms on any type).
    function makeOffer(uint256 typeId, Offer calldata o) external onlyAssetOwner(_types[typeId].assetId) returns (uint256 offerId) {
        if (o.licensee == address(0) || o.termsHash == bytes32(0) || o.revShareBps > 10_000) revert BadInput();
        if (o.expiresAt <= block.timestamp) revert BadInput();
        offerId = ++offerCount;
        _offers[offerId] = o;
        _offers[offerId].typeId = typeId;
        _offers[offerId].used = false;
        emit OfferMade(offerId, typeId, o.licensee, o.fee, o.revShareBps, o.expiresAt);
    }

    function revoke(uint256 licenseId, string calldata reason) external onlyAssetOwner(_licenses[licenseId].assetId) {
        if (_licenses[licenseId].licensee == address(0)) revert NotActive(licenseId);
        _licenses[licenseId].revoked = true;
        emit LicenseRevoked(licenseId, reason);
    }

    // ---------------------------------------------------------------- licensees

    /// @notice Take a standard license. `termsHash` must be the published template's fingerprint: sending this
    ///         transaction is the licensee's signature on those exact terms.
    function buy(uint256 typeId, bytes32 termsHash, string calldata work) external returns (uint256 licenseId) {
        LicenseType storage t = _types[typeId];
        if (!t.active) revert Inactive(typeId);
        if (t.byRequest) revert ByRequestOnly(typeId);
        if (termsHash != t.termsHash) revert TermsMismatch(t.termsHash, termsHash);
        return _issue(t.assetId, typeId, termsHash, t.feeToken, t.fee, t.revShareBps, t.durationDays, work, t.territory);
    }

    /// @notice A card payment, signed (EIP-712) by a verifier the asset's holder allowed.
    struct CardReceipt {
        bytes32 paymentRef; // the processor's payment id, hashed
        uint256 amount; // in the fee token's units (e.g. USD, 6 decimals)
        uint64 deadline;
        bytes sig;
    }

    /// @notice Take a standard license paid by card. The receipt must cover the fee and works once.
    function buyWithReceipt(uint256 typeId, bytes32 termsHash, string calldata work, CardReceipt calldata r)
        external
        returns (uint256 licenseId)
    {
        LicenseType storage t = _types[typeId];
        if (!t.active) revert Inactive(typeId);
        if (t.byRequest) revert ByRequestOnly(typeId);
        if (termsHash != t.termsHash) revert TermsMismatch(t.termsHash, termsHash);
        address signer = _checkReceipt(typeId, t, termsHash, r);
        receiptUsed[r.paymentRef] = true;
        licenseId = _issueUnpaid(t.assetId, typeId, termsHash, t.feeToken, r.amount, t.revShareBps, t.durationDays, work, t.territory);
        emit PaidByCard(licenseId, r.paymentRef, signer, r.amount);
    }

    function _checkReceipt(uint256 typeId, LicenseType storage t, bytes32 termsHash, CardReceipt calldata r)
        internal
        view
        returns (address signer)
    {
        if (block.timestamp > r.deadline || receiptUsed[r.paymentRef] || r.amount < t.fee) revert BadReceipt();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(RECEIPT_TYPEHASH, typeId, msg.sender, termsHash, r.paymentRef, r.amount, r.deadline))
        );
        signer = ECDSA.recover(digest, r.sig);
        if (!verifier[t.assetId][signer]) revert BadReceipt();
    }

    function acceptOffer(uint256 offerId, bytes32 termsHash, string calldata work) external returns (uint256 licenseId) {
        Offer storage o = _offers[offerId];
        if (o.licensee != msg.sender || o.used || block.timestamp > o.expiresAt) revert BadOffer(offerId);
        if (termsHash != o.termsHash) revert TermsMismatch(o.termsHash, termsHash);
        LicenseType storage t = _types[o.typeId];
        if (!t.active) revert Inactive(o.typeId);
        o.used = true;
        return _issue(t.assetId, o.typeId, termsHash, t.feeToken, o.fee, o.revShareBps, o.durationDays, work, o.territory);
    }

    /// @notice Revenue-share licenses: report gross revenue for a period and pay the share in the license's token.
    function reportRevenue(uint256 licenseId, uint256 gross, string calldata period) external {
        License storage l = _licenses[licenseId];
        if (l.licensee != msg.sender) revert NotLicensee(licenseId);
        // Allowed after expiry or revocation too: revenue earned during the license is still owed.
        uint256 owed = (gross * l.revShareBps) / 10_000;
        l.revenueReported += gross;
        if (owed > 0) _pay(l.assetId, l.feeToken, msg.sender, owed);
        emit RevenueReported(licenseId, gross, owed, period);
    }

    // ---------------------------------------------------------------- views

    function licenseType(uint256 typeId) external view returns (LicenseType memory) {
        return _types[typeId];
    }

    function license(uint256 licenseId) external view returns (License memory) {
        return _licenses[licenseId];
    }

    function offer(uint256 offerId) external view returns (Offer memory) {
        return _offers[offerId];
    }

    /// @notice What a certificate's QR code checks.
    function status(uint256 licenseId) public view returns (Status) {
        License storage l = _licenses[licenseId];
        if (l.licensee == address(0)) return Status.None;
        if (l.revoked) return Status.Revoked;
        if (l.end != 0 && block.timestamp > l.end) return Status.Expired;
        return Status.Active;
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string.concat(baseURI, _toString(id));
    }

    /// @notice EIP-712 digest of a card receipt (what the platform verifier signs).
    function receiptDigest(uint256 typeId, address licensee, bytes32 termsHash, bytes32 paymentRef, uint256 amount, uint64 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(RECEIPT_TYPEHASH, typeId, licensee, termsHash, paymentRef, amount, deadline)));
    }

    function supportsInterface(bytes4 id) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(id);
    }

    // ---------------------------------------------------------------- internals

    function _issue(
        uint256 assetId, uint256 typeId, bytes32 termsHash, address feeToken, uint256 fee, uint16 revShareBps,
        uint32 durationDays, string calldata work, string memory territory
    ) internal returns (uint256 id) {
        if (verifiedUntil[assetId][msg.sender] < block.timestamp) revert NotVerified(msg.sender);
        if (fee > 0) _pay(assetId, feeToken, msg.sender, fee);
        return _issueUnpaid(assetId, typeId, termsHash, feeToken, fee, revShareBps, durationDays, work, territory);
    }

    /// @dev Records the license; the fee was paid on chain by `_issue`, or by card (`buyWithReceipt`).
    function _issueUnpaid(
        uint256 assetId, uint256 typeId, bytes32 termsHash, address feeToken, uint256 fee, uint16 revShareBps,
        uint32 durationDays, string calldata work, string memory territory
    ) internal returns (uint256 id) {
        if (verifiedUntil[assetId][msg.sender] < block.timestamp) revert NotVerified(msg.sender);
        if (bytes(work).length > 200) revert BadInput();
        id = ++licenseCount;
        uint64 start = uint64(block.timestamp);
        uint64 end = durationDays == 0 ? 0 : start + uint64(durationDays) * 1 days;
        _licenses[id] = License({
            assetId: assetId, typeId: typeId, licensee: msg.sender, termsHash: termsHash, feeToken: feeToken, feePaid: fee,
            revShareBps: revShareBps, start: start, end: end, revoked: false, revenueReported: 0, work: work, territory: territory
        });
        _safeMint(msg.sender, id);
        emit LicenseIssued(id, assetId, msg.sender, typeId, termsHash, fee, start, end, work);
    }

    /// @dev Payments go straight to the asset's payee, minus the platform fee (if any).
    function _pay(uint256 assetId, address token, address from, uint256 amount) internal {
        (address payee,) = assets.payeeOf(assetId);
        uint256 cut = (amount * platformFeeBps) / 10_000;
        if (cut > 0) IERC20(token).safeTransferFrom(from, platformFeeRecipient, cut);
        IERC20(token).safeTransferFrom(from, payee, amount - cut);
    }

    /// @dev Licenses can't be transferred: only minting is allowed.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function _toString(uint256 v) private pure returns (string memory s) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) { len++; j /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        s = string(b);
    }
}
