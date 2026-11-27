// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSD
/// @notice TESTNET ONLY. A 6-decimal play-money stablecoin anyone can mint (capped per call) so issuers and
///         investors can rehearse a full purchase. The platform refuses to deploy it on mainnets.
contract TestUSD is ERC20 {
    uint256 public constant MAX_MINT = 100_000e6;

    error MintTooLarge();

    constructor() ERC20("Test USD (no value)", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge();
        _mint(to, amount);
    }
}
