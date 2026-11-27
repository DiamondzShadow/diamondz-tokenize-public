extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Env,
};

/// Stand-in for the OZ RWA token: only its manager may mint (as `#[only_role(operator, "manager")]` does), and a
/// compliance failure is simulated for one blocked recipient.
#[contract]
pub struct MockRwa;

#[contracttype]
enum MK {
    Manager,
    Blocked,
    Bal(Address),
}

#[contractimpl]
impl MockRwa {
    pub fn init(e: Env, manager: Address, blocked: Address) {
        e.storage().instance().set(&MK::Manager, &manager);
        e.storage().instance().set(&MK::Blocked, &blocked);
    }
    pub fn mint(e: Env, to: Address, amount: i128, operator: Address) {
        operator.require_auth();
        let m: Address = e.storage().instance().get(&MK::Manager).unwrap();
        if operator != m {
            panic!("operator lacks the manager role");
        }
        let b: Address = e.storage().instance().get(&MK::Blocked).unwrap();
        if to == b {
            panic!("compliance: recipient not allowed");
        }
        let k = MK::Bal(to);
        let cur: i128 = e.storage().persistent().get(&k).unwrap_or(0);
        e.storage().persistent().set(&k, &(cur + amount));
    }
    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage().persistent().get(&MK::Bal(id)).unwrap_or(0)
    }
}

struct T<'a> {
    e: Env,
    sale: SaleClient<'a>,
    rwa: MockRwaClient<'a>,
    usdc: TokenClient<'a>,
    admin: Address,
    manager: Address,
    treasury: Address,
    buyer: Address,
    blocked: Address,
}

const USD: i128 = 10_000_000; // USDC SAC: 7 decimals
fn ce(x: SaleError) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(x as u32)
}

fn setup(price_usd: i128, min_usd: i128, cap_tokens: i128, starts: u64, ends: u64, sale_is_manager: bool) -> T<'static> {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_800_000_000);
    let admin = Address::generate(&e);
    let manager = Address::generate(&e);
    let treasury = Address::generate(&e);
    let buyer = Address::generate(&e);
    let blocked = Address::generate(&e);
    let issuer = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(issuer);
    let usdc = TokenClient::new(&e, &sac.address());
    StellarAssetClient::new(&e, &sac.address()).mint(&buyer, &(10_000 * USD));
    StellarAssetClient::new(&e, &sac.address()).mint(&blocked, &(10_000 * USD));
    let rwa_id = e.register(MockRwa, ());
    let rwa = MockRwaClient::new(&e, &rwa_id);
    let sale_id = e.register(
        Sale,
        (&admin, &manager, &rwa_id, &sac.address(), &treasury, price_usd * USD, min_usd * USD, cap_tokens * UNIT, starts, ends),
    );
    let sale = SaleClient::new(&e, &sale_id);
    rwa.init(&(if sale_is_manager { sale_id.clone() } else { manager.clone() }), &blocked);
    T { e, sale, rwa, usdc, admin, manager, treasury, buyer, blocked }
}

#[test]
fn buy_pays_treasury_and_mints_to_buyer() {
    let t = setup(10, 500, 1_000_000, 0, 0, true);
    t.sale.set_open(&true, &t.admin);
    let paid = t.sale.buy(&t.buyer, &(100 * UNIT));
    assert_eq!(paid, 1_000 * USD);
    assert_eq!(t.usdc.balance(&t.treasury), 1_000 * USD);
    assert_eq!(t.usdc.balance(&t.buyer), 9_000 * USD);
    assert_eq!(t.rwa.balance(&t.buyer), 100 * UNIT);
    assert_eq!(t.sale.sold(), 100 * UNIT);
    assert_eq!(t.sale.remaining(), (1_000_000 - 100) * UNIT);
    assert_eq!(t.usdc.balance(&t.sale.address), 0); // the sale never holds funds
}

#[test]
fn closed_by_default_and_manager_can_open_and_close() {
    let t = setup(10, 0, 1_000, 0, 0, true);
    assert_eq!(t.sale.try_buy(&t.buyer, &UNIT), Err(Ok(ce(SaleError::Closed))));
    t.sale.set_open(&true, &t.manager);
    assert!(t.sale.is_open());
    t.sale.set_open(&false, &t.manager);
    assert_eq!(t.sale.try_buy(&t.buyer, &UNIT), Err(Ok(ce(SaleError::Closed))));
}

