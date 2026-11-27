// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvestorRegistry} from "../src/compliance/InvestorRegistry.sol";
import {OfferingRules} from "../src/compliance/OfferingRules.sol";
import {PermissionedToken} from "../src/tokens/PermissionedToken.sol";
import {PermissionedNFT} from "../src/tokens/PermissionedNFT.sol";
import {PermissionedMultiToken} from "../src/tokens/PermissionedMultiToken.sol";
import {PermissionedVault} from "../src/vaults/PermissionedVault.sol";
import {TestUSD} from "../src/test-helpers/TestUSD.sol";

contract OfferingRulesTest is Test {
    InvestorRegistry registry;
    address issuer = makeAddr("issuer");
    address alice = makeAddr("alice"); // accredited, US
    address bob = makeAddr("bob"); // accredited, US
    address erin = makeAddr("erin"); // accredited, US
    address carol = makeAddr("carol"); // verified, NOT accredited, US
    address dave = makeAddr("dave"); // accredited, UK

    uint64 constant YEAR = 365 days;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new InvestorRegistry(issuer, issuer, address(0));
        vm.startPrank(issuer);
        registry.setInvestor(alice, true, 840, 0);
        registry.setInvestor(bob, true, 840, 0);
        registry.setInvestor(erin, true, 840, 0);
        registry.setInvestor(carol, false, 840, 0);
        registry.setInvestor(dave, true, 826, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _cfg() internal view returns (OfferingRules.Config memory c) {
        c.admin = issuer;
    }

    function _erc20(OfferingRules.Config memory c) internal returns (PermissionedToken t, OfferingRules r) {
        r = new OfferingRules(c);
        t = new PermissionedToken(
            PermissionedToken.Config("Harbor Lofts", "HARB", 18, 0, issuer, address(registry), "", address(r))
        );
        vm.prank(issuer);
        r.bindToken(address(t));
    }

    function _err(OfferingRules.Code c) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(OfferingRules.RuleViolation.selector, c);
    }

    function _mint(PermissionedToken t, address to, uint256 a) internal {
        vm.prank(issuer);
        t.mint(to, a);
    }

    // ---------------------------------------------------------------- setup guards

    function test_bindOnceAndOnlyTokenCallsHook() public {
        (PermissionedToken t, OfferingRules r) = _erc20(_cfg());
        vm.prank(issuer);
        vm.expectRevert(OfferingRules.AlreadyBound.selector);
        r.bindToken(address(t));
        vm.expectRevert(OfferingRules.OnlyToken.selector);
        r.onTransfer(address(0), alice, 1, 0, 0, false);
    }

    function test_noRulesBehavesAsBefore() public {
        PermissionedToken t = new PermissionedToken(
            PermissionedToken.Config("T", "T", 18, 0, issuer, address(registry), "", address(0))
        );
        _mint(t, carol, 10);
        vm.prank(carol);
        t.transfer(alice, 10);
        assertEq(t.balanceOf(alice), 10);
    }

    // ---------------------------------------------------------------- who may hold

    function test_accreditedOnly() public {
        OfferingRules.Config memory c = _cfg();
        c.accreditedOnly = true;
        (PermissionedToken t,) = _erc20(c);
        assertFalse(t.canReceive(carol));
        assertTrue(t.canReceive(alice));
        vm.prank(issuer);
        vm.expectRevert(); // mint path: canReceive fails first
        t.mint(carol, 1);
        _mint(t, alice, 10);
        assertFalse(t.canTransfer(alice, carol, 1));
        vm.prank(alice);
        vm.expectRevert();
        t.transfer(carol, 1);
    }

    function test_countryAllowAndBlock() public {
        uint16[] memory us = new uint16[](1);
        us[0] = 840;
        OfferingRules.Config memory c = _cfg();
        c.countryMode = OfferingRules.CountryMode.Allow;
        c.countries = us;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        assertTrue(t.canReceive(alice));
        assertFalse(t.canReceive(dave));

        // Reg S style: everyone except the US
        vm.prank(issuer);
        r.setCountries(OfferingRules.CountryMode.Block, us);
        assertFalse(t.canReceive(alice));
        assertTrue(t.canReceive(dave));
        assertFalse(r.countryListed(0));
        assertEq(r.countries().length, 1);
    }

    function test_rulesArePerOffering() public {
        // Same registry, two offerings with different rules: a 506(c) one and an open one.
        OfferingRules.Config memory c = _cfg();
        c.accreditedOnly = true;
        (PermissionedToken strict,) = _erc20(c);
        (PermissionedToken open,) = _erc20(_cfg());
        assertFalse(strict.canReceive(carol));
        assertTrue(open.canReceive(carol));
    }

    // ---------------------------------------------------------------- holding period

    function test_lockupPerIssuanceLot() public {
        OfferingRules.Config memory c = _cfg();
        c.lockup = YEAR;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        _mint(t, alice, 100);
        assertFalse(t.canTransfer(alice, bob, 1));
        vm.prank(alice);
        vm.expectRevert(_err(OfferingRules.Code.Locked));
        t.transfer(bob, 1);

        vm.warp(block.timestamp + 200 days);
        _mint(t, alice, 50); // second purchase, its own clock
        assertEq(r.lockedOf(alice, 150), 150);

        vm.warp(block.timestamp + 165 days); // first lot unlocks
        assertEq(r.lockedOf(alice, 150), 50);
        vm.prank(alice);
        vm.expectRevert(_err(OfferingRules.Code.Locked));
        t.transfer(bob, 101);
        vm.prank(alice);
        t.transfer(bob, 100);
        assertEq(r.unlocksAt(alice), uint64(block.timestamp + 200 days));

        // Secondary buyer is not re-locked (holding period carries over).
        vm.prank(bob);
        t.transfer(erin, 100);
        assertEq(t.balanceOf(erin), 100);
    }

    function test_lockupShortenWaitsLengthenIsImmediate() public {
        OfferingRules.Config memory c = _cfg();
        c.lockup = YEAR;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        _mint(t, alice, 100);

        vm.prank(issuer);
        r.scheduleLockup(30 days);
        assertEq(r.lockup(), YEAR);
        vm.expectRevert(abi.encodeWithSelector(OfferingRules.NotYet.selector, uint64(block.timestamp + 7 days)));
        r.applyLockup();
        vm.warp(block.timestamp + 7 days);
        r.applyLockup(); // anyone
        assertEq(r.lockup(), 30 days);

        vm.warp(block.timestamp + 23 days);
        vm.prank(alice);
        t.transfer(bob, 100);

        vm.prank(issuer);
        r.scheduleLockup(2 * YEAR);
        assertEq(r.lockup(), 2 * YEAR);
        vm.expectRevert(OfferingRules.NothingPending.selector);
        r.applyLockup();

        vm.prank(alice);
        vm.expectRevert();
        r.scheduleLockup(0);
    }

    function test_privilegedMovesSkipLockupAndTrimLots() public {
        OfferingRules.Config memory c = _cfg();
        c.lockup = YEAR;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        _mint(t, alice, 100);
        vm.startPrank(issuer);
        t.forcedTransfer(alice, bob, 60); // court order, during the lockup
        t.burn(alice, 10); // issuer redemption, during the lockup
        vm.stopPrank();
        assertEq(t.balanceOf(alice), 30);
        assertEq(r.lockedOf(alice, 30), 30);
        // Lots were trimmed to the remaining balance: receiving unlocked tokens later stays transferable.
        vm.warp(block.timestamp + YEAR);
        _mint(t, alice, 5);
        assertEq(r.lockedOf(alice, 35), 5);
    }

    function test_forcedMoveKeepsLockedLotWhenOlderLotExpired() public {
        OfferingRules.Config memory c = _cfg();
        c.lockup = YEAR;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        _mint(t, alice, 100);
        vm.warp(block.timestamp + YEAR);
        _mint(t, alice, 50); // locked; the first 100 are free
        vm.prank(issuer);
        t.forcedTransfer(alice, bob, 100); // 50 left: still the locked lot
        assertEq(r.lockedOf(alice, 50), 50);
        vm.prank(alice);
        vm.expectRevert(_err(OfferingRules.Code.Locked));
        t.transfer(bob, 1);
    }

    function test_manyLotsMergeAndNeverReleaseEarly() public {
        OfferingRules.Config memory c = _cfg();
        c.lockup = YEAR;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        for (uint256 i; i < 70; ++i) {
            _mint(t, alice, 1);
            vm.warp(block.timestamp + 1 hours);
        }
        assertEq(r.lockedOf(alice, 70), 70);
        vm.warp(block.timestamp + YEAR - 2 hours);
        // The merged newest lot carries the latest date: those units are still locked.
        assertGe(r.lockedOf(alice, 70), 7);
    }

    // ---------------------------------------------------------------- limits

    function test_maxHolders() public {
        OfferingRules.Config memory c = _cfg();
        c.maxHolders = 2;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        _mint(t, alice, 10);
        _mint(t, bob, 10);
        assertEq(r.holderCount(), 2);
        vm.prank(issuer);
        vm.expectRevert(_err(OfferingRules.Code.MaxHolders));
        t.mint(erin, 1);
        // Existing holders trade freely; adding to an existing holder is fine.
        vm.prank(alice);
        t.transfer(bob, 5);
        // A holder selling out to a new holder keeps the count level.
        vm.prank(alice);
        t.transfer(erin, 5);
        assertEq(r.holderCount(), 2);
        vm.prank(bob);
        vm.expectRevert(_err(OfferingRules.Code.MaxHolders));
        t.transfer(alice, 1);
    }

    /// A holder sending their whole balance to themselves must not drop out of the count (that would let more
    /// investors in than the cap allows).
    function test_selfTransferKeepsHolderCount() public {
        OfferingRules.Config memory c = _cfg();
        c.maxHolders = 2;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        _mint(t, alice, 10);
        _mint(t, bob, 10);
        vm.prank(alice);
        t.transfer(alice, 10);
        assertEq(r.holderCount(), 2);
        vm.prank(issuer);
        vm.expectRevert(_err(OfferingRules.Code.MaxHolders));
        t.mint(erin, 1);
    }

    function test_maxBalance() public {
        OfferingRules.Config memory c = _cfg();
        c.maxBalance = 100;
        (PermissionedToken t,) = _erc20(c);
        _mint(t, alice, 100);
        vm.prank(issuer);
        vm.expectRevert(_err(OfferingRules.Code.MaxBalance));
        t.mint(alice, 1);
        _mint(t, bob, 50);
        vm.prank(bob);
        vm.expectRevert(_err(OfferingRules.Code.MaxBalance));
        t.transfer(alice, 1);
    }

    function test_resaleApproval() public {
        OfferingRules.Config memory c = _cfg();
        c.resaleApproval = true;
        (PermissionedToken t, OfferingRules r) = _erc20(c);
        _mint(t, alice, 100); // issuance needs no approval
        vm.prank(alice);
        vm.expectRevert(_err(OfferingRules.Code.NeedsApproval));
        t.transfer(bob, 40);
        vm.prank(issuer);
        r.approveTransfer(alice, bob, 40);
        assertTrue(t.canTransfer(alice, bob, 40));
        vm.prank(alice);
        t.transfer(bob, 40);
        assertEq(r.approvedAmount(keccak256(abi.encode(alice, bob))), 0);
        vm.prank(alice);
        vm.expectRevert(_err(OfferingRules.Code.NeedsApproval));
        t.transfer(bob, 1);
    }

    function test_maturity() public {
        OfferingRules.Config memory c = _cfg();
        c.maturity = uint64(block.timestamp + 30 days);
        (PermissionedToken t,) = _erc20(c);
        _mint(t, alice, 100);
        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        vm.expectRevert(_err(OfferingRules.Code.Matured));
        t.transfer(bob, 1);
        vm.prank(issuer);
        vm.expectRevert(_err(OfferingRules.Code.Matured));
        t.mint(bob, 1);
        vm.prank(issuer);
        t.burn(alice, 100); // repaid and burned at maturity
        assertEq(t.totalSupply(), 0);
    }

    // ---------------------------------------------------------------- other token types

    function test_nftLockupAndHolders() public {
        OfferingRules.Config memory c = _cfg();
        c.lockup = YEAR;
        c.maxHolders = 1;
        OfferingRules r = new OfferingRules(c);
        PermissionedNFT t = new PermissionedNFT(
            PermissionedNFT.Config("Deeds", "HLD", "", 10, issuer, address(registry), "", address(r))
        );
        vm.startPrank(issuer);
        r.bindToken(address(t));
        uint256 id = t.mint(alice);
        vm.expectRevert(_err(OfferingRules.Code.MaxHolders));
        t.mint(bob);
        vm.stopPrank();
        assertFalse(t.canTransfer(alice, bob, id));
        vm.prank(alice);
        vm.expectRevert(_err(OfferingRules.Code.Locked));
        t.transferFrom(alice, bob, id);
        vm.warp(block.timestamp + YEAR);
        vm.prank(alice);
        t.transferFrom(alice, bob, id); // alice leaves, bob joins: count stays 1
        assertEq(r.holderCount(), 1);
    }

    function test_multiTokenRetireRespectsLockBurns() public {
        OfferingRules.Config memory c = _cfg();
        c.lockup = YEAR;
        c.lockBurns = true;
        OfferingRules r = new OfferingRules(c);
        PermissionedMultiToken t = new PermissionedMultiToken(
            PermissionedMultiToken.Config("Credits", "CRB", "", issuer, address(registry), "", address(r))
        );
        vm.startPrank(issuer);
        r.bindToken(address(t));
        t.createItem(1, 1_000, "");
        t.mint(alice, 1, 100);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(_err(OfferingRules.Code.Locked));
        t.retire(1, 10, "Beneficiary", "offset");
        vm.prank(issuer);
        r.setLockBurns(false);
        vm.prank(alice);
        t.retire(1, 10, "Beneficiary", "offset");
        assertEq(t.balanceOf(alice, 1), 90);
    }

    function test_vaultAccreditedAndRedemptionLock() public {
        TestUSD usd = new TestUSD();
        OfferingRules.Config memory c = _cfg();
        c.accreditedOnly = true;
        c.lockup = 90 days;
        c.lockBurns = true;
        OfferingRules r = new OfferingRules(c);
        PermissionedVault v = new PermissionedVault(
            PermissionedVault.Config(
                IERC20(address(usd)), "Fund", "FND", issuer, address(registry), 0, address(0), 0, address(r)
            )
        );
        vm.prank(issuer);
        r.bindToken(address(v));
        assertEq(v.maxDeposit(carol), 0);
        usd.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usd.approve(address(v), type(uint256).max);
        v.deposit(1_000e6, alice);
        uint256 shares = v.balanceOf(alice);
        vm.expectRevert(_err(OfferingRules.Code.Locked));
        v.redeem(shares, alice, alice);
        vm.warp(block.timestamp + 90 days);
        v.redeem(shares, alice, alice);
        vm.stopPrank();
        assertEq(usd.balanceOf(alice), 1_000e6);
    }
}
