// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AssetOracle} from "../src/oracle/AssetOracle.sol";
import {CreAssetFeed} from "../src/oracle/CreAssetFeed.sol";
import {StellarAssetAnchor} from "../src/stellar/StellarAssetAnchor.sol";

contract StellarAssetAnchorTest is Test {
    bytes32 constant REAL_ESTATE = keccak256("real-estate");
    bytes32 constant TITLE = keccak256("TITLE");
    bytes32 constant REGISTRY = keccak256("REGISTRY");
    bytes32 constant SUPPLY = keccak256("STELLAR_TOTAL_SUPPLY");
    string constant DZTP = "CCSF5LSCKB3CVYCKF5ZJGNC67DCNCZJVGMJDAN3QDR373NPTMCXASPNG";

    address platform = makeAddr("platform");
    address forwarder = makeAddr("forwarder");
    address issuer = makeAddr("issuer");

    AssetOracle oracle;
    CreAssetFeed feed;
    StellarAssetAnchor anchor;

    function setUp() public {
        vm.warp(1_800_000_000);
        oracle = new AssetOracle(platform);
        vm.prank(platform);
        feed = new CreAssetFeed(forwarder, oracle);
        bytes32[] memory min = new bytes32[](1);
        min[0] = TITLE;
        vm.startPrank(platform);
        oracle.setMaxValidity(TITLE, 365 days);
        oracle.setMaxValidity(REGISTRY, 120 days);
        oracle.setClassRequirements(REAL_ESTATE, min);
        oracle.setVerifier(address(feed), true, "Chainlink CRE");
        oracle.setVerifierKind(address(feed), REGISTRY, true);
        vm.stopPrank();
        anchor = new StellarAssetAnchor("testnet", DZTP, issuer);
    }

    function _kinds() internal pure returns (bytes32[] memory k) {
        k = new bytes32[](2);
        k[0] = TITLE;
        k[1] = REGISTRY;
    }

    function _send(CreAssetFeed.Item[] memory items) internal {
        vm.prank(forwarder);
        feed.onReport(abi.encodePacked(keccak256("wf"), bytes10("assetfeeds"), address(this), bytes2(0)), abi.encode(items));
    }

    function test_storesStellarIdentity() public view {
        assertEq(anchor.network(), "testnet");
        assertEq(anchor.stellarContract(), DZTP);
        assertEq(anchor.owner(), issuer);
    }

    function test_rejectsBadIds() public {
        vm.expectRevert(StellarAssetAnchor.BadNetwork.selector);
        new StellarAssetAnchor("futurenet", DZTP, issuer);
        vm.expectRevert(StellarAssetAnchor.BadContractId.selector);
        new StellarAssetAnchor("testnet", "GCSF5LSCKB3CVYCKF5ZJGNC67DCNCZJVGMJDAN3QDR373NPTMCXASPNG", issuer); // account, not contract
        vm.expectRevert(StellarAssetAnchor.BadContractId.selector);
        new StellarAssetAnchor("testnet", "CCSF5LSCKB3CVYCKF5ZJGNC67DCNCZJVGMJDAN3QDR373NPTMCXASPN", issuer); // 55 chars
        vm.expectRevert(StellarAssetAnchor.BadContractId.selector);
        new StellarAssetAnchor("testnet", "CCSF5LSCKB3CVYCKF5ZJGNC67DCNCZJVGMJDAN3QDR373NPTMCXASPN1", issuer); // '1' not base32
    }

    function test_onlyIssuerCanRegister() public {
        bytes32[] memory k = _kinds();
        vm.expectRevert();
        oracle.register(address(anchor), REAL_ESTATE, k);
        vm.prank(issuer);
        oracle.register(address(anchor), REAL_ESTATE, k);
    }

    function test_creMarksAndAttestsStellarSupply() public {
        bytes32[] memory k = _kinds();
        vm.prank(issuer);
        oracle.register(address(anchor), REAL_ESTATE, k);

        CreAssetFeed.Item[] memory items = new CreAssetFeed.Item[](2);
        items[0] = CreAssetFeed.Item(1, abi.encode(address(anchor), SUPPLY, int256(1_000_000_000), uint8(7), uint64(block.timestamp - 30), keccak256("src")));
        items[1] = CreAssetFeed.Item(
            2,
            abi.encode(
                AssetOracle.AttestInput(
                    address(anchor), REGISTRY, AssetOracle.Result.Pass, uint64(block.timestamp + 1 days), 1_000_000_000,
                    keccak256("supply=1000000000 cap=10000000000000"), string.concat("stellar:testnet:", DZTP, ":total_supply")
                )
            )
        );
        _send(items);
        assertEq(feed.latestMark(address(anchor), SUPPLY).value, 1_000_000_000);
        assertEq(uint8(oracle.latest(address(anchor), REGISTRY).result), uint8(AssetOracle.Result.Pass));
    }

    function test_unregisteredAnchorRevertsBatch() public {
        CreAssetFeed.Item[] memory items = new CreAssetFeed.Item[](1);
        items[0] = CreAssetFeed.Item(
            2,
            abi.encode(AssetOracle.AttestInput(address(anchor), REGISTRY, AssetOracle.Result.Pass, uint64(block.timestamp + 1 days), 1, keccak256("x"), "stellar:x"))
        );
        vm.prank(forwarder);
        vm.expectRevert();
        feed.onReport(abi.encodePacked(keccak256("wf"), bytes10("assetfeeds"), address(this), bytes2(0)), abi.encode(items));
    }
}
