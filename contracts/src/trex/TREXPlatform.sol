// SPDX-License-Identifier: GPL-3.0
//
// Platform deployer for the audited ERC-3643 suite (T-REX 4.1.6 + OnchainID 2.2.1, both GPL-3.0, pinned submodules).
//
// T-REX and OnchainID pin `pragma solidity 0.8.17` EXACTLY, so nothing at our 0.8.28 can import them. This file is
// the only one that touches upstream types; everything else talks to the deployed suite through small interfaces.
// It only `new`s upstream contracts and hands ownership to its caller: nothing upstream is modified, so the audit
// still describes the bytecode that lands on chain. Do not add offering logic here.
//
// Used by the forge tests. Production deploys go through `web/scripts/trex.ts`, which deploys the same contracts one
// by one from their own artifacts (one transaction each, so no chain's block gas limit is a problem) in this order.
pragma solidity 0.8.17;

import {Token} from "@tokeny/t-rex/contracts/token/Token.sol";
import {IdentityRegistry} from "@tokeny/t-rex/contracts/registry/implementation/IdentityRegistry.sol";
import {IdentityRegistryStorage} from "@tokeny/t-rex/contracts/registry/implementation/IdentityRegistryStorage.sol";
import {ClaimTopicsRegistry} from "@tokeny/t-rex/contracts/registry/implementation/ClaimTopicsRegistry.sol";
import {TrustedIssuersRegistry} from "@tokeny/t-rex/contracts/registry/implementation/TrustedIssuersRegistry.sol";
import {ModularCompliance} from "@tokeny/t-rex/contracts/compliance/modular/ModularCompliance.sol";
import {TREXFactory} from "@tokeny/t-rex/contracts/factory/TREXFactory.sol";
import {TREXImplementationAuthority} from "@tokeny/t-rex/contracts/proxy/authority/TREXImplementationAuthority.sol";
import {ITREXImplementationAuthority} from "@tokeny/t-rex/contracts/proxy/authority/ITREXImplementationAuthority.sol";
import {IAFactory} from "@tokeny/t-rex/contracts/proxy/authority/IAFactory.sol";

import {Identity} from "@onchain-id/solidity/contracts/Identity.sol";
import {ClaimIssuer} from "@onchain-id/solidity/contracts/ClaimIssuer.sol";
import {IdFactory} from "@onchain-id/solidity/contracts/factory/IdFactory.sol";
import {ImplementationAuthority} from "@onchain-id/solidity/contracts/proxy/ImplementationAuthority.sol";

interface IOwnableV4 {
    function transferOwnership(address newOwner) external;
}

contract TREXPlatform {
    uint8 internal constant MAJOR = 4;
    uint8 internal constant MINOR = 1;
    uint8 internal constant PATCH = 6;

    struct Core {
        address idFactory; // OnchainID factory: investor + token identities
        address implementationAuthority; // reference T-REX authority (platform-managed upgrades)
        address trexFactory; // deploys each offering's suite (owner-only)
        address iaFactory; // gives an offering its own authority (issuer-managed upgrades)
    }

    /// @notice Deploys the per-chain platform core and hands every ownership to `msg.sender`.
    function deployCore() external returns (Core memory c) {
        // OnchainID: identity implementation (library mode), its authority, the identity factory.
        Identity identityImpl = new Identity(address(this), true);
        ImplementationAuthority idImplAuth = new ImplementationAuthority(address(identityImpl));
        IdFactory idFactory = new IdFactory(address(idImplAuth));
        c.idFactory = address(idFactory);

        // T-REX logic contracts; each offering's proxies resolve through an implementation authority.
        ITREXImplementationAuthority.TREXContracts memory impls = ITREXImplementationAuthority.TREXContracts({
            tokenImplementation: address(new Token()),
            ctrImplementation: address(new ClaimTopicsRegistry()),
            irImplementation: address(new IdentityRegistry()),
            irsImplementation: address(new IdentityRegistryStorage()),
            tirImplementation: address(new TrustedIssuersRegistry()),
            mcImplementation: address(new ModularCompliance())
        });
        TREXImplementationAuthority ia = new TREXImplementationAuthority(true, address(0), address(0));
        ia.addAndUseTREXVersion(ITREXImplementationAuthority.Version({major: MAJOR, minor: MINOR, patch: PATCH}), impls);
        c.implementationAuthority = address(ia);

        TREXFactory factory = new TREXFactory(address(ia), address(idFactory));
        c.trexFactory = address(factory);
        ia.setTREXFactory(address(factory));
        IAFactory iaFactory = new IAFactory(address(factory));
        c.iaFactory = address(iaFactory);
        ia.setIAFactory(address(iaFactory));
        // Lets the T-REX factory mint each token's own identity.
        idFactory.addTokenFactory(address(factory));

        IOwnableV4(c.trexFactory).transferOwnership(msg.sender);
        IOwnableV4(c.implementationAuthority).transferOwnership(msg.sender);
        IOwnableV4(c.idFactory).transferOwnership(msg.sender);
    }

    /// @notice Deploys an issuer's claim issuer, managed by `issuerKey` (the issuer's wallet). Its management key can
    ///         sign KYC claims; the platform holds no key on it. Stateless utility: anyone may call.
    function newClaimIssuer(address issuerKey) external returns (address) {
        return address(new ClaimIssuer(issuerKey));
    }
}
