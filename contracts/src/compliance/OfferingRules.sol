// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {InvestorRegistry} from "./InvestorRegistry.sol";

interface IHasRegistry {
    function registry() external view returns (InvestorRegistry);
}

/// @title OfferingRules
/// @notice One offering's transfer rules, checked by its token on every mint, transfer and burn (wizard step 5,
///         design W11). Rules here are PER OFFERING, on top of the workspace-wide InvestorRegistry, so a Reg S
///         offering and a 506(c) offering from the same issuer can differ.
///
///         - accreditedOnly: every receiver must be accredited in the registry (Reg D 506(c)).
///         - countries: allow list or block list on the receiver's registry country.
///         - lockup: tokens can't move for `lockup` seconds after they were issued to a wallet (each issuance is its
///           own lot). Shortening it only takes effect LOOSEN_DELAY after it is scheduled. Buying on the secondary
///           market does not restart it (the seller's holding period carries over, as under Rule 144).
///           `lockBurns` extends it to holder-initiated burns (fund redemptions, carbon retirement).
///         - maxHolders: no new holder once this many wallets hold a balance.
///         - maxBalance: no wallet may hold more than this many units.
///         - resaleApproval: holder-to-holder transfers need the issuer's prior approval (right of first refusal).
///         - maturity: from this time on, nothing can be issued or transferred; redemptions (burns) still work.
///
///         Privileged moves (court-ordered forced transfers, issuer burns) skip the rules but keep the bookkeeping
///         (holder count, lots) correct.
/// @dev Deploy, then `bindToken` once from the admin BEFORE anything is minted (the holder count starts at zero).
///      Units are whatever the token counts: ERC-20 base units, ERC-721 NFTs, units of the ERC-1155 offering item.
contract OfferingRules is AccessControl {
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
    uint64 public constant LOOSEN_DELAY = 7 days;
    /// @notice Lots kept per wallet; past this, a new lot is merged into the newest one (the later date wins, so
    ///         merging can only lock longer, never release early).
    uint256 public constant MAX_LOTS = 64;

    enum Code {
        Ok,
        NotAccredited,
        CountryNotAllowed,
        Locked,
        MaxHolders,
        MaxBalance,
        NeedsApproval,
        Matured
    }

    enum CountryMode {
        None,
        Allow,
        Block
    }

    struct Config {
        address admin;
        bool accreditedOnly;
        CountryMode countryMode;
        uint16[] countries;
        uint64 lockup;
        bool lockBurns;
        uint32 maxHolders;
        uint256 maxBalance;
        bool resaleApproval;
        uint64 maturity;
    }

    struct Lot {
        uint192 amount;
        uint64 issuedAt;
    }

    address public token;

    bool public accreditedOnly;
    CountryMode public countryMode;
    mapping(uint16 => bool) public countryListed;
    uint16[] private _countries;
    uint64 public lockup;
    bool public lockBurns;
    uint32 public maxHolders;
    uint256 public maxBalance;
    bool public resaleApproval;
    uint64 public maturity;

    uint64 public pendingLockup;
    uint64 public pendingLockupAt; // 0 = nothing pending

    uint32 public holderCount;
    mapping(address => Lot[]) private _lots;
    /// @notice Remaining approved amount for a holder-to-holder transfer, keyed by keccak256(from, to).
    mapping(bytes32 => uint256) public approvedAmount;

    event TokenBound(address indexed token);
    event AccreditedOnlySet(bool on);
    event CountriesSet(CountryMode mode, uint16[] countries);
    event LockupSet(uint64 seconds_);
    event LockupScheduled(uint64 seconds_, uint64 effectiveAt);
    event LockBurnsSet(bool on);
    event MaxHoldersSet(uint32 max);
    event MaxBalanceSet(uint256 max);
    event ResaleApprovalSet(bool on);
    event MaturitySet(uint64 at);
    event TransferApproved(address indexed from, address indexed to, uint256 amount);

    error OnlyToken();
    error AlreadyBound();
    error ZeroAddress();
    error RuleViolation(Code code);
    error NothingPending();
    error NotYet(uint64 effectiveAt);
    error UseSchedule();

    constructor(Config memory c) {
        if (c.admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
        _grantRole(APPROVER_ROLE, c.admin);
        accreditedOnly = c.accreditedOnly;
        _setCountries(c.countryMode, c.countries);
        lockup = c.lockup;
        lockBurns = c.lockBurns;
        maxHolders = c.maxHolders;
        maxBalance = c.maxBalance;
        resaleApproval = c.resaleApproval;
        maturity = c.maturity;
    }

    // ---------------------------------------------------------------- setup

    function bindToken(address t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (t == address(0)) revert ZeroAddress();
        if (token != address(0)) revert AlreadyBound();
        token = t;
        emit TokenBound(t);
    }

    // ---------------------------------------------------------------- issuer settings (each one public on chain)

    function setAccreditedOnly(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        accreditedOnly = on;
        emit AccreditedOnlySet(on);
    }

    function setCountries(CountryMode mode, uint16[] calldata list) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setCountries(mode, list);
    }

    /// @notice Lengthen the holding period now, or schedule a shorter one (takes effect after LOOSEN_DELAY, so
    ///         holders and buyers can see it coming). A new schedule replaces any pending one.
    function scheduleLockup(uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (seconds_ >= lockup) {
            lockup = seconds_;
            pendingLockupAt = 0;
            emit LockupSet(seconds_);
            return;
        }
        pendingLockup = seconds_;
        pendingLockupAt = uint64(block.timestamp) + LOOSEN_DELAY;
        emit LockupScheduled(seconds_, pendingLockupAt);
    }

    /// @notice Anyone may apply a scheduled shorter holding period once its delay has passed.
    function applyLockup() external {
        if (pendingLockupAt == 0) revert NothingPending();
        if (block.timestamp < pendingLockupAt) revert NotYet(pendingLockupAt);
        lockup = pendingLockup;
        pendingLockupAt = 0;
        emit LockupSet(lockup);
    }

    function setLockBurns(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        lockBurns = on;
        emit LockBurnsSet(on);
    }

    function setMaxHolders(uint32 max) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxHolders = max;
        emit MaxHoldersSet(max);
    }

    function setMaxBalance(uint256 max) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxBalance = max;
        emit MaxBalanceSet(max);
    }

    function setResaleApproval(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        resaleApproval = on;
        emit ResaleApprovalSet(on);
    }

    function setMaturity(uint64 at) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maturity = at;
        emit MaturitySet(at);
    }

    /// @notice Approve one holder-to-holder transfer (resale approval). Replaces any earlier approval for the pair.
    function approveTransfer(address from, address to, uint256 amount) external onlyRole(APPROVER_ROLE) {
        approvedAmount[keccak256(abi.encode(from, to))] = amount;
        emit TransferApproved(from, to, amount);
    }

    // ---------------------------------------------------------------- views

    function countries() external view returns (uint16[] memory) {
        return _countries;
    }

    /// @notice Units of `account` still inside the holding period (capped at `balance`).
    function lockedOf(address account, uint256 balance) public view returns (uint256 locked) {
        if (lockup == 0) return 0;
        Lot[] storage lots = _lots[account];
        for (uint256 i; i < lots.length; ++i) {
            if (uint256(lots[i].issuedAt) + lockup > block.timestamp) locked += lots[i].amount;
        }
        if (locked > balance) locked = balance;
    }

    /// @notice When `account`'s last locked lot unlocks (0 = nothing locked).
    function unlocksAt(address account) external view returns (uint64 at) {
        if (lockup == 0) return 0;
        Lot[] storage lots = _lots[account];
        for (uint256 i; i < lots.length; ++i) {
            uint64 r = lots[i].issuedAt + lockup;
            if (r > block.timestamp && r > at) at = r;
        }
    }

    /// @notice Whether `account` may hold the token at all under these rules (accreditation and country).
    function canHold(address account) public view returns (bool) {
        return _holdCode(account) == Code.Ok;
    }

    /// @notice The rule a move would break, or Code.Ok. Balances are BEFORE the move, in the token's units.
    function check(address from, address to, uint256 amount, uint256 fromBal, uint256 toBal)
        public
        view
        returns (Code)
    {
        bool matured = maturity != 0 && block.timestamp >= maturity;
        if (to == address(0)) {
            // burn / redemption: allowed after maturity; holder burns respect the lockup when lockBurns is on
            if (lockBurns && amount + lockedOf(from, fromBal) > fromBal) return Code.Locked;
            return Code.Ok;
        }
        if (matured) return Code.Matured;
        Code c = _holdCode(to);
        if (c != Code.Ok) return c;
        if (from != address(0)) {
            if (amount + lockedOf(from, fromBal) > fromBal) return Code.Locked;
            if (resaleApproval && approvedAmount[keccak256(abi.encode(from, to))] < amount) return Code.NeedsApproval;
        }
        if (maxBalance != 0 && toBal + amount > maxBalance) return Code.MaxBalance;
        if (maxHolders != 0 && amount != 0 && toBal == 0) {
            // A new holder; the sender leaving at the same time keeps the count level.
            bool senderLeaves = from != address(0) && fromBal == amount;
            if (!senderLeaves && holderCount >= maxHolders) return Code.MaxHolders;
        }
        return Code.Ok;
    }

    // ---------------------------------------------------------------- token hook

    /// @notice Called by the token before every balance change. Reverts on a rule violation unless `privileged`
    ///         (forced transfer, issuer burn); always updates the holder count and lots.
    function onTransfer(address from, address to, uint256 amount, uint256 fromBal, uint256 toBal, bool privileged)
        external
    {
        if (msg.sender != token) revert OnlyToken();
        if (!privileged) {
            Code c = check(from, to, amount, fromBal, toBal);
            if (c != Code.Ok) revert RuleViolation(c);
            if (resaleApproval && from != address(0) && to != address(0)) {
                approvedAmount[keccak256(abi.encode(from, to))] -= amount;
            }
        }
        // Nothing moves on a self-transfer: counting it would drop the holder from the count, and trimming would
        // erase their locked lots.
        if (amount == 0 || from == to) return;
        if (to != address(0) && toBal == 0) ++holderCount;
        if (from != address(0) && fromBal == amount && holderCount != 0) --holderCount;
        if (from == address(0)) {
            _addLot(to, amount);
        } else if (privileged) {
            _trimLots(from, fromBal - amount);
        }
    }

    // ---------------------------------------------------------------- internals

    function _holdCode(address account) internal view returns (Code) {
        bool needsRegistry = accreditedOnly || countryMode != CountryMode.None;
        if (!needsRegistry) return Code.Ok;
        InvestorRegistry reg = IHasRegistry(token).registry();
        if (accreditedOnly && !reg.isAccredited(account)) return Code.NotAccredited;
        if (countryMode != CountryMode.None) {
            bool listed = countryListed[reg.investor(account).country];
            if (countryMode == CountryMode.Allow ? !listed : listed) return Code.CountryNotAllowed;
        }
        return Code.Ok;
    }

    function _setCountries(CountryMode mode, uint16[] memory list) internal {
        for (uint256 i; i < _countries.length; ++i) countryListed[_countries[i]] = false;
        delete _countries;
        for (uint256 i; i < list.length; ++i) {
            countryListed[list[i]] = true;
            _countries.push(list[i]);
        }
        countryMode = mode;
        emit CountriesSet(mode, list);
    }

    function _addLot(address to, uint256 amount) internal {
        if (lockup == 0) return; // no holding period: nothing to track
        Lot[] storage lots = _lots[to];
        // Drop lots already past the holding period (cheap upkeep; keeps the array short).
        uint256 w;
        for (uint256 i; i < lots.length; ++i) {
            if (uint256(lots[i].issuedAt) + lockup > block.timestamp) lots[w++] = lots[i];
        }
        while (lots.length > w) lots.pop();
        if (lots.length >= MAX_LOTS) {
            Lot storage last = lots[lots.length - 1];
            last.amount += uint192(amount);
            last.issuedAt = uint64(block.timestamp);
        } else {
            lots.push(Lot(uint192(amount), uint64(block.timestamp)));
        }
    }

    /// @dev After a privileged move, cap the still-locked lots at the remaining balance, newest first. Expired lots
    ///      are ignored: they hold no lock, and counting them would let a move erase a locked lot.
    function _trimLots(address from, uint256 remaining) internal {
        if (lockup == 0) return;
        Lot[] storage lots = _lots[from];
        uint256 sum;
        for (uint256 j; j < lots.length; ++j) {
            if (uint256(lots[j].issuedAt) + lockup > block.timestamp) sum += lots[j].amount;
        }
        uint256 i = lots.length;
        while (sum > remaining && i > 0) {
            --i;
            if (uint256(lots[i].issuedAt) + lockup <= block.timestamp) continue;
            uint256 cut = sum - remaining;
            if (cut >= lots[i].amount) {
                sum -= lots[i].amount;
                lots[i].amount = 0;
            } else {
                lots[i].amount -= uint192(cut);
                sum = remaining;
            }
        }
    }
}
