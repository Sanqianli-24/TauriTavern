use async_trait::async_trait;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::sync::Arc;

use tt_adapter_http::github::classify_github_rate_limit;
use tt_adapter_http::{HttpClientPool, HttpClientProfile};
use tt_domain::errors::DomainError;
use tt_domain::models::update::{ReleaseAsset, ReleaseInfo, UpdateChannel};
use tt_ports::repositories::update_repository::UpdateRepository;

const GITHUB_REPOSITORY_API: &str = concat!(
    "https://api.github.com/repos/",
    env!("TAURITAVERN_UPDATE_REPOSITORY"),
);

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    prerelease: bool,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    state: String,
    size: u64,
    browser_download_url: String,
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubCommit {
    sha: String,
}

pub struct GitHubUpdateRepository {
    http_clients: Arc<HttpClientPool>,
}

impl GitHubUpdateRepository {
    pub fn new(http_clients: Arc<HttpClientPool>) -> Self {
        Self { http_clients }
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T, DomainError> {
        let client = self.http_clients.client(HttpClientProfile::Default)?;
        let response = client
            .get(format!("{GITHUB_REPOSITORY_API}/{path}"))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|error| {
                DomainError::InternalError(format!("GitHub API request failed: {error}"))
            })?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if let Some(domain_error) = classify_github_rate_limit(status, &body) {
                return Err(domain_error);
            }

            let snippet = body.trim();
            let suffix = if snippet.is_empty() {
                String::new()
            } else {
                format!(" ({snippet})")
            };

            return Err(DomainError::InternalError(format!(
                "GitHub API error: HTTP {}{}",
                status, suffix
            )));
        }

        response.json().await.map_err(|error| {
            DomainError::InternalError(format!("Failed to parse GitHub response: {error}"))
        })
    }
}

#[async_trait]
impl UpdateRepository for GitHubUpdateRepository {
    async fn get_release(&self, channel: UpdateChannel) -> Result<ReleaseInfo, DomainError> {
        let response: GitHubRelease = self
            .get_json(match channel {
                UpdateChannel::Stable => "releases/latest",
                UpdateChannel::Canary => "releases/tags/Canary",
            })
            .await?;

        match channel {
            UpdateChannel::Stable if response.prerelease => {
                return Err(DomainError::InvalidData(
                    "Stable update endpoint returned a prerelease".to_string(),
                ));
            }
            UpdateChannel::Canary if !response.prerelease => {
                return Err(DomainError::InvalidData(
                    "Canary update endpoint returned a stable release".to_string(),
                ));
            }
            _ => {}
        }

        let version =
            (channel == UpdateChannel::Stable).then(|| parse_version_from_tag(&response.tag_name));
        let source_revision = if channel == UpdateChannel::Canary {
            Some(self.get_json::<GitHubCommit>("commits/Canary").await?.sha)
        } else {
            None
        };

        Ok(ReleaseInfo {
            tag_name: response.tag_name,
            version,
            source_revision,
            name: response.name.unwrap_or_default(),
            body: response.body.unwrap_or_default(),
            html_url: response.html_url,
            prerelease: response.prerelease,
            published_at: response.published_at.unwrap_or_default(),
            assets: response
                .assets
                .into_iter()
                .filter(|asset| asset.state == "uploaded")
                .map(|asset| ReleaseAsset {
                    name: asset.name,
                    size: asset.size,
                    download_url: asset.browser_download_url,
                    digest: asset.digest,
                })
                .collect(),
        })
    }
}

fn parse_version_from_tag(tag: &str) -> String {
    let tag = tag.trim();
    let Some(start) = tag.find(|c: char| c.is_ascii_digit()) else {
        return tag.to_string();
    };

    let candidate = &tag[start..];
    let end = candidate
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(candidate.len());
    candidate[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::parse_version_from_tag;

    #[test]
    fn mobile_auto_branch_suffix_keeps_release_version() {
        assert_eq!(
            parse_version_from_tag("mobile-auto-v1.4.0-next-2.0.0"),
            "1.4.0"
        );
    }
}
