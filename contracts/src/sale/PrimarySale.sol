// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PermissionedToken} from "../tokens/PermissionedToken.sol";

interface IAssetOracle {
    function isVerified(address token) external view returns (bool);
}

/// @title PrimarySale
/// @notice Fixed-price primary offering. A verified investor pays a stablecoin and the sale mints them tokens.
///         Proceeds go straight to the issuer's treasury (minus the platform fee); the sale never holds funds.
/// @dev The token must grant MINTER_ROLE to this contract. Buyers must pass the token's own canReceive check,
///      so the investor registry is the single source of truth for who may buy.
///      With `oracle` set, the sale only sells while the AssetOracle says the asset is verified (proof of asset):
///      an expired or failed verification stops new purchases until it is current again.
contract PrimarySale is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 1_000;

    PermissionedToken public immutable token;
    IERC20 public immutable payToken;
    /// @notice Price in payToken base units for one whole token (10**token.decimals() base units).
    uint256 public immutable price;
    /// @notice Max token base units this sale can mint.
    uint256 public immutable cap;
    /// @notice Minimum spend per purchase, in payToken base units.
    uint256 public immutable minPurchase;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    /// @notice Proof-of-asset oracle gating purchases; address(0) = no gating.
    IAssetOracle public immutable oracle;
    uint256 private immutable _unit;

    address public treasury;
    uint64 public startsAt;
    uint64 public endsAt; // 0 = no end
    uint256 public sold;
    uint256 public raised; // gross, in payToken units

    event Purchased(address indexed buyer, uint256 tokens, uint256 cost, uint256 fee);
    event WindowUpdated(uint64 startsAt, uint64 endsAt);
    event TreasuryUpdated(address treasury);

    error ZeroAddress();
    error FeeTooHigh();
    error NotOpen();
    error SoldOut(uint256 requested, uint256 remaining);
    error BelowMinimum(uint256 cost, uint256 minimum);
    error NotVerified(address buyer);
    error ZeroAmount();
    error AssetNotVerified();

    struct Config {
        address token;
        address payToken;
        address treasury;
        address admin;
        uint256 price;
        uint256 cap;
        uint256 minPurchase;
        uint64 startsAt;
        uint64 endsAt;
        address feeRecipient;
        uint16 feeBps;
        address oracle;
    }

    constructor(Config memory c) {
        if (c.token == address(0) || c.payToken == address(0) || c.treasury == address(0) || c.admin == address(0)) {
            revert ZeroAddress();
        }
        if (c.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (c.feeBps != 0 && c.feeRecipient == address(0)) revert ZeroAddress();
        token = PermissionedToken(c.token);
        payToken = IERC20(c.payToken);
        treasury = c.treasury;
        price = c.price;
        cap = c.cap;
        minPurchase = c.minPurchase;
        startsAt = c.startsAt;
        endsAt = c.endsAt;
        feeRecipient = c.feeRecipient;
        feeBps = c.feeBps;
        oracle = IAssetOracle(c.oracle);
        _unit = 10 ** PermissionedToken(c.token).decimals();
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
    }

    /// @notice Cost in payToken units for `tokens` base units, rounded up so the issuer is never short-changed.
    function quote(uint256 tokens) public view returns (uint256) {
        return (tokens * price + _unit - 1) / _unit;
    }

    function remaining() public view returns (uint256) {
        return cap - sold;
    }

    function isOpen() public view returns (bool) {
        return !paused() && block.timestamp >= startsAt && (endsAt == 0 || block.timestamp <= endsAt) && sold < cap
            && assetVerified();
    }

    /// @notice True when no oracle is set, or the oracle currently verifies the asset.
    function assetVerified() public view returns (bool) {
        return address(oracle) == address(0) || oracle.isVerified(address(token));
    }

    /// @notice Buy `tokens` base units. Caller must have approved `quote(tokens)` of payToken.
    function buy(uint256 tokens) external nonReentrant returns (uint256 cost) {
        if (tokens == 0) revert ZeroAmount();
        if (!assetVerified()) revert AssetNotVerified();
        if (!isOpen()) revert NotOpen();
        if (tokens > remaining()) revert SoldOut(tokens, remaining());
        if (!token.canReceive(msg.sender)) revert NotVerified(msg.sender);
        cost = quote(tokens);
        if (cost < minPurchase) revert BelowMinimum(cost, minPurchase);

        sold += tokens;
        raised += cost;
        uint256 fee = (cost * feeBps) / 10_000;
        if (fee != 0) payToken.safeTransferFrom(msg.sender, feeRecipient, fee);
        payToken.safeTransferFrom(msg.sender, treasury, cost - fee);
        token.mint(msg.sender, tokens);
        emit Purchased(msg.sender, tokens, cost, fee);
    }

    function setWindow(uint64 startsAt_, uint64 endsAt_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        startsAt = startsAt_;
        endsAt = endsAt_;
        emit WindowUpdated(startsAt_, endsAt_);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
