extern crate std;

use ed25519_dalek::Signer as Ed25519Signer;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Map, Vec,
};
use stellar_tokens::rwa::{
    claim_issuer::{encode_claim_data_expiration, Ed25519Verifier, SignatureVerifier},
    claim_topics_and_issuers::{
        storage as cti, ClaimTopicsAndIssuers, ClaimTopicsAndIssuersClient,
    },
};

use crate::contract::{ClaimIssuerContract, ClaimIssuerContractClient, ED25519_SCHEME};

// ============ Mock registry ============

#[contract]
struct MockRegistry;

#[contractimpl]
impl ClaimTopicsAndIssuers for MockRegistry {
    fn add_claim_topic(e: &Env, claim_topic: u32, _operator: Address) {
        cti::add_claim_topic(e, claim_topic);
    }

    fn remove_claim_topic(e: &Env, claim_topic: u32, _operator: Address) {
        cti::remove_claim_topic(e, claim_topic);
    }

    fn get_claim_topics(e: &Env) -> Vec<u32> {
        cti::get_claim_topics(e)
    }

    fn add_trusted_issuer(
        e: &Env,
        trusted_issuer: Address,
        claim_topics: Vec<u32>,
        _operator: Address,
    ) {
        cti::add_trusted_issuer(e, &trusted_issuer, &claim_topics);
    }

    fn remove_trusted_issuer(e: &Env, trusted_issuer: Address, _operator: Address) {
        cti::remove_trusted_issuer(e, &trusted_issuer);
    }

    fn update_issuer_claim_topics(
        e: &Env,
        trusted_issuer: Address,
        claim_topics: Vec<u32>,
        _operator: Address,
    ) {
        cti::update_issuer_claim_topics(e, &trusted_issuer, &claim_topics);
    }

    fn get_trusted_issuers(e: &Env) -> Vec<Address> {
        cti::get_trusted_issuers(e)
    }

    fn get_claim_topic_issuers(e: &Env, claim_topic: u32) -> Vec<Address> {
        cti::get_claim_topic_issuers(e, claim_topic)
    }

    fn get_claim_topics_and_issuers(e: &Env) -> Map<u32, Vec<Address>> {
        cti::get_claim_topics_and_issuers(e)
    }

    fn is_trusted_issuer(e: &Env, issuer: Address) -> bool {
        cti::is_trusted_issuer(e, &issuer)
    }

    fn get_trusted_issuer_claim_topics(e: &Env, trusted_issuer: Address) -> Vec<u32> {
        cti::get_trusted_issuer_claim_topics(e, &trusted_issuer)
    }

    fn has_claim_topic(e: &Env, issuer: Address, claim_topic: u32) -> bool {
        cti::has_claim_topic(e, &issuer, claim_topic)
    }
}

// ============ Helpers ============

struct Ed25519KeyPair {
    signing_key: ed25519_dalek::SigningKey,
    public_key_bytes: [u8; 32],
}

impl Ed25519KeyPair {
    fn generate(secret: [u8; 32]) -> Self {
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&secret);
        let public_key_bytes = signing_key.verifying_key().to_bytes();
        Self { signing_key, public_key_bytes }
    }

    fn public_key(&self, e: &Env) -> Bytes {
        Bytes::from_array(e, &self.public_key_bytes)
    }

    fn sign_message(&self, e: &Env, message: &Bytes) -> BytesN<64> {
        let buf = message.to_buffer::<256>();
        let slice = &buf.as_slice()[..message.len() as usize];
        let sig = self.signing_key.sign(slice).to_bytes();
        BytesN::from_array(e, &sig)
    }
}

fn make_sig_data(e: &Env, public_key: &Bytes, signature: &BytesN<64>) -> Bytes {
    let mut sig_data = Bytes::new(e);
    sig_data.append(public_key);
    sig_data.append(&signature.clone().into());
    sig_data
}

