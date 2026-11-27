// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {ERC1155Utils} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Utils.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC7943MultiToken} from "../interfaces/IERC7943MultiToken.sol";
import {InvestorRegistry} from "../compliance/InvestorRegistry.sol";
import {OfferingRules} from "../compliance/OfferingRules.sol";

/// @title PermissionedMultiToken
/// @notice ERC-1155 implementing ERC-7943 (uRWA) multi-token. Each token id is one item: a whisky cask, a painting,
///         a carbon-credit vintage. Its units are fixed fractions of that item. Only wallets verified in the tenant's
///         InvestorRegistry can hold or move units. Issuers can freeze units and force transfers (court orders,
///         lost keys), and pause all transfers.
///         Carbon: a holder can `retire` units: they are burned for good, with the beneficiary and reason on record.
/// @dev Roles as PermissionedToken: DEFAULT_ADMIN_ROLE = issuer multisig; MINTER_ROLE issues/redeems (the sale);
///      ENFORCER_ROLE freezes and force-transfers; PAUSER_ROLE pauses.
///      An item's cap is fixed when the item is created and can never be raised, so holders' fractions can't be
///      diluted. Units have no decimals: 1 unit = 1 fraction.
contract PermissionedMultiToken is ERC1155Supply, AccessControl, Pausable, IERC7943MultiToken {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant ENFORCER_ROLE = keccak256("ENFORCER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    string public name;
    string public symbol;
    InvestorRegistry public registry;
    /// @notice Free-form pointer to the offering documents (IPFS CID or URL).
    string public documentURI;

    struct Item {
        bool exists;
        uint256 maxSupply; // units; fixed at creation
        string uri; // per-item metadata; empty = the collection URI
    }

    mapping(uint256 => Item) private _items;
    /// @notice Units of each item retired (burned for good) by holders.
    mapping(uint256 => uint256) public retired;
    mapping(address => mapping(uint256 => uint256)) private _frozen;
    bool private _forcing;
    /// @notice This offering's transfer rules; address(0) = none. Fixed at deploy (see OfferingRules).
    OfferingRules public immutable rules;
    bool private _issuerBurn;

    event ItemCreated(uint256 indexed id, uint256 maxSupply, string uri);
    event Retired(address indexed holder, uint256 indexed id, uint256 amount, string beneficiary, string reason);
    event RegistryUpdated(address indexed registry);
    event DocumentURIUpdated(string uri);

    error ZeroAddress();
    error ZeroAmount();
    error ItemExists(uint256 id);
    error UnknownItem(uint256 id);
    error MaxSupplyExceeded(uint256 id, uint256 requested, uint256 cap);

    struct Config {
        string name;
        string symbol;
        string uri; // collection metadata, ERC-1155 `{id}` substitution allowed
        address admin;
        address registry;
        string documentURI;
        address rules;
    }

    constructor(Config memory c) ERC1155(c.uri) {
        if (c.admin == address(0) || c.registry == address(0)) revert ZeroAddress();
        name = c.name;
        symbol = c.symbol;
        registry = InvestorRegistry(c.registry);
        documentURI = c.documentURI;
        rules = OfferingRules(c.rules);
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
        _grantRole(MINTER_ROLE, c.admin);
        _grantRole(ENFORCER_ROLE, c.admin);
        _grantRole(PAUSER_ROLE, c.admin);
    }

    // ---------------------------------------------------------------- items

    /// @notice Create an item with a cap that can never change. `maxSupply` must be > 0.
    function createItem(uint256 id, uint256 maxSupply_, string calldata itemURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_items[id].exists) revert ItemExists(id);
        if (maxSupply_ == 0) revert ZeroAmount();
        _items[id] = Item(true, maxSupply_, itemURI);
        emit ItemCreated(id, maxSupply_, itemURI);
        if (bytes(itemURI).length != 0) emit URI(itemURI, id);
    }

    function itemExists(uint256 id) public view returns (bool) {
        return _items[id].exists;
    }

    function maxSupply(uint256 id) public view returns (uint256) {
        return _items[id].maxSupply;
    }

    function uri(uint256 id) public view override returns (string memory) {
        string memory u = _items[id].uri;
        return bytes(u).length != 0 ? u : super.uri(id);
    }

    // ---------------------------------------------------------------- admin

    function mint(address to, uint256 id, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (!_items[id].exists) revert UnknownItem(id);
        if (amount == 0) revert ZeroAmount();
        uint256 next = totalSupply(id) + amount;
        if (next > _items[id].maxSupply) revert MaxSupplyExceeded(id, next, _items[id].maxSupply);
        _mint(to, id, amount, "");
    }

    /// @notice Redeem (burn) units from a holder, e.g. when the item is sold and holders are paid out. Frozen units
    ///         can't be burned this way; unfreeze first.
    function burn(address from, uint256 id, uint256 amount) external onlyRole(MINTER_ROLE) {
        _issuerBurn = true;
        _burn(from, id, amount);
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

    function setURI(string calldata u) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setURI(u);
    }

    // ---------------------------------------------------------------- holders

    /// @notice Retire (permanently burn) your own units, e.g. to claim a carbon offset. Must be verified, unfrozen,
    ///         and not paused. `beneficiary` and `reason` are recorded on chain; never put personal data in them.
    function retire(uint256 id, uint256 amount, string calldata beneficiary, string calldata reason) external {
        if (amount == 0) revert ZeroAmount();
        _requireNotPaused();
        if (!canSend(msg.sender)) revert ERC7943CannotSend(msg.sender);
        retired[id] += amount;
        _burn(msg.sender, id, amount); // _update enforces the unfrozen balance
        emit Retired(msg.sender, id, amount, beneficiary, reason);
    }

    // ---------------------------------------------------------------- ERC-7943

    /// @inheritdoc IERC7943MultiToken
    function setFrozenTokens(address account, uint256 id, uint256 amount) external onlyRole(ENFORCER_ROLE) returns (bool) {
        _frozen[account][id] = amount;
        emit Frozen(account, id, amount);
        return true;
    }

    /// @inheritdoc IERC7943MultiToken
    /// @dev Bypasses sender checks, freezes and pause; the receiver must still be verified. If the move eats into the
    ///      frozen amount, frozen is reduced first (Frozen emitted before TransferSingle). The receiver hook runs only
    ///      after the bypass flag is cleared, so a receiving contract can't re-enter with checks switched off.
    function forcedTransfer(address from, address to, uint256 id, uint256 amount)
        external
        onlyRole(ENFORCER_ROLE)
        returns (bool)
    {
        if (to == address(0)) revert ERC1155InvalidReceiver(address(0));
        if (from == address(0)) revert ERC1155InvalidSender(address(0));
        if (!canReceive(to)) revert ERC7943CannotReceive(to);
        uint256 bal = balanceOf(from, id);
        uint256 f = _frozen[from][id];
        uint256 unfrozen = bal > f ? bal - f : 0;
        if (amount > unfrozen && amount <= bal) {
            uint256 newFrozen = bal - amount;
            _frozen[from][id] = newFrozen;
            emit Frozen(from, id, newFrozen);
        }
        uint256[] memory ids = new uint256[](1);
        uint256[] memory vals = new uint256[](1);
        ids[0] = id;
        vals[0] = amount;
        _forcing = true;
        _update(from, to, ids, vals); // reverts with ERC1155InsufficientBalance if amount > bal
        _forcing = false;
        emit ForcedTransfer(from, to, id, amount);
        ERC1155Utils.checkOnERC1155Received(_msgSender(), from, to, id, amount, "");
        return true;
    }

    /// @inheritdoc IERC7943MultiToken
    function canSend(address account) public view returns (bool) {
        return registry.isVerified(account);
    }

    /// @inheritdoc IERC7943MultiToken
    function canReceive(address account) public view returns (bool) {
        return registry.isVerified(account) && (address(rules) == address(0) || rules.canHold(account));
    }

    /// @inheritdoc IERC7943MultiToken
    function getFrozenTokens(address account, uint256 id) external view returns (uint256) {
        return _frozen[account][id];
    }

    /// @inheritdoc IERC7943MultiToken
    function canTransfer(address from, address to, uint256 id, uint256 amount) public view returns (bool) {
        if (paused()) return false;
        if (!canSend(from) || !canReceive(to)) return false;
        if (amount > _unfrozenBalance(from, id)) return false;
        return address(rules) == address(0)
            || rules.check(from, to, amount, balanceOf(from, id), balanceOf(to, id)) == OfferingRules.Code.Ok;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC7943MultiToken).interfaceId || super.supportsInterface(interfaceId);
    }

    // ---------------------------------------------------------------- internals

    function _unfrozenBalance(address account, uint256 id) internal view returns (uint256) {
        uint256 bal = balanceOf(account, id);
        uint256 f = _frozen[account][id];
        return bal > f ? bal - f : 0;
    }

    function _checkUnfrozen(address from, uint256[] memory ids, uint256[] memory values) private view {
        for (uint256 i; i < ids.length; ++i) {
            uint256 bal = balanceOf(from, ids[i]);
            // Over the full balance: let the base standard revert with ERC1155InsufficientBalance (per ERC-7943).
            if (values[i] > bal) continue;
            uint256 unfrozen = _unfrozenBalance(from, ids[i]);
            if (values[i] > unfrozen) revert ERC7943InsufficientUnfrozenBalance(from, ids[i], values[i], unfrozen);
        }
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (!_forcing) {
            if (from == address(0)) {
                if (!canReceive(to)) revert ERC7943CannotReceive(to);
            } else if (to == address(0)) {
                _checkUnfrozen(from, ids, values);
            } else {
                _requireNotPaused();
                if (!canSend(from)) revert ERC7943CannotSend(from);
                if (!canReceive(to)) revert ERC7943CannotReceive(to);
                _checkUnfrozen(from, ids, values);
            }
        }
        if (address(rules) != address(0)) {
            // Rules count units per item; an offering sells one item (see ITEM_ID in the app).
            for (uint256 i; i < ids.length; ++i) {
                rules.onTransfer(
                    from, to, values[i],
                    from == address(0) ? 0 : balanceOf(from, ids[i]),
                    to == address(0) ? 0 : balanceOf(to, ids[i]),
                    _forcing || _issuerBurn
                );
            }
        }
        super._update(from, to, ids, values);
    }
}
