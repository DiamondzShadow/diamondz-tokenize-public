// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {InvestorRegistry} from "../src/compliance/InvestorRegistry.sol";
import {PermissionedToken} from "../src/tokens/PermissionedToken.sol";
import {PermissionedVault} from "../src/vaults/PermissionedVault.sol";
import {Distributor} from "../src/distribution/Distributor.sol";
import {TokenizeFactory} from "../src/factory/TokenizeFactory.sol";
import {IERC7943Fungible} from "../src/interfaces/IERC7943.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

contract TokenizeTest is Test {
    address admin = makeAddr("issuerSafe");
    address verifier = makeAddr("kycKeeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address eve = makeAddr("eve"); // never verified
    address platform = makeAddr("platformFees");

    TokenizeFactory factory;
    InvestorRegistry registry;
    PermissionedToken token;
    MockUSDC usdc;

    bytes32 constant TENANT = keccak256("diamondz");
    bytes32 constant ASSET = keccak256("oak-ridge");

    function setUp() public {
        factory = new TokenizeFactory();
        registry = InvestorRegistry(factory.deployRegistry(TENANT, admin, verifier, address(0)));
        token = PermissionedToken(
            factory.deployToken(
                TENANT,
                ASSET,
                PermissionedToken.Config({
                    name: "Oak Ridge Duplex SPV",
                    symbol: "OAKR",
                    decimals: 18,
                    maxSupply: 1_200_000e18,
                    admin: admin,
                    registry: address(registry),
                    documentURI: "ipfs://offering",
                    rules: address(0)
                })
            )
        );
        usdc = new MockUSDC();
        vm.startPrank(verifier);
        registry.setInvestor(alice, true, 840, 0);
        registry.setInvestor(bob, false, 840, uint64(block.timestamp + 365 days));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ ERC-7943 token

    function test_interfaceIdMatchesSpec() public view {
        assertEq(type(IERC7943Fungible).interfaceId, bytes4(0x3edbb4c4));
        assertTrue(token.supportsInterface(0x3edbb4c4));
    }

    function test_factoryKeepsNoRights() public view {
        assertTrue(token.hasRole(token.DEFAULT_ADMIN_ROLE(), admin));
        assertFalse(token.hasRole(token.DEFAULT_ADMIN_ROLE(), address(factory)));
        assertFalse(token.hasRole(token.MINTER_ROLE(), address(factory)));
        assertFalse(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(factory)));
    }

    function test_mintOnlyToVerified() public {
        vm.startPrank(admin);
        token.mint(alice, 100e18);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, eve));
        token.mint(eve, 1);
        vm.stopPrank();
    }

    function test_maxSupply() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(PermissionedToken.MaxSupplyExceeded.selector, 1_200_001e18, 1_200_000e18)
        );
        token.mint(alice, 1_200_001e18);
    }

    function test_transferBetweenVerified() public {
        vm.prank(admin);
        token.mint(alice, 100e18);
        assertTrue(token.canTransfer(alice, bob, 40e18));
        vm.prank(alice);
        token.transfer(bob, 40e18);
        assertEq(token.balanceOf(bob), 40e18);
    }

    function test_transferToUnverifiedReverts() public {
        vm.prank(admin);
        token.mint(alice, 100e18);
        assertFalse(token.canTransfer(alice, eve, 1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, eve));
        token.transfer(eve, 1);
    }

    function test_expiredKycBlocksSending() public {
        vm.prank(admin);
        token.mint(bob, 10e18);
        vm.warp(block.timestamp + 366 days);
        assertFalse(token.canSend(bob));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotSend.selector, bob));
        token.transfer(alice, 1);
    }

    function test_blockedCountry() public {
        vm.prank(admin);
        registry.setCountryBlocked(840, true);
        assertFalse(registry.isVerified(alice));
    }

    function test_freezeLimitsTransfers() public {
        vm.startPrank(admin);
        token.mint(alice, 100e18);
        token.setFrozenTokens(alice, 70e18);
        vm.stopPrank();
        assertTrue(token.canTransfer(alice, bob, 30e18));
        assertFalse(token.canTransfer(alice, bob, 31e18));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC7943Fungible.ERC7943InsufficientUnfrozenBalance.selector, alice, 31e18, 30e18
            )
        );
        token.transfer(bob, 31e18);
    }

    function test_forcedTransferReducesFrozen() public {
        vm.startPrank(admin);
        token.mint(alice, 100e18);
        token.setFrozenTokens(alice, 100e18);
        token.forcedTransfer(alice, bob, 60e18);
        vm.stopPrank();
        assertEq(token.balanceOf(bob), 60e18);
        assertEq(token.getFrozenTokens(alice), 40e18);
    }

    function test_forcedTransferStillNeedsVerifiedReceiver() public {
        vm.startPrank(admin);
        token.mint(alice, 10e18);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, eve));
        token.forcedTransfer(alice, eve, 1);
        vm.stopPrank();
    }

    function test_forcedTransferMoreThanBalanceReverts() public {
        vm.startPrank(admin);
        token.mint(alice, 10e18);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 10e18, 11e18)
        );
        token.forcedTransfer(alice, bob, 11e18);
        vm.stopPrank();
    }

    function test_pauseBlocksTransfers() public {
        vm.startPrank(admin);
        token.mint(alice, 10e18);
        token.pause();
        vm.stopPrank();
        assertFalse(token.canTransfer(alice, bob, 1));
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        token.transfer(bob, 1);
    }

    function test_onlyEnforcerCanFreeze() public {
        bytes32 role = token.ENFORCER_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        token.setFrozenTokens(bob, 1);
    }

    function test_burnOnlyUnfrozen() public {
        vm.startPrank(admin);
        token.mint(alice, 10e18);
        token.setFrozenTokens(alice, 8e18);
        vm.expectRevert(
            abi.encodeWithSelector(IERC7943Fungible.ERC7943InsufficientUnfrozenBalance.selector, alice, 3e18, 2e18)
        );
        token.burn(alice, 3e18);
        token.burn(alice, 2e18);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 8e18);
    }

    // ------------------------------------------------------------------ ERC-4626 vault

    function _vault() internal returns (PermissionedVault v) {
        v = PermissionedVault(
            factory.deployVault(TENANT, ASSET, IERC20(address(usdc)), "Permian Pool I", "PRP1", admin, address(registry), 2_000)
        );
        usdc.mint(alice, 1_000e6);
        usdc.mint(eve, 1_000e6);
    }

    function test_vaultDepositOnlyVerified() public {
        PermissionedVault v = _vault();
        vm.startPrank(alice);
        usdc.approve(address(v), type(uint256).max);
        v.deposit(1_000e6, alice);
        vm.stopPrank();
        assertEq(v.totalAssets(), 1_000e6);

        assertEq(v.maxDeposit(eve), 0);
        vm.startPrank(eve);
        usdc.approve(address(v), type(uint256).max);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit
        v.deposit(1, eve);
        vm.stopPrank();
    }

    function test_vaultSharesCantGoToUnverified() public {
        PermissionedVault v = _vault();
        vm.startPrank(alice);
        usdc.approve(address(v), type(uint256).max);
        uint256 shares = v.deposit(1_000e6, alice);
        vm.expectRevert(abi.encodeWithSelector(PermissionedVault.NotVerified.selector, eve));
        v.transfer(eve, shares / 2);
        vm.stopPrank();
    }

    function test_vaultDepositCap() public {
        PermissionedVault v = new PermissionedVault(
            PermissionedVault.Config(IERC20(address(usdc)), "Capped", "CAP", admin, address(registry), 0, address(0), 600e6, address(0))
        );
        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(v), type(uint256).max);
        assertEq(v.maxDeposit(alice), 600e6);
        v.deposit(500e6, alice);
        assertEq(v.maxDeposit(alice), 100e6);
        vm.expectRevert(); // ERC4626ExceededMaxDeposit
        v.deposit(101e6, alice);
        v.deposit(100e6, alice);
        assertEq(v.maxDeposit(alice), 0);
        vm.stopPrank();
    }

    function test_vaultNavAndLiquidity() public {
        PermissionedVault v = _vault();
        vm.startPrank(alice);
        usdc.approve(address(v), type(uint256).max);
        v.deposit(1_000e6, alice);
        vm.stopPrank();

        address escrow = makeAddr("escrow");
        vm.prank(admin);
        v.deployCapital(escrow, 800e6, "property purchase");
        assertEq(v.totalAssets(), 1_000e6); // NAV unchanged by deploying

        // Only 200 USDC liquid: redemptions capped there
        assertEq(v.maxWithdraw(alice), 200e6);

        bytes32 navRole = v.NAV_REPORTER_ROLE();
        vm.prank(admin);
        v.grantRole(navRole, admin);
        vm.prank(admin);
        v.reportNav(900e6); // +100 = 10% of 1000, under the 20% guard
        assertEq(v.totalAssets(), 1_100e6);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(PermissionedVault.NavChangeTooLarge.selector, 900e6, 2_000e6));
        v.reportNav(2_000e6);
    }

    // ------------------------------------------------------------------ distributor

    function _leaf(uint256 i, address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(i, a, amt))));
    }

    function _dist() internal returns (Distributor d) {
        d = new Distributor(platform, platform);
        vm.prank(platform);
        d.setPayoutToken(address(usdc), true, 25e6); // flat $25 per payout
    }

    function _root2() internal view returns (bytes32 l0, bytes32 l1, bytes32 root) {
        l0 = _leaf(0, alice, 600e6);
        l1 = _leaf(1, bob, 400e6);
        root = l0 < l1 ? keccak256(abi.encodePacked(l0, l1)) : keccak256(abi.encodePacked(l1, l0));
    }

    function test_distributionFlatFeeClaimAndSweep() public {
        Distributor d = _dist();
        (, bytes32 l1, bytes32 root) = _root2();
        usdc.mint(admin, 2_000e6);
        vm.startPrank(admin);
        usdc.approve(address(d), type(uint256).max);
        uint256 id = d.createDistribution(
            address(token), IERC20(address(usdc)), root, 1_000e6, uint64(block.number), uint64(block.timestamp + 30 days), "Q4 rent", 25e6
        );
        vm.stopPrank();
        assertEq(usdc.balanceOf(platform), 25e6, "flat fee on top");
        assertEq(usdc.balanceOf(address(d)), 1_000e6, "holders' money intact");

        bytes32[] memory p0 = new bytes32[](1);
        p0[0] = l1;
        vm.prank(eve); // anyone can relay; funds go to alice
        d.claim(id, 0, alice, 600e6, p0);
        assertEq(usdc.balanceOf(alice), 600e6);
        assertEq(usdc.balanceOf(eve), 0);

        vm.expectRevert(Distributor.AlreadyClaimed.selector);
        d.claim(id, 0, alice, 600e6, p0);
        vm.expectRevert(Distributor.InvalidProof.selector);
        d.claim(id, 1, bob, 401e6, p0);

        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(Distributor.DeadlinePassed.selector);
        d.claim(id, 1, bob, 400e6, p0);
        uint256 before = usdc.balanceOf(admin);
        vm.prank(eve); // anyone may sweep; funds return to the funder
        d.sweep(id);
        assertEq(usdc.balanceOf(admin) - before, 400e6);
    }

    function test_onlyTokenAdminCanFundPayouts() public {
        Distributor d = _dist();
        (,, bytes32 root) = _root2();
        usdc.mint(eve, 2_000e6);
        vm.startPrank(eve);
        usdc.approve(address(d), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(Distributor.NotTokenAdmin.selector, eve));
        d.createDistribution(address(token), IERC20(address(usdc)), root, 1_000e6, 1, uint64(block.timestamp + 1 days), "x", 25e6);
        vm.stopPrank();
    }

    function test_feeGuardAndPayoutTokenAllowlist() public {
        Distributor d = _dist();
        (,, bytes32 root) = _root2();
        usdc.mint(admin, 2_000e6);
        vm.prank(admin);
        usdc.approve(address(d), type(uint256).max);
        // platform raises the fee after the issuer quoted it: the issuer's maxFee protects them
        vm.prank(platform);
        d.setPayoutToken(address(usdc), true, 50e6);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Distributor.FeeAboveMax.selector, 50e6, 25e6));
        d.createDistribution(address(token), IERC20(address(usdc)), root, 1_000e6, 1, uint64(block.timestamp + 1 days), "x", 25e6);
        // a stablecoin the platform hasn't enabled is refused
        vm.prank(platform);
        d.setPayoutToken(address(usdc), false, 0);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Distributor.PayoutTokenNotEnabled.selector, address(usdc)));
        d.createDistribution(address(token), IERC20(address(usdc)), root, 1_000e6, 1, uint64(block.timestamp + 1 days), "x", 99e6);
    }

    function test_onlyPlatformSetsFees() public {
        Distributor d = _dist();
        vm.prank(admin); // the issuer can't zero the platform fee
        vm.expectRevert();
        d.setPayoutToken(address(usdc), true, 0);
    }
}
