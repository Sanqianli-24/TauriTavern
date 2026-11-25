use async_trait::async_trait;
use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{PluginHandle, TauriPlugin},
};
use tt_domain::errors::DomainError;
use tt_ports::cloud_sync::CloudCredentialStore;

struct CloudCredentialsPlugin<R: Runtime>(Result<PluginHandle<R>, String>);

pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("cloud-credentials")
        .setup(|app, api| {
            let handle = api
                .register_android_plugin("com.tauritavern.client", "CloudCredentialsPlugin")
                .map_err(|error| error.to_string());
            app.manage(CloudCredentialsPlugin(handle));
            Ok(())
        })
        .build()
}

pub(crate) struct AndroidCredentialStore(AppHandle);

impl AndroidCredentialStore {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self(app)
    }

    pub(crate) async fn private_root(&self) -> Result<std::path::PathBuf, DomainError> {
        let storage: CloudStorage = self
            .invoke("storageDirectory", serde_json::Value::Null)
            .await?;
        Ok(storage.path)
    }

    async fn invoke<T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        payload: serde_json::Value,
    ) -> Result<T, DomainError> {
        let plugin = self
            .0
            .try_state::<CloudCredentialsPlugin<tauri::Wry>>()
            .ok_or_else(unavailable)?;
        let handle = plugin.0.as_ref().map_err(|_| unavailable())?;
        handle
            .run_mobile_plugin_async(command, payload)
            .await
            .map_err(|_| unavailable())
    }
}

fn unavailable() -> DomainError {
    DomainError::AuthenticationError(
        "Android Keystore could not access the WebDAV connection".into(),
    )
}

#[derive(serde::Deserialize)]
struct LoadedCredentials {
    value: Option<String>,
}

#[derive(serde::Deserialize)]
struct CloudStorage {
    path: std::path::PathBuf,
}

#[async_trait]
impl CloudCredentialStore for AndroidCredentialStore {
    async fn load(&self) -> Result<Option<String>, DomainError> {
        let loaded: LoadedCredentials = self.invoke("load", serde_json::Value::Null).await?;
        Ok(loaded.value)
    }

    async fn save(&self, credentials: String) -> Result<(), DomainError> {
        self.invoke("save", serde_json::json!({ "value": credentials }))
            .await
    }

    async fn clear(&self) -> Result<(), DomainError> {
        self.invoke("clear", serde_json::Value::Null).await
    }
}
