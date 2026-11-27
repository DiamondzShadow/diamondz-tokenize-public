// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The slices of the audited ERC-3643 suite (T-REX 4.1.6 / OnchainID 2.2.1) that our 0.8.28 code talks to.
///         Upstream pins 0.8.17 exactly, so we can't import its types; these mirror its external signatures.

interface ITREXToken {
    function mint(address to, uint256 amount) external;
    function decimals() external view returns (uint8);
    function identityRegistry() external view returns (address);
    function compliance() external view returns (address);
    function owner() external view returns (address);
    function addAgent(address agent) external;
    function isAgent(address agent) external view returns (bool);
    function unpause() external;
    function paused() external view returns (bool);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function onchainID() external view returns (address);
    function setAddressFrozen(address user, bool freeze) external;
    function forcedTransfer(address from, address to, uint256 amount) external returns (bool);
    function transferOwnership(address newOwner) external;
}

interface ITREXIdentityRegistry {
    function isVerified(address user) external view returns (bool);
    function registerIdentity(address user, address identity, uint16 country) external;
    function deleteIdentity(address user) external;
    function identity(address user) external view returns (address);
    function identityStorage() external view returns (address);
    function topicsRegistry() external view returns (address);
    function issuersRegistry() external view returns (address);
    function addAgent(address agent) external;
    function isAgent(address agent) external view returns (bool);
    function owner() external view returns (address);
}

interface ITREXFactory {
    struct TokenDetails {
        address owner;
        string name;
        string symbol;
        uint8 decimals;
        address irs;
        address ONCHAINID;
        address[] irAgents;
        address[] tokenAgents;
        address[] complianceModules;
        bytes[] complianceSettings;
    }

    struct ClaimDetails {
        uint256[] claimTopics;
        address[] issuers;
        uint256[][] issuerClaims;
    }

    function deployTREXSuite(string memory salt, TokenDetails calldata tokenDetails, ClaimDetails calldata claimDetails)
        external;
    function getToken(string calldata salt) external view returns (address);
    function recoverContractOwnership(address target, address newOwner) external;
    function getImplementationAuthority() external view returns (address);
    function owner() external view returns (address);
}

interface ITREXImplementationAuthority {
    function changeImplementationAuthority(address token, address newImplementationAuthority) external;
    function owner() external view returns (address);
    function isReferenceContract() external view returns (bool);
}

interface ITREXProxy {
    function getImplementationAuthority() external view returns (address);
}

interface IOwnableLike {
    function owner() external view returns (address);
}

interface IIdFactory {
    function createIdentityWithManagementKeys(address wallet, string memory salt, bytes32[] memory managementKeys)
        external
        returns (address);
    function getIdentity(address wallet) external view returns (address);
}

interface IOnchainIdentity {
    function addClaim(
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes memory signature,
        bytes memory data,
        string memory uri
    ) external returns (bytes32);
    function keyHasPurpose(bytes32 key, uint256 purpose) external view returns (bool);
}

interface IClaimIssuer {
    function isClaimValid(address identity, uint256 topic, bytes calldata sig, bytes calldata data)
        external
        view
        returns (bool);
    function revokeClaimBySignature(bytes calldata signature) external;
}

interface ITREXPlatform {
    struct Core {
        address idFactory;
        address implementationAuthority;
        address trexFactory;
        address iaFactory;
    }

    function deployCore() external returns (Core memory);
    function newClaimIssuer(address issuerKey) external returns (address);
}
