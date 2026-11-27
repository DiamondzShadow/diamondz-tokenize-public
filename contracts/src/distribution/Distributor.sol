// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {TokenAdmin} from "../utils/TokenAdmin.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title Distributor
/// @notice Pays income (rent, royalties, interest) to token holders. One platform-run contract per network.
///         For each payout the platform snapshots holder balances at a block and builds a Merkle tree of
///         (index, account, amount); the offering's admin (its treasury multisig on mainnet) funds it in an approved
///         stablecoin. Anyone may submit a claim, but funds always go to the holder, so the platform can claim for
///         holders gas-free and deliver unclaimed payouts automatically.
/// @dev Fees: a FLAT fee per payout, set per payout stablecoin by the platform (DEFAULT_ADMIN_ROLE), paid on top
///      of the payout and never taken from holders. The funder passes `maxFee`, so a fee change can never surprise
///      a payout already being signed. Unclaimed funds return to the funder after `claimDeadline`.
contract Distributor is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Distribution {
        address token; // the asset token whose holders are paid
        IERC20 payout; // stablecoin paid out
        bytes32 merkleRoot;
        uint256 total; // sum of leaf amounts (excludes the fee)
        uint256 claimed;
        uint64 snapshotBlock;
        uint64 claimDeadline;
        address funder;
        string memo;
    }

    struct PayoutToken {
        bool enabled;
        uint256 flatFee; // in the payout token's base units
    }

    address public feeRecipient;
    mapping(address => PayoutToken) public payoutTokens;

    Distribution[] private _distributions;
    mapping(uint256 => mapping(uint256 => uint256)) private _claimedBitmap; // id => word => bits

    event DistributionCreated(
        uint256 indexed id,
        address indexed token,
        address indexed payout,
        bytes32 merkleRoot,
        uint256 total,
        uint256 fee,
        uint64 snapshotBlock,
        uint64 claimDeadline,
        string memo
    );
    event Claimed(uint256 indexed id, uint256 index, address indexed account, uint256 amount);
    event Swept(uint256 indexed id, address to, uint256 amount);
    event FeeRecipientSet(address recipient);
    event PayoutTokenSet(address indexed payout, bool enabled, uint256 flatFee);

    error AlreadyClaimed();
    error InvalidProof();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error ZeroAddress();
    error BadDeadline();
    error ZeroTotal();
    error PayoutTokenNotEnabled(address payout);
    error FeeAboveMax(uint256 fee, uint256 maxFee);
    error NotTokenAdmin(address caller);
    error UnknownDistribution(uint256 id);

    constructor(address admin, address feeRecipient_) {
        if (admin == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        feeRecipient = feeRecipient_;
        emit FeeRecipientSet(feeRecipient_);
    }

    // ------------------------------------------------------------------ platform admin

    function setFeeRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    /// @notice Accept a stablecoin for payouts and set the flat fee charged per payout in it.
    function setPayoutToken(address payout, bool enabled, uint256 flatFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (payout == address(0)) revert ZeroAddress();
        payoutTokens[payout] = PayoutToken(enabled, flatFee);
        emit PayoutTokenSet(payout, enabled, flatFee);
    }

    // ------------------------------------------------------------------ issuer

    /// @notice Fund a payout to `token`'s holders. Caller must be the token's admin (DEFAULT_ADMIN_ROLE, or owner() for
    ///         ERC-3643 tokens) and pays `total` + the flat fee
    ///         in `payout`. `maxFee` protects the caller from a fee change between quoting and sending.
    function createDistribution(
        address token,
        IERC20 payout,
        bytes32 merkleRoot,
        uint256 total,
        uint64 snapshotBlock,
        uint64 claimDeadline,
        string calldata memo,
        uint256 maxFee
    ) external nonReentrant returns (uint256 id) {
        if (token == address(0)) revert ZeroAddress();
        if (!TokenAdmin.isAdmin(token, msg.sender)) revert NotTokenAdmin(msg.sender);
        PayoutToken memory pt = payoutTokens[address(payout)];
        if (!pt.enabled) revert PayoutTokenNotEnabled(address(payout));
        if (pt.flatFee > maxFee) revert FeeAboveMax(pt.flatFee, maxFee);
        if (total == 0) revert ZeroTotal();
        if (claimDeadline <= block.timestamp) revert BadDeadline();

        payout.safeTransferFrom(msg.sender, address(this), total);
        if (pt.flatFee != 0) payout.safeTransferFrom(msg.sender, feeRecipient, pt.flatFee);

        id = _distributions.length;
        _distributions.push(
            Distribution(token, payout, merkleRoot, total, 0, snapshotBlock, claimDeadline, msg.sender, memo)
        );
        emit DistributionCreated(
            id, token, address(payout), merkleRoot, total, pt.flatFee, snapshotBlock, claimDeadline, memo
        );
    }

    // ------------------------------------------------------------------ holders (anyone may relay)

    /// @notice Claim for `account`. Anyone may submit it; the funds always go to `account`.
    function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
    {
        if (id >= _distributions.length) revert UnknownDistribution(id);
        Distribution storage d = _distributions[id];
        if (block.timestamp > d.claimDeadline) revert DeadlinePassed();
        if (isClaimed(id, index)) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, d.merkleRoot, leaf)) revert InvalidProof();

        _claimedBitmap[id][index >> 8] |= (1 << (index & 0xff));
        d.claimed += amount;
        d.payout.safeTransfer(account, amount);
        emit Claimed(id, index, account, amount);
    }

    /// @notice After the deadline, return unclaimed funds to the funder. Anyone may trigger it.
    function sweep(uint256 id) external nonReentrant {
        if (id >= _distributions.length) revert UnknownDistribution(id);
        Distribution storage d = _distributions[id];
        if (block.timestamp <= d.claimDeadline) revert DeadlineNotPassed();
        uint256 left = d.total - d.claimed;
        d.claimed = d.total;
        if (left != 0) d.payout.safeTransfer(d.funder, left);
        emit Swept(id, d.funder, left);
    }

    // ------------------------------------------------------------------ views

    function isClaimed(uint256 id, uint256 index) public view returns (bool) {
        return (_claimedBitmap[id][index >> 8] >> (index & 0xff)) & 1 == 1;
    }

    function distribution(uint256 id) external view returns (Distribution memory) {
        return _distributions[id];
    }

    function distributionCount() external view returns (uint256) {
        return _distributions.length;
    }
}
