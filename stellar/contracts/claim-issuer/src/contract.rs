//! RWA Claim Issuer Example Contract.
//!
//! Implements the [`ClaimIssuer`] trait using Ed25519 signatures (scheme 101).
//! Authorized signing keys are managed by the contract owner via `allow_key`
//! and `remove_key`. The `is_claim_valid` function verifies that:
//!
//! 1. The scheme is Ed25519 (101).
//! 2. The signing key is authorized for the given claim topic.
//! 3. The claim has not expired (using encoded `valid_until` metadata).
//! 4. The claim has not been individually revoked.
//! 5. The signature over the canonical claim message is valid.
//!
//! Two signature schemes:
//! - 101, Ed25519 over the claim message (a server-held key; testnet and older offerings).
//! - 1, Ethereum `personal_sign` (secp256k1): the issuer signs keccak256(claim message) with an ordinary EVM wallet,
//!   so a hardware wallet (Trezor, Ledger) behind MetaMask can hold the claim key and no key sits on a server.
//!   sig_data = uncompressed public key (65) || r || s (64) || recovery id (4, big-endian), the OpenZeppelin
//!   secp256k1 layout. Verified as secp256k1_recover(keccak256("\x19Ethereum Signed Message:\n32" ||
//!   keccak256(message))) == public key.

use soroban_sdk::{contract, contractimpl, panic_with_error, Address, Bytes, Env};
use stellar_access::ownable::{self, Ownable};
use stellar_macros::only_owner;
use stellar_tokens::rwa::claim_issuer::{
    allow_key, is_claim_expired, is_claim_revoked, is_key_allowed_for_registry,
    is_key_allowed_for_topic, remove_key, ClaimIssuer, ClaimIssuerError, Ed25519Verifier,
    Secp256k1Verifier, SignatureVerifier,
};

/// Scheme identifier for Ed25519 signatures.
pub const ED25519_SCHEME: u32 = 101;
/// Scheme identifier for Ethereum personal_sign (secp256k1, ERC-735 ECDSA).
pub const ETH_PERSONAL_SIGN_SCHEME: u32 = 1;

const ETH_PREFIX: &[u8; 28] = b"\x19Ethereum Signed Message:\n32";

/// keccak256("\x19Ethereum Signed Message:\n32" || keccak256(message)): what an EVM wallet signs for
/// personal_sign over the 32-byte claim digest.
pub fn eth_signed_digest(e: &Env, message: &Bytes) -> soroban_sdk::crypto::Hash<32> {
    let inner = e.crypto().keccak256(message);
    let mut m = Bytes::from_array(e, ETH_PREFIX);
    m.append(&Bytes::from_array(e, &inner.to_array()));
    e.crypto().keccak256(&m)
}

#[contract]
pub struct ClaimIssuerContract;

#[contractimpl]
impl ClaimIssuerContract {
    pub fn __constructor(e: &Env, owner: Address) {
        ownable::set_owner(e, &owner);
    }

    pub fn is_key_allowed(e: &Env, public_key: Bytes, registry: Address, claim_topic: u32) -> bool {
        is_key_allowed_for_topic(e, &public_key, ED25519_SCHEME, claim_topic)
            && is_key_allowed_for_registry(e, &public_key, ED25519_SCHEME, &registry)
    }

    #[only_owner]
    pub fn allow_key(e: &Env, public_key: Bytes, registry: Address, claim_topic: u32) {
        allow_key(e, &public_key, &registry, ED25519_SCHEME, claim_topic);
    }

    #[only_owner]
    pub fn remove_key(e: &Env, public_key: Bytes, registry: Address, claim_topic: u32) {
        remove_key(e, &public_key, &registry, ED25519_SCHEME, claim_topic);
    }

    /// An issuer's EVM wallet key (65-byte uncompressed secp256k1 public key) for Ethereum personal_sign claims.
    pub fn is_eth_key_allowed(e: &Env, public_key: Bytes, registry: Address, claim_topic: u32) -> bool {
        is_key_allowed_for_topic(e, &public_key, ETH_PERSONAL_SIGN_SCHEME, claim_topic)
            && is_key_allowed_for_registry(e, &public_key, ETH_PERSONAL_SIGN_SCHEME, &registry)
    }

    #[only_owner]
    pub fn allow_eth_key(e: &Env, public_key: Bytes, registry: Address, claim_topic: u32) {
        if public_key.len() != 65 || public_key.get(0) != Some(4) {
            panic_with_error!(e, ClaimIssuerError::SigDataMismatch);
        }
        allow_key(e, &public_key, &registry, ETH_PERSONAL_SIGN_SCHEME, claim_topic);
    }

    #[only_owner]
    pub fn remove_eth_key(e: &Env, public_key: Bytes, registry: Address, claim_topic: u32) {
        remove_key(e, &public_key, &registry, ETH_PERSONAL_SIGN_SCHEME, claim_topic);
    }
}

#[contractimpl]
impl ClaimIssuer for ClaimIssuerContract {
    fn is_claim_valid(
        e: &Env,
        identity: Address,
        claim_topic: u32,
        scheme: u32,
        sig_data: Bytes,
        claim_data: Bytes,
    ) {
        if is_claim_expired(e, &claim_data) {
            panic_with_error!(e, ClaimIssuerError::NotAllowed);
        }
        if is_claim_revoked(e, &identity, claim_topic, &claim_data) {
            panic_with_error!(e, ClaimIssuerError::NotAllowed);
        }

        if scheme == ED25519_SCHEME {
            let signature_data = Ed25519Verifier::extract_signature_data(e, &sig_data);
            let public_key_bytes: Bytes = signature_data.public_key.clone().into();
            if !is_key_allowed_for_topic(e, &public_key_bytes, ED25519_SCHEME, claim_topic) {
                panic_with_error!(e, ClaimIssuerError::NotAllowed);
            }
            let message = Ed25519Verifier::build_message(e, &identity, claim_topic, &claim_data);
            Ed25519Verifier::verify(e, &message, &signature_data);
        } else if scheme == ETH_PERSONAL_SIGN_SCHEME {
            let signature_data = Secp256k1Verifier::extract_signature_data(e, &sig_data);
            let public_key_bytes: Bytes = signature_data.public_key.clone().into();
            if !is_key_allowed_for_topic(e, &public_key_bytes, ETH_PERSONAL_SIGN_SCHEME, claim_topic) {
                panic_with_error!(e, ClaimIssuerError::NotAllowed);
            }
            let message = Secp256k1Verifier::build_message(e, &identity, claim_topic, &claim_data);
            let digest = eth_signed_digest(e, &message);
            let recovered = e.crypto().secp256k1_recover(&digest, &signature_data.signature, signature_data.recovery_id);
            if recovered != signature_data.public_key {
                panic_with_error!(e, ClaimIssuerError::Secp256k1RecoveryFailed);
            }
        } else {
            panic_with_error!(e, ClaimIssuerError::SigDataMismatch);
        }
    }
}

#[contractimpl(contracttrait)]
impl Ownable for ClaimIssuerContract {}
