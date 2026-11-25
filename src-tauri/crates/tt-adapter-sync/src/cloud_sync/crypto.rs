use aws_lc_rs::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use aws_lc_rs::{digest, hkdf, rand};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use tt_domain::errors::DomainError;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::invalid;

const RECOVERY_PREFIX: &str = "tt-cloud-v1-";
const AAD_PREFIX: &str = "tauritavern-cloud/v1";

pub(super) struct VaultKey {
    pub(super) id: Uuid,
    seed: Zeroizing<[u8; 32]>,
    key: LessSafeKey,
}

impl VaultKey {
    pub(super) fn generate() -> Result<Self, DomainError> {
        let mut seed = Zeroizing::new([0; 32]);
        rand::fill(seed.as_mut()).map_err(|_| invalid("Random number generator unavailable"))?;
        Self::from_seed(seed)
    }

    pub(super) fn parse(code: &str) -> Result<Self, DomainError> {
        let seed = code
            .trim()
            .strip_prefix(RECOVERY_PREFIX)
            .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
            .map(Zeroizing::new)
            .ok_or_else(wrong_code)?;
        let bytes = <[u8; 32]>::try_from(seed.as_slice()).map_err(|_| wrong_code())?;
        Self::from_seed(Zeroizing::new(bytes))
    }

    fn from_seed(seed: Zeroizing<[u8; 32]>) -> Result<Self, DomainError> {
        let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, AAD_PREFIX.as_bytes()).extract(seed.as_ref());
        let mut id = [0; 16];
        let mut material = Zeroizing::new([0u8; 32]);
        prk.expand(&[b"vault identifier"], hkdf::HKDF_SHA256)
            .and_then(|okm| okm.fill(material.as_mut()))
            .map_err(|_| wrong_code())?;
        id.copy_from_slice(&material[..16]);
        prk.expand(&[b"object encryption"], hkdf::HKDF_SHA256)
            .and_then(|okm| okm.fill(material.as_mut()))
            .map_err(|_| wrong_code())?;
        let key = UnboundKey::new(&AES_256_GCM, material.as_ref()).map_err(|_| wrong_code())?;
        Ok(Self {
            id: Uuid::from_bytes(id),
            seed,
            key: LessSafeKey::new(key),
        })
    }

    pub(super) fn code(&self) -> String {
        format!(
            "{RECOVERY_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(self.seed.as_ref())
        )
    }

    pub(super) fn seal(&self, path: &str, plain: &[u8]) -> Result<Vec<u8>, DomainError> {
        let mut data = zstd::bulk::compress(plain, 3)
            .map_err(|_| invalid("Failed to compress cloud sync data"))?;
        let mut nonce = [0; NONCE_LEN];
        rand::fill(&mut nonce).map_err(|_| invalid("Random number generator unavailable"))?;
        self.key
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(self.aad(path)),
                &mut data,
            )
            .map_err(|_| invalid("Failed to encrypt cloud sync data"))?;
        let mut output = Vec::with_capacity(NONCE_LEN + data.len());
        output.extend(nonce);
        output.extend(data);
        Ok(output)
    }

    pub(super) fn open(
        &self,
        path: &str,
        mut sealed: Vec<u8>,
        limit: usize,
    ) -> Result<Vec<u8>, DomainError> {
        let nonce = sealed.get(..NONCE_LEN).ok_or_else(wrong_code)?;
        let nonce = Nonce::try_assume_unique_for_key(nonce).map_err(|_| wrong_code())?;
        let compressed = self
            .key
            .open_in_place(nonce, Aad::from(self.aad(path)), &mut sealed[NONCE_LEN..])
            .map_err(|_| wrong_code())?;
        zstd::bulk::decompress(compressed, limit)
            .map_err(|_| invalid("Corrupt or oversized cloud sync object"))
    }

    fn aad(&self, path: &str) -> String {
        format!("{AAD_PREFIX}/{}/{path}", self.id)
    }
}

fn wrong_code() -> DomainError {
    DomainError::AuthenticationError(
        "The cloud recovery code is incorrect or the encrypted data is damaged".into(),
    )
}

pub(super) fn hash(bytes: &[u8]) -> String {
    digest_text(digest::digest(&digest::SHA256, bytes))
}

pub(super) fn digest_text(value: digest::Digest) -> String {
    URL_SAFE_NO_PAD.encode(value.as_ref())
}
