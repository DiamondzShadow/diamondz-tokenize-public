// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC7943Fungible} from "../interfaces/IERC7943.sol";
import {InvestorRegistry} from "../compliance/InvestorRegistry.sol";
import {OfferingRules} from "../compliance/OfferingRules.sol";

/// @title PermissionedToken
/// @notice ERC-20 security-style token implementing ERC-7943 (uRWA). Only wallets verified in the tenant's
///         InvestorRegistry can send or receive. Issuers can freeze balances and force transfers (court
///         orders, lost keys), and can pause all transfers.
/// @dev Roles: DEFAULT_ADMIN_ROLE = issuer multisig. MINTER_ROLE issues/redeems. ENFORCER_ROLE freezes and
///      force-transfers. PAUSER_ROLE pauses. Use the full ERC-3643 suite instead when a deal needs
///      ONCHAINID claims or T-REX compliance modules.
contract PermissionedToken is ERC20, AccessControl, Pausable, IERC7943Fungible {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant ENFORCER_ROLE = keccak256("ENFORCER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    InvestorRegistry public registry;
    uint8 private immutable _decimals;
    /// @notice Hard cap on supply; 0 = uncapped.
    uint256 public immutable maxSupply;
    /// @notice Free-form pointer to the offering documents (IPFS CID or URL).
    string public documentURI;

    /// @notice This offering's transfer rules (holding period, limits, accreditation...); address(0) = none.
    ///         Fixed at deploy so the issuer can't swap the rules out; the rules contract's own setters are public.
    OfferingRules public immutable rules;

    mapping(address => uint256) private _frozen;
    bool private _forcing;
    bool private _issuerBurn;

    event RegistryUpdated(address indexed registry);
    event DocumentURIUpdated(string uri);

    error ZeroAddress();
    error MaxSupplyExceeded(uint256 requested, uint256 cap);

    struct Config {
        string name;
        string symbol;
        uint8 decimals;
        uint256 maxSupply;
        address admin;
        address registry;
        string documentURI;
        address rules;
    }

    constructor(Config memory c) ERC20(c.name, c.symbol) {
        if (c.admin == address(0) || c.registry == address(0)) revert ZeroAddress();
        _decimals = c.decimals;
        maxSupply = c.maxSupply;
        registry = InvestorRegistry(c.registry);
        documentURI = c.documentURI;
        rules = OfferingRules(c.rules);
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
        _grantRole(MINTER_ROLE, c.admin);
        _grantRole(ENFORCER_ROLE, c.admin);
        _grantRole(PAUSER_ROLE, c.admin);
    }

    // ---------------------------------------------------------------- admin

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (maxSupply != 0 && totalSupply() + amount > maxSupply) {
            revert MaxSupplyExceeded(totalSupply() + amount, maxSupply);
        }
        _mint(to, amount);
    }

    /// @notice Redeem (burn) tokens from a holder, e.g. at maturity or on buyback. Frozen tokens can't be burned
    ///         this way; unfreeze first.
    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        _issuerBurn = true; // issuer redemption: skips the offering rules (still only unfrozen tokens)
        _burn(from, amount);
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

    function setDocumentURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        documentURI = uri;
        emit DocumentURIUpdated(uri);
    }

    // ---------------------------------------------------------------- ERC-7943

    /// @inheritdoc IERC7943Fungible
    function setFrozenTokens(address account, uint256 amount) external onlyRole(ENFORCER_ROLE) returns (bool) {
        _frozen[account] = amount;
        emit Frozen(account, amount);
        return true;
    }

    /// @inheritdoc IERC7943Fungible
    /// @dev Bypasses sender checks, freezes and pause. Receiver must still be verified. If the move eats into
    ///      the sender's frozen amount, the frozen amount is reduced to the remaining balance.
    function forcedTransfer(address from, address to, uint256 amount)
        external
        onlyRole(ENFORCER_ROLE)
        returns (bool)
    {
        if (!canReceive(to)) revert ERC7943CannotReceive(to);
        uint256 bal = balanceOf(from);
        uint256 unfrozen = bal > _frozen[from] ? bal - _frozen[from] : 0;
        if (amount > unfrozen) {
            // If amount > bal, _transfer below reverts with ERC20InsufficientBalance.
            uint256 newFrozen = amount >= bal ? 0 : bal - amount;
            _frozen[from] = newFrozen;
            emit Frozen(from, newFrozen);
        }
        _forcing = true;
        _transfer(from, to, amount);
        _forcing = false;
        emit ForcedTransfer(from, to, amount);
        return true;
    }

    /// @inheritdoc IERC7943Fungible
    function canSend(address account) public view returns (bool) {
        return registry.isVerified(account);
    }

    /// @inheritdoc IERC7943Fungible
    function canReceive(address account) public view returns (bool) {
        return registry.isVerified(account) && (address(rules) == address(0) || rules.canHold(account));
    }

    /// @inheritdoc IERC7943Fungible
    function getFrozenTokens(address account) external view returns (uint256) {
        return _frozen[account];
    }

    /// @inheritdoc IERC7943Fungible
    function canTransfer(address from, address to, uint256 amount) public view returns (bool) {
        if (paused()) return false;
        if (!canSend(from) || !canReceive(to)) return false;
        if (amount > _unfrozenBalance(from)) return false;
        return address(rules) == address(0)
            || rules.check(from, to, amount, balanceOf(from), balanceOf(to)) == OfferingRules.Code.Ok;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC7943Fungible).interfaceId || super.supportsInterface(interfaceId);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ---------------------------------------------------------------- internals

    function _unfrozenBalance(address account) internal view returns (uint256) {
        uint256 bal = balanceOf(account);
        uint256 f = _frozen[account];
        return bal > f ? bal - f : 0;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (!_forcing) {
            if (from == address(0)) {
                // mint
                if (!canReceive(to)) revert ERC7943CannotReceive(to);
            } else if (to == address(0)) {
                // burn / redeem: only unfrozen tokens
                uint256 unfrozen = _unfrozenBalance(from);
                if (amount > unfrozen) revert ERC7943InsufficientUnfrozenBalance(from, amount, unfrozen);
            } else {
                _requireNotPaused();
                if (!canSend(from)) revert ERC7943CannotSend(from);
                if (!canReceive(to)) revert ERC7943CannotReceive(to);
                uint256 unfrozen = _unfrozenBalance(from);
                if (amount > unfrozen) revert ERC7943InsufficientUnfrozenBalance(from, amount, unfrozen);
            }
        }
        if (address(rules) != address(0)) {
            uint256 fromBal = from == address(0) ? 0 : balanceOf(from);
            uint256 toBal = to == address(0) ? 0 : balanceOf(to);
            rules.onTransfer(from, to, amount, fromBal, toBal, _forcing || _issuerBurn);
        }
        super._update(from, to, amount);
    }
}
