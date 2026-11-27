// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Who administers a token, across the token styles the platform deploys.
library TokenAdmin {
    /// @notice True when `who` holds DEFAULT_ADMIN_ROLE on an AccessControl token (ERC-7943 / ERC-4626 / ERC-1155 /
    ///         ERC-721 offerings) or is `owner()` of an Ownable token (ERC-3643 / T-REX offerings). Never reverts:
    ///         an address with neither interface (or no code) has no admin.
    function isAdmin(address token, address who) internal view returns (bool) {
        (bool ok, bytes memory r) =
            token.staticcall(abi.encodeWithSelector(IAccessControl.hasRole.selector, bytes32(0), who));
        if (ok && r.length >= 32 && abi.decode(r, (bool))) return true;
        (ok, r) = token.staticcall(abi.encodeWithSignature("owner()"));
        return ok && r.length >= 32 && abi.decode(r, (address)) == who;
    }
}
