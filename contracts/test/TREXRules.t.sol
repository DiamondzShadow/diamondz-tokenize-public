// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {
    ITREXToken,
    ITREXIdentityRegistry,
    ITREXFactory,
    IIdFactory,
    IOnchainIdentity,
    ITREXPlatform
} from "../src/interfaces/ITREX.sol";

interface IRulesModule {
    struct Settings {
        uint64 lockup;
        uint64 pendingLockup;
        uint64 pendingLockupAt;
        uint64 maturity;
        uint32 maxHolders;
        uint32 holderCount;
        uint8 countryMode;
        bool resaleApproval;
        uint256 maxBalance;
    }

    function scheduleLockup(uint64) external;
    function applyLockup(address compliance) external;
    function setMaxHolders(uint32) external;
    function setMaxBalance(uint256) external;
    function setResaleApproval(bool) external;
    function setMaturity(uint64) external;
    function setCountries(uint8, uint16[] calldata) external;
    function approveTransfer(address, address, uint256) external;
    function settings(address) external view returns (Settings memory);
    function lockedOf(address compliance, address account) external view returns (uint256);
    function checkCode(address compliance, address from, address to, uint256 value) external view returns (uint8);
}

interface ICompliance {
    function callModuleFunction(bytes calldata callData, address module) external;
    function canTransfer(address from, address to, uint256 value) external view returns (bool);
}

interface ITokenOps {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function forcedTransfer(address from, address to, uint256 amount) external returns (bool);
    function unpause() external;
    function balanceOf(address) external view returns (uint256);
}

