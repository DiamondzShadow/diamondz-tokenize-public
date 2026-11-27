// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PermissionedNFT} from "../tokens/PermissionedNFT.sol";
import {IAssetOracle} from "./PrimarySale.sol";

/// @title PrimarySale721
/// @notice Fixed-price primary offering of PermissionedNFT tokens. A verified investor pays a stablecoin per token and
///         the sale issues the next token ids to them. Proceeds go straight to the issuer's treasury; the sale never
///         holds funds. Same rules as PrimarySale: optional proof-of-asset gating via `oracle`.
/// @dev The token must grant MINTER_ROLE to this contract. At most MAX_PER_BUY tokens per purchase (gas).
contract PrimarySale721 is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 1_000;
    uint256 public constant MAX_PER_BUY = 50;

    PermissionedNFT public immutable token;
    IERC20 public immutable payToken;
    /// @notice Price in payToken base units for one token.
    uint256 public immutable price;
    /// @notice Max tokens this sale can issue.
    uint256 public immutable cap;
    /// @notice Minimum spend per purchase, in payToken base units.
    uint256 public immutable minPurchase;
    address public immutable feeRecipient;
    uint16 public immutable feeBps;
    IAssetOracle public immutable oracle;

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
    error TooMany(uint256 requested, uint256 max);
    error AssetNotVerified();
    error CapAboveMaxSupply(uint256 cap, uint256 maxSupply);

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
        PermissionedNFT t = PermissionedNFT(c.token);
        if (c.cap > t.maxSupply()) revert CapAboveMaxSupply(c.cap, t.maxSupply());
        token = t;
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
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
    }

    function quote(uint256 count) public view returns (uint256) {
        return count * price;
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

    /// @notice Buy `count` tokens (the next ids in order). Caller must have approved `quote(count)` of payToken. A
    ///         buyer that is a contract must accept ERC-721 (onERC721Received).
    function buy(uint256 count) external nonReentrant returns (uint256 cost) {
        if (count == 0) revert ZeroAmount();
        if (count > MAX_PER_BUY) revert TooMany(count, MAX_PER_BUY);
        if (!assetVerified()) revert AssetNotVerified();
        if (!isOpen()) revert NotOpen();
        if (count > remaining()) revert SoldOut(count, remaining());
        if (!token.canReceive(msg.sender)) revert NotVerified(msg.sender);
        cost = quote(count);
        if (cost < minPurchase) revert BelowMinimum(cost, minPurchase);

        sold += count;
        raised += cost;
        uint256 fee = (cost * feeBps) / 10_000;
        if (fee != 0) payToken.safeTransferFrom(msg.sender, feeRecipient, fee);
        payToken.safeTransferFrom(msg.sender, treasury, cost - fee);
        for (uint256 i; i < count; ++i) token.mint(msg.sender);
        emit Purchased(msg.sender, count, cost, fee);
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
