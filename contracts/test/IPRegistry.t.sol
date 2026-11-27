// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {InvestorRegistry} from "../src/compliance/InvestorRegistry.sol";
import {PermissionedToken} from "../src/tokens/PermissionedToken.sol";
import {TestUSD} from "../src/test-helpers/TestUSD.sol";
import {AssetRegistry} from "../src/ip/AssetRegistry.sol";
import {LicenseRegistry} from "../src/ip/LicenseRegistry.sol";

contract OwnableOffering {
    address public owner;

    constructor(address o) {
        owner = o;
    }
}

contract IPRegistryTest is Test {
    AssetRegistry reg;
    LicenseRegistry lic;
    TestUSD usd;
    PermissionedToken film;
    address platform = makeAddr("platform");
    address issuer = makeAddr("issuer");
    address treasury = makeAddr("treasury");
    address studio = makeAddr("studio"); // licensee
    address stranger = makeAddr("stranger");
    address kyb = makeAddr("kyb"); // platform KYB relayer
    bytes32 constant TERMS = keccak256("Commercial remix v1.0");
    bytes32 constant FILM = keccak256("film");
    uint256 assetId;

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new AssetRegistry();
        lic = new LicenseRegistry(reg, platform, "https://tokenize.diamondz.one/api/licenses/84532/");
        usd = new TestUSD();
        InvestorRegistry ir = new InvestorRegistry(issuer, issuer, address(0));
        film = new PermissionedToken(PermissionedToken.Config("Night Shift", "NITE", 18, 0, issuer, address(ir), "", address(0)));
        assetId = _register(address(film), issuer);
        usd.mint(studio, 100_000e6);
        vm.prank(studio);
        usd.approve(address(lic), type(uint256).max);
    }

    function _registration(address offering) internal view returns (AssetRegistry.Registration memory r) {
        r.offering = offering;
        r.assetClass = FILM;
        r.uri = "https://tokenize.diamondz.one/api/ip/ast_1/meta";
        r.docsManifest = keccak256("docs v1");
        r.payee = treasury;
        r.holdersBps = 3_000;
        r.to = treasury;
        r.idKeys = new string[](2);
        r.idValues = new string[](2);
        r.idKeys[0] = "EIDR";
        r.idValues[0] = "10.5240/AAAA-BBBB";
        r.idKeys[1] = "US_COPYRIGHT";
        r.idValues[1] = "PAu 1-234-567";
    }

    function _register(address offering, address as_) internal returns (uint256 id) {
        vm.prank(as_);
        id = reg.register(_registration(offering));
    }

    function _type(uint256 fee, uint16 rev, bool byRequest) internal view returns (LicenseRegistry.LicenseType memory t) {
        t.assetId = assetId;
        t.termsHash = TERMS;
        t.feeToken = address(usd);
        t.fee = fee;
        t.revShareBps = rev;
        t.durationDays = 1095;
        t.byRequest = byRequest;
        t.name = "Commercial remix";
        t.territory = "Worldwide";
        t.termsURI = "https://tokenize.diamondz.one/api/ip/ast_1/terms/remix-v1";
    }

    function _publish(uint256 fee, uint16 rev, bool byRequest) internal returns (uint256 typeId) {
        vm.prank(treasury);
        typeId = lic.publishType(_type(fee, rev, byRequest));
    }

    function _verify(address who) internal {
        vm.prank(treasury);
        lic.verifyLicensee(assetId, who, uint64(block.timestamp + 365 days));
    }

    // ---------------------------------------------------------------- asset registry

    function test_registerRecordsTheAsset() public view {
        assertEq(reg.ownerOf(assetId), treasury);
        assertEq(reg.assetOf(address(film)), assetId);
        AssetRegistry.Asset memory a = reg.asset(assetId);
        assertEq(a.offering, address(film));
        assertEq(a.assetClass, FILM);
        assertEq(a.holdersBps, 3_000);
        (string[] memory k, string[] memory v) = reg.identifiers(assetId);
        assertEq(k.length, 2);
        assertEq(v[0], "10.5240/AAAA-BBBB");
        assertEq(reg.tokenURI(assetId), "https://tokenize.diamondz.one/api/ip/ast_1/meta");
    }

    function test_onlyOfferingAdminRegistersOnce() public {
        InvestorRegistry ir = new InvestorRegistry(issuer, issuer, address(0));
        PermissionedToken other = new PermissionedToken(PermissionedToken.Config("X", "X", 18, 0, issuer, address(ir), "", address(0)));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotOfferingAdmin.selector, address(other), stranger));
        reg.register(_registration(address(other)));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.AlreadyRegistered.selector, address(film), assetId));
        reg.register(_registration(address(film)));
    }

    function test_ownableOfferingsLikeErc3643Register() public {
        OwnableOffering t = new OwnableOffering(issuer);
        uint256 id = _register(address(t), issuer);
        assertEq(reg.ownerOf(id), treasury);
    }

    function test_holderControlsTheRecord() public {
        vm.prank(issuer); // the token admin is no longer in charge once the NFT is minted to the treasury
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.NotAssetOwner.selector, assetId, issuer));
        reg.setDocuments(assetId, keccak256("docs v2"));
        vm.startPrank(treasury);
        reg.setDocuments(assetId, keccak256("docs v2"));
        reg.setIdentifier(assetId, "EIDR", "10.5240/CCCC");
        reg.setPayee(assetId, treasury, 2_500);
        vm.stopPrank();
        assertEq(reg.asset(assetId).docsManifest, keccak256("docs v2"));
        (string[] memory k, string[] memory v) = reg.identifiers(assetId);
        assertEq(k.length, 2);
        assertEq(v[0], "10.5240/CCCC");
    }

    // ---------------------------------------------------------------- licenses

    function test_buyStandardLicense() public {
        uint256 typeId = _publish(1_000e6, 1_000, false);
        _verify(studio);
        vm.prank(studio);
        uint256 id = lic.buy(typeId, TERMS, "Night Shift: The Game");
        assertEq(lic.ownerOf(id), studio);
        assertEq(usd.balanceOf(treasury), 1_000e6);
        assertEq(uint8(lic.status(id)), uint8(LicenseRegistry.Status.Active));
        LicenseRegistry.License memory l = lic.license(id);
        assertEq(l.termsHash, TERMS);
        assertEq(l.end, l.start + 1095 days);
        assertEq(l.work, "Night Shift: The Game");
        assertEq(lic.tokenURI(id), "https://tokenize.diamondz.one/api/licenses/84532/1");
    }

    function test_mustBeVerifiedAndSignExactTerms() public {
        uint256 typeId = _publish(250e6, 0, false);
        vm.prank(studio);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotVerified.selector, studio));
        lic.buy(typeId, TERMS, "clip");
        _verify(studio);
        vm.prank(studio);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.TermsMismatch.selector, TERMS, keccak256("old terms")));
        lic.buy(typeId, keccak256("old terms"), "clip");
    }

    function test_platformVerifierAllowedByHolder() public {
        uint256 typeId = _publish(250e6, 0, false);
        vm.prank(kyb);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotVerifier.selector, assetId));
        lic.verifyLicensee(assetId, studio, uint64(block.timestamp + 1 days));
        vm.prank(treasury);
        lic.setVerifier(assetId, kyb, true);
        vm.prank(kyb);
        lic.verifyLicensee(assetId, studio, uint64(block.timestamp + 1 days));
        vm.prank(studio);
        lic.buy(typeId, TERMS, "clip");
    }

    function test_licensesCantBeTransferred() public {
        uint256 typeId = _publish(0, 0, false);
        _verify(studio);
        vm.prank(studio);
        uint256 id = lic.buy(typeId, TERMS, "fan edit");
        vm.prank(studio);
        vm.expectRevert(LicenseRegistry.Soulbound.selector);
        lic.transferFrom(studio, stranger, id);
    }

    function test_byRequestOnlyThroughOffer() public {
        uint256 typeId = _publish(0, 0, true);
        _verify(studio);
        vm.prank(studio);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.ByRequestOnly.selector, typeId));
        lic.buy(typeId, TERMS, "LatAm streaming");

        LicenseRegistry.Offer memory o;
        o.licensee = studio;
        o.fee = 50_000e6;
        o.revShareBps = 1_500;
        o.durationDays = 730;
        o.termsHash = keccak256("Distribution LatAm v1");
        o.expiresAt = uint64(block.timestamp + 14 days);
        o.territory = "Latin America";
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotAssetOwner.selector, assetId));
        lic.makeOffer(typeId, o);
        vm.prank(treasury);
        uint256 offerId = lic.makeOffer(typeId, o);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.BadOffer.selector, offerId));
        lic.acceptOffer(offerId, o.termsHash, "x");
        vm.prank(studio);
        uint256 id = lic.acceptOffer(offerId, o.termsHash, "LatAm streaming");
        assertEq(lic.license(id).territory, "Latin America");
        assertEq(usd.balanceOf(treasury), 50_000e6);
        vm.prank(studio);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.BadOffer.selector, offerId));
        lic.acceptOffer(offerId, o.termsHash, "again");
    }

    function test_revenueShareAndRevocationAndExpiry() public {
        uint256 typeId = _publish(1_000e6, 1_000, false);
        _verify(studio);
        vm.prank(studio);
        uint256 id = lic.buy(typeId, TERMS, "game");
        vm.prank(studio);
        lic.reportRevenue(id, 20_000e6, "2027-Q1");
        assertEq(usd.balanceOf(treasury), 1_000e6 + 2_000e6);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.NotLicensee.selector, id));
        lic.reportRevenue(id, 1, "x");
        vm.prank(treasury);
        lic.revoke(id, "unpaid revenue share");
        assertEq(uint8(lic.status(id)), uint8(LicenseRegistry.Status.Revoked));

        vm.prank(studio);
        uint256 id2 = lic.buy(typeId, TERMS, "sequel");
        vm.warp(block.timestamp + 1096 days);
        assertEq(uint8(lic.status(id2)), uint8(LicenseRegistry.Status.Expired));
        assertEq(uint8(lic.status(999)), uint8(LicenseRegistry.Status.None));
    }

    function test_platformFeeOnlyFromAdmin() public {
        vm.prank(stranger);
        vm.expectRevert();
        lic.setPlatformFee(100, stranger);
        vm.prank(platform);
        vm.expectRevert(LicenseRegistry.BadInput.selector);
        lic.setPlatformFee(1_001, platform);
        vm.prank(platform);
        lic.setPlatformFee(250, platform);
        uint256 typeId = _publish(1_000e6, 0, false);
        _verify(studio);
        vm.prank(studio);
        lic.buy(typeId, TERMS, "clip");
        assertEq(usd.balanceOf(platform), 25e6);
        assertEq(usd.balanceOf(treasury), 975e6);
    }

    function test_retiredTemplateCantBeBought() public {
        uint256 typeId = _publish(0, 0, false);
        vm.prank(treasury);
        lic.setTypeActive(typeId, false);
        _verify(studio);
        vm.prank(studio);
        vm.expectRevert(abi.encodeWithSelector(LicenseRegistry.Inactive.selector, typeId));
        lic.buy(typeId, TERMS, "x");
    }

    // ---------------------------------------------------------------- card payments (receipts)

    function _receipt(uint256 pk, uint256 typeId, address licensee, bytes32 ref, uint256 amount, uint64 deadline)
        internal
        view
        returns (LicenseRegistry.CardReceipt memory r)
    {
        bytes32 d = lic.receiptDigest(typeId, licensee, TERMS, ref, amount, deadline);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(pk, d);
        r = LicenseRegistry.CardReceipt(ref, amount, deadline, abi.encodePacked(rr, ss, v));
    }

    function test_cardReceiptIssuesLicenseWithoutUsdc() public {
        (address agent, uint256 pk) = makeAddrAndKey("cardAgent");
        uint256 typeId = _publish(250e6, 0, false);
        _verify(studio);
        uint64 dl = uint64(block.timestamp + 1 hours);
        LicenseRegistry.CardReceipt memory r = _receipt(pk, typeId, studio, keccak256("pi_123"), 250e6, dl);
        vm.prank(studio);
        vm.expectRevert(LicenseRegistry.BadReceipt.selector); // holder hasn't allowed the agent yet
        lic.buyWithReceipt(typeId, TERMS, "Ad campaign", r);
        vm.prank(treasury);
        lic.setVerifier(assetId, agent, true);
        uint256 before = usd.balanceOf(studio);
        vm.prank(studio);
        uint256 id = lic.buyWithReceipt(typeId, TERMS, "Ad campaign", r);
        assertEq(lic.ownerOf(id), studio);
        assertEq(lic.license(id).feePaid, 250e6);
        assertEq(usd.balanceOf(studio), before); // paid by card, no USDC moved
        vm.prank(studio);
        vm.expectRevert(LicenseRegistry.BadReceipt.selector); // one license per payment
        lic.buyWithReceipt(typeId, TERMS, "again", r);
    }

    function test_cardReceiptRejections() public {
        (address agent, uint256 pk) = makeAddrAndKey("cardAgent");
        (, uint256 otherPk) = makeAddrAndKey("notAllowed");
        uint256 typeId = _publish(250e6, 0, false);
        vm.prank(treasury);
        lic.setVerifier(assetId, agent, true);
        _verify(studio);
        _verify(stranger);
        uint64 dl = uint64(block.timestamp + 1 hours);
        LicenseRegistry.CardReceipt memory low = _receipt(pk, typeId, studio, keccak256("a"), 249e6, dl);
        LicenseRegistry.CardReceipt memory forged = _receipt(otherPk, typeId, studio, keccak256("b"), 250e6, dl);
        LicenseRegistry.CardReceipt memory forStudio = _receipt(pk, typeId, studio, keccak256("c"), 250e6, dl);
        LicenseRegistry.CardReceipt memory expired = _receipt(pk, typeId, studio, keccak256("d"), 250e6, uint64(block.timestamp - 1));
        vm.startPrank(studio);
        vm.expectRevert(LicenseRegistry.BadReceipt.selector);
        lic.buyWithReceipt(typeId, TERMS, "x", low);
        vm.expectRevert(LicenseRegistry.BadReceipt.selector);
        lic.buyWithReceipt(typeId, TERMS, "x", forged);
        vm.expectRevert(LicenseRegistry.BadReceipt.selector);
        lic.buyWithReceipt(typeId, TERMS, "x", expired);
        vm.stopPrank();
        vm.prank(stranger); // a receipt is bound to its licensee
        vm.expectRevert(LicenseRegistry.BadReceipt.selector);
        lic.buyWithReceipt(typeId, TERMS, "x", forStudio);
    }
}
