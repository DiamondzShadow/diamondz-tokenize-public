// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {InvestorRegistry} from "../src/compliance/InvestorRegistry.sol";
import {PermissionedToken} from "../src/tokens/PermissionedToken.sol";
import {PrimarySale} from "../src/sale/PrimarySale.sol";
import {TestUSD} from "../src/test-helpers/TestUSD.sol";

contract PrimarySaleTest is Test {
    address admin = makeAddr("issuer");
    address treasury = makeAddr("treasury");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");
    address eve = makeAddr("eve");

    InvestorRegistry registry;
    PermissionedToken token;
    PrimarySale sale;
    TestUSD usd;

    function setUp() public {
        registry = new InvestorRegistry(admin, admin, address(0));
        token = new PermissionedToken(
            PermissionedToken.Config("Oak Ridge", "OAKR", 18, 1_000_000e18, admin, address(registry), "", address(0))
        );
        usd = new TestUSD();
        sale = new PrimarySale(
            PrimarySale.Config({
                token: address(token),
                payToken: address(usd),
                treasury: treasury,
                admin: admin,
                price: 1_500_000, // $1.50 per token
                cap: 100_000e18,
                minPurchase: 500e6,
                startsAt: uint64(block.timestamp),
                endsAt: 0,
                feeRecipient: platform,
                feeBps: 150,
                oracle: address(0)
            })
        );
        bytes32 minter = token.MINTER_ROLE();
        vm.startPrank(admin);
        token.grantRole(minter, address(sale));
        registry.setInvestor(alice, true, 840, 0);
        vm.stopPrank();
        usd.mint(alice, 100_000e6);
        usd.mint(eve, 100_000e6);
    }

    function test_buySplitsProceedsAndMints() public {
        vm.startPrank(alice);
        usd.approve(address(sale), type(uint256).max);
        uint256 cost = sale.buy(1_000e18);
        vm.stopPrank();
        assertEq(cost, 1_500e6);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(usd.balanceOf(platform), 22_500_000); // 1.5% of 1500
        assertEq(usd.balanceOf(treasury), 1_500e6 - 22_500_000);
        assertEq(usd.balanceOf(address(sale)), 0);
        assertEq(sale.sold(), 1_000e18);
    }

    function test_unverifiedCannotBuy() public {
        vm.startPrank(eve);
        usd.approve(address(sale), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale.NotVerified.selector, eve));
        sale.buy(1_000e18);
        vm.stopPrank();
    }

    function test_minimumAndCap() public {
        vm.startPrank(alice);
        usd.approve(address(sale), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale.BelowMinimum.selector, 150e6, 500e6));
        sale.buy(100e18);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale.SoldOut.selector, 100_001e18, 100_000e18));
        sale.buy(100_001e18);
        vm.stopPrank();
    }

    function test_quoteRoundsUp() public view {
        assertEq(sale.quote(1), 1); // 1 wei of token still costs 1 unit
    }

    function test_windowAndPause() public {
        vm.prank(admin);
        sale.setWindow(uint64(block.timestamp + 1 days), 0);
        assertFalse(sale.isOpen());
        vm.startPrank(alice);
        usd.approve(address(sale), type(uint256).max);
        vm.expectRevert(PrimarySale.NotOpen.selector);
        sale.buy(1_000e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        vm.prank(admin);
        sale.pause();
        vm.prank(alice);
        vm.expectRevert(PrimarySale.NotOpen.selector);
        sale.buy(1_000e18);
    }

    function test_saleWithoutMinterRoleReverts() public {
        bytes32 minter = token.MINTER_ROLE();
        vm.prank(admin);
        token.revokeRole(minter, address(sale));
        vm.startPrank(alice);
        usd.approve(address(sale), type(uint256).max);
        vm.expectRevert(); // AccessControlUnauthorizedAccount from token.mint
        sale.buy(1_000e18);
        vm.stopPrank();
    }

    function test_feeCeiling() public {
        PrimarySale.Config memory c = PrimarySale.Config(address(token), address(usd), treasury, admin, 1, 1, 0, 0, 0, platform, 1_001, address(0));
        vm.expectRevert(PrimarySale.FeeTooHigh.selector);
        new PrimarySale(c);
    }

    function test_testUsdMintCap() public {
        vm.expectRevert(TestUSD.MintTooLarge.selector);
        usd.mint(alice, 100_001e6);
    }
}
