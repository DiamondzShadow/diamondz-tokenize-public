// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {InvestorRegistry} from "../src/compliance/InvestorRegistry.sol";
import {PermissionedToken} from "../src/tokens/PermissionedToken.sol";
import {AssetOracle} from "../src/oracle/AssetOracle.sol";
import {CreAssetFeed} from "../src/oracle/CreAssetFeed.sol";
import {ReceiverTemplate} from "../src/oracle/cre/ReceiverTemplate.sol";
import {IReceiver} from "../src/oracle/cre/IReceiver.sol";

contract CreAssetFeedTest is Test {
    bytes32 constant CARBON = keccak256("carbon");
    bytes32 constant REGISTRY = keccak256("REGISTRY");
    bytes32 constant MARKET_VALUE = keccak256("MARKET_VALUE");
    bytes32 constant WID = keccak256("workflow-1");

    address platform = makeAddr("platform");
    address forwarder = makeAddr("forwarder");
    address issuer = makeAddr("issuer");
    address workflowOwner = makeAddr("workflowOwner");

    AssetOracle oracle;
    CreAssetFeed feed;
    PermissionedToken token;

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new AssetOracle(platform);
        vm.prank(platform);
        feed = new CreAssetFeed(forwarder, oracle);
        InvestorRegistry registry = new InvestorRegistry(issuer, issuer, address(0));
        token = new PermissionedToken(PermissionedToken.Config("Mangrove Credits", "MGRV", 18, 1e24, issuer, address(registry), "", address(0)));
        bytes32[] memory k = new bytes32[](1);
        k[0] = REGISTRY;
        vm.startPrank(platform);
        oracle.setMaxValidity(REGISTRY, 120 days);
        oracle.setClassRequirements(CARBON, k);
        oracle.setVerifier(address(feed), true, "Chainlink CRE: carbon registry feed");
        oracle.setVerifierKind(address(feed), REGISTRY, true);
        vm.stopPrank();
        vm.prank(issuer);
        oracle.register(address(token), CARBON, k);
    }

    function _meta(bytes32 wid, address owner_) internal pure returns (bytes memory) {
        // Production KeystoneForwarder passes 64 bytes: workflowId, bytes10 name, owner, bytes2 reportId.
        return abi.encodePacked(wid, bytes10("assetfeeds"), owner_, bytes2(0));
    }

    function _markItem(bytes32 metric, int256 value, uint64 observedAt) internal view returns (CreAssetFeed.Item memory) {
        return CreAssetFeed.Item(1, abi.encode(address(token), metric, value, uint8(2), observedAt, keccak256("src")));
    }

    function _attestItem(AssetOracle.Result r) internal view returns (CreAssetFeed.Item memory) {
        return CreAssetFeed.Item(
            2,
            abi.encode(
                AssetOracle.AttestInput(
                    address(token), REGISTRY, r, uint64(block.timestamp + 30 days), 50_000, keccak256("registry json"), "https://registry.goldstandard.org/credit-blocks/details/123"
                )
            )
        );
    }

    function _send(CreAssetFeed.Item[] memory items) internal {
        vm.prank(forwarder);
        feed.onReport(_meta(WID, workflowOwner), abi.encode(items));
    }

    function _one(CreAssetFeed.Item memory a) internal pure returns (CreAssetFeed.Item[] memory items) {
        items = new CreAssetFeed.Item[](1);
        items[0] = a;
    }

    function test_marksStoredAndReadable() public {
        _send(_one(_markItem(MARKET_VALUE, 245_000_000_00, uint64(block.timestamp - 60))));
        CreAssetFeed.Mark memory m = feed.latestMark(address(token), MARKET_VALUE);
        assertEq(m.value, 245_000_000_00);
        assertEq(m.decimals, 2);
        assertEq(m.observedAt, block.timestamp - 60);
    }

    function test_onlyForwarder() public {
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), forwarder));
        feed.onReport(_meta(WID, workflowOwner), abi.encode(_one(_markItem(MARKET_VALUE, 1, uint64(block.timestamp)))));
    }

    function test_workflowIdentityEnforcedOnceConfigured() public {
        vm.startPrank(platform);
        feed.setExpectedWorkflowId(WID);
        feed.setExpectedAuthor(workflowOwner);
        vm.stopPrank();
        bytes memory report = abi.encode(_one(_markItem(MARKET_VALUE, 1, uint64(block.timestamp))));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidWorkflowId.selector, keccak256("other"), WID));
        feed.onReport(_meta(keccak256("other"), workflowOwner), report);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidAuthor.selector, issuer, workflowOwner));
        feed.onReport(_meta(WID, issuer), report);
        _send(_one(_markItem(MARKET_VALUE, 1, uint64(block.timestamp))));
    }

    function test_rejectsFutureAndStale() public {
        CreAssetFeed.Item[] memory f = _one(_markItem(MARKET_VALUE, 1, uint64(block.timestamp + 1)));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CreAssetFeed.FutureObservation.selector, block.timestamp + 1, block.timestamp));
        feed.onReport(_meta(WID, workflowOwner), abi.encode(f));
        CreAssetFeed.Item[] memory s = _one(_markItem(MARKET_VALUE, 1, uint64(block.timestamp - 2 days)));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CreAssetFeed.StaleObservation.selector, block.timestamp - 2 days, 1 days));
        feed.onReport(_meta(WID, workflowOwner), abi.encode(s));
    }

    function test_olderDeliveryDoesNotOverwrite() public {
        _send(_one(_markItem(MARKET_VALUE, 200, uint64(block.timestamp - 10))));
        _send(_one(_markItem(MARKET_VALUE, 100, uint64(block.timestamp - 20)))); // late, older observation
        assertEq(feed.latestMark(address(token), MARKET_VALUE).value, 200);
    }

    function test_onlyOwnerConfigures() public {
        vm.expectRevert();
        feed.setMaxReportAge(1);
        vm.prank(platform);
        feed.setMaxReportAge(2 hours);
        assertEq(feed.maxReportAge(), 2 hours);
    }

    function test_attestsIntoOracleAsApprovedVerifier() public {
        CreAssetFeed.Item[] memory items = new CreAssetFeed.Item[](2);
        items[0] = _markItem(keccak256("CREDITS_HELD"), 50_000, uint64(block.timestamp));
        items[1] = _attestItem(AssetOracle.Result.Pass);
        _send(items);
        assertTrue(oracle.isVerified(address(token)));
        AssetOracle.Attestation memory a = oracle.latest(address(token), REGISTRY);
        assertEq(a.verifier, address(feed));
        assertEq(a.value, 50_000);
    }

    function test_feedCannotSignKindsPlatformDidNotAllow() public {
        vm.prank(platform);
        oracle.setVerifierKind(address(feed), REGISTRY, false);
        CreAssetFeed.Item[] memory items = _one(_attestItem(AssetOracle.Result.Pass));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.NotAllowedVerifier.selector, address(feed), REGISTRY));
        feed.onReport(_meta(WID, workflowOwner), abi.encode(items));
    }

    function test_removingFeedAsVerifierVoidsItsChecks() public {
        _send(_one(_attestItem(AssetOracle.Result.Pass)));
        assertTrue(oracle.isVerified(address(token)));
        vm.prank(platform);
        oracle.setVerifier(address(feed), false, "Chainlink CRE: carbon registry feed");
        assertFalse(oracle.isVerified(address(token)));
    }

    function test_unknownItemRevertsWholeBatch() public {
        CreAssetFeed.Item[] memory items = new CreAssetFeed.Item[](2);
        items[0] = _markItem(MARKET_VALUE, 7, uint64(block.timestamp));
        items[1] = CreAssetFeed.Item(9, "");
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(CreAssetFeed.UnknownItem.selector, 9));
        feed.onReport(_meta(WID, workflowOwner), abi.encode(items));
        assertEq(feed.latestMark(address(token), MARKET_VALUE).observedAt, 0);
    }

    function test_supportsIReceiver() public view {
        assertTrue(feed.supportsInterface(type(IReceiver).interfaceId));
    }
}
