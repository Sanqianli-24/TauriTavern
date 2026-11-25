use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

use reqwest::{Client, Method, Response, StatusCode, header};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tt_domain::errors::DomainError;
use url::Url;
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

use super::crypto::VaultKey;
use super::invalid;

const DIRECTORY: &str = "TauriTavern-Sync-v1/";
const MARKER: &str = "vault";
const MAX_HEADS: usize = 128;
const MAX_LIST_BYTES: usize = 1024 * 1024;
const REQUEST_WINDOW: Duration = Duration::from_secs(30 * 60);
const REQUESTS_PER_WINDOW: usize = 250;
pub(super) const CIPHERTEXT_MARGIN: usize = 256 * 1024;

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub(super) struct Credentials {
    pub(super) url: String,
    pub(super) account: String,
    pub(super) password: String,
    pub(super) recovery_code: String,
}

pub(super) struct Dav<'a> {
    client: Client,
    base: Url,
    vault: Url,
    credentials: &'a Credentials,
    budget: &'a Mutex<RequestBudget>,
}

#[derive(Default)]
pub(super) struct RequestBudget {
    retry_after: Option<Instant>,
    sent: VecDeque<Instant>,
}

impl<'a> Dav<'a> {
    pub(super) fn new(
        credentials: &'a Credentials,
        key: &VaultKey,
        user_agent: &str,
        budget: &'a Mutex<RequestBudget>,
    ) -> Result<Self, DomainError> {
        let mut base = Url::parse(credentials.url.trim())
            .map_err(|_| invalid("Enter a valid HTTPS WebDAV address"))?;
        if base.scheme() != "https"
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(invalid(
                "Use an HTTPS WebDAV address without credentials or query parameters",
            ));
        }
        if !base.path().ends_with('/') {
            base.path_segments_mut()
                .map_err(|_| invalid("Invalid WebDAV address"))?
                .push("");
        }
        if credentials.account.trim().is_empty()
            || credentials.account.contains(':')
            || credentials.password.is_empty()
        {
            return Err(invalid("Enter the WebDAV account and app password"));
        }
        let vault = base
            .join(&format!("{DIRECTORY}{}/", key.id.simple()))
            .map_err(|_| invalid("Invalid WebDAV storage path"))?;
        let builder = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(12))
            .timeout(Duration::from_secs(120));
        let client = tt_adapter_http::build_http_client(builder, user_agent)
            .map_err(|_| invalid("Cannot start WebDAV client"))?;
        Ok(Self {
            client,
            base,
            vault,
            credentials,
            budget,
        })
    }

    pub(super) async fn check_account(&self) -> Result<(), DomainError> {
        self.propfind(self.base.clone(), "0").await?;
        Ok(())
    }

    pub(super) async fn create(&self, key: &VaultKey) -> Result<(), DomainError> {
        self.create_collection(self.base.join(DIRECTORY).expect("valid DAV path"), true)
            .await?;
        self.create_collection(self.vault.clone(), false).await?;
        self.create_collection(self.url("heads/")?, false).await?;
        self.create_collection(self.url("objects/")?, false).await?;
        self.put(MARKER, key.seal(MARKER, b"TauriTavern encrypted sync v1")?)
            .await
    }

    pub(super) async fn unlock(&self, key: &VaultKey) -> Result<(), DomainError> {
        let data = self.get(MARKER, 1024).await.map_err(|error| match error {
            DomainError::NotFound(_) => DomainError::AuthenticationError(
                "This recovery code does not identify a vault on the selected WebDAV account"
                    .into(),
            ),
            other => other,
        })?;
        if key.open(MARKER, data, 128)? != b"TauriTavern encrypted sync v1" {
            return Err(invalid("Unsupported cloud vault format"));
        }
        Ok(())
    }

    pub(super) async fn heads(&self) -> Result<BTreeMap<Uuid, Option<String>>, DomainError> {
        let url = self.url("heads/")?;
        let bytes = limited(self.propfind(url.clone(), "1").await?, MAX_LIST_BYTES).await?;
        let listing: Listing = quick_xml::de::from_reader(bytes.as_slice())
            .map_err(|_| invalid("Invalid WebDAV directory listing"))?;
        let mut heads = BTreeMap::new();
        let mut saw_collection = false;
        for row in listing.response {
            let href = url
                .join(&row.href)
                .map_err(|_| invalid("Invalid WebDAV directory entry"))?;
            if href.origin() != url.origin() || href.query().is_some() || href.fragment().is_some()
            {
                return Err(invalid("Unexpected WebDAV directory entry"));
            }
            if href.path().trim_end_matches('/') == url.path().trim_end_matches('/') {
                saw_collection = true;
                continue;
            }
            let id = href
                .path()
                .strip_prefix(url.path())
                .and_then(|name| name.strip_suffix(".head"))
                .and_then(|name| {
                    Uuid::parse_str(name)
                        .ok()
                        .filter(|id| id.simple().to_string() == name)
                })
                .ok_or_else(|| invalid("Unexpected file in cloud sync heads directory"))?;
            let etag = row
                .propstat
                .into_iter()
                .find(|p| p.status.split_whitespace().nth(1) == Some("200"))
                .map(|p| {
                    p.prop
                        .getetag
                        .filter(|tag| !tag.is_empty() && !tag.starts_with("W/"))
                })
                .ok_or_else(|| invalid("WebDAV returned an unreadable sync head"))?;
            if heads.insert(id, etag).is_some() || heads.len() > MAX_HEADS {
                return Err(invalid(
                    "Cloud sync device listing is incomplete or exceeds 128 devices",
                ));
            }
        }
        if !saw_collection {
            return Err(invalid("WebDAV returned an incomplete sync directory"));
        }
        Ok(heads)
    }

    pub(super) async fn get(&self, object: &str, limit: usize) -> Result<Vec<u8>, DomainError> {
        let response = self
            .request(Method::GET, self.url(object)?)
            .await?
            .send()
            .await
            .map_err(network_error)?;
        self.check(&response, "download").await?;
        limited(response, limit).await
    }

    pub(super) async fn put(&self, object: &str, bytes: Vec<u8>) -> Result<(), DomainError> {
        let response = self
            .request(Method::PUT, self.url(object)?)
            .await?
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(network_error)?;
        self.check(&response, "upload").await
    }

    fn url(&self, relative: &str) -> Result<Url, DomainError> {
        self.vault
            .join(relative)
            .map_err(|_| invalid("Invalid WebDAV object path"))
    }

    async fn create_collection(&self, url: Url, may_exist: bool) -> Result<(), DomainError> {
        let response = self
            .request(
                Method::from_bytes(b"MKCOL").expect("valid method"),
                url.clone(),
            )
            .await?
            .send()
            .await
            .map_err(network_error)?;
        if may_exist
            && matches!(
                response.status(),
                StatusCode::METHOD_NOT_ALLOWED | StatusCode::FORBIDDEN
            )
        {
            self.propfind(url, "0").await?;
            return Ok(());
        }
        self.check(&response, "create sync directory").await
    }

    async fn propfind(&self, url: Url, depth: &'static str) -> Result<Response, DomainError> {
        let response = self
            .request(Method::from_bytes(b"PROPFIND").expect("valid method"), url)
            .await?
            .header("Depth", depth)
            .header(header::CONTENT_TYPE, "application/xml")
            .body(r#"<propfind xmlns="DAV:"><prop><getetag/><resourcetype/></prop></propfind>"#)
            .send()
            .await
            .map_err(network_error)?;
        self.check(&response, "list sync directory").await?;
        if response.status() != StatusCode::MULTI_STATUS {
            return Err(invalid(
                "The endpoint did not return a WebDAV directory listing",
            ));
        }
        Ok(response)
    }

    async fn request(
        &self,
        method: Method,
        url: Url,
    ) -> Result<reqwest::RequestBuilder, DomainError> {
        let mut budget = self.budget.lock().await;
        let now = Instant::now();
        if let Some(until) = budget.retry_after
            && let Some(remaining) = until.checked_duration_since(now)
        {
            return Err(rate_limit(remaining));
        }
        while budget
            .sent
            .front()
            .is_some_and(|sent| now.duration_since(*sent) >= REQUEST_WINDOW)
        {
            budget.sent.pop_front();
        }
        // Leave spare capacity for two devices sharing a personal Nutstore account.
        if budget.sent.len() >= REQUESTS_PER_WINDOW {
            return Err(rate_limit(
                REQUEST_WINDOW - now.duration_since(budget.sent[0]),
            ));
        }
        budget.sent.push_back(now);
        Ok(self
            .client
            .request(method, url)
            .header(header::CACHE_CONTROL, "no-cache")
            .basic_auth(&self.credentials.account, Some(&self.credentials.password)))
    }

    async fn check(&self, response: &Response, action: &str) -> Result<(), DomainError> {
        let status = response.status();
        match status {
            StatusCode::TOO_MANY_REQUESTS
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::INSUFFICIENT_STORAGE => {
                let seconds = response
                    .headers()
                    .get(header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()?.parse::<u64>().ok())
                    .unwrap_or(120)
                    .clamp(1, 1800);
                let delay = Duration::from_secs(seconds);
                self.budget.lock().await.retry_after = Some(Instant::now() + delay);
                if status == StatusCode::INSUFFICIENT_STORAGE {
                    return Err(DomainError::rate_limited(
                        "The WebDAV account has insufficient storage",
                    ));
                }
                Err(rate_limit(delay))
            }
            StatusCode::UNAUTHORIZED => Err(DomainError::AuthenticationError(
                "WebDAV rejected the account or app password".into(),
            )),
            StatusCode::NOT_FOUND => {
                Err(DomainError::NotFound(format!("WebDAV could not {action}")))
            }
            StatusCode::FORBIDDEN => Err(DomainError::AuthenticationError(format!(
                "WebDAV refused to {action} (403). Check the app password, directory access, and transfer quota."
            ))),
            status if status.is_success() => Ok(()),
            _ => Err(DomainError::Transient(format!(
                "WebDAV could not {action} (HTTP {})",
                status.as_u16()
            ))),
        }
    }

    #[cfg(test)]
    pub(super) fn trust_test_server(&mut self, pem: &[u8]) {
        self.client = Client::builder()
            .https_only(true)
            .add_root_certificate(reqwest::Certificate::from_pem(pem).unwrap())
            .build()
            .unwrap();
    }
}

