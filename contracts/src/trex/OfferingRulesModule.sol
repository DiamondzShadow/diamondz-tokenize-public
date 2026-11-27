// SPDX-License-Identifier: GPL-3.0
//
// ERC-3643 (T-REX 4.1.6) compliance module carrying the same per-offering rules as OfferingRules.sol (wizard step 5,
// design W11): holding period per issuance lot, max holders, max balance per wallet, issuer-approved resales,
// maturity, and a country allow/block list. Accreditation is NOT here: on ERC-3643 it is a required claim topic on
// the offering's own identity registry, which is already per offering.
//
// T-REX ships no lockup, holder-count or maturity module (4.1.6 modules: CountryAllow/Restrict, MaxBalance,
// SupplyLimit, TimeTransfersLimits, ConditionalTransfer, ...), so this is our own code on top of the audited
// AbstractModule. It is NOT covered by the T-REX audit. GPL-3.0 because it derives from T-REX.
//
// One instance per chain serves every offering: all state is keyed by the calling compliance contract, and every
// setter must arrive through that compliance's `callModuleFunction` (owner = the issuer).
//
// Hook order in T-REX Token: mint checks canTransfer(0, to) then calls created(); transfer checks canTransfer then
// calls transferred(); forcedTransfer skips the check but calls transferred(); burn calls destroyed() with no check.
// So court-ordered moves and issuer burns bypass the rules, and the action hooks keep the bookkeeping right.
pragma solidity 0.8.17;

import {AbstractModule} from "@tokeny/t-rex/contracts/compliance/modular/modules/AbstractModule.sol";

interface IModularComplianceView {
    function getTokenBound() external view returns (address);
}

interface ITokenView {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function identityRegistry() external view returns (address);
}

interface IIdentityRegistryCountry {
    function investorCountry(address) external view returns (uint16);
}