/// ERC-3643 offerings with OfferingRulesModule plugged into the audited T-REX 4.1.6 modular compliance.
contract TREXRulesTest is Test {
    uint256 constant KYC = 1;
    uint64 constant YEAR = 365 days;

    address platform = makeAddr("platform");
    address issuer;
    uint256 issuerKey;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    ITREXPlatform helper;
    ITREXPlatform.Core core;
    address claimIssuer;
    address module;

    function setUp() public {
        vm.warp(1_800_000_000);
        (issuer, issuerKey) = makeAddrAndKey("issuer");
        helper = ITREXPlatform(_create("TREXPlatform.sol:TREXPlatform"));
        vm.prank(platform);
        core = helper.deployCore();
        claimIssuer = helper.newClaimIssuer(issuer);
        module = _create("OfferingRulesModule.sol:OfferingRulesModule"); // one per chain, shared
    }

    // ---------------------------------------------------------------- helpers

    function _create(string memory artifact) internal returns (address a) {
        bytes memory code = vm.getCode(artifact);
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0), "create failed");
    }

    /// Same sequence as api/src/trex.ts: the module is listed once per setting call, the factory binds it once.
    function _suite(string memory salt, bytes[] memory settings) internal returns (ITREXToken t) {
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
        address[] memory mods = new address[](settings.length == 0 ? 1 : settings.length);
        for (uint256 i; i < mods.length; ++i) mods[i] = module;
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
                complianceModules: mods,
                complianceSettings: settings
            }),
            ITREXFactory.ClaimDetails({claimTopics: topics, issuers: issuers, issuerClaims: issuerClaims})
        );
        t = ITREXToken(ITREXFactory(core.trexFactory).getToken(salt));
        vm.stopPrank();
        vm.prank(issuer);
        ITokenOps(address(t)).unpause();
        _kyc(t, alice, 840);
        _kyc(t, bob, 840);
        _kyc(t, carol, 840);
        _kyc(t, dave, 826);
    }

    /// One identity per wallet across offerings (OnchainID); each offering's registry links it with its own country.
    function _kyc(ITREXToken t, address wallet, uint16 country) internal {
        ITREXIdentityRegistry ir = ITREXIdentityRegistry(t.identityRegistry());
        address identity = IIdFactory(core.idFactory).getIdentity(wallet);
        if (identity == address(0)) {
            bytes32[] memory keys = new bytes32[](1);
            keys[0] = keccak256(abi.encode(platform));
            vm.prank(platform);
            identity = IIdFactory(core.idFactory).createIdentityWithManagementKeys(wallet, vm.toString(wallet), keys);
            bytes memory data = abi.encode("kyc");
            bytes32 h = MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(identity, KYC, data)));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(issuerKey, h);
            vm.prank(platform);
            IOnchainIdentity(identity).addClaim(KYC, 1, claimIssuer, abi.encodePacked(r, s, v), data, "");
        }
        vm.prank(platform);
        ir.registerIdentity(wallet, identity, country);
    }

    function _one(bytes memory call) internal pure returns (bytes[] memory s) {
        s = new bytes[](1);
        s[0] = call;
    }

    function _mint(ITREXToken t, address to, uint256 a) internal {
        vm.prank(issuer);
        ITokenOps(address(t)).mint(to, a);
    }

    // ---------------------------------------------------------------- tests

    function test_settingsAppliedAtDeploy() public {
        bytes[] memory s = new bytes[](3);
        s[0] = abi.encodeCall(IRulesModule.scheduleLockup, (YEAR));
        s[1] = abi.encodeCall(IRulesModule.setMaxHolders, (1_999));
        s[2] = abi.encodeCall(IRulesModule.setMaxBalance, (100e18));
        ITREXToken t = _suite("a", s);
        IRulesModule.Settings memory st = IRulesModule(module).settings(t.compliance());
        assertEq(st.lockup, YEAR);
        assertEq(st.maxHolders, 1_999);
        assertEq(st.maxBalance, 100e18);
    }

    function test_settersOnlyThroughCompliance() public {
        _suite("a", _one(abi.encodeCall(IRulesModule.scheduleLockup, (YEAR))));
        vm.prank(issuer);
        vm.expectRevert("only bound compliance can call");
        IRulesModule(module).setMaxHolders(1);
    }

    function test_lockupPerLotForcedTransferStillWorks() public {
        ITREXToken t = _suite("a", _one(abi.encodeCall(IRulesModule.scheduleLockup, (YEAR))));
        _mint(t, alice, 100e18);
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        ITokenOps(address(t)).transfer(bob, 1e18);

        vm.warp(block.timestamp + 200 days);
        _mint(t, alice, 50e18);
        vm.warp(block.timestamp + 165 days);
        assertEq(IRulesModule(module).lockedOf(t.compliance(), alice), 50e18);
        vm.prank(alice);
        ITokenOps(address(t)).transfer(bob, 100e18); // free lot only
        // Moving free tokens must not erase the still-locked lot.
        assertEq(IRulesModule(module).lockedOf(t.compliance(), alice), 50e18);

        vm.prank(issuer);
        ITokenOps(address(t)).forcedTransfer(alice, carol, 30e18); // court order skips the lockup
        assertEq(IRulesModule(module).lockedOf(t.compliance(), alice), 20e18);
    }

    function test_shorterLockupWaitsSevenDays() public {
        ITREXToken t = _suite("a", _one(abi.encodeCall(IRulesModule.scheduleLockup, (YEAR))));
        address c = t.compliance();
        vm.prank(issuer);
        ICompliance(c).callModuleFunction(abi.encodeCall(IRulesModule.scheduleLockup, (30 days)), module);
        assertEq(IRulesModule(module).settings(c).lockup, YEAR);
        vm.expectRevert("not yet");
        IRulesModule(module).applyLockup(c);
        vm.warp(block.timestamp + 7 days);
        IRulesModule(module).applyLockup(c);
        assertEq(IRulesModule(module).settings(c).lockup, 30 days);
    }

    function test_maxHoldersAndBalance() public {
        bytes[] memory s = new bytes[](2);
        s[0] = abi.encodeCall(IRulesModule.setMaxHolders, (2));
        s[1] = abi.encodeCall(IRulesModule.setMaxBalance, (100e18));
        ITREXToken t = _suite("a", s);
        _mint(t, alice, 50e18);
        _mint(t, bob, 50e18);
        assertEq(IRulesModule(module).settings(t.compliance()).holderCount, 2);
        vm.prank(issuer);
        vm.expectRevert("Compliance not followed");
        ITokenOps(address(t)).mint(carol, 1);
        vm.prank(issuer);
        vm.expectRevert("Compliance not followed");
        ITokenOps(address(t)).mint(alice, 51e18); // over max balance
        vm.prank(alice);
        ITokenOps(address(t)).transfer(carol, 50e18); // alice leaves, carol joins
        assertEq(IRulesModule(module).settings(t.compliance()).holderCount, 2);
        vm.prank(issuer);
        ITokenOps(address(t)).burn(bob, 50e18);
        assertEq(IRulesModule(module).settings(t.compliance()).holderCount, 1);
    }

    function test_resaleApprovalAndMaturity() public {
        bytes[] memory s = new bytes[](2);
        s[0] = abi.encodeCall(IRulesModule.setResaleApproval, (true));
        s[1] = abi.encodeCall(IRulesModule.setMaturity, (uint64(block.timestamp + 30 days)));
        ITREXToken t = _suite("a", s);
        address c = t.compliance();
        _mint(t, alice, 100e18);
        assertEq(IRulesModule(module).checkCode(c, alice, bob, 10e18), 6);
        vm.prank(issuer);
        ICompliance(c).callModuleFunction(abi.encodeCall(IRulesModule.approveTransfer, (alice, bob, 10e18)), module);
        vm.prank(alice);
        ITokenOps(address(t)).transfer(bob, 10e18);
        assertEq(IRulesModule(module).checkCode(c, alice, bob, 1), 6); // approval used up

        vm.warp(block.timestamp + 30 days);
        assertEq(IRulesModule(module).checkCode(c, alice, bob, 1), 7);
        vm.prank(issuer);
        ITokenOps(address(t)).burn(alice, 90e18); // redemption still works
    }

    function test_countriesPerOffering() public {
        uint16[] memory us = new uint16[](1);
        us[0] = 840;
        ITREXToken regS = _suite("regs", _one(abi.encodeCall(IRulesModule.setCountries, (2, us))));
        ITREXToken regD = _suite("regd", _one(abi.encodeCall(IRulesModule.setCountries, (1, us))));
        assertFalse(ICompliance(regS.compliance()).canTransfer(address(0), alice, 1));
        assertTrue(ICompliance(regS.compliance()).canTransfer(address(0), dave, 1));
        assertTrue(ICompliance(regD.compliance()).canTransfer(address(0), alice, 1));
        assertFalse(ICompliance(regD.compliance()).canTransfer(address(0), dave, 1));
    }

    /// A holder sending their whole balance to themselves must not count as a new holder (it would let anyone
    /// fill the max-holders cap and lock new investors out).
    function test_selfTransferDoesNotInflateHolderCount() public {
        ITREXToken t = _suite("a", _one(abi.encodeCall(IRulesModule.setMaxHolders, (3))));
        _mint(t, alice, 50e18);
        _mint(t, bob, 50e18);
        for (uint256 i; i < 3; ++i) {
            vm.prank(alice);
            ITokenOps(address(t)).transfer(alice, 50e18);
        }
        assertEq(IRulesModule(module).settings(t.compliance()).holderCount, 2);
        _mint(t, carol, 1e18); // the third seat is still free
        assertEq(IRulesModule(module).settings(t.compliance()).holderCount, 3);
    }

    /// Self-transfers can't be used to move locked tokens or to shift lots around.
    function test_selfTransferKeepsLockup() public {
        ITREXToken t = _suite("a", _one(abi.encodeCall(IRulesModule.scheduleLockup, (YEAR))));
        _mint(t, alice, 100e18);
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        ITokenOps(address(t)).transfer(alice, 100e18);
        assertEq(IRulesModule(module).lockedOf(t.compliance(), alice), 100e18);
    }
}
