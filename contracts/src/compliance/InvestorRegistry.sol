// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Chainalysis on-chain sanctions oracle (https://go.chainalysis.com/chainalysis-oracle-docs.html).
interface ISanctionsList {
    function isSanctioned(address addr) external view returns (bool);
}

/// @title InvestorRegistry
/// @notice One registry per tenant. Records which wallets passed KYC/AML (and, optionally, accreditation),
///         their country and when the verification expires. Tokens and vaults read it to gate transfers.
///         An optional sanctions oracle overrides everything: a sanctioned wallet is never verified.
/// @dev Verification itself happens off-chain (e.g. Sumsub); a VERIFIER_ROLE keeper writes the result here.
///      No personal data is stored on chain: only a status, an ISO-3166 numeric country code and an expiry.
contract InvestorRegistry is AccessControl {
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    struct Investor {
        bool verified;
        bool accredited;
        uint16 country; // ISO-3166-1 numeric
        uint64 expiresAt; // unix seconds; 0 = never
    }

    mapping(address => Investor) private _investors;
    /// @notice Countries whose residents may not hold tokens (ISO-3166-1 numeric => blocked).
    mapping(uint16 => bool) public countryBlocked;
    /// @notice Optional sanctions oracle. When set, sanctioned wallets are never verified, even if listed.
    ISanctionsList public sanctionsOracle;

    event InvestorUpdated(address indexed wallet, bool verified, bool accredited, uint16 country, uint64 expiresAt);
    event InvestorRemoved(address indexed wallet);
    event CountryBlocked(uint16 indexed country, bool blocked);
    event SanctionsOracleUpdated(address oracle);

    error ZeroAddress();
    error LengthMismatch();
    error Sanctioned(address wallet);

    constructor(address admin, address verifier, address sanctionsOracle_) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (verifier != address(0)) _grantRole(VERIFIER_ROLE, verifier);
        sanctionsOracle = ISanctionsList(sanctionsOracle_);
        emit SanctionsOracleUpdated(sanctionsOracle_);
    }

    function setSanctionsOracle(address oracle) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sanctionsOracle = ISanctionsList(oracle);
        emit SanctionsOracleUpdated(oracle);
    }

    /// @notice True if the oracle flags the wallet, or if the oracle call fails (fail closed).
    function isSanctioned(address wallet) public view returns (bool) {
        if (address(sanctionsOracle) == address(0)) return false;
        try sanctionsOracle.isSanctioned(wallet) returns (bool s) {
            return s;
        } catch {
            return true;
        }
    }

    function setInvestor(address wallet, bool accredited, uint16 country, uint64 expiresAt)
        public
        onlyRole(VERIFIER_ROLE)
    {
        if (wallet == address(0)) revert ZeroAddress();
        if (isSanctioned(wallet)) revert Sanctioned(wallet);
        _investors[wallet] = Investor(true, accredited, country, expiresAt);
        emit InvestorUpdated(wallet, true, accredited, country, expiresAt);
    }

    function setInvestors(
        address[] calldata wallets,
        bool[] calldata accredited,
        uint16[] calldata countries,
        uint64[] calldata expiresAt
    ) external onlyRole(VERIFIER_ROLE) {
        uint256 n = wallets.length;
        if (accredited.length != n || countries.length != n || expiresAt.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            setInvestor(wallets[i], accredited[i], countries[i], expiresAt[i]);
        }
    }

    function removeInvestor(address wallet) external onlyRole(VERIFIER_ROLE) {
        delete _investors[wallet];
        emit InvestorRemoved(wallet);
    }

    function setCountryBlocked(uint16 country, bool blocked) external onlyRole(DEFAULT_ADMIN_ROLE) {
        countryBlocked[country] = blocked;
        emit CountryBlocked(country, blocked);
    }

    function investor(address wallet) external view returns (Investor memory) {
        return _investors[wallet];
    }

    /// @notice True when the wallet is verified, unexpired and not in a blocked country.
    function isVerified(address wallet) public view returns (bool) {
        Investor memory i = _investors[wallet];
        if (!i.verified) return false;
        if (i.expiresAt != 0 && i.expiresAt < block.timestamp) return false;
        if (countryBlocked[i.country]) return false;
        return !isSanctioned(wallet);
    }

    function isAccredited(address wallet) external view returns (bool) {
        return isVerified(wallet) && _investors[wallet].accredited;
    }
}
