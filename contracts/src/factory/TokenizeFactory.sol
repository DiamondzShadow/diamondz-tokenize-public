// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {InvestorRegistry} from "../compliance/InvestorRegistry.sol";
import {PermissionedToken} from "../tokens/PermissionedToken.sol";
import {PermissionedVault} from "../vaults/PermissionedVault.sol";

/// @title TokenizeFactory
/// @notice Deploys per-tenant registries and per-asset tokens/vaults. Everything it deploys is owned by the
///         `admin` passed in (the issuer's multisig); the factory keeps no rights over deployed contracts.
/// @dev Tenants and assets are indexed by emitted events, which the platform API reads.
contract TokenizeFactory {
    event RegistryDeployed(bytes32 indexed tenantId, address registry, address admin, address verifier);
    event TokenDeployed(bytes32 indexed tenantId, bytes32 indexed assetId, address token, address admin);
    event VaultDeployed(bytes32 indexed tenantId, bytes32 indexed assetId, address vault, address admin);

    function deployRegistry(bytes32 tenantId, address admin, address verifier, address sanctionsOracle)
        external
        returns (address r)
    {
        r = address(new InvestorRegistry(admin, verifier, sanctionsOracle));
        emit RegistryDeployed(tenantId, r, admin, verifier);
    }

    function deployToken(bytes32 tenantId, bytes32 assetId, PermissionedToken.Config calldata c)
        external
        returns (address t)
    {
        t = address(new PermissionedToken(c));
        emit TokenDeployed(tenantId, assetId, t, c.admin);
    }

    function deployVault(
        bytes32 tenantId,
        bytes32 assetId,
        IERC20 asset,
        string calldata name,
        string calldata symbol,
        address admin,
        address registry,
        uint16 maxNavChangeBps
    ) external returns (address v) {
        v = address(
            new PermissionedVault(
                PermissionedVault.Config(asset, name, symbol, admin, registry, maxNavChangeBps, address(0), 0, address(0))
            )
        );
        emit VaultDeployed(tenantId, assetId, v, admin);
    }
}
