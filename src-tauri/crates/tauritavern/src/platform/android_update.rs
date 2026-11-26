use tt_domain::models::update::{ReleaseAsset, UpdateChannel, UpdateCheckResult};

const REPOSITORY: &str = env!("TAURITAVERN_UPDATE_REPOSITORY");

pub(crate) fn installable_apk(result: &UpdateCheckResult) -> Option<(&ReleaseAsset, &str)> {
    if !result.has_update || result.channel != UpdateChannel::Stable {
        return None;
    }
    let release = result.latest_release.as_ref()?;
    let version = release.version.as_deref()?;
    if version.split('.').count() != 3
        || !version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        || release.tag_name != format!("v{version}")
        || release.prerelease
    {
        return None;
    }

    let name = format!("NexusTavern-{version}-android-arm64.apk");
    let url = format!(
        "https://github.com/{REPOSITORY}/releases/download/{}/{name}",
        release.tag_name
    );
    release.assets.iter().find_map(|asset| {
        let digest = asset.digest.as_deref()?.strip_prefix("sha256:")?;
        (asset.name == name
            && asset.download_url == url
            && asset.size > 0
            && digest.len() == 64
            && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some((asset, digest))
    })
}

#[cfg(all(android_local, target_arch = "aarch64"))]
mod native {
    use std::sync::Arc;

    use tauri::{
        AppHandle, Manager, Runtime,
        ipc::Channel,
        plugin::{PluginHandle, TauriPlugin},
    };
    use tokio::sync::Mutex;
    use tt_adapter_http::HttpClientPool;
    use tt_domain::errors::DomainError;
    use tt_domain::models::update::UpdateCheckResult;

    struct AndroidUpdate<R: Runtime> {
        handle: PluginHandle<R>,
        in_progress: Mutex<()>,
    }

    #[derive(serde::Deserialize, serde::Serialize)]
    #[serde(rename_all = "snake_case")]
    pub(crate) enum InstallOutcome {
        InstallerOpened,
        PermissionRequired,
    }

    pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
        tauri::plugin::Builder::new("android-update")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin("com.tauritavern.client", "AndroidUpdatePlugin")?;
                app.manage(AndroidUpdate {
                    handle,
                    in_progress: Mutex::new(()),
                });
                Ok(())
            })
            .build()
    }

    pub(crate) async fn install(
        app: &AppHandle,
        result: &UpdateCheckResult,
        progress: Channel<u8>,
    ) -> Result<InstallOutcome, DomainError> {
        let (asset, sha256) = super::installable_apk(result).ok_or_else(|| {
            DomainError::InvalidData("The release has no compatible Android update package".into())
        })?;
        let plugin = app.state::<AndroidUpdate<tauri::Wry>>();
        let _install = plugin.in_progress.try_lock().map_err(|_| {
            DomainError::Conflict("An Android update is already in progress".into())
        })?;

        let directory = app
            .path()
            .app_cache_dir()
            .map_err(internal_error)?
            .join("updates");
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(internal_error)?;
        let package = directory.join("update.apk");
        let mut last_percentage = 0;
        app.state::<Arc<HttpClientPool>>()
            .download_verified(
                &asset.download_url,
                &package,
                asset.size,
                sha256,
                |received| {
                    let percentage = ((u128::from(received) * 100) / u128::from(asset.size)) as u8;
                    if percentage > last_percentage {
                        last_percentage = percentage;
                        let _ = progress.send(percentage);
                    }
                },
            )
            .await?;

        plugin.handle
            .run_mobile_plugin_async("install", serde_json::json!({
                "version": result.latest_release.as_ref().and_then(|release| release.version.as_deref()),
            }))
            .await
            .map_err(internal_error)
    }

    fn internal_error(error: impl std::fmt::Display) -> DomainError {
        DomainError::InternalError(format!("Android update failed: {error}"))
    }
}

#[cfg(all(android_local, target_arch = "aarch64"))]
pub(crate) use native::{InstallOutcome, install, plugin};

#[cfg(test)]
mod tests {
    use super::*;
    use tt_domain::models::update::ReleaseInfo;

    #[test]
    fn android_install_requires_an_uploaded_arm64_asset_from_the_configured_release() {
        let mut result = UpdateCheckResult {
            has_update: true,
            current_version: "2.4.5".into(),
            channel: UpdateChannel::Stable,
            release_token: Some("stable:v2.4.6".into()),
            latest_release: Some(ReleaseInfo {
                tag_name: "v2.4.6".into(),
                version: Some("2.4.6".into()),
                source_revision: None,
                name: String::new(),
                body: String::new(),
                html_url: String::new(),
                prerelease: false,
                published_at: String::new(),
                assets: vec![ReleaseAsset {
                    name: "NexusTavern-2.4.6-android-arm64.apk".into(),
                    size: 100,
                    download_url: format!(
                        "https://github.com/{REPOSITORY}/releases/download/v2.4.6/NexusTavern-2.4.6-android-arm64.apk"
                    ),
                    digest: Some(format!("sha256:{}", "ab".repeat(32))),
                }],
            }),
        };
        assert!(installable_apk(&result).is_some());

        let asset = &mut result.latest_release.as_mut().unwrap().assets[0];
        let url = asset.download_url.clone();
        asset.download_url = url.replace("/v2.4.6/", "/v2.4.5/");
        assert!(installable_apk(&result).is_none());

        let asset = &mut result.latest_release.as_mut().unwrap().assets[0];
        asset.download_url = url;
        asset.digest = None;
        assert!(installable_apk(&result).is_none());
    }
}
