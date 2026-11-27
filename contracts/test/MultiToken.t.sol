// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {InvestorRegistry} from "../src/compliance/InvestorRegistry.sol";
import {PermissionedMultiToken} from "../src/tokens/PermissionedMultiToken.sol";
import {IERC7943MultiToken} from "../src/interfaces/IERC7943MultiToken.sol";
import {PrimarySale1155} from "../src/sale/PrimarySale1155.sol";
import {AssetOracle} from "../src/oracle/AssetOracle.sol";
import {TestUSD} from "../src/test-helpers/TestUSD.sol";

/// A verified contract wallet that, on receiving units, tries to move units it doesn't own (re-entrancy probe).
contract Reenterer is ERC1155Holder {
    PermissionedMultiToken public t;
    address public victim;
    bool public tried;
    bool public succeeded;

    constructor(PermissionedMultiToken t_, address victim_) {
        t = t_;
        victim = victim_;
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes memory) public override returns (bytes4) {
        if (!tried) {
            tried = true;
            // Tries to pull the victim's frozen units while a forced transfer is in flight.
            try t.safeTransferFrom(victim, address(this), id, 1, "") {
                succeeded = true;
            } catch {}
        }
        return this.onERC1155Received.selector;
    }
}

contract MultiTokenTest is Test {
    address issuer = makeAddr("issuer");
    address treasury = makeAddr("treasury");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address eve = makeAddr("eve");

    uint256 constant CASK = 1;
    uint256 constant VINTAGE_2024 = 2024;

    InvestorRegistry registry;
    PermissionedMultiToken t;
    TestUSD usd;

    function setUp() public {
        registry = new InvestorRegistry(issuer, issuer, address(0));
        t = new PermissionedMultiToken(
            PermissionedMultiToken.Config("Speyside Cask 1998", "CASK98", "ipfs://meta/{id}.json", issuer, address(registry), "ipfs://docs", address(0))
        );
        usd = new TestUSD();
        vm.startPrank(issuer);
        t.createItem(CASK, 1_000, "");
        t.createItem(VINTAGE_2024, 50_000, "ipfs://vintage-2024.json");
        registry.setInvestor(alice, true, 840, 0);
        registry.setInvestor(bob, true, 840, 0);
        t.mint(alice, CASK, 100);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- spec

    function test_interfaceIds() public view {
        assertEq(type(IERC7943MultiToken).interfaceId, bytes4(0x41c4fbad));
        assertTrue(t.supportsInterface(0x41c4fbad));
        assertTrue(t.supportsInterface(type(IERC1155).interfaceId));
        assertFalse(t.supportsInterface(0x3edbb4c4)); // not the fungible variant
    }

    function test_metadata() public view {
        assertEq(t.name(), "Speyside Cask 1998");
        assertEq(t.symbol(), "CASK98");
        assertEq(t.uri(CASK), "ipfs://meta/{id}.json");
        assertEq(t.uri(VINTAGE_2024), "ipfs://vintage-2024.json");
        assertEq(t.maxSupply(CASK), 1_000);
    }

    // ---------------------------------------------------------------- items + caps

    function test_capIsFixedAndEnforced() public {
        vm.startPrank(issuer);
        vm.expectRevert(abi.encodeWithSelector(PermissionedMultiToken.ItemExists.selector, CASK));
        t.createItem(CASK, 10_000, "");
        vm.expectRevert(abi.encodeWithSelector(PermissionedMultiToken.MaxSupplyExceeded.selector, CASK, 1_001, 1_000));
        t.mint(alice, CASK, 901);
        t.mint(alice, CASK, 900);
        vm.expectRevert(abi.encodeWithSelector(PermissionedMultiToken.UnknownItem.selector, 7));
        t.mint(alice, 7, 1);
        vm.expectRevert(PermissionedMultiToken.ZeroAmount.selector);
        t.createItem(8, 0, "");
        vm.stopPrank();
        assertEq(t.totalSupply(CASK), 1_000);
    }

    function test_onlyAdminCreatesOnlyMinterMints() public {
        vm.prank(eve);
        vm.expectRevert();
        t.createItem(9, 1, "");
        vm.prank(eve);
        vm.expectRevert();
        t.mint(eve, CASK, 1);
    }

    function test_mintToUnverifiedReverts() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943CannotReceive.selector, eve));
        t.mint(eve, CASK, 1);
    }

    // ---------------------------------------------------------------- transfers

    function test_transferBetweenVerified() public {
        vm.prank(alice);
        t.safeTransferFrom(alice, bob, CASK, 40, "");
        assertEq(t.balanceOf(bob, CASK), 40);
        assertTrue(t.canTransfer(alice, bob, CASK, 60));
        assertFalse(t.canTransfer(alice, eve, CASK, 1));
    }

    function test_transferToUnverifiedReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943CannotReceive.selector, eve));
        t.safeTransferFrom(alice, eve, CASK, 1, "");
    }

    function test_revokedSenderCannotSend() public {
        vm.prank(issuer);
        registry.removeInvestor(alice);
        assertFalse(t.canSend(alice));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943CannotSend.selector, alice));
        t.safeTransferFrom(alice, bob, CASK, 1, "");
    }

    function test_batchTransferChecksEveryId() public {
        vm.startPrank(issuer);
        t.mint(alice, VINTAGE_2024, 10);
        t.setFrozenTokens(alice, VINTAGE_2024, 10);
        vm.stopPrank();
        uint256[] memory ids = new uint256[](2);
        uint256[] memory vals = new uint256[](2);
        ids[0] = CASK;
        ids[1] = VINTAGE_2024;
        vals[0] = 1;
        vals[1] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943InsufficientUnfrozenBalance.selector, alice, VINTAGE_2024, 1, 0));
        t.safeBatchTransferFrom(alice, bob, ids, vals, "");
    }

    function test_pauseBlocksTransfersNotMint() public {
        vm.prank(issuer);
        t.pause();
        assertFalse(t.canTransfer(alice, bob, CASK, 1));
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        t.safeTransferFrom(alice, bob, CASK, 1, "");
        vm.prank(issuer);
        t.mint(bob, CASK, 1);
    }

    // ---------------------------------------------------------------- freeze + force

    function test_freezeLimitsTransfers() public {
        vm.prank(issuer);
        vm.expectEmit(true, true, false, true);
        emit IERC7943MultiToken.Frozen(alice, CASK, 70);
        t.setFrozenTokens(alice, CASK, 70);
        assertEq(t.getFrozenTokens(alice, CASK), 70);
        assertTrue(t.canTransfer(alice, bob, CASK, 30));
        assertFalse(t.canTransfer(alice, bob, CASK, 31));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943InsufficientUnfrozenBalance.selector, alice, CASK, 31, 30));
        t.safeTransferFrom(alice, bob, CASK, 31, "");
        // Over the full balance: the base standard's error, not ERC-7943's.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, alice, 100, 101, CASK));
        t.safeTransferFrom(alice, bob, CASK, 101, "");
    }

    function test_freezeMoreThanBalanceAllowed() public {
        vm.prank(issuer);
        t.setFrozenTokens(alice, CASK, 5_000);
        assertFalse(t.canTransfer(alice, bob, CASK, 1));
    }

    function test_forcedTransferEatsFrozenAndEmitsInOrder() public {
        vm.prank(issuer);
        t.setFrozenTokens(alice, CASK, 100);
        vm.recordLogs();
        vm.prank(issuer);
        t.forcedTransfer(alice, bob, CASK, 60);
        assertEq(t.balanceOf(bob, CASK), 60);
        assertEq(t.getFrozenTokens(alice, CASK), 40);
        // Frozen must come before TransferSingle, then ForcedTransfer.
        bytes32[3] memory want = [
            IERC7943MultiToken.Frozen.selector,
            IERC1155.TransferSingle.selector,
            IERC7943MultiToken.ForcedTransfer.selector
        ];
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        for (uint256 i; i < 3; ++i) assertEq(logs[i].topics[0], want[i]);
    }

    function test_forcedTransferWorksWhilePausedButNotToUnverified() public {
        vm.startPrank(issuer);
        t.pause();
        t.forcedTransfer(alice, bob, CASK, 10);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943CannotReceive.selector, eve));
        t.forcedTransfer(alice, eve, CASK, 10);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, alice, 90, 91, CASK));
        t.forcedTransfer(alice, bob, CASK, 91);
        vm.stopPrank();
        assertEq(t.balanceOf(bob, CASK), 10);
    }

    function test_onlyEnforcerForces() public {
        vm.prank(alice);
        vm.expectRevert();
        t.forcedTransfer(alice, bob, CASK, 1);
        vm.prank(alice);
        vm.expectRevert();
        t.setFrozenTokens(bob, CASK, 1);
    }

    function test_forcedTransferReceiverCannotReenterWithChecksOff() public {
        Reenterer r = new Reenterer(t, bob);
        vm.startPrank(issuer);
        registry.setInvestor(address(r), true, 840, 0);
        t.mint(bob, CASK, 10);
        t.setFrozenTokens(bob, CASK, 10);
        t.forcedTransfer(alice, address(r), CASK, 1);
        vm.stopPrank();
        assertTrue(r.tried());
        assertFalse(r.succeeded());
        assertEq(t.balanceOf(bob, CASK), 10);
    }

    // ---------------------------------------------------------------- burn + retire

    function test_redeemCannotBurnFrozen() public {
        vm.startPrank(issuer);
        t.setFrozenTokens(alice, CASK, 90);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943InsufficientUnfrozenBalance.selector, alice, CASK, 11, 10));
        t.burn(alice, CASK, 11);
        t.burn(alice, CASK, 10);
        vm.stopPrank();
        assertEq(t.totalSupply(CASK), 90);
    }

    function test_retireBurnsAndRecords() public {
        vm.prank(issuer);
        t.mint(alice, VINTAGE_2024, 500);
        vm.expectEmit(true, true, false, true);
        emit PermissionedMultiToken.Retired(alice, VINTAGE_2024, 200, "Acme Corp 2025 Scope 1", "Annual offset");
        vm.prank(alice);
        t.retire(VINTAGE_2024, 200, "Acme Corp 2025 Scope 1", "Annual offset");
        assertEq(t.balanceOf(alice, VINTAGE_2024), 300);
        assertEq(t.retired(VINTAGE_2024), 200);
        assertEq(t.totalSupply(VINTAGE_2024), 300);
        // Retired units are gone for good: the cap still counts only live supply, but retiring never re-mints.
    }

    function test_retireRules() public {
        vm.prank(issuer);
        t.setFrozenTokens(alice, CASK, 100);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943InsufficientUnfrozenBalance.selector, alice, CASK, 1, 0));
        t.retire(CASK, 1, "", "");
        vm.prank(alice);
        vm.expectRevert(PermissionedMultiToken.ZeroAmount.selector);
        t.retire(CASK, 0, "", "");
        vm.prank(issuer);
        t.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        t.retire(CASK, 1, "", "");
        vm.prank(issuer);
        t.unpause();
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(IERC7943MultiToken.ERC7943CannotSend.selector, eve));
        t.retire(CASK, 1, "", "");
    }
}