/// Registers a `ClaimIssuerContract` and a `MockRegistry`. Adds `claim_topic`
/// to the registry and registers the issuer contract as a trusted issuer for
/// that topic. Returns `(client, registry_address_address)`.
fn setup<'a>(e: &Env, claim_topic: u32) -> (ClaimIssuerContractClient<'a>, Address) {
    let owner = Address::generate(e);
    let issuer_addr = e.register(ClaimIssuerContract, (&owner,));
    let client = ClaimIssuerContractClient::new(e, &issuer_addr);

    let registry = e.register(MockRegistry, ());
    let operator = Address::generate(e);
    let reg_client = ClaimTopicsAndIssuersClient::new(e, &registry);
    reg_client.add_claim_topic(&claim_topic, &operator);
    reg_client.add_trusted_issuer(&issuer_addr, &soroban_sdk::vec![e, claim_topic], &operator);

    (client, registry)
}

fn default_claim_data(e: &Env) -> Bytes {
    let raw = Bytes::from_array(e, &[1u8, 2, 3, 4, 5]);
    let created_at = e.ledger().timestamp();
    let valid_until = created_at + 1000;
    encode_claim_data_expiration(e, created_at, valid_until, &raw)
}

// ============ Key management ============

#[test]
fn allow_key_and_remove_key_works() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, registry) = setup(&e, claim_topic);

    let kp = Ed25519KeyPair::generate([1u8; 32]);

    client.allow_key(&kp.public_key(&e), &registry, &claim_topic);
    client.remove_key(&kp.public_key(&e), &registry, &claim_topic);
}

#[test]
#[should_panic(expected = "Error(Contract, #352)")]
fn allow_key_duplicate_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, registry) = setup(&e, claim_topic);

    let kp = Ed25519KeyPair::generate([1u8; 32]);

    client.allow_key(&kp.public_key(&e), &registry, &claim_topic);
    client.allow_key(&kp.public_key(&e), &registry, &claim_topic);
}

#[test]
#[should_panic(expected = "Error(Contract, #353)")]
fn remove_nonexistent_key_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, registry) = setup(&e, claim_topic);

    let kp = Ed25519KeyPair::generate([1u8; 32]);

    client.remove_key(&kp.public_key(&e), &registry, &claim_topic);
}

#[test]
#[should_panic(expected = "Error(Contract, #354)")]
fn allow_key_for_unregistered_topic_panics() {
    let e = Env::default();
    e.mock_all_auths();
    // Registry only knows about topic 1; trying to allow key for topic 99
    // fails.
    let (client, registry) = setup(&e, 1u32);

    let kp = Ed25519KeyPair::generate([1u8; 32]);

    client.allow_key(&kp.public_key(&e), &registry, &99u32);
}

// ============ is_claim_valid ============

#[test]
fn is_claim_valid_works() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, registry) = setup(&e, claim_topic);

    let kp = Ed25519KeyPair::generate([42u8; 32]);
    let identity = Address::generate(&e);

    client.allow_key(&kp.public_key(&e), &registry, &claim_topic);

    let claim_data = default_claim_data(&e);

    let issuer_addr = client.address.clone();
    let message = e.as_contract(&issuer_addr, || {
        Ed25519Verifier::build_message(&e, &identity, claim_topic, &claim_data)
    });
    let signature = kp.sign_message(&e, &message);
    let sig_data = make_sig_data(&e, &kp.public_key(&e), &signature);

    client.is_claim_valid(&identity, &claim_topic, &ED25519_SCHEME, &sig_data, &claim_data);
}

#[test]
#[should_panic(expected = "Error(Contract, #350)")]
fn is_claim_valid_wrong_scheme_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, _registry) = setup(&e, claim_topic);

    let kp = Ed25519KeyPair::generate([42u8; 32]);
    let identity = Address::generate(&e);
    let claim_data = default_claim_data(&e);

    let dummy_signature = BytesN::from_array(&e, &[0u8; 64]);
    let sig_data = make_sig_data(&e, &kp.public_key(&e), &dummy_signature);

    client.is_claim_valid(&identity, &claim_topic, &999u32, &sig_data, &claim_data);
}

