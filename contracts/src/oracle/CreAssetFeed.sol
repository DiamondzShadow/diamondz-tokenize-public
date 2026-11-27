// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReceiverTemplate} from "./cre/ReceiverTemplate.sol";
import {AssetOracle} from "./AssetOracle.sol";

/// @title CreAssetFeed
/// @notice Chainlink CRE consumer for per-asset-class data feeds. A CRE workflow (DON consensus over market and
///         registry sources) delivers batched reports through Chainlink's KeystoneForwarder. Two item types:
///         - MARK: a live market value for a listing (e.g. index-adjusted property value, WTI price, NAV per share),
///           stored here as a feed anyone can read.
///         - ATTEST: a proof-of-asset check signed into the AssetOracle. This contract is itself a platform-approved
///           verifier there, so the oracle limits which kinds of check it may sign (e.g. REGISTRY, ROYALTY_INCOME, NAV).
/// @dev ReceiverTemplate (official Chainlink source) checks the forwarder and, once configured by the owner
///      (platform multisig), the workflow ID / owner. The owner also sets the freshness window for marks.
contract CreAssetFeed is ReceiverTemplate {
    uint8 public constant ITEM_MARK = 1;
    uint8 public constant ITEM_ATTEST = 2;

    struct Item {
        uint8 itemType;
        bytes body;
    }

    struct Mark {
        int256 value;
        uint8 decimals;
        uint64 observedAt; // DON time of the observation (unix seconds)
        bytes32 sourceHash; // hash of the source observations the DON agreed on
    }

    AssetOracle public immutable oracle;
    /// @notice Reports observed longer ago than this are rejected (seconds).
    uint64 public maxReportAge = 1 days;

    /// @dev token => metric => latest mark
    mapping(address => mapping(bytes32 => Mark)) private _marks;

    event MarkUpdated(
        address indexed token, bytes32 indexed metric, int256 value, uint8 decimals, uint64 observedAt, bytes32 sourceHash
    );
    event MarkSkipped(address indexed token, bytes32 indexed metric, uint64 observedAt, uint64 latestObservedAt);
    event MaxReportAgeSet(uint64 seconds_);

    error UnknownItem(uint8 itemType);
    error FutureObservation(uint64 observedAt, uint256 nowTs);
    error StaleObservation(uint64 observedAt, uint64 maxAge);
    error ZeroToken();

    constructor(address forwarder, AssetOracle oracle_) ReceiverTemplate(forwarder) {
        oracle = oracle_;
    }

    function setMaxReportAge(uint64 seconds_) external onlyOwner {
        maxReportAge = seconds_;
        emit MaxReportAgeSet(seconds_);
    }

    /// @notice Latest market value for (token, metric). observedAt == 0 means no value yet.
    function latestMark(address token, bytes32 metric) external view returns (Mark memory) {
        return _marks[token][metric];
    }

    function _processReport(bytes calldata report) internal override {
        Item[] memory items = abi.decode(report, (Item[]));
        for (uint256 i; i < items.length; ++i) {
            if (items[i].itemType == ITEM_MARK) _mark(items[i].body);
            else if (items[i].itemType == ITEM_ATTEST) oracle.attest(abi.decode(items[i].body, (AssetOracle.AttestInput)));
            else revert UnknownItem(items[i].itemType);
        }
    }

    function _mark(bytes memory body) internal {
        (address token, bytes32 metric, int256 value, uint8 decimals, uint64 observedAt, bytes32 sourceHash) =
            abi.decode(body, (address, bytes32, int256, uint8, uint64, bytes32));
        if (token == address(0)) revert ZeroToken();
        if (observedAt > block.timestamp) revert FutureObservation(observedAt, block.timestamp);
        if (block.timestamp - observedAt > maxReportAge) revert StaleObservation(observedAt, maxReportAge);
        Mark storage m = _marks[token][metric];
        // Out-of-order or replayed delivery: keep the newer value, don't revert the whole batch.
        if (observedAt <= m.observedAt) {
            emit MarkSkipped(token, metric, observedAt, m.observedAt);
            return;
        }
        _marks[token][metric] = Mark(value, decimals, observedAt, sourceHash);
        emit MarkUpdated(token, metric, value, decimals, observedAt, sourceHash);
    }
}
