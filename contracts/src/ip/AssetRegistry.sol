// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

interface IOwnable {
    function owner() external view returns (address);
}

/// @title AssetRegistry
/// @notice The official on-chain record of each offering's underlying asset (designs F1–F7, approved 2026-11-19):
///         one asset NFT per offering token, held by the issuer (normally its treasury multisig). The record carries
///         the asset class, a metadata URI (title, image, description), the fingerprint of its chain-of-title
///         documents, industry identifiers (EIDR, ISRC, ISWC, parcel numbers, registry project IDs...), who receives
///         license payments, and the share of license revenue that belongs to token holders.
///         Laid out like Story's IP assets, but kept on the offering's own chain (Story's L1 is being retired).
/// @dev One registry per network, no admin: only an admin of the offering token can register it (AccessControl
///      DEFAULT_ADMIN_ROLE, or owner() for Ownable tokens such as ERC-3643), and only once. After that the asset NFT's
///      holder controls the record. Document and metadata changes are append-only in the event log.
contract AssetRegistry is ERC721 {
    struct Asset {
        address offering; // the offering's token (or vault)
        bytes32 assetClass; // keccak256("film"), keccak256("real-estate"), ...
        bytes32 docsManifest; // sha256 manifest of the chain-of-title fingerprints (same as the token's documentURI)
        address payee; // receives license fees and revenue shares
        uint16 holdersBps; // share of license revenue owed to token holders (paid through Payouts)
        uint64 registeredAt;
        string uri; // metadata JSON (title, image, description)
    }

    struct Registration {
        address offering;
        bytes32 assetClass;
        string uri;
        bytes32 docsManifest;
        address payee;
        uint16 holdersBps;
        address to; // who receives the asset NFT (the issuer's treasury)
        string[] idKeys; // e.g. ["EIDR", "US_COPYRIGHT"]
        string[] idValues;
    }

    uint256 public assetCount;
    mapping(uint256 => Asset) private _assets;
    mapping(address => uint256) public assetOf; // offering token => asset id (0 = none)
    mapping(uint256 => mapping(string => string)) private _ids;
    mapping(uint256 => string[]) private _idKeys;

    event AssetRegistered(uint256 indexed assetId, address indexed offering, bytes32 indexed assetClass, address to, string uri);
    event MetadataUpdated(uint256 indexed assetId, string uri);
    event DocumentsUpdated(uint256 indexed assetId, bytes32 previous, bytes32 current);
    event IdentifierSet(uint256 indexed assetId, string key, string value);
    event PayeeUpdated(uint256 indexed assetId, address payee, uint16 holdersBps);

    error NotOfferingAdmin(address offering, address caller);
    error AlreadyRegistered(address offering, uint256 assetId);
    error NotAssetOwner(uint256 assetId, address caller);
    error BadInput();

    constructor() ERC721("Diamondz Asset Registry", "ASSET") {}

    modifier onlyAssetOwner(uint256 id) {
        if (_ownerOf(id) != msg.sender) revert NotAssetOwner(id, msg.sender);
        _;
    }

    // ---------------------------------------------------------------- register

    function register(Registration calldata r) external returns (uint256 id) {
        if (r.offering == address(0) || r.to == address(0) || r.payee == address(0)) revert BadInput();
        if (r.holdersBps > 10_000 || r.idKeys.length != r.idValues.length || r.idKeys.length > 16) revert BadInput();
        if (!isOfferingAdmin(r.offering, msg.sender)) revert NotOfferingAdmin(r.offering, msg.sender);
        if (assetOf[r.offering] != 0) revert AlreadyRegistered(r.offering, assetOf[r.offering]);
        id = ++assetCount;
        assetOf[r.offering] = id;
        _assets[id] = Asset({
            offering: r.offering,
            assetClass: r.assetClass,
            docsManifest: r.docsManifest,
            payee: r.payee,
            holdersBps: r.holdersBps,
            registeredAt: uint64(block.timestamp),
            uri: r.uri
        });
        for (uint256 i; i < r.idKeys.length; ++i) _setId(id, r.idKeys[i], r.idValues[i]);
        _safeMint(r.to, id);
        emit AssetRegistered(id, r.offering, r.assetClass, r.to, r.uri);
        emit DocumentsUpdated(id, bytes32(0), r.docsManifest);
        emit PayeeUpdated(id, r.payee, r.holdersBps);
    }

    // ---------------------------------------------------------------- the holder's controls

    function setMetadata(uint256 id, string calldata uri) external onlyAssetOwner(id) {
        _assets[id].uri = uri;
        emit MetadataUpdated(id, uri);
    }

    /// @notice New document set (e.g. a renewed insurance policy). The old manifest stays in the event log.
    function setDocuments(uint256 id, bytes32 manifest) external onlyAssetOwner(id) {
        emit DocumentsUpdated(id, _assets[id].docsManifest, manifest);
        _assets[id].docsManifest = manifest;
    }

    function setIdentifier(uint256 id, string calldata key, string calldata value) external onlyAssetOwner(id) {
        if (_idKeys[id].length >= 16 && bytes(_ids[id][key]).length == 0) revert BadInput();
        _setId(id, key, value);
    }

    function setPayee(uint256 id, address payee, uint16 holdersBps) external onlyAssetOwner(id) {
        if (payee == address(0) || holdersBps > 10_000) revert BadInput();
        _assets[id].payee = payee;
        _assets[id].holdersBps = holdersBps;
        emit PayeeUpdated(id, payee, holdersBps);
    }

    // ---------------------------------------------------------------- views

    function asset(uint256 id) external view returns (Asset memory) {
        return _assets[id];
    }

    function identifiers(uint256 id) external view returns (string[] memory keys, string[] memory values) {
        keys = _idKeys[id];
        values = new string[](keys.length);
        for (uint256 i; i < keys.length; ++i) values[i] = _ids[id][keys[i]];
    }

    function payeeOf(uint256 id) external view returns (address payee, uint16 holdersBps) {
        return (_assets[id].payee, _assets[id].holdersBps);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return _assets[id].uri;
    }

    /// @notice True when `who` administers the offering token: AccessControl admin, or owner() for Ownable tokens.
    function isOfferingAdmin(address offering, address who) public view returns (bool) {
        (bool ok, bytes memory ret) = offering.staticcall(abi.encodeCall(IAccessControl.hasRole, (bytes32(0), who)));
        if (ok && ret.length >= 32 && abi.decode(ret, (bool))) return true;
        (ok, ret) = offering.staticcall(abi.encodeCall(IOwnable.owner, ()));
        return ok && ret.length >= 32 && abi.decode(ret, (address)) == who;
    }

    function _setId(uint256 id, string calldata key, string calldata value) internal {
        if (bytes(key).length == 0 || bytes(key).length > 32 || bytes(value).length == 0 || bytes(value).length > 128) revert BadInput();
        if (bytes(_ids[id][key]).length == 0) _idKeys[id].push(key);
        _ids[id][key] = value;
        emit IdentifierSet(id, key, value);
    }
}