contract PrimarySale1155Test is Test {
    address issuer = makeAddr("issuer");
    address treasury = makeAddr("treasury");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");
    address eve = makeAddr("eve");
    address titleCo = makeAddr("custodian");
    address appraiser = makeAddr("authenticator");
    address insurer = makeAddr("insurer");

    bytes32 constant COLLECTIBLES = keccak256("collectibles");
    bytes32 constant CUSTODY = keccak256("CUSTODY");
    bytes32 constant AUTHENTICITY = keccak256("AUTHENTICITY");
    bytes32 constant INSURANCE = keccak256("INSURANCE");
    uint256 constant CASK = 1;

    InvestorRegistry registry;
    PermissionedMultiToken t;
    PrimarySale1155 sale;
    AssetOracle oracle;
    TestUSD usd;

    function setUp() public {
        registry = new InvestorRegistry(issuer, issuer, address(0));
        t = new PermissionedMultiToken(
            PermissionedMultiToken.Config("Speyside Cask 1998", "CASK98", "", issuer, address(registry), "", address(0))
        );
        usd = new TestUSD();
        oracle = new AssetOracle(platform);
        vm.startPrank(platform);
        bytes32[3] memory k = [CUSTODY, AUTHENTICITY, INSURANCE];
        address[3] memory v = [titleCo, appraiser, insurer];
        bytes32[] memory req = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            oracle.setMaxValidity(k[i], 365 days);
            oracle.setVerifier(v[i], true, "v");
            oracle.setVerifierKind(v[i], k[i], true);
            req[i] = k[i];
        }
        oracle.setClassRequirements(COLLECTIBLES, req);
        vm.stopPrank();

        vm.startPrank(issuer);
        t.createItem(CASK, 1_000, "");
        oracle.register(address(t), COLLECTIBLES, req);
        vm.stopPrank();
        sale = new PrimarySale1155(
            PrimarySale1155.Config({
                token: address(t),
                tokenId: CASK,
                payToken: address(usd),
                treasury: treasury,
                admin: issuer,
                price: 250e6, // $250 per fraction
                cap: 800,
                minPurchase: 500e6,
                startsAt: uint64(block.timestamp),
                endsAt: 0,
                feeRecipient: address(0),
                feeBps: 0,
                oracle: address(oracle)
            })
        );
        bytes32 minter = t.MINTER_ROLE();
        vm.startPrank(issuer);
        t.grantRole(minter, address(sale));
        registry.setInvestor(alice, true, 840, 0);
        vm.stopPrank();
        usd.mint(alice, 100_000e6);
        usd.mint(eve, 100_000e6);
        vm.prank(alice);
        usd.approve(address(sale), type(uint256).max);
        vm.prank(eve);
        usd.approve(address(sale), type(uint256).max);
    }

    function _verifyAll() internal {
        bytes32[3] memory k = [CUSTODY, AUTHENTICITY, INSURANCE];
        address[3] memory v = [titleCo, appraiser, insurer];
        for (uint256 i; i < 3; ++i) {
            vm.prank(v[i]);
            oracle.attest(AssetOracle.AttestInput(address(t), k[i], AssetOracle.Result.Pass, uint64(block.timestamp + 30 days), 0, keccak256("doc"), "ipfs://doc"));
        }
    }

    function test_gatedUntilVerified() public {
        assertFalse(sale.isOpen());
        vm.prank(alice);
        vm.expectRevert(PrimarySale1155.AssetNotVerified.selector);
        sale.buy(2);
        _verifyAll();
        assertTrue(sale.isOpen());
    }

    function test_buyPaysTreasuryAndMintsUnits() public {
        _verifyAll();
        vm.prank(alice);
        uint256 cost = sale.buy(4);
        assertEq(cost, 1_000e6);
        assertEq(usd.balanceOf(treasury), 1_000e6);
        assertEq(usd.balanceOf(address(sale)), 0);
        assertEq(t.balanceOf(alice, CASK), 4);
        assertEq(sale.sold(), 4);
        assertEq(sale.raised(), 1_000e6);
    }

    function test_buyRules() public {
        _verifyAll();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale1155.BelowMinimum.selector, 250e6, 500e6));
        sale.buy(1);
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale1155.NotVerified.selector, eve));
        sale.buy(2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale1155.SoldOut.selector, 801, 800));
        sale.buy(801);
        vm.prank(alice);
        vm.expectRevert(PrimarySale1155.ZeroAmount.selector);
        sale.buy(0);
    }

    function test_expiredCheckStopsSales() public {
        _verifyAll();
        vm.warp(block.timestamp + 31 days);
        assertFalse(sale.isOpen());
        vm.prank(alice);
        vm.expectRevert(PrimarySale1155.AssetNotVerified.selector);
        sale.buy(2);
    }

    function test_constructorRejectsBadItemOrCap() public {
        PrimarySale1155.Config memory c = PrimarySale1155.Config({
            token: address(t), tokenId: 99, payToken: address(usd), treasury: treasury, admin: issuer, price: 1, cap: 1,
            minPurchase: 0, startsAt: 0, endsAt: 0, feeRecipient: address(0), feeBps: 0, oracle: address(0)
        });
        vm.expectRevert(abi.encodeWithSelector(PrimarySale1155.UnknownItem.selector, 99));
        new PrimarySale1155(c);
        c.tokenId = CASK;
        c.cap = 1_001;
        vm.expectRevert(abi.encodeWithSelector(PrimarySale1155.CapAboveItemSupply.selector, 1_001, 1_000));
        new PrimarySale1155(c);
    }

    function test_pausedSaleRefuses() public {
        _verifyAll();
        vm.prank(issuer);
        sale.pause();
        vm.prank(alice);
        vm.expectRevert(PrimarySale1155.NotOpen.selector);
        sale.buy(2);
    }
}
