// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {InvestorRegistry} from "../src/compliance/InvestorRegistry.sol";
import {PermissionedNFT} from "../src/tokens/PermissionedNFT.sol";
import {IERC7943NonFungible} from "../src/interfaces/IERC7943NonFungible.sol";
import {PrimarySale721} from "../src/sale/PrimarySale721.sol";
import {AssetOracle} from "../src/oracle/AssetOracle.sol";
import {TestUSD} from "../src/test-helpers/TestUSD.sol";

/// A verified contract wallet that, on receiving a token, tries to take another holder's frozen token.
contract Grabber is ERC721Holder {
    PermissionedNFT public t;
    address public victim;
    uint256 public victimId;
    bool public tried;
    bool public succeeded;

    constructor(PermissionedNFT t_, address victim_, uint256 victimId_) {
        t = t_;
        victim = victim_;
        victimId = victimId_;
    }

    function onERC721Received(address, address, uint256, bytes memory) public override returns (bytes4) {
        if (!tried) {
            tried = true;
            try t.transferFrom(victim, address(this), victimId) {
                succeeded = true;
            } catch {}
        }
        return this.onERC721Received.selector;
    }
}

/// Contract that can't receive ERC-721 (no onERC721Received).
contract NoReceiver {}

contract NFTTest is Test {
    address issuer = makeAddr("issuer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address eve = makeAddr("eve");

    InvestorRegistry registry;
    PermissionedNFT t;

    function setUp() public {
        registry = new InvestorRegistry(issuer, issuer, address(0));
        t = new PermissionedNFT(
            PermissionedNFT.Config("Harbor Lofts Deeds", "HLD", "https://x.example/api/meta/ast_1/", 3, issuer, address(registry), "ipfs://docs", address(0))
        );
        vm.startPrank(issuer);
        registry.setInvestor(alice, true, 840, 0);
        registry.setInvestor(bob, true, 840, 0);
        t.mint(alice); // id 1
        t.mint(alice); // id 2
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- spec + metadata

    function test_interfaceIds() public view {
        assertEq(type(IERC7943NonFungible).interfaceId, bytes4(0xbf1ef5fe));
        assertTrue(t.supportsInterface(0xbf1ef5fe));
        assertTrue(t.supportsInterface(type(IERC721).interfaceId));
        assertFalse(t.supportsInterface(0x3edbb4c4));
        assertFalse(t.supportsInterface(0x41c4fbad));
    }

    function test_metadataAndCounters() public view {
        assertEq(t.name(), "Harbor Lofts Deeds");
        assertEq(t.symbol(), "HLD");
        assertEq(t.tokenURI(2), "https://x.example/api/meta/ast_1/2");
        assertEq(t.maxSupply(), 3);
        assertEq(t.minted(), 2);
        assertEq(t.totalSupply(), 2);
    }

    // ---------------------------------------------------------------- mint + cap

    function test_sequentialIdsAndCap() public {
        vm.startPrank(issuer);
        assertEq(t.mint(bob), 3);
        vm.expectRevert(abi.encodeWithSelector(PermissionedNFT.MaxSupplyExceeded.selector, 4, 3));
        t.mint(bob);
        t.burn(3);
        // Burned ids are never reissued; the cap counts every token ever issued.
        vm.expectRevert(abi.encodeWithSelector(PermissionedNFT.MaxSupplyExceeded.selector, 4, 3));
        t.mint(bob);
        vm.stopPrank();
        assertEq(t.totalSupply(), 2);
        assertEq(t.minted(), 3);
    }

    function test_mintRules() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, eve));
        t.mint(eve);
        vm.prank(eve);
        vm.expectRevert();
        t.mint(eve);
        NoReceiver nr = new NoReceiver();
        vm.startPrank(issuer);
        registry.setInvestor(address(nr), true, 840, 0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(nr)));
        t.mint(address(nr));
        vm.stopPrank();
    }

    function test_zeroMaxSupplyRejected() public {
        vm.expectRevert(PermissionedNFT.ZeroAmount.selector);
        new PermissionedNFT(PermissionedNFT.Config("x", "x", "", 0, issuer, address(registry), "", address(0)));
    }

    // ---------------------------------------------------------------- transfers

    function test_transferBetweenVerified() public {
        assertTrue(t.canTransfer(alice, bob, 1));
        vm.prank(alice);
        t.safeTransferFrom(alice, bob, 1);
        assertEq(t.ownerOf(1), bob);
    }

    function test_transferRules() public {
        assertFalse(t.canTransfer(alice, eve, 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, eve));
        t.transferFrom(alice, eve, 1);
        vm.prank(issuer);
        registry.removeInvestor(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotSend.selector, alice));
        t.transferFrom(alice, bob, 1);
        // Not the owner: base ERC-721 error.
        vm.prank(bob);
        vm.expectRevert();
        t.transferFrom(alice, bob, 2);
    }

    function test_pauseBlocksTransfersNotMint() public {
        vm.prank(issuer);
        t.pause();
        assertFalse(t.canTransfer(alice, bob, 1));
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        t.transferFrom(alice, bob, 1);
        vm.prank(issuer);
        t.mint(bob);
    }

    // ---------------------------------------------------------------- freeze + force

    function test_freezeBlocksTransferAndBurn() public {
        vm.prank(issuer);
        vm.expectEmit(true, true, true, true);
        emit IERC7943NonFungible.Frozen(alice, 1, true);
        t.setFrozenTokens(alice, 1, true);
        assertTrue(t.getFrozenTokens(alice, 1));
        assertFalse(t.canTransfer(alice, bob, 1));
        assertTrue(t.canTransfer(alice, bob, 2));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943NonFungible.ERC7943InsufficientUnfrozenBalance.selector, alice, 1));
        t.transferFrom(alice, bob, 1);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(IERC7943NonFungible.ERC7943InsufficientUnfrozenBalance.selector, alice, 1));
        t.burn(1);
    }

    function test_freezeUnownedTokenAllowed() public {
        vm.prank(issuer);
        t.setFrozenTokens(bob, 1, true);
        assertTrue(t.getFrozenTokens(bob, 1));
        assertTrue(t.canTransfer(alice, bob, 1)); // freeze is per (account, token): alice's 1 is not frozen
    }

    function test_forcedTransferUnfreezesFirstAndEmitsInOrder() public {
        vm.prank(issuer);
        t.setFrozenTokens(alice, 1, true);
        vm.recordLogs();
        vm.prank(issuer);
        t.forcedTransfer(alice, bob, 1);
        assertEq(t.ownerOf(1), bob);
        assertFalse(t.getFrozenTokens(alice, 1));
        bytes32[3] memory want = [IERC7943NonFungible.Frozen.selector, IERC721.Transfer.selector, IERC7943NonFungible.ForcedTransfer.selector];
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        for (uint256 i; i < 3; ++i) assertEq(logs[i].topics[0], want[i]);
    }

    function test_forcedTransferRules() public {
        vm.startPrank(issuer);
        t.pause();
        t.forcedTransfer(alice, bob, 1); // works while paused
        vm.expectRevert(abi.encodeWithSelector(IERC7943NonFungible.ERC7943CannotReceive.selector, eve));
        t.forcedTransfer(alice, eve, 2);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, bob, 2, alice));
        t.forcedTransfer(bob, alice, 2);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 9));
        t.forcedTransfer(alice, bob, 9);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert();
        t.forcedTransfer(alice, bob, 2);
    }

    function test_forcedTransferReceiverCannotReenterWithChecksOff() public {
        vm.prank(issuer);
        t.setFrozenTokens(alice, 2, true);
        Grabber g = new Grabber(t, alice, 2);
        vm.startPrank(issuer);
        registry.setInvestor(address(g), true, 840, 0);
        t.forcedTransfer(alice, address(g), 1);
        vm.stopPrank();
        assertTrue(g.tried());
        assertFalse(g.succeeded());
        assertEq(t.ownerOf(2), alice);
    }
}