#[test]
fn strangers_cannot_open_or_move_the_window() {
    let t = setup(10, 0, 1_000, 0, 0, true);
    let stranger = Address::generate(&t.e);
    assert_eq!(t.sale.try_set_open(&true, &stranger), Err(Ok(ce(SaleError::Unauthorized))));
    assert_eq!(t.sale.try_set_window(&0, &0, &stranger), Err(Ok(ce(SaleError::Unauthorized))));
}

#[test]
fn minimum_purchase_enforced() {
    let t = setup(10, 500, 1_000, 0, 0, true);
    t.sale.set_open(&true, &t.admin);
    assert_eq!(t.sale.try_buy(&t.buyer, &(49 * UNIT)), Err(Ok(ce(SaleError::BelowMinimum))));
    assert_eq!(t.sale.buy(&t.buyer, &(50 * UNIT)), 500 * USD);
}

#[test]
fn cap_enforced() {
    let t = setup(1, 0, 100, 0, 0, true);
    t.sale.set_open(&true, &t.admin);
    t.sale.buy(&t.buyer, &(60 * UNIT));
    assert_eq!(t.sale.try_buy(&t.buyer, &(41 * UNIT)), Err(Ok(ce(SaleError::SoldOut))));
    t.sale.buy(&t.buyer, &(40 * UNIT));
    assert_eq!(t.sale.remaining(), 0);
}

#[test]
fn window_enforced() {
    let t = setup(1, 0, 100, 1_800_000_100, 1_800_000_200, true);
    t.sale.set_open(&true, &t.admin);
    assert_eq!(t.sale.try_buy(&t.buyer, &UNIT), Err(Ok(ce(SaleError::NotStarted))));
    t.e.ledger().set_timestamp(1_800_000_150);
    t.sale.buy(&t.buyer, &UNIT);
    t.e.ledger().set_timestamp(1_800_000_200);
    assert_eq!(t.sale.try_buy(&t.buyer, &UNIT), Err(Ok(ce(SaleError::Ended))));
    assert_eq!(t.sale.try_set_window(&10, &5, &t.admin), Err(Ok(ce(SaleError::BadConfig))));
}

#[test]
fn zero_or_negative_amounts_refused() {
    let t = setup(1, 0, 100, 0, 0, true);
    t.sale.set_open(&true, &t.admin);
    assert_eq!(t.sale.try_buy(&t.buyer, &0), Err(Ok(ce(SaleError::BadAmount))));
    assert_eq!(t.sale.try_buy(&t.buyer, &-5), Err(Ok(ce(SaleError::BadAmount))));
}

#[test]
fn cost_rounds_up_so_splitting_never_underpays() {
    // price 0.0000003 USDC per whole token: 1 base unit of token costs a fraction of a USDC base unit -> rounds up to 1
    assert_eq!(cost_of(1, 3), 1);
    assert_eq!(cost_of(UNIT, 3), 3);
    assert_eq!(cost_of(3 * UNIT / 2, 10 * USD), 15 * USD);
}

#[test]
fn compliance_refusal_reverts_the_payment_too() {
    let t = setup(10, 0, 1_000, 0, 0, true);
    t.sale.set_open(&true, &t.admin);
    assert!(t.sale.try_buy(&t.blocked, &UNIT).is_err());
    assert_eq!(t.usdc.balance(&t.blocked), 10_000 * USD);
    assert_eq!(t.usdc.balance(&t.treasury), 0);
    assert_eq!(t.sale.sold(), 0);
}

#[test]
fn without_the_manager_role_nothing_is_sold() {
    let t = setup(10, 0, 1_000, 0, 0, false);
    t.sale.set_open(&true, &t.admin);
    assert!(t.sale.try_buy(&t.buyer, &UNIT).is_err());
    assert_eq!(t.usdc.balance(&t.buyer), 10_000 * USD);
    assert_eq!(t.sale.sold(), 0);
}

#[test]
#[should_panic]
fn zero_price_rejected_at_construction() {
    let e = Env::default();
    let a = Address::generate(&e);
    e.register(Sale, (&a, &a, &a, &a, &a, 0i128, 0i128, 1i128, 0u64, 0u64));
}
