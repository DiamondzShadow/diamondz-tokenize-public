// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ITREXToken, ITREXIdentityRegistry} from "../interfaces/ITREX.sol";
import {IAssetOracle} from "./PrimarySale.sol";

/// @title PrimarySale3643
/// @notice Fixed-price primary offering of an ERC-3643 (T-REX) token. A buyer whose on-chain identity the token's
///         identity registry verifies (a current KYC claim from the issuer's claim issuer) pays a stablecoin and the
///         sale mints them tokens. The token's own compliance contract still runs on every mint. Proceeds go straight
///         to the issuer's treasury; the sale never holds funds. Same rules as PrimarySale: optional proof-of-asset
///         gating via `oracle`.
/// @dev The token's owner must make this contract a token agent (`addAgent`) so it can mint. Price is per whole
///      token (10**decimals base units), rounded up so the issuer is never short-changed.
contract PrimarySale3643 is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 1_000;

    ITREXToken public immutable token;
    IERC20 public immutable payToken;
    uint256 public immutable price;
    uint256 public immutable cap;
    uint256 public immutable minPurchase;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    IAssetOracle public immutable oracle;
    uint256 private immutable _unit;

    address public treasury;
    uint64 public startsAt;
    uint64 public endsAt; // 0 = no end
    uint256 public sold;
    uint256 public raised;

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
        token = ITREXToken(c.token);
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
        _unit = 10 ** ITREXToken(c.token).decimals();
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
    }

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

    function assetVerified() public view returns (bool) {
        return address(oracle) == address(0) || oracle.isVerified(address(token));
    }

    /// @notice True when the token's identity registry verifies `buyer` (same check the token runs on mint).
    function canBuy(address buyer) public view returns (bool) {
        return ITREXIdentityRegistry(token.identityRegistry()).isVerified(buyer);
    }

    /// @notice Buy `tokens` base units. Caller must have approved `quote(tokens)` of payToken.
    function buy(uint256 tokens) external nonReentrant returns (uint256 cost) {
        if (tokens == 0) revert ZeroAmount();
        if (!assetVerified()) revert AssetNotVerified();
        if (!isOpen()) revert NotOpen();
        if (tokens > remaining()) revert SoldOut(tokens, remaining());
        if (!canBuy(msg.sender)) revert NotVerified(msg.sender);
        cost = quote(tokens);
        if (cost < minPurchase) revert BelowMinimum(cost, minPurchase);

        sold += tokens;
        raised += cost;
        uint256 fee = (cost * feeBps) / 10_000;
        if (fee != 0) payToken.safeTransferFrom(msg.sender, feeRecipient, fee);
        payToken.safeTransferFrom(msg.sender, treasury, cost - fee);
        token.mint(msg.sender, tokens); // T-REX runs identity + compliance checks again
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
