// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    ITREXToken,
    ITREXIdentityRegistry,
    ITREXFactory,
    ITREXImplementationAuthority,
    ITREXProxy,
    IOwnableLike,
    IIdFactory,
    IOnchainIdentity,
    IClaimIssuer,
    ITREXPlatform
} from "../src/interfaces/ITREX.sol";
import {PrimarySale3643} from "../src/sale/PrimarySale3643.sol";
import {AssetOracle} from "../src/oracle/AssetOracle.sol";
import {Distributor} from "../src/distribution/Distributor.sol";
import {TestUSD} from "../src/test-helpers/TestUSD.sol";

/// ERC-3643 on the platform, against the audited T-REX 4.1.6 / OnchainID 2.2.1 bytecode (deployed via TREXPlatform,
/// compiled at 0.8.17 untouched): platform factory → suite owned by the issuer → issuer-owned upgrades (opt-in) →
/// issuer-signed KYC claims filed by the platform → proof-of-asset-gated sale → transfers → payouts (v2 contracts).
contract TREXTest is Test {
    uint256 constant KYC = 1; // claim topic
    bytes32 constant REAL_ESTATE = keccak256("real-estate");
    bytes32 constant TITLE = keccak256("TITLE");
    bytes32 constant VALUATION = keccak256("VALUATION");
    bytes32 constant INSURANCE = keccak256("INSURANCE");

    address platform = makeAddr("platform"); // factory owner + identity manager (the API relayer)
    address issuer;
    uint256 issuerKey;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address[3] verifiers = [makeAddr("title"), makeAddr("appraiser"), makeAddr("insurer")];

    ITREXPlatform helper;
    ITREXPlatform.Core core;
    address claimIssuer;
    ITREXToken token;
    ITREXIdentityRegistry ir;
    PrimarySale3643 sale;
    AssetOracle oracle;
    TestUSD usd;

    function setUp() public {
        (issuer, issuerKey) = makeAddrAndKey("issuer");
        helper = ITREXPlatform(_create("TREXPlatform.sol:TREXPlatform"));
        vm.prank(platform);
        core = helper.deployCore();
        claimIssuer = helper.newClaimIssuer(issuer);

        usd = new TestUSD();
        oracle = new AssetOracle(platform);
        bytes32[3] memory k = [TITLE, VALUATION, INSURANCE];
        vm.startPrank(platform);
        bytes32[] memory req = new bytes32[](3);
        for (uint256 i; i < 3; ++i) {
            oracle.setMaxValidity(k[i], 365 days);
            oracle.setVerifier(verifiers[i], true, "v");
            oracle.setVerifierKind(verifiers[i], k[i], true);
            req[i] = k[i];
        }
        oracle.setClassRequirements(REAL_ESTATE, req);
        vm.stopPrank();

        token = _deploySuite("ast_harbor", true);
        ir = ITREXIdentityRegistry(token.identityRegistry());

        sale = new PrimarySale3643(
            PrimarySale3643.Config({
                token: address(token),
                payToken: address(usd),
                treasury: treasury,
                admin: issuer,
                price: 10e6, // $10 per token
                cap: 10_000e18,
                minPurchase: 100e6,
                startsAt: uint64(block.timestamp),
                endsAt: 0,
                feeRecipient: address(0),
                feeBps: 0,
                oracle: address(oracle)
            })
        );
        vm.startPrank(issuer);
        token.addAgent(address(sale));
        oracle.register(address(token), REAL_ESTATE, req); // Ownable token: owner() is the admin (v2)
        vm.stopPrank();

        for (uint256 i; i < 3; ++i) {
            usd.mint([alice, bob, carol][i], 100_000e6);
            vm.prank([alice, bob, carol][i]);
            usd.approve(address(sale), type(uint256).max);
        }
    }

    // ---------------------------------------------------------------- helpers

    function _create(string memory artifact) internal returns (address a) {
        bytes memory code = vm.getCode(artifact);
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0), "create failed");
    }

    /// The platform API's exact sequence: deploy via the factory (owner = issuer), recover the identity registry
    /// storage from the factory, then (opt-in) the issuer takes its own implementation authority.
    function _deploySuite(string memory salt, bool issuerOwnsUpgrades) internal returns (ITREXToken t) {
        address[] memory irAgents = new address[](2);
        irAgents[0] = issuer;
        irAgents[1] = platform;
        address[] memory tokenAgents = new address[](1);
        tokenAgents[0] = issuer;
        uint256[] memory topics = new uint256[](1);
        topics[0] = KYC;
        address[] memory issuers = new address[](1);
        issuers[0] = claimIssuer;
        uint256[][] memory issuerClaims = new uint256[][](1);
        issuerClaims[0] = topics;
        vm.startPrank(platform);
        ITREXFactory(core.trexFactory).deployTREXSuite(
            salt,
            ITREXFactory.TokenDetails({
                owner: issuer,
                name: "Harbor Lofts",
                symbol: "HARB",
                decimals: 18,
                irs: address(0),
                ONCHAINID: address(0),
                irAgents: irAgents,
                tokenAgents: tokenAgents,
                complianceModules: new address[](0),
                complianceSettings: new bytes[](0)
            }),
            ITREXFactory.ClaimDetails({claimTopics: topics, issuers: issuers, issuerClaims: issuerClaims})
        );
        t = ITREXToken(ITREXFactory(core.trexFactory).getToken(salt));
        address irs = ITREXIdentityRegistry(t.identityRegistry()).identityStorage();
        ITREXFactory(core.trexFactory).recoverContractOwnership(irs, issuer);
        vm.stopPrank();
        if (issuerOwnsUpgrades) {
            vm.prank(issuer);
            ITREXImplementationAuthority(core.implementationAuthority).changeImplementationAuthority(address(t), address(0));
        }
    }

    function _issuerClaimSig(address identity, bytes memory data) internal view returns (bytes memory) {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(identity, KYC, data)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(issuerKey, h);
        return abi.encodePacked(r, s, v);
    }

    /// Issuer verifies an investor: its wallet signs a KYC claim (gasless); the platform creates the investor's
    /// identity, files the issuer-signed claim and registers the wallet.
    function _kyc(address wallet) internal returns (address identity, bytes memory sig) {
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = keccak256(abi.encode(platform));
        vm.prank(platform);
        identity = IIdFactory(core.idFactory).createIdentityWithManagementKeys(wallet, vm.toString(wallet), keys);
        bytes memory data = abi.encode("kyc:sumsub:approved");
        sig = _issuerClaimSig(identity, data);
        vm.startPrank(platform);
        IOnchainIdentity(identity).addClaim(KYC, 1, claimIssuer, sig, data, "");
        ir.registerIdentity(wallet, identity, 840);
        vm.stopPrank();
    }

    function _verifyAsset() internal {
        bytes32[3] memory k = [TITLE, VALUATION, INSURANCE];
        for (uint256 i; i < 3; ++i) {
            vm.prank(verifiers[i]);
            oracle.attest(AssetOracle.AttestInput(address(token), k[i], AssetOracle.Result.Pass, uint64(block.timestamp + 30 days), 0, keccak256("doc"), "ipfs://doc"));
        }
    }

    // ---------------------------------------------------------------- ownership + upgrades

    function test_wholeSuiteOwnedByIssuer() public view {
        address irs = ir.identityStorage();
        address[6] memory parts = [address(token), address(ir), irs, token.compliance(), ir.topicsRegistry(), ir.issuersRegistry()];
        for (uint256 i; i < 6; ++i) assertEq(IOwnableLike(parts[i]).owner(), issuer);
        assertEq(ITREXFactory(core.trexFactory).owner(), platform);
        assertTrue(token.paused()); // T-REX starts paused: holder transfers wait for the issuer
        assertEq(token.decimals(), 18);
        assertTrue(token.onchainID() != address(0));
    }

    function test_issuerOwnsUpgradesWhenOptedIn() public view {
        address ia = ITREXProxy(address(token)).getImplementationAuthority();
        assertTrue(ia != core.implementationAuthority);
        assertFalse(ITREXImplementationAuthority(ia).isReferenceContract());
        assertEq(ITREXImplementationAuthority(ia).owner(), issuer);
        assertEq(ITREXProxy(address(ir)).getImplementationAuthority(), ia);
    }

    function test_platformManagedUpgradesWhenNotOptedIn() public {
        ITREXToken t = _deploySuite("ast_other", false);
        assertEq(ITREXProxy(address(t)).getImplementationAuthority(), core.implementationAuthority);
        assertEq(ITREXImplementationAuthority(core.implementationAuthority).owner(), platform);
    }

    function test_onlyPlatformDeploysSuites() public {
        ITREXFactory.TokenDetails memory d;
        ITREXFactory.ClaimDetails memory c;
        vm.prank(issuer);
        vm.expectRevert("Ownable: caller is not the owner");
        ITREXFactory(core.trexFactory).deployTREXSuite("x", d, c);
    }

    // ---------------------------------------------------------------- KYC claims

    function test_issuerSignedClaimVerifiesInvestor() public {
        assertFalse(ir.isVerified(alice));
        _kyc(alice);
        assertTrue(ir.isVerified(alice));
        assertTrue(sale.canBuy(alice));
    }

    function test_platformCannotForgeKyc() public {
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = keccak256(abi.encode(platform));
        vm.prank(platform);
        address id = IIdFactory(core.idFactory).createIdentityWithManagementKeys(bob, "bob", keys);
        (, uint256 platformKey) = makeAddrAndKey("platform");
        bytes memory data = abi.encode("forged");
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(id, KYC, data)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(platformKey, h);
        vm.prank(platform);
        vm.expectRevert("invalid claim");
        IOnchainIdentity(id).addClaim(KYC, 1, claimIssuer, abi.encodePacked(r, s, v), data, "");
        // Registering an identity without a valid claim doesn't verify anyone either.
        vm.prank(platform);
        ir.registerIdentity(bob, id, 840);
        assertFalse(ir.isVerified(bob));
    }

    function test_issuerRevokesClaim() public {
        (, bytes memory sig) = _kyc(alice);
        vm.prank(issuer);
        IClaimIssuer(claimIssuer).revokeClaimBySignature(sig);
        assertFalse(ir.isVerified(alice));
        _verifyAsset();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale3643.NotVerified.selector, alice));
        sale.buy(100e18);
    }

    // ---------------------------------------------------------------- sale

    function test_saleGatedByProofOfAsset() public {
        _kyc(alice);
        vm.prank(alice);
        vm.expectRevert(PrimarySale3643.AssetNotVerified.selector);
        sale.buy(100e18);
        _verifyAsset();
        assertTrue(sale.isOpen());
    }

    function test_verifiedInvestorBuys() public {
        _kyc(alice);
        _verifyAsset();
        vm.prank(alice);
        assertEq(sale.buy(150e18), 1_500e6);
        assertEq(token.balanceOf(alice), 150e18);
        assertEq(usd.balanceOf(treasury), 1_500e6);
        assertEq(usd.balanceOf(address(sale)), 0);
        assertEq(token.totalSupply(), 150e18);
    }

    function test_saleRules() public {
        _kyc(alice);
        _verifyAsset();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale3643.NotVerified.selector, bob));
        sale.buy(100e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale3643.BelowMinimum.selector, 50e6, 100e6));
        sale.buy(5e18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PrimarySale3643.SoldOut.selector, 10_001e18, 10_000e18));
        sale.buy(10_001e18);
    }

    function test_saleMustBeAgentToMint() public {
        PrimarySale3643 rogue = new PrimarySale3643(
            PrimarySale3643.Config(address(token), address(usd), treasury, issuer, 10e6, 1e24, 0, 0, 0, address(0), 0, address(0))
        );
        _kyc(alice);
        vm.prank(alice);
        usd.approve(address(rogue), type(uint256).max);
        vm.prank(alice);
        vm.expectRevert("AgentRole: caller does not have the Agent role");
        rogue.buy(1e18);
    }

    // ---------------------------------------------------------------- holders

    function test_transfersOnlyAfterUnpauseAndOnlyToVerified() public {
        _kyc(alice);
        _kyc(bob);
        _verifyAsset();
        vm.prank(alice);
        sale.buy(100e18);
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        token.transfer(bob, 1e18);
        vm.prank(issuer);
        token.unpause();
        vm.prank(alice);
        token.transfer(bob, 10e18);
        assertEq(token.balanceOf(bob), 10e18);
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(carol, 1e18);
    }

    function test_issuerCanFreezeAndForce() public {
        _kyc(alice);
        _kyc(bob);
        _verifyAsset();
        vm.prank(alice);
        sale.buy(100e18);
        vm.startPrank(issuer);
        token.unpause();
        token.setAddressFrozen(alice, true);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert("wallet is frozen");
        token.transfer(bob, 1e18);
        vm.prank(issuer);
        token.forcedTransfer(alice, bob, 40e18);
        assertEq(token.balanceOf(bob), 40e18);
    }

    // ---------------------------------------------------------------- v2 platform contracts

    function test_payoutsFundedByTokenOwner() public {
        Distributor d = new Distributor(platform, platform);
        vm.prank(platform);
        d.setPayoutToken(address(usd), true, 0);
        usd.mint(issuer, 1_000e6);
        vm.prank(issuer);
        usd.approve(address(d), type(uint256).max);
        vm.prank(issuer);
        d.createDistribution(address(token), IERC20(address(usd)), keccak256("root"), 500e6, uint64(block.number), uint64(block.timestamp + 30 days), "Q1", 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Distributor.NotTokenAdmin.selector, alice));
        d.createDistribution(address(token), IERC20(address(usd)), keccak256("root"), 1, uint64(block.number), uint64(block.timestamp + 30 days), "x", 0);
    }

    function test_onlyOwnerRegistersWithOracle() public {
        ITREXToken t = _deploySuite("ast_reg", true);
        bytes32[] memory req = new bytes32[](3);
        (req[0], req[1], req[2]) = (TITLE, VALUATION, INSURANCE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssetOracle.NotTokenAdmin.selector, alice));
        oracle.register(address(t), REAL_ESTATE, req);
    }

    function test_oracleMigrationWindow() public {
        address old = makeAddr("old-token");
        bytes32[] memory req = new bytes32[](3);
        (req[0], req[1], req[2]) = (TITLE, VALUATION, INSURANCE);
        vm.prank(alice);
        vm.expectRevert();
        oracle.importRegistration(old, REAL_ESTATE, req);
        vm.prank(platform);
        oracle.importRegistration(old, REAL_ESTATE, req);
        (bytes32 cls,) = oracle.registration(old);
        assertEq(cls, REAL_ESTATE);
        vm.prank(platform);
        oracle.closeMigration();
        vm.prank(platform);
        vm.expectRevert(AssetOracle.MigrationClosed.selector);
        oracle.importRegistration(makeAddr("another"), REAL_ESTATE, req);
    }
}