#[test]
#[should_panic(expected = "Error(Contract, #354)")]
fn is_claim_valid_unauthorized_key_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, _registry) = setup(&e, claim_topic);

    // Key is never authorized via allow_key.
    let kp = Ed25519KeyPair::generate([42u8; 32]);
    let identity = Address::generate(&e);
    let claim_data = default_claim_data(&e);

    let issuer_addr = client.address.clone();
    let message = e.as_contract(&issuer_addr, || {
        Ed25519Verifier::build_message(&e, &identity, claim_topic, &claim_data)
    });
    let signature = kp.sign_message(&e, &message);
    let sig_data = make_sig_data(&e, &kp.public_key(&e), &signature);

    client.is_claim_valid(&identity, &claim_topic, &ED25519_SCHEME, &sig_data, &claim_data);
}

#[test]
#[should_panic(expected = "Error(Contract, #354)")]
fn is_claim_valid_expired_claim_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, registry) = setup(&e, claim_topic);

    let kp = Ed25519KeyPair::generate([42u8; 32]);
    let identity = Address::generate(&e);

    client.allow_key(&kp.public_key(&e), &registry, &claim_topic);

    // Claim expires at timestamp 500.
    let raw = Bytes::from_array(&e, &[1u8, 2, 3]);
    let claim_data = encode_claim_data_expiration(&e, 100, 500, &raw);

    // Build message and sign while ledger is still at the default (0)
    // timestamp.
    let issuer_addr = client.address.clone();
    let message = e.as_contract(&issuer_addr, || {
        Ed25519Verifier::build_message(&e, &identity, claim_topic, &claim_data)
    });
    let signature = kp.sign_message(&e, &message);
    let sig_data = make_sig_data(&e, &kp.public_key(&e), &signature);

    // Advance ledger past expiry.
    e.ledger().set_timestamp(600);

    client.is_claim_valid(&identity, &claim_topic, &ED25519_SCHEME, &sig_data, &claim_data);
}

#[test]
#[should_panic(expected = "Error(Contract, #354)")]
fn is_claim_valid_after_remove_key_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, registry) = setup(&e, claim_topic);

    let kp = Ed25519KeyPair::generate([42u8; 32]);
    let identity = Address::generate(&e);

    client.allow_key(&kp.public_key(&e), &registry, &claim_topic);

    let claim_data = default_claim_data(&e);

    let issuer_addr = client.address.clone();
    let message = e.as_contract(&issuer_addr, || {
        Ed25519Verifier::build_message(&e, &identity, claim_topic, &claim_data)
    });
    let signature = kp.sign_message(&e, &message);
    let sig_data = make_sig_data(&e, &kp.public_key(&e), &signature);

    // Revoke the key.
    client.remove_key(&kp.public_key(&e), &registry, &claim_topic);

    client.is_claim_valid(&identity, &claim_topic, &ED25519_SCHEME, &sig_data, &claim_data);
}

#[test]
#[should_panic(expected = "Error(Contract, #350)")]
fn is_claim_valid_sig_data_too_short_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let claim_topic = 1u32;
    let (client, _registry) = setup(&e, claim_topic);

    let identity = Address::generate(&e);
    let claim_data = default_claim_data(&e);

    // 32 bytes — too short for the 96-byte Ed25519 sig_data.
    let short_sig_data = Bytes::from_array(&e, &[0u8; 32]);

    client.is_claim_valid(&identity, &claim_topic, &ED25519_SCHEME, &short_sig_data, &claim_data);
}

// ============ Ethereum personal_sign (hardware-wallet claim keys) ============