pub(super) fn head_path(device: Uuid) -> String {
    format!("heads/{}.head", device.simple())
}

pub(super) fn object_path(object: Uuid) -> String {
    format!("objects/{}", object.simple())
}

#[derive(Deserialize)]
struct Listing {
    #[serde(default)]
    response: Vec<ListingEntry>,
}

#[derive(Deserialize)]
struct ListingEntry {
    href: String,
    #[serde(default)]
    propstat: Vec<PropertyStatus>,
}

#[derive(Deserialize)]
struct PropertyStatus {
    prop: Properties,
    status: String,
}

#[derive(Deserialize)]
struct Properties {
    getetag: Option<String>,
}

fn rate_limit(delay: Duration) -> DomainError {
    DomainError::rate_limited(format!(
        "WebDAV is limiting sync requests. Try again in {} seconds.",
        delay.as_secs() + 1
    ))
}

fn network_error(error: reqwest::Error) -> DomainError {
    // Credentials and server URLs must not appear in command errors or job logs.
    let reason = if error.is_timeout() {
        "request timed out"
    } else {
        "connection interrupted"
    };
    DomainError::transient(format!("WebDAV {reason}"))
}

async fn limited(mut response: Response, limit: usize) -> Result<Vec<u8>, DomainError> {
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(invalid("WebDAV object exceeds the sync format size limit"));
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > limit.saturating_sub(data.len()) {
            return Err(invalid("WebDAV object exceeds the sync format size limit"));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
