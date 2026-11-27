// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice ERC-7943 (uRWA) non-fungible interface, per https://eips.ethereum.org/EIPS/eip-7943 (Final).
/// ERC-165 interface id: 0xbf1ef5fe
interface IERC7943NonFungible is IERC165 {
    event ForcedTransfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Frozen(address indexed account, uint256 indexed tokenId, bool indexed frozenStatus);

    error ERC7943CannotSend(address account);
    error ERC7943CannotReceive(address account);
    error ERC7943CannotTransfer(address from, address to, uint256 tokenId);
    error ERC7943InsufficientUnfrozenBalance(address account, uint256 tokenId);

    function forcedTransfer(address from, address to, uint256 tokenId) external returns (bool result);
    function setFrozenTokens(address account, uint256 tokenId, bool frozenStatus) external returns (bool result);
    function canSend(address account) external view returns (bool allowed);
    function canReceive(address account) external view returns (bool allowed);
    function getFrozenTokens(address account, uint256 tokenId) external view returns (bool frozenStatus);
    function canTransfer(address from, address to, uint256 tokenId) external view returns (bool allowed);
}