use crate::contract::ETH_PERSONAL_SIGN_SCHEME;
use k256::ecdsa::SigningKey as K256Key;
use sha3::{Digest, Keccak256};

/// Signs like MetaMask's personal_sign over the raw 32-byte keccak256(claim message), returning OZ secp256k1
/// sig_data (pubkey 65 || r||s 64 || recovery id 4) and the public key.
fn eth_personal_sign(e: &Env, key: &K256Key, message: &Bytes) -> (Bytes, Bytes) {
    let buf = message.to_buffer::<512>();
    let msg = &buf.as_slice()[..message.len() as usize];
    let inner = Keccak256::digest(msg);
    let mut prefixed = b"\x19Ethereum Signed Message:\n32".to_vec();
    prefixed.extend_from_slice(&inner);
    let digest = Keccak256::digest(&prefixed);
    let (sig, rid) = key.sign_prehash_recoverable(&digest).unwrap();
    let pk = key.verifying_key().to_encoded_point(false);
    let pk_bytes = Bytes::from_slice(e, pk.as_bytes());
    let mut sd = Bytes::new(e);
    sd.append(&pk_bytes);
    sd.append(&Bytes::from_slice(e, &sig.to_bytes()));
    sd.extend_from_array(&(rid.to_byte() as u32).to_be_bytes());
    (sd, pk_bytes)
}

fn eth_setup<'a>(e: &Env) -> (ClaimIssuerContractClient<'a>, Address, K256Key, Bytes, u32) {
    let claim_topic = 1u32;
    let (client, registry) = setup(e, claim_topic);
    let key = K256Key::from_slice(&[7u8; 32]).unwrap();
    let pk = Bytes::from_slice(e, key.verifying_key().to_encoded_point(false).as_bytes());
    (client, registry, key, pk, claim_topic)
}

#[test]
fn eth_claim_valid_works() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, registry, key, pk, topic) = eth_setup(&e);
    client.allow_eth_key(&pk, &registry, &topic);
    assert!(client.is_eth_key_allowed(&pk, &registry, &topic));
    let identity = Address::generate(&e);
    let claim_data = default_claim_data(&e);
    let message = e.as_contract(&client.address, || {
        stellar_tokens::rwa::claim_issuer::Secp256k1Verifier::build_message(&e, &identity, topic, &claim_data)
    });
    let (sd, _) = eth_personal_sign(&e, &key, &message);
    client.is_claim_valid(&identity, &topic, &ETH_PERSONAL_SIGN_SCHEME, &sd, &claim_data);
}

#[test]
#[should_panic]
fn eth_claim_unallowed_key_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, _registry, key, _pk, topic) = eth_setup(&e);
    let identity = Address::generate(&e);
    let claim_data = default_claim_data(&e);
    let message = e.as_contract(&client.address, || {
        stellar_tokens::rwa::claim_issuer::Secp256k1Verifier::build_message(&e, &identity, topic, &claim_data)
    });
    let (sd, _) = eth_personal_sign(&e, &key, &message);
    client.is_claim_valid(&identity, &topic, &ETH_PERSONAL_SIGN_SCHEME, &sd, &claim_data);
}

#[test]
#[should_panic]
fn eth_claim_other_identity_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, registry, key, pk, topic) = eth_setup(&e);
    client.allow_eth_key(&pk, &registry, &topic);
    let identity = Address::generate(&e);
    let other = Address::generate(&e);
    let claim_data = default_claim_data(&e);
    let message = e.as_contract(&client.address, || {
        stellar_tokens::rwa::claim_issuer::Secp256k1Verifier::build_message(&e, &identity, topic, &claim_data)
    });
    let (sd, _) = eth_personal_sign(&e, &key, &message);
    client.is_claim_valid(&other, &topic, &ETH_PERSONAL_SIGN_SCHEME, &sd, &claim_data);
}

