// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {InvestorRegistry, ISanctionsList} from "../src/compliance/InvestorRegistry.sol";
import {PermissionedToken} from "../src/tokens/PermissionedToken.sol";
import {IERC7943Fungible} from "../src/interfaces/IERC7943.sol";

contract MockOracle is ISanctionsList {
    mapping(address => bool) public bad;
    bool public broken;

    function set(address a, bool v) external {
        bad[a] = v;
    }

    function breakIt() external {
        broken = true;
    }

    function isSanctioned(address a) external view returns (bool) {
        require(!broken, "oracle down");
        return bad[a];
    }
}

contract SanctionsTest is Test {
    address admin = makeAddr("issuer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    MockOracle oracle;
    InvestorRegistry registry;
    PermissionedToken token;

    function setUp() public {
        oracle = new MockOracle();
        registry = new InvestorRegistry(admin, admin, address(oracle));
        token = new PermissionedToken(PermissionedToken.Config("T", "T", 18, 0, admin, address(registry), "", address(0)));
        vm.startPrank(admin);
        registry.setInvestor(alice, true, 840, 0);
        registry.setInvestor(bob, true, 840, 0);
        token.mint(alice, 100e18);
        vm.stopPrank();
    }

    function test_cannotVerifySanctionedWallet() public {
        address eve = makeAddr("eve");
        oracle.set(eve, true);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(InvestorRegistry.Sanctioned.selector, eve));
        registry.setInvestor(eve, true, 840, 0);
    }

    function test_laterSanctionBlocksTransfers() public {
        oracle.set(bob, true);
        assertFalse(registry.isVerified(bob));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC7943Fungible.ERC7943CannotReceive.selector, bob));
        token.transfer(bob, 1e18);
    }

    function test_brokenOracleFailsClosed() public {
        oracle.breakIt();
        assertTrue(registry.isSanctioned(alice));
        assertFalse(registry.isVerified(alice));
    }

    function test_adminCanReplaceOracle() public {
        oracle.breakIt();
        vm.prank(admin);
        registry.setSanctionsOracle(address(0));
        assertTrue(registry.isVerified(alice));
    }

    function test_noOracleMeansNoSanctionsCheck() public {
        InvestorRegistry r = new InvestorRegistry(admin, admin, address(0));
        assertFalse(r.isSanctioned(alice));
    }
}