contract OfferingRulesModule is AbstractModule {
    uint64 public constant LOOSEN_DELAY = 7 days;
    uint256 public constant MAX_LOTS = 64;

    uint8 public constant COUNTRY_NONE = 0;
    uint8 public constant COUNTRY_ALLOW = 1;
    uint8 public constant COUNTRY_BLOCK = 2;

    struct Settings {
        uint64 lockup;
        uint64 pendingLockup;
        uint64 pendingLockupAt;
        uint64 maturity;
        uint32 maxHolders;
        uint32 holderCount;
        uint8 countryMode;
        bool resaleApproval;
        uint256 maxBalance;
    }

    struct Lot {
        uint192 amount;
        uint64 issuedAt;
    }

    mapping(address => Settings) private _s; // compliance => settings
    mapping(address => mapping(uint16 => bool)) public countryListed; // compliance => country => listed
    mapping(address => uint16[]) private _countries;
    mapping(address => mapping(address => Lot[])) private _lots; // compliance => wallet => lots
    mapping(address => mapping(bytes32 => uint256)) public approvedAmount; // compliance => keccak(from,to) => amount

    event LockupSet(address indexed compliance, uint64 seconds_);
    event LockupScheduled(address indexed compliance, uint64 seconds_, uint64 effectiveAt);
    event MaxHoldersSet(address indexed compliance, uint32 max);
    event MaxBalanceSet(address indexed compliance, uint256 max);
    event ResaleApprovalSet(address indexed compliance, bool on);
    event MaturitySet(address indexed compliance, uint64 at);
    event CountriesSet(address indexed compliance, uint8 mode, uint16[] countries);
    event TransferApproved(address indexed compliance, address indexed from, address indexed to, uint256 amount);

    // ---------------------------------------------------------------- settings (via compliance.callModuleFunction)

    /// @notice Lengthen now, or schedule a shorter holding period that applies after LOOSEN_DELAY.
    function scheduleLockup(uint64 seconds_) external onlyComplianceCall {
        Settings storage s = _s[msg.sender];
        if (seconds_ >= s.lockup) {
            s.lockup = seconds_;
            s.pendingLockupAt = 0;
            emit LockupSet(msg.sender, seconds_);
            return;
        }
        s.pendingLockup = seconds_;
        s.pendingLockupAt = uint64(block.timestamp) + LOOSEN_DELAY;
        emit LockupScheduled(msg.sender, seconds_, s.pendingLockupAt);
    }

    /// @notice Anyone may apply a compliance's scheduled shorter holding period once its delay has passed.
    function applyLockup(address compliance) external {
        Settings storage s = _s[compliance];
        require(s.pendingLockupAt != 0, "nothing pending");
        require(block.timestamp >= s.pendingLockupAt, "not yet");
        s.lockup = s.pendingLockup;
        s.pendingLockupAt = 0;
        emit LockupSet(compliance, s.lockup);
    }

    function setMaxHolders(uint32 max) external onlyComplianceCall {
        _s[msg.sender].maxHolders = max;
        emit MaxHoldersSet(msg.sender, max);
    }

    function setMaxBalance(uint256 max) external onlyComplianceCall {
        _s[msg.sender].maxBalance = max;
        emit MaxBalanceSet(msg.sender, max);
    }

    function setResaleApproval(bool on) external onlyComplianceCall {
        _s[msg.sender].resaleApproval = on;
        emit ResaleApprovalSet(msg.sender, on);
    }

    function setMaturity(uint64 at) external onlyComplianceCall {
        _s[msg.sender].maturity = at;
        emit MaturitySet(msg.sender, at);
    }

    function setCountries(uint8 mode, uint16[] calldata list) external onlyComplianceCall {
        require(mode <= COUNTRY_BLOCK, "bad mode");
        uint16[] storage cur = _countries[msg.sender];
        for (uint256 i; i < cur.length; ++i) countryListed[msg.sender][cur[i]] = false;
        delete _countries[msg.sender];
        for (uint256 i; i < list.length; ++i) {
            countryListed[msg.sender][list[i]] = true;
            cur.push(list[i]);
        }
        _s[msg.sender].countryMode = mode;
        emit CountriesSet(msg.sender, mode, list);
    }

    function approveTransfer(address from, address to, uint256 amount) external onlyComplianceCall {
        approvedAmount[msg.sender][keccak256(abi.encode(from, to))] = amount;
        emit TransferApproved(msg.sender, from, to, amount);
    }

    // ---------------------------------------------------------------- views

    function settings(address compliance) external view returns (Settings memory) {
        return _s[compliance];
    }

    function countries(address compliance) external view returns (uint16[] memory) {
        return _countries[compliance];
    }

    function lockedOf(address compliance, address account) public view returns (uint256 locked) {
        uint64 lockup = _s[compliance].lockup;
        if (lockup == 0) return 0;
        Lot[] storage lots = _lots[compliance][account];
        for (uint256 i; i < lots.length; ++i) {
            if (uint256(lots[i].issuedAt) + lockup > block.timestamp) locked += lots[i].amount;
        }
        uint256 bal = _token(compliance).balanceOf(account);
        if (locked > bal) locked = bal;
    }

    /// @notice Why a move would fail: 0 ok, 2 country, 3 locked, 4 max holders, 5 max balance, 6 needs approval,
    ///         7 matured (same numbering as OfferingRules.Code).
    function checkCode(address compliance, address from, address to, uint256 value) public view returns (uint8) {
        Settings storage s = _s[compliance];
        if (s.maturity != 0 && block.timestamp >= s.maturity) return 7;
        ITokenView t = _token(compliance);
        if (s.countryMode != COUNTRY_NONE) {
            uint16 c = IIdentityRegistryCountry(t.identityRegistry()).investorCountry(to);
            bool listed = countryListed[compliance][c];
            if (s.countryMode == COUNTRY_ALLOW ? !listed : listed) return 2;
        }
        uint256 fromBal = from == address(0) ? 0 : t.balanceOf(from);
        uint256 toBal = t.balanceOf(to);
        if (from != address(0)) {
            if (value + lockedOf(compliance, from) > fromBal) return 3;
            if (s.resaleApproval && approvedAmount[compliance][keccak256(abi.encode(from, to))] < value) return 6;
        }
        if (s.maxBalance != 0 && toBal + value > s.maxBalance) return 5;
        if (s.maxHolders != 0 && value != 0 && toBal == 0) {
            bool senderLeaves = from != address(0) && fromBal == value;
            if (!senderLeaves && s.holderCount >= s.maxHolders) return 4;
        }
        return 0;
    }

    // ---------------------------------------------------------------- IModule

    function moduleCheck(address from, address to, uint256 value, address compliance)
        external
        view
        override
        returns (bool)
    {
        return checkCode(compliance, from, to, value) == 0;
    }

    /// @dev Runs after the balance change (normal and forced transfers).
    function moduleTransferAction(address from, address to, uint256 value) external override onlyComplianceCall {
        if (value == 0) return;
        Settings storage s = _s[msg.sender];
        ITokenView t = _token(msg.sender);
        // A wallet sending to itself neither joins nor leaves (counting it would let any holder fill maxHolders).
        if (from != to) {
            if (t.balanceOf(to) == value) ++s.holderCount;
            if (t.balanceOf(from) == 0 && s.holderCount != 0) --s.holderCount;
        }
        if (s.resaleApproval) {
            bytes32 k = keccak256(abi.encode(from, to));
            uint256 a = approvedAmount[msg.sender][k];
            approvedAmount[msg.sender][k] = a > value ? a - value : 0;
        }
        _trimLots(msg.sender, from, t.balanceOf(from));
    }

    function moduleMintAction(address to, uint256 value) external override onlyComplianceCall {
        if (value == 0) return;
        Settings storage s = _s[msg.sender];
        if (_token(msg.sender).balanceOf(to) == value) ++s.holderCount;
        if (s.lockup != 0) _addLot(msg.sender, to, value, s.lockup);
    }

    function moduleBurnAction(address from, uint256 value) external override onlyComplianceCall {
        if (value == 0) return;
        Settings storage s = _s[msg.sender];
        uint256 bal = _token(msg.sender).balanceOf(from);
        if (bal == 0 && s.holderCount != 0) --s.holderCount;
        _trimLots(msg.sender, from, bal);
    }

    /// @notice Binds only before any token is issued, so the holder count starts right.
    function canComplianceBind(address compliance) external view override returns (bool) {
        address token = IModularComplianceView(compliance).getTokenBound();
        return token == address(0) || ITokenView(token).totalSupply() == 0;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return false;
    }

    function name() public pure override returns (string memory) {
        return "OfferingRulesModule";
    }

    // ---------------------------------------------------------------- internals

    function _token(address compliance) internal view returns (ITokenView) {
        return ITokenView(IModularComplianceView(compliance).getTokenBound());
    }

    function _addLot(address compliance, address to, uint256 amount, uint64 lockup) internal {
        Lot[] storage lots = _lots[compliance][to];
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

    /// @dev Cap the still-locked lots at `remaining`, newest first. Expired lots are ignored: they hold no lock, and
    ///      counting them would let a move of free tokens erase a locked lot.
    function _trimLots(address compliance, address from, uint256 remaining) internal {
        uint64 lockup = _s[compliance].lockup;
        if (lockup == 0) return;
        Lot[] storage lots = _lots[compliance][from];
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
