// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {InvestorRegistry} from "../src/compliance/InvestorRegistry.sol";
import {PermissionedToken} from "../src/tokens/PermissionedToken.sol";
import {PrimarySale} from "../src/sale/PrimarySale.sol";
import {TestUSD} from "../src/test-helpers/TestUSD.sol";
import {AssetOracle} from "../src/oracle/AssetOracle.sol";
import {PermissionedVault} from "../src/vaults/PermissionedVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AssetOracleTest is Test {
    bytes32 constant REAL_ESTATE = keccak256("real-estate");
    bytes32 constant TITLE = keccak256("TITLE");
    bytes32 constant VALUATION = keccak256("VALUATION");
    bytes32 constant INSURANCE = keccak256("INSURANCE");
    bytes32 constant NAV = keccak256("NAV");
    bytes32 constant DOC = keccak256("the deed pdf");

    address platform = makeAddr("platform");
    address issuer = makeAddr("issuer");
    address titleCo = makeAddr("titleCo");
    address appraiser;
    uint256 appraiserKey;
    address appraiser2 = makeAddr("appraiser2");
    address alice = makeAddr("alice");

    AssetOracle oracle;
    InvestorRegistry registry;
    PermissionedToken token;

    function setUp() public {
        (appraiser, appraiserKey) = makeAddrAndKey("appraiser");
        oracle = new AssetOracle(platform);
        registry = new InvestorRegistry(issuer, issuer, address(0));
        token = new PermissionedToken(
            PermissionedToken.Config("Oak Ridge", "OAKR", 18, 1_000_000e18, issuer, address(registry), "", address(0))
        );
        vm.startPrank(platform);
        oracle.setMaxValidity(TITLE, 365 days);
        oracle.setMaxValidity(VALUATION, 180 days);
        oracle.setMaxValidity(INSURANCE, 365 days);
        bytes32[] memory re = new bytes32[](2);
        re[0] = TITLE;
        re[1] = VALUATION;
        oracle.setClassRequirements(REAL_ESTATE, re);
        oracle.setVerifier(titleCo, true, "Acme Title Insurance Co.");
        oracle.setVerifierKind(titleCo, TITLE, true);
        oracle.setVerifier(appraiser, true, "Jane Doe, MAI");
        oracle.setVerifierKind(appraiser, VALUATION, true);
        oracle.setVerifier(appraiser2, true, "Second Appraisal LLC");
        oracle.setVerifierKind(appraiser2, VALUATION, true);
        vm.stopPrank();
    }

    function _kinds(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory k) {
        k = new bytes32[](2);
        k[0] = a;
        k[1] = b;
    }

    function _register() internal {
        vm.prank(issuer);
        oracle.register(address(token), REAL_ESTATE, _kinds(TITLE, VALUATION));
    }

    function _attest(address v, bytes32 kind, AssetOracle.Result r, uint64 ttl) internal {
        vm.prank(v);
        oracle.attest(AssetOracle.AttestInput(address(token), kind, r, uint64(block.timestamp) + ttl, 0, DOC, "ipfs://doc"));
    }

    // ---------------------------------------------------------------- registration

    function test_onlyTokenAdminRegisters() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.NotTokenAdmin.selector, alice));
        oracle.register(address(token), REAL_ESTATE, _kinds(TITLE, VALUATION));
    }

    function test_cannotSkipClassMinimum() public {
        bytes32[] memory k = new bytes32[](1);
        k[0] = TITLE;
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.MissingRequiredKind.selector, VALUATION));
        oracle.register(address(token), REAL_ESTATE, k);
    }

    function test_registerRejectsUnknownAndDuplicateAndTwice() public {
        vm.startPrank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.UnknownKind.selector, NAV));
        oracle.register(address(token), REAL_ESTATE, _kinds(TITLE, NAV));
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.DuplicateKind.selector, TITLE));
        oracle.register(address(token), REAL_ESTATE, _kinds(TITLE, TITLE));
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.UnknownClass.selector, keccak256("x")));
        oracle.register(address(token), keccak256("x"), _kinds(TITLE, VALUATION));
        oracle.register(address(token), REAL_ESTATE, _kinds(TITLE, VALUATION));
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.AlreadyRegistered.selector, address(token)));
        oracle.register(address(token), REAL_ESTATE, _kinds(TITLE, VALUATION));
        vm.stopPrank();
    }

    function test_issuerCanAddButNotRemoveChecks() public {
        _register();
        _attest(titleCo, TITLE, AssetOracle.Result.Pass, 30 days);
        _attest(appraiser, VALUATION, AssetOracle.Result.Pass, 30 days);
        assertTrue(oracle.isVerified(address(token)));
        vm.prank(issuer);
        oracle.addKind(address(token), INSURANCE);
        assertFalse(oracle.isVerified(address(token)), "new check outstanding");
        (, bytes32[] memory k) = oracle.registration(address(token));
        assertEq(k.length, 3);
    }

    function test_issuerCannotMakeItselfAVerifier() public {
        vm.startPrank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, issuer, bytes32(0))
        );
        oracle.setVerifier(issuer, true, "Totally Independent Title");
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- attestations

    function test_verifiedOnlyWhenEveryCheckPasses() public {
        _register();
        assertFalse(oracle.isVerified(address(token)));
        _attest(titleCo, TITLE, AssetOracle.Result.Pass, 30 days);
        assertFalse(oracle.isVerified(address(token)));
        _attest(appraiser, VALUATION, AssetOracle.Result.Pass, 30 days);
        assertTrue(oracle.isVerified(address(token)));
        AssetOracle.Attestation memory a = oracle.latest(address(token), TITLE);
        assertEq(a.verifier, titleCo);
        assertEq(a.evidenceHash, DOC);
    }

    function test_expiryUnverifies() public {
        _register();
        _attest(titleCo, TITLE, AssetOracle.Result.Pass, 30 days);
        _attest(appraiser, VALUATION, AssetOracle.Result.Pass, 10 days);
        vm.warp(block.timestamp + 10 days + 1);
        assertFalse(oracle.isVerified(address(token)));
        assertTrue(oracle.isCurrent(address(token), TITLE));
    }

    function test_removingVerifierVoidsItsAttestations() public {
        _register();
        _attest(titleCo, TITLE, AssetOracle.Result.Pass, 30 days);
        _attest(appraiser, VALUATION, AssetOracle.Result.Pass, 30 days);
        vm.prank(platform);
        oracle.setVerifier(titleCo, false, "Acme Title Insurance Co.");
        assertFalse(oracle.isVerified(address(token)));
    }

    function test_verifierLimitedToItsKinds() public {
        _register();
        vm.prank(titleCo);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.NotAllowedVerifier.selector, titleCo, VALUATION));
        oracle.attest(AssetOracle.AttestInput(address(token), VALUATION, AssetOracle.Result.Pass, uint64(block.timestamp + 1 days), 0, DOC, "x"));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.NotAllowedVerifier.selector, alice, TITLE));
        oracle.attest(AssetOracle.AttestInput(address(token), TITLE, AssetOracle.Result.Pass, uint64(block.timestamp + 1 days), 0, DOC, "x"));
    }

    function test_attestationRules() public {
        vm.prank(titleCo);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.NotRegistered.selector, address(token)));
        oracle.attest(AssetOracle.AttestInput(address(token), TITLE, AssetOracle.Result.Pass, uint64(block.timestamp + 1 days), 0, DOC, "x"));
        _register();
        vm.startPrank(titleCo);
        uint64 maxUntil = uint64(block.timestamp + 365 days);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.BadValidity.selector, maxUntil + 1, maxUntil));
        oracle.attest(AssetOracle.AttestInput(address(token), TITLE, AssetOracle.Result.Pass, maxUntil + 1, 0, DOC, "x"));
        vm.expectRevert(AssetOracle.NoEvidence.selector);
        oracle.attest(AssetOracle.AttestInput(address(token), TITLE, AssetOracle.Result.Pass, maxUntil, 0, bytes32(0), "x"));
        vm.expectRevert(AssetOracle.NoEvidence.selector);
        oracle.attest(AssetOracle.AttestInput(address(token), TITLE, AssetOracle.Result.Pass, maxUntil, 0, DOC, ""));
        vm.expectRevert(AssetOracle.BadResult.selector);
        oracle.attest(AssetOracle.AttestInput(address(token), TITLE, AssetOracle.Result.None, maxUntil, 0, DOC, "x"));
        vm.stopPrank();
        // Kind enabled platform-wide but not required for this token.
        vm.startPrank(platform);
        oracle.setVerifierKind(titleCo, INSURANCE, true);
        vm.stopPrank();
        vm.prank(titleCo);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.KindNotRequired.selector, address(token), INSURANCE));
        oracle.attest(AssetOracle.AttestInput(address(token), INSURANCE, AssetOracle.Result.Pass, maxUntil, 0, DOC, "x"));
    }

    function test_failCannotBeShoppedAway() public {
        _register();
        _attest(titleCo, TITLE, AssetOracle.Result.Pass, 30 days);
        _attest(appraiser, VALUATION, AssetOracle.Result.Fail, 30 days);
        uint64 until = uint64(block.timestamp + 30 days);
        // A friendlier appraiser can't overwrite the fail...
        vm.prank(appraiser2);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.FailStandsUntil.selector, appraiser, until));
        oracle.attest(AssetOracle.AttestInput(address(token), VALUATION, AssetOracle.Result.Pass, uint64(block.timestamp + 1 days), 0, DOC, "x"));
        // ...but the same appraiser can clear it after a fix.
        _attest(appraiser, VALUATION, AssetOracle.Result.Pass, 30 days);
        assertTrue(oracle.isVerified(address(token)));
    }

    function test_failExpiresOrVerifierRemovedThenOthersMayAttest() public {
        _register();
        _attest(appraiser, VALUATION, AssetOracle.Result.Fail, 5 days);
        vm.warp(block.timestamp + 5 days + 1);
        _attest(appraiser2, VALUATION, AssetOracle.Result.Pass, 30 days);
        _attest(appraiser, VALUATION, AssetOracle.Result.Fail, 30 days); // any qualified verifier may flag a problem
        vm.prank(platform);
        oracle.setVerifier(appraiser, false, "Jane Doe, MAI");
        _attest(appraiser2, VALUATION, AssetOracle.Result.Pass, 30 days);
        assertTrue(oracle.isCurrent(address(token), VALUATION));
    }

    // ---------------------------------------------------------------- signatures

    function _sig(uint256 key, uint64 validUntil, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                oracle.ATTEST_TYPEHASH(),
                address(token),
                VALUATION,
                uint8(AssetOracle.Result.Pass),
                validUntil,
                int256(250_000_000),
                DOC,
                keccak256(bytes("ipfs://appraisal")),
                nonce,
                deadline
            )
        );
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = oracle.eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _in(uint64 until) internal view returns (AssetOracle.AttestInput memory) {
        return AssetOracle.AttestInput(address(token), VALUATION, AssetOracle.Result.Pass, until, 250_000_000, DOC, "ipfs://appraisal");
    }

    function test_attestBySigRelayedNoReplay() public {
        _register();
        uint64 until = uint64(block.timestamp + 30 days);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(appraiserKey, until, 0, deadline);
        vm.prank(alice); // anyone relays
        oracle.attestBySig(appraiser, _in(until), deadline, sig);
        assertEq(oracle.latest(address(token), VALUATION).value, 250_000_000);
        assertEq(oracle.nonces(appraiser), 1);
        vm.expectRevert(AssetOracle.BadSignature.selector);
        oracle.attestBySig(appraiser, _in(until), deadline, sig);
    }

    function test_attestBySigRejectsWrongSignerAndLate() public {
        _register();
        uint64 until = uint64(block.timestamp + 30 days);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sig(appraiserKey, until, 0, deadline);
        vm.expectRevert(AssetOracle.BadSignature.selector);
        oracle.attestBySig(appraiser2, _in(until), deadline, sig);
        vm.warp(deadline + 1);
        vm.expectRevert(AssetOracle.Expired.selector);
        oracle.attestBySig(appraiser, _in(until), deadline, sig);
    }

    // ---------------------------------------------------------------- sale gating

    function test_saleOnlySellsWhileVerified() public {
        TestUSD usd = new TestUSD();
        PrimarySale sale = new PrimarySale(
            PrimarySale.Config({
                token: address(token),
                payToken: address(usd),
                treasury: issuer,
                admin: issuer,
                price: 1e6,
                cap: 1_000e18,
                minPurchase: 0,
                startsAt: 0,
                endsAt: 0,
                feeRecipient: address(0),
                feeBps: 0,
                oracle: address(oracle)
            })
        );
        bytes32 minter = token.MINTER_ROLE();
        vm.startPrank(issuer);
        token.grantRole(minter, address(sale));
        registry.setInvestor(alice, true, 840, 0);
        vm.stopPrank();
        _register();
        usd.mint(alice, 1_000e6);
        vm.prank(alice);
        usd.approve(address(sale), type(uint256).max);

        assertFalse(sale.isOpen());
        vm.prank(alice);
        vm.expectRevert(PrimarySale.AssetNotVerified.selector);
        sale.buy(1e18);

        _attest(titleCo, TITLE, AssetOracle.Result.Pass, 30 days);
        _attest(appraiser, VALUATION, AssetOracle.Result.Pass, 10 days);
        assertTrue(sale.isOpen());
        vm.prank(alice);
        sale.buy(1e18);
        assertEq(token.balanceOf(alice), 1e18);

        vm.warp(block.timestamp + 10 days + 1); // appraisal lapses
        vm.prank(alice);
        vm.expectRevert(PrimarySale.AssetNotVerified.selector);
        sale.buy(1e18);
    }

    function test_vaultOnlyAcceptsDepositsWhileVerified() public {
        bytes32 FUNDS = keccak256("funds");
        bytes32 NAVK = keccak256("NAV");
        TestUSD usd = new TestUSD();
        PermissionedVault v = new PermissionedVault(
            PermissionedVault.Config(IERC20(address(usd)), "Pool", "POOL", issuer, address(registry), 0, address(oracle), 0, address(0))
        );
        vm.startPrank(platform);
        oracle.setMaxValidity(NAVK, 3 days);
        bytes32[] memory k = new bytes32[](1);
        k[0] = NAVK;
        oracle.setClassRequirements(FUNDS, k);
        oracle.setVerifierKind(appraiser, NAVK, true);
        vm.stopPrank();
        vm.prank(issuer);
        oracle.register(address(v), FUNDS, k);
        vm.prank(issuer);
        registry.setInvestor(alice, true, 840, 0);
        usd.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usd.approve(address(v), type(uint256).max);
        assertEq(v.maxDeposit(alice), 0, "closed until NAV is signed");
        vm.expectRevert();
        v.deposit(100e6, alice);
        vm.stopPrank();
        vm.prank(appraiser);
        oracle.attest(AssetOracle.AttestInput(address(v), NAVK, AssetOracle.Result.Pass, uint64(block.timestamp + 2 days), 1e6, DOC, "x"));
        vm.prank(alice);
        v.deposit(100e6, alice);
        assertGt(v.balanceOf(alice), 0);
        vm.warp(block.timestamp + 2 days + 1);
        assertEq(v.maxDeposit(alice), 0, "closed again once NAV lapses");
    }
}
