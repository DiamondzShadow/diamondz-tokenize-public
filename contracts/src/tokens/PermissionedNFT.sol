// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Utils} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Utils.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC7943NonFungible} from "../interfaces/IERC7943NonFungible.sol";
import {InvestorRegistry} from "../compliance/InvestorRegistry.sol";
import {OfferingRules} from "../compliance/OfferingRules.sol";

/// @title PermissionedNFT
/// @notice ERC-721 implementing ERC-7943 (uRWA) non-fungible. Each token is one unique unit of the offering: a deed,
///         a parking space, a work of art. Only wallets verified in the tenant's InvestorRegistry can hold or move
///         them. Issuers can freeze a token and force transfers (court orders, lost keys), and pause all transfers.
/// @dev Roles as PermissionedToken: DEFAULT_ADMIN_ROLE = issuer multisig; MINTER_ROLE issues/redeems (the sale);
///      ENFORCER_ROLE freezes and force-transfers; PAUSER_ROLE pauses.
///      Token ids are issued in order from 1 and never reused; `maxSupply` caps how many can ever be issued.
contract PermissionedNFT is ERC721, AccessControl, Pausable, IERC7943NonFungible {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant ENFORCER_ROLE = keccak256("ENFORCER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    InvestorRegistry public registry;
    /// @notice Most tokens that can ever be issued (ids 1..maxSupply).
    uint256 public immutable maxSupply;
    /// @notice Free-form pointer to the offering documents (IPFS CID or URL).
    string public documentURI;
    /// @notice Tokens issued so far (also the last id issued).
    uint256 public minted;
    /// @notice Tokens in existence (issued minus redeemed).
    uint256 public totalSupply;

    string private _base;
    mapping(address => mapping(uint256 => bool)) private _frozen;
    bool private _forcing;
    /// @notice This offering's transfer rules; address(0) = none. Fixed at deploy (see OfferingRules).
    OfferingRules public immutable rules;
    bool private _issuerBurn;

    event RegistryUpdated(address indexed registry);
    event DocumentURIUpdated(string uri);
    event BaseURIUpdated(string uri);

    error ZeroAddress();
    error ZeroAmount();
    error MaxSupplyExceeded(uint256 requested, uint256 cap);

    struct Config {
        string name;
        string symbol;
        string baseURI; // tokenURI = baseURI + id
        uint256 maxSupply;
        address admin;
        address registry;
        string documentURI;
        address rules;
    }

    constructor(Config memory c) ERC721(c.name, c.symbol) {
        if (c.admin == address(0) || c.registry == address(0)) revert ZeroAddress();
        if (c.maxSupply == 0) revert ZeroAmount();
        maxSupply = c.maxSupply;
        registry = InvestorRegistry(c.registry);
        documentURI = c.documentURI;
        rules = OfferingRules(c.rules);
        _base = c.baseURI;
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
        _grantRole(MINTER_ROLE, c.admin);
        _grantRole(ENFORCER_ROLE, c.admin);
        _grantRole(PAUSER_ROLE, c.admin);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Issue the next token to `to`. Returns its id. A contract recipient must accept ERC-721.
    function mint(address to) external onlyRole(MINTER_ROLE) returns (uint256 id) {
        id = minted + 1;
        if (id > maxSupply) revert MaxSupplyExceeded(id, maxSupply);
        minted = id;
        _safeMint(to, id);
    }

    /// @notice Redeem (burn) a token, e.g. when the underlying asset is sold. A frozen token can't be burned this
    ///         way; unfreeze it first.
    function burn(uint256 tokenId) external onlyRole(MINTER_ROLE) {
        _issuerBurn = true;
        _burn(tokenId);
        _issuerBurn = false;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function setRegistry(address newRegistry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRegistry == address(0)) revert ZeroAddress();
        registry = InvestorRegistry(newRegistry);
        emit RegistryUpdated(newRegistry);
    }

    function setDocumentURI(string calldata u) external onlyRole(DEFAULT_ADMIN_ROLE) {
        documentURI = u;
        emit DocumentURIUpdated(u);
    }

    function setBaseURI(string calldata u) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _base = u;
        emit BaseURIUpdated(u);
    }

    // ---------------------------------------------------------------- ERC-7943

    /// @inheritdoc IERC7943NonFungible
    function setFrozenTokens(address account, uint256 tokenId, bool frozenStatus) external onlyRole(ENFORCER_ROLE) returns (bool) {
        _frozen[account][tokenId] = frozenStatus;
        emit Frozen(account, tokenId, frozenStatus);
        return true;
    }

    /// @inheritdoc IERC7943NonFungible
    /// @dev Bypasses sender checks, freezes and pause; the receiver must still be verified and `from` must own the
    ///      token. A frozen token is unfrozen first (Frozen emitted before Transfer). The receiver hook runs only
    ///      after the bypass flag is cleared, so a receiving contract can't re-enter with checks switched off.
    function forcedTransfer(address from, address to, uint256 tokenId) external onlyRole(ENFORCER_ROLE) returns (bool) {
        if (to == address(0)) revert ERC721InvalidReceiver(address(0));
        if (!canReceive(to)) revert ERC7943CannotReceive(to);
        address owner = _ownerOf(tokenId);
        if (owner == address(0)) revert ERC721NonexistentToken(tokenId);
        if (owner != from) revert ERC721IncorrectOwner(from, tokenId, owner);
        if (_frozen[from][tokenId]) {
            _frozen[from][tokenId] = false;
            emit Frozen(from, tokenId, false);
        }
        _forcing = true;
        _update(to, tokenId, address(0));
        _forcing = false;
        emit ForcedTransfer(from, to, tokenId);
        ERC721Utils.checkOnERC721Received(_msgSender(), from, to, tokenId, "");
        return true;
    }

    /// @inheritdoc IERC7943NonFungible
    function canSend(address account) public view returns (bool) {
        return registry.isVerified(account);
    }

    /// @inheritdoc IERC7943NonFungible
    function canReceive(address account) public view returns (bool) {
        return registry.isVerified(account) && (address(rules) == address(0) || rules.canHold(account));
    }

    /// @inheritdoc IERC7943NonFungible
    function getFrozenTokens(address account, uint256 tokenId) external view returns (bool) {
        return _frozen[account][tokenId];
    }

    /// @inheritdoc IERC7943NonFungible
    function canTransfer(address from, address to, uint256 tokenId) public view returns (bool) {
        if (paused()) return false;
        if (_frozen[from][tokenId]) return false;
        if (!canSend(from) || !canReceive(to)) return false;
        return address(rules) == address(0)
            || rules.check(from, to, 1, balanceOf(from), balanceOf(to)) == OfferingRules.Code.Ok;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC7943NonFungible).interfaceId || super.supportsInterface(interfaceId);
    }

    // ---------------------------------------------------------------- internals

    function _baseURI() internal view override returns (string memory) {
        return _base;
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (!_forcing) {
            if (from == address(0)) {
                if (!canReceive(to)) revert ERC7943CannotReceive(to);
            } else if (to == address(0)) {
                if (_frozen[from][tokenId]) revert ERC7943InsufficientUnfrozenBalance(from, tokenId);
            } else {
                _requireNotPaused();
                if (!canSend(from)) revert ERC7943CannotSend(from);
                if (!canReceive(to)) revert ERC7943CannotReceive(to);
                if (_frozen[from][tokenId]) revert ERC7943InsufficientUnfrozenBalance(from, tokenId);
            }
        }
        if (address(rules) != address(0)) {
            rules.onTransfer(
                from, to, 1, from == address(0) ? 0 : balanceOf(from), to == address(0) ? 0 : balanceOf(to),
                _forcing || _issuerBurn
            );
        }
        if (from == address(0)) ++totalSupply;
        else if (to == address(0)) --totalSupply;
        return super._update(to, tokenId, auth);
    }
}
