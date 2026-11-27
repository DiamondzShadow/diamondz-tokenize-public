// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title StellarAssetAnchor
/// @notice The EVM identity of one Stellar (Soroban) offering. Compliance, balances and every transfer stay in the
///         Soroban contracts; this anchor only gives the offering an address on the EVM side so it can be registered in
///         AssetOracle (its issuer is `owner()`, which AssetOracle.register accepts) and receive Chainlink CRE marks and
///         attestations. CRE reads Stellar over RPC and writes here; it cannot write to Stellar.
contract StellarAssetAnchor is Ownable2Step {
    /// "testnet" or "mainnet".
    string public network;
    /// Soroban contract id of the token (strkey, 56 chars, starts with "C").
    string public stellarContract;

    error BadNetwork();
    error BadContractId();

    event Anchored(string network, string stellarContract);

    constructor(string memory network_, string memory stellarContract_, address issuer) Ownable(issuer) {
        bytes32 n = keccak256(bytes(network_));
        if (n != keccak256("testnet") && n != keccak256("mainnet")) revert BadNetwork();
        bytes memory c = bytes(stellarContract_);
        if (c.length != 56 || c[0] != "C") revert BadContractId();
        for (uint256 i; i < 56; ++i) {
            bytes1 ch = c[i];
            // strkey alphabet: base32 (A-Z, 2-7)
            if (!((ch >= "A" && ch <= "Z") || (ch >= "2" && ch <= "7"))) revert BadContractId();
        }
        network = network_;
        stellarContract = stellarContract_;
        emit Anchored(network_, stellarContract_);
    }
}
