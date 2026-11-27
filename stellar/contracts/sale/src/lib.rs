//! Diamondz Tokenize — Stellar primary sale (design X4 "Buy").
//!
//! An investor pays the offering's stablecoin (a Stellar Asset Contract, e.g. Circle USDC) straight to the issuer's
//! treasury and the sale mints the RWA token to them in the same transaction. Minting goes through the token's own
//! `mint`, so every compliance rule applies to the buyer exactly as on any other issuance: the identity check
//! (KYC/AML claims), country allow/block, max balance, supply cap, and the lockup, which starts at the purchase.
//! The sale holds no funds and no tokens.
//!
//! Roles: `admin` (the issuer's wallet) and `manager` (the platform relayer) may open/close the sale and move its
//! window; nothing else is mutable. The token must grant this contract its "manager" role (one issuer signature).
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token, vec, Address, Env,
    IntoVal, Symbol,
};

/// RWA token amounts use 7 decimals (Stellar's standard).
const UNIT: i128 = 10_000_000;
const DAY_LEDGERS: u32 = 17_280;
const BUMP: u32 = 30 * DAY_LEDGERS;
const BUMP_THRESHOLD: u32 = 7 * DAY_LEDGERS;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub manager: Address,
    /// The RWA token (OpenZeppelin Stellar RWA) this sale mints.
    pub token: Address,
    /// The stablecoin buyers pay with (SEP-41 / Stellar Asset Contract).
    pub pay_token: Address,
    /// Where payments go (the issuer).
    pub treasury: Address,
    /// Price of one whole token, in pay-token base units.
    pub price: i128,
    /// Smallest purchase, in pay-token base units (0 = none).
    pub min_purchase: i128,
    /// Most tokens this sale may mint, in token base units.
    pub cap: i128,
    /// Unix seconds; 0 = no limit.
    pub starts_at: u64,
    pub ends_at: u64,
}

#[contracttype]
enum Key {
    Config,
    Sold,
    Open,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SaleError {
    Closed = 1,
    NotStarted = 2,
    Ended = 3,
    BelowMinimum = 4,
    SoldOut = 5,
    BadAmount = 6,
    Unauthorized = 7,
    BadConfig = 8,
}

#[contract]
pub struct Sale;

fn cfg(e: &Env) -> Config {
    e.storage().instance().get(&Key::Config).unwrap()
}
fn sold(e: &Env) -> i128 {
    e.storage().instance().get(&Key::Sold).unwrap_or(0)
}
fn bump(e: &Env) {
    e.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP);
}
fn only_operator(e: &Env, c: &Config, caller: &Address) {
    caller.require_auth();
    if caller != &c.admin && caller != &c.manager {
        panic_with_error!(e, SaleError::Unauthorized);
    }
}
/// Cost of `amount` token base units, rounded up so a buyer can never underpay by splitting purchases.
pub fn cost_of(amount: i128, price: i128) -> i128 {
    (amount * price + UNIT - 1) / UNIT
}

#[contractimpl]
impl Sale {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: Env,
        admin: Address,
        manager: Address,
        token: Address,
        pay_token: Address,
        treasury: Address,
        price: i128,
        min_purchase: i128,
        cap: i128,
        starts_at: u64,
        ends_at: u64,
    ) {
        if price <= 0 || cap <= 0 || min_purchase < 0 || (ends_at != 0 && ends_at <= starts_at) {
            panic_with_error!(&e, SaleError::BadConfig);
        }
        let c = Config { admin, manager, token, pay_token, treasury, price, min_purchase, cap, starts_at, ends_at };
        e.storage().instance().set(&Key::Config, &c);
        e.storage().instance().set(&Key::Open, &false);
        bump(&e);
    }

    /// Pay for `amount` token base units and receive them. Returns what was paid (pay-token base units).
    pub fn buy(e: Env, buyer: Address, amount: i128) -> i128 {
        buyer.require_auth();
        let c = cfg(&e);
        if !Self::is_open(e.clone()) {
            panic_with_error!(&e, SaleError::Closed);
        }
        let now = e.ledger().timestamp();
        if c.starts_at != 0 && now < c.starts_at {
            panic_with_error!(&e, SaleError::NotStarted);
        }
        if c.ends_at != 0 && now >= c.ends_at {
            panic_with_error!(&e, SaleError::Ended);
        }
        if amount <= 0 {
            panic_with_error!(&e, SaleError::BadAmount);
        }
        let s = sold(&e);
        if s + amount > c.cap {
            panic_with_error!(&e, SaleError::SoldOut);
        }
        let cost = cost_of(amount, c.price);
        if cost < c.min_purchase || cost <= 0 {
            panic_with_error!(&e, SaleError::BelowMinimum);
        }
        // Effects before interactions.
        e.storage().instance().set(&Key::Sold, &(s + amount));
        bump(&e);
        token::Client::new(&e, &c.pay_token).transfer(&buyer, &c.treasury, &cost);
        // The token's mint enforces identity + every compliance module on the buyer; this contract is the operator.
        e.invoke_contract::<()>(
            &c.token,
            &Symbol::new(&e, "mint"),
            vec![&e, buyer.into_val(&e), amount.into_val(&e), e.current_contract_address().into_val(&e)],
        );
        #[allow(deprecated)]
        e.events().publish((symbol_short!("purchase"), buyer), (amount, cost));
        cost
    }

    pub fn set_open(e: Env, open: bool, caller: Address) {
        let c = cfg(&e);
        only_operator(&e, &c, &caller);
        e.storage().instance().set(&Key::Open, &open);
        bump(&e);
        #[allow(deprecated)]
        e.events().publish((symbol_short!("open"),), open);
    }

    pub fn set_window(e: Env, starts_at: u64, ends_at: u64, caller: Address) {
        let mut c = cfg(&e);
        only_operator(&e, &c, &caller);
        if ends_at != 0 && ends_at <= starts_at {
            panic_with_error!(&e, SaleError::BadConfig);
        }
        c.starts_at = starts_at;
        c.ends_at = ends_at;
        e.storage().instance().set(&Key::Config, &c);
        bump(&e);
    }

    pub fn is_open(e: Env) -> bool {
        e.storage().instance().get(&Key::Open).unwrap_or(false)
    }
    pub fn config(e: Env) -> Config {
        cfg(&e)
    }
    pub fn sold(e: Env) -> i128 {
        sold(&e)
    }
    pub fn remaining(e: Env) -> i128 {
        cfg(&e).cap - sold(&e)
    }
    /// What `amount` token base units cost right now (pay-token base units).
    pub fn quote(e: Env, amount: i128) -> i128 {
        cost_of(amount, cfg(&e).price)
    }
}

#[cfg(test)]
mod test;