contract PrimarySale721Test is Test {
    address issuer = makeAddr("issuer");
    address treasury = makeAddr("treasury");
    address platform = makeAddr("platform");
    address alice = makeAddr("alice");
    address eve = makeAddr("eve");
    address titleCo = makeAddr("title");
    address appraiser = makeAddr("appraiser");
    address insurer = makeAddr("insurer");

    bytes32 constant REAL_ESTATE = keccak256("real-estate");
    bytes32 constant TITLE = keccak256("TITLE");
    bytes32 constant VALUATION = keccak256("VALUATION");
    bytes32 constant INSURANCE = keccak256("INSURANCE");

    InvestorRegistry registry;
    PermissionedNFT t;
    PrimarySale721 sale;
    AssetOracle oracle;
    TestUSD usd;

    function setUp() public {
        registry = new InvestorRegistry(issuer, issuer, address(0));
        t = new PermissionedNFT(PermissionedNFT.Config("Harbor Lofts Deeds", "HLD", "", 100, issuer, address(registry), "", address(0)));
        usd = new TestUSD();
        oracle = new AssetOracle(platform);
        bytes32[3] memory k = [TITLE, VALUATION, INSURANCE];
        address[3] memory v = [titleCo, appraiser, insurer];
        bytes32[] memory req = new bytes32[](3);
        vm.startPrank(platform);
        for (uint256 i; i < 3; ++i) {
            oracle.setMaxValidity(k[i], 365 days);
            oracle.setVerifier(v[i], true, "v");
            oracle.setVerifierKind(v[i], k[i], true);
            req[i] = k[i];
        }
        oracle.setClassRequirements(REAL_ESTATE, req);
        vm.stopPrank();
        vm.prank(issuer);
        oracle.register(address(t), REAL_ESTATE, req);
        sale = new PrimarySale721(
            PrimarySale721.Config({
                token: address(t),
                payToken: address(usd),
                treasury: treasury,
                admin: issuer,
                price: 2_000e6, // $2,000 per deed
                cap: 100,
                minPurchase: 2_000e6,
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
        usd.mint(alice, 100_000e6);
        usd.mint(eve, 100_000e6);
        vm.prank(alice);
        usd.approve(address(sale), type(uint256).max);
        vm.prank(eve);
        usd.approve(address(sale), type(uint256).max);
    }

    function _verifyAll() internal {
        bytes32[3] memory k = [TITLE, VALUATION, INSURANCE];
        address[3] memory v = [titleCo, appraiser, insurer];
        for (uint256 i; i < 3; ++i) {
            vm.prank(v[i]);
            oracle.attest(AssetOracle.AttestInput(address(t), k[i], AssetOracle.Result.Pass, uint64(block.timestamp + 30 days), 0, keccak256("doc"), "ipfs://doc"));
        }
    }

    function test_gatedUntilVerified() public {
        vm.prank(alice);
        vm.expectRevert(PrimarySale721.AssetNotVerified.selector);
        sale.buy(1);
        _verifyAll();
        assertTrue(sale.isOpen());
    }

    function test_buyIssuesNextIdsAndPaysTreasury() public {
        _verifyAll();
        vm.prank(alice);
        assertEq(sale.buy(3), 6_000e6);
        assertEq(t.ownerOf(1), alice);
        assertEq(t.ownerOf(3), alice);
        assertEq(t.balanceOf(alice), 3);
        assertEq(usd.balanceOf(treasury), 6_000e6);
        assertEq(usd.balanceOf(address(sale)), 0);
        assertEq(sale.sold(), 3);
    }

    function test_buyRules() public {
        _verifyAll();
        vm.prank(eve);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale721.NotVerified.selector, eve));
        sale.buy(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale721.TooMany.selector, 51, 50));
        sale.buy(51);
        vm.prank(alice);
        vm.expectRevert(PrimarySale721.ZeroAmount.selector);
        sale.buy(0);
    }

    function test_soldOut() public {
        _verifyAll();
        usd.mint(alice, 100_000e6);
        vm.startPrank(alice);
        sale.buy(50);
        sale.buy(48);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale721.SoldOut.selector, 3, 2));
        sale.buy(3);
        sale.buy(2);
        vm.stopPrank();
        assertFalse(sale.isOpen());
        assertEq(t.minted(), 100);
    }

    function test_capCannotExceedMaxSupply() public {
        PrimarySale721.Config memory c = PrimarySale721.Config({
            token: address(t), payToken: address(usd), treasury: treasury, admin: issuer, price: 1, cap: 101,
            minPurchase: 0, startsAt: 0, endsAt: 0, feeRecipient: address(0), feeBps: 0, oracle: address(0)
        });
        vm.expectRevert(abi.encodeWithSelector(PrimarySale721.CapAboveMaxSupply.selector, 101, 100));
        new PrimarySale721(c);
    }

    function test_expiredCheckStopsSales() public {
        _verifyAll();
        vm.warp(block.timestamp + 31 days);
        vm.prank(alice);
        vm.expectRevert(PrimarySale721.AssetNotVerified.selector);
        sale.buy(1);
    }
}