#[test]
#[should_panic]
fn eth_claim_pubkey_swap_panics() {
    // Signed by key A but claims to be key B (allowed): recovery must not match B.
    let e = Env::default();
    e.mock_all_auths();
    let (client, registry, _key, pk, topic) = eth_setup(&e);
    client.allow_eth_key(&pk, &registry, &topic);
    let attacker = K256Key::from_slice(&[9u8; 32]).unwrap();
    let identity = Address::generate(&e);
    let claim_data = default_claim_data(&e);
    let message = e.as_contract(&client.address, || {
        stellar_tokens::rwa::claim_issuer::Secp256k1Verifier::build_message(&e, &identity, topic, &claim_data)
    });
    let (sd, _) = eth_personal_sign(&e, &attacker, &message);
    let mut forged = Bytes::new(&e);
    forged.append(&pk);
    forged.append(&sd.slice(65..133));
    client.is_claim_valid(&identity, &topic, &ETH_PERSONAL_SIGN_SCHEME, &forged, &claim_data);
}

#[test]
#[should_panic]
fn eth_claim_raw_keccak_signature_panics() {
    // A signature over the raw digest (no Ethereum prefix) must not pass under scheme 1.
    let e = Env::default();
    e.mock_all_auths();
    let (client, registry, key, pk, topic) = eth_setup(&e);
    client.allow_eth_key(&pk, &registry, &topic);
    let identity = Address::generate(&e);
    let claim_data = default_claim_data(&e);
    let message = e.as_contract(&client.address, || {
        stellar_tokens::rwa::claim_issuer::Secp256k1Verifier::build_message(&e, &identity, topic, &claim_data)
    });
    let buf = message.to_buffer::<512>();
    let digest = Keccak256::digest(&buf.as_slice()[..message.len() as usize]);
    let (sig, rid) = key.sign_prehash_recoverable(&digest).unwrap();
    let mut sd = Bytes::new(&e);
    sd.append(&pk);
    sd.append(&Bytes::from_slice(&e, &sig.to_bytes()));
    sd.extend_from_array(&(rid.to_byte() as u32).to_be_bytes());
    client.is_claim_valid(&identity, &topic, &ETH_PERSONAL_SIGN_SCHEME, &sd, &claim_data);
}

#[test]
#[should_panic]
fn eth_claim_expired_panics() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, registry, key, pk, topic) = eth_setup(&e);
    client.allow_eth_key(&pk, &registry, &topic);
    let identity = Address::generate(&e);
    let claim_data = default_claim_data(&e);
    let message = e.as_contract(&client.address, || {
        stellar_tokens::rwa::claim_issuer::Secp256k1Verifier::build_message(&e, &identity, topic, &claim_data)
    });
    let (sd, _) = eth_personal_sign(&e, &key, &message);
    e.ledger().with_mut(|l| l.timestamp += 5000);
    client.is_claim_valid(&identity, &topic, &ETH_PERSONAL_SIGN_SCHEME, &sd, &claim_data);
}

#[test]
#[should_panic]
fn allow_eth_key_rejects_compressed_key() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, registry, key, _pk, topic) = eth_setup(&e);
    let compressed = Bytes::from_slice(&e, key.verifying_key().to_encoded_point(true).as_bytes());
    client.allow_eth_key(&compressed, &registry, &topic);
}

#[test]
fn ed25519_and_eth_keys_coexist() {
    let e = Env::default();
    e.mock_all_auths();
    let (client, registry, _key, pk, topic) = eth_setup(&e);
    let kp = Ed25519KeyPair::generate([42u8; 32]);
    client.allow_key(&kp.public_key(&e), &registry, &topic);
    client.allow_eth_key(&pk, &registry, &topic);
    assert!(client.is_key_allowed(&kp.public_key(&e), &registry, &topic));
    assert!(client.is_eth_key_allowed(&pk, &registry, &topic));
    assert!(!client.is_key_allowed(&pk, &registry, &topic));
}
