// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {InvestorRegistry} from "../compliance/InvestorRegistry.sol";
import {OfferingRules} from "../compliance/OfferingRules.sol";

interface IAssetOracleView {
    function isVerified(address token) external view returns (bool);
}

/// @title PermissionedVault
/// @notice ERC-4626 fund/pool shares for pooled assets (funds, royalty pools, credit pools). Investors deposit a
///         stablecoin and get shares. Part of the capital can be deployed off-chain (buying property, lending),
///         and a NAV reporter records its value so share price reflects the whole pool.
/// @dev With `oracle` set, deposits only open while the AssetOracle verifies this vault's asset (proof of asset), the
///      same rule as PrimarySale. `depositCap` (asset units, 0 = none) is the offering size.
///      Only verified investors may hold shares. Off-chain NAV is trusted input from NAV_REPORTER_ROLE (e.g. a
///      fund administrator or a Chainlink NAV feed keeper); a max-change guard limits single-update jumps.
contract PermissionedVault is ERC4626, AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant NAV_REPORTER_ROLE = keccak256("NAV_REPORTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    InvestorRegistry public immutable registry;
    /// @notice Proof-of-asset oracle gating deposits; address(0) = no gating.
    IAssetOracleView public immutable oracle;
    /// @notice Max total assets the vault accepts through deposits (asset units). 0 = no cap.
    uint256 public immutable depositCap;
    /// @notice This fund's transfer rules (accreditation, countries, holders, redemption lock); 0 = none.
    OfferingRules public immutable rules;
    /// @notice Value (in asset units) of capital deployed off-chain, as last reported.
    uint256 public offchainAssets;
    uint64 public navUpdatedAt;
    /// @notice Max allowed change of offchainAssets per report, in bps of totalAssets. 0 = unlimited.
    uint16 public maxNavChangeBps;

    event CapitalDeployed(address indexed to, uint256 assets, string memo);
    event CapitalReturned(address indexed from, uint256 assets, string memo);
    event NavReported(uint256 offchainAssets, uint64 at);
    event MaxNavChangeUpdated(uint16 bps);

    error NotVerified(address account);
    error NavChangeTooLarge(uint256 previous, uint256 next);
    error ZeroAddress();

    struct Config {
        IERC20 asset;
        string name;
        string symbol;
        address admin;
        address registry;
        uint16 maxNavChangeBps;
        address oracle;
        uint256 depositCap;
        address rules;
    }

    constructor(Config memory c) ERC20(c.name, c.symbol) ERC4626(c.asset) {
        address admin = c.admin;
        uint16 maxNavChangeBps_ = c.maxNavChangeBps;
        if (admin == address(0) || c.registry == address(0)) revert ZeroAddress();
        registry = InvestorRegistry(c.registry);
        oracle = IAssetOracleView(c.oracle);
        depositCap = c.depositCap;
        rules = OfferingRules(c.rules);
        maxNavChangeBps = maxNavChangeBps_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ------------------------------------------------------------ fund ops

    /// @notice Move idle capital to an off-chain use (e.g. property purchase escrow). Increases offchainAssets
    ///         by the same amount so NAV is unchanged.
    function deployCapital(address to, uint256 assets, string calldata memo) external onlyRole(MANAGER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        offchainAssets += assets;
        IERC20(asset()).safeTransfer(to, assets);
        emit CapitalDeployed(to, assets, memo);
    }

    /// @notice Return capital from an off-chain use back into the vault. Decreases offchainAssets.
    function returnCapital(uint256 assets, string calldata memo) external onlyRole(MANAGER_ROLE) {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
        offchainAssets = assets > offchainAssets ? 0 : offchainAssets - assets;
        emit CapitalReturned(msg.sender, assets, memo);
    }

    function reportNav(uint256 newOffchainAssets) external onlyRole(NAV_REPORTER_ROLE) {
        uint256 prev = offchainAssets;
        if (maxNavChangeBps != 0) {
            uint256 base = totalAssets();
            uint256 diff = newOffchainAssets > prev ? newOffchainAssets - prev : prev - newOffchainAssets;
            if (base != 0 && diff * 10_000 > base * maxNavChangeBps) revert NavChangeTooLarge(prev, newOffchainAssets);
        }
        offchainAssets = newOffchainAssets;
        navUpdatedAt = uint64(block.timestamp);
        emit NavReported(newOffchainAssets, navUpdatedAt);
    }

    function setMaxNavChangeBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxNavChangeBps = bps;
        emit MaxNavChangeUpdated(bps);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------ ERC-4626

    function totalAssets() public view override returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + offchainAssets;
    }

    /// @dev Redemptions are limited to on-chain liquidity.
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 owned = super.maxWithdraw(owner);
        uint256 liquid = IERC20(asset()).balanceOf(address(this));
        return owned < liquid ? owned : liquid;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 byLiquidity = _convertToShares(IERC20(asset()).balanceOf(address(this)), Math.Rounding.Floor);
        uint256 owned = balanceOf(owner);
        return owned < byLiquidity ? owned : byLiquidity;
    }

    /// @notice True when no oracle is set, or the oracle currently verifies this vault's asset.
    function assetVerified() public view returns (bool) {
        return address(oracle) == address(0) || oracle.isVerified(address(this));
    }

    /// @notice Deposits accepted until the cap (asset units); type(uint256).max when uncapped.
    function capRemaining() public view returns (uint256) {
        if (depositCap == 0) return type(uint256).max;
        uint256 t = totalAssets();
        return t >= depositCap ? 0 : depositCap - t;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused() || !_canHold(receiver) || !assetVerified()) return 0;
        uint256 m = super.maxDeposit(receiver);
        uint256 left = capRemaining();
        return m < left ? m : left;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        if (paused() || !_canHold(receiver) || !assetVerified()) return 0;
        uint256 left = capRemaining();
        if (left == type(uint256).max) return super.maxMint(receiver);
        return _convertToShares(left, Math.Rounding.Floor);
    }

    /// @dev Every share holder must be verified; share transfers are paused with the vault.
    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && !registry.isVerified(to)) revert NotVerified(to);
        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
            if (!registry.isVerified(from)) revert NotVerified(from);
        }
        if (address(rules) != address(0)) {
            rules.onTransfer(
                from, to, value, from == address(0) ? 0 : balanceOf(from), to == address(0) ? 0 : balanceOf(to), false
            );
        }
        super._update(from, to, value);
    }

    function _canHold(address account) internal view returns (bool) {
        return registry.isVerified(account) && (address(rules) == address(0) || rules.canHold(account));
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6; // inflation-attack hardening for low-decimal stablecoins
    }
}
