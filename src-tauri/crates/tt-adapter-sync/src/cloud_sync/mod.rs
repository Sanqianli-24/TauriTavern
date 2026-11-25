mod apply;
mod browser;
mod crypto;
mod dav;
mod exchange;
mod model;
mod packing;
#[cfg(test)]
mod tests;
mod workspace;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;
use tt_contracts::cloud_sync::{
    CloudBrowserRequest, CloudBrowserResponse, CloudConnectInput, CloudConnectMode,
    CloudConnectPreview, CloudConnection, CloudSyncOperation, CloudSyncStatus,
};
use tt_contracts::sync::{
    LocalAppliedChangeSummary, SyncExecutionFailure, SyncExecutionReport, SyncJob, SyncJobEvent,
    SyncJobProgress, SyncJobProgressDirection, SyncJobSummary,
};
use tt_domain::errors::DomainError;
use tt_ports::cloud_sync::{CloudAccountGateway, CloudCredentialStore};
use tt_ports::database::DatabaseFileAccess;
use tt_ports::sync::SyncJobEventPublisher;
use ttsync_contract::sync::SyncPhase;
use zeroize::Zeroizing;

use self::browser::BrowserStorage;
use self::crypto::VaultKey;
use self::dav::{Credentials, Dav, RequestBudget};
use self::model::{Catalog, State, conflicts};
use self::workspace::{CloudWorkspace, ScanCache};
use crate::json_file::{read_json_file, write_json_file};

pub struct CloudSyncRuntime {
    root: PathBuf,
    workspace: CloudWorkspace,
    browser: BrowserStorage,
    credentials: Arc<dyn CloudCredentialStore>,
    events: Arc<dyn SyncJobEventPublisher>,
    user_agent: String,
    gate: Mutex<()>,
    browser_vault: Mutex<Option<PathBuf>>,
    scan_cache: Mutex<ScanCache>,
    request_budget: Mutex<RequestBudget>,
}

impl CloudSyncRuntime {
    pub fn new(
        data_root: PathBuf,
        private_root: PathBuf,
        database: Arc<dyn DatabaseFileAccess>,
        vector_database: Arc<dyn DatabaseFileAccess>,
        credentials: Arc<dyn CloudCredentialStore>,
        events: Arc<dyn SyncJobEventPublisher>,
        user_agent: impl Into<String>,
    ) -> Self {
        let browser = BrowserStorage::new(private_root.clone());
        let workspace =
            CloudWorkspace::new(data_root, browser.current(), database, vector_database);
        Self {
            root: private_root,
            credentials,
            workspace,
            browser,
            events,
            user_agent: user_agent.into(),
            gate: Mutex::new(()),
            browser_vault: Mutex::new(None),
            scan_cache: Mutex::new(ScanCache::new()),
            request_budget: Mutex::new(RequestBudget::default()),
        }
    }

    #[expect(
        clippy::result_large_err,
        reason = "Keeps the shared sync error and partial local changes together"
    )]
    pub async fn execute(
        &self,
        job: &SyncJob,
        operation: CloudSyncOperation,
    ) -> Result<SyncExecutionReport, SyncExecutionFailure> {
        let _guard = self.try_lock()?;
        let (credentials, key) = self.account().await?;
        let root = self.vault(&key);
        let mut state = load_state(&root).await?;
        if self.browser.capturing().await {
            return Err(DomainError::transient("Browser storage capture is still running").into());
        }
        let mut local = LocalAppliedChangeSummary::default();
        let result = match operation {
            CloudSyncOperation::Apply => self.apply(job, &root, &key, &mut state, &mut local).await,
            CloudSyncOperation::Exchange | CloudSyncOperation::Resolve(_) => {
                let dav = self.dav(&credentials, &key)?;
                self.exchange(job, &root, &key, &dav, &mut state, operation)
                    .await
            }
        };
        result
            .map(|summary| SyncExecutionReport::completed(summary, local))
            .map_err(|error| SyncExecutionFailure::new(error, local))
    }

    fn dav<'a>(
        &'a self,
        credentials: &'a Credentials,
        key: &VaultKey,
    ) -> Result<Dav<'a>, DomainError> {
        Dav::new(credentials, key, &self.user_agent, &self.request_budget)
    }

    fn vault(&self, key: &VaultKey) -> PathBuf {
        self.root.join(key.id.simple().to_string())
    }

    async fn account(&self) -> Result<(Credentials, VaultKey), DomainError> {
        let credentials = self.load_credentials().await?.ok_or_else(|| {
            DomainError::AuthenticationError("Connect a WebDAV account to sync".into())
        })?;
        let key = VaultKey::parse(&credentials.recovery_code)?;
        Ok((credentials, key))
    }

    async fn load_credentials(&self) -> Result<Option<Credentials>, DomainError> {
        self.credentials
            .load()
            .await?
            .map(|payload| {
                let payload = Zeroizing::new(payload);
                serde_json::from_str(&payload)
                    .map_err(|_| invalid("Invalid stored WebDAV credentials"))
            })
            .transpose()
    }

    fn try_lock(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, DomainError> {
        self.gate
            .try_lock()
            .map_err(|_| DomainError::transient("Another cloud sync operation is running"))
    }

    fn progress(&self, job: &SyncJob, phase: SyncPhase, done: usize, total: usize) {
        self.events.publish_sync_job(SyncJobEvent::progress(
            job.context(),
            SyncJobProgress {
                direction: if phase == SyncPhase::Uploading {
                    SyncJobProgressDirection::Push
                } else {
                    SyncJobProgressDirection::Pull
                },
                phase,
                files_done: done,
                files_total: total,
                bytes_done: 0,
                bytes_total: 0,
                current_path: None,
            },
        ));
    }
}

#[async_trait]
impl CloudAccountGateway for CloudSyncRuntime {
    async fn preview(&self, input: CloudConnectInput) -> Result<CloudConnectPreview, DomainError> {
        let _guard = self.try_lock()?;
        let (mode, credentials, key) = connection(input)?;
        let dav = self.dav(&credentials, &key)?;
        let cloud = if mode == CloudConnectMode::Create {
            dav.check_account().await?;
            Catalog::new()
        } else {
            dav.unlock(&key).await?;
            let mut state = State::new(false);
            self.read_heads(&dav, &key, &mut state).await?;
            state.known
        };
        let _vector = self.workspace.vector_database.prepare_sync(false).await?;
        let _db = self.workspace.database.prepare_sync(false).await?;
        let local = self
            .workspace
            .scan(&mut *self.scan_cache.lock().await)
            .await?;
        Ok(CloudConnectPreview {
            local_files: local.values().map(|unit| unit.len()).sum(),
            local_bytes: local.values().flatten().map(|(_, file)| file.len).sum(),
            cloud_items: cloud
                .values()
                .filter(|versions| versions.iter().any(|version| !version.files.is_empty()))
                .count(),
            cloud_bytes: cloud
                .values()
                .flatten()
                .flat_map(|version| version.files.values())
                .fold(0u64, |sum, file| sum.saturating_add(file.len)),
        })
    }

    async fn connect(&self, input: CloudConnectInput) -> Result<CloudConnection, DomainError> {
        let _guard = self.try_lock()?;
        if self.load_credentials().await?.is_some() {
            return Err(DomainError::Conflict(
                "Disconnect the current WebDAV account first".into(),
            ));
        }
        let (mode, credentials, key) = connection(input)?;
        let dav = self.dav(&credentials, &key)?;
        match mode {
            CloudConnectMode::Create => {
                dav.check_account().await?;
                dav.create(&key).await?;
            }
            _ => dav.unlock(&key).await?,
        }
        let root = self.vault(&key);
        match load_state(&root).await {
            Ok(_) => {}
            Err(DomainError::NotFound(_)) => {
                save_state(&root, &State::new(mode == CloudConnectMode::Restore)).await?
            }
            Err(error) => return Err(error),
        }
        let payload = serde_json::to_string(&credentials)
            .map_err(|_| invalid("Cannot save the WebDAV account"))?;
        self.credentials.save(payload).await?;
        *self.browser_vault.lock().await = Some(root);
        Ok(CloudConnection {
            recovery_code: if mode == CloudConnectMode::Create {
                key.code()
            } else {
                String::new()
            },
        })
    }

    async fn disconnect(&self) -> Result<(), DomainError> {
        let _guard = self.try_lock()?;
        self.credentials.clear().await?;
        *self.browser_vault.lock().await = None;
        *self.request_budget.lock().await = RequestBudget::default();
        Ok(())
    }

    async fn recovery_code(&self) -> Result<String, DomainError> {
        let (_, key) = self.account().await?;
        Ok(key.code())
    }

    async fn status(&self) -> Result<CloudSyncStatus, DomainError> {
        let Some(credentials) = self.load_credentials().await? else {
            return Ok(CloudSyncStatus::default());
        };
        let root = self.vault(&VaultKey::parse(&credentials.recovery_code)?);
        let state = load_state(&root).await?;
        Ok(CloudSyncStatus {
            account: Some(credentials.account.clone()),
            device: Some(state.device.simple().to_string()[..8].to_owned()),
            last_synced_ms: state.last_synced_ms,
            pending_apply: !state.apply.is_empty() || !browser::pending(&root).await?.is_empty(),
            pending_upload: state.outbox.is_some(),
            conflicts: conflicts(&state.known),
        })
    }

    async fn browser(
        &self,
        request: CloudBrowserRequest,
    ) -> Result<CloudBrowserResponse, DomainError> {
        let _guard = self.try_lock()?;
        let mut vault = self.browser_vault.lock().await;
        if vault.is_none() {
            let (_, key) = self.account().await?;
            *vault = Some(self.vault(&key));
        }
        self.browser
            .command(vault.as_deref().expect("connected vault"), request)
            .await
    }
}

fn connection(
    input: CloudConnectInput,
) -> Result<(CloudConnectMode, Credentials, VaultKey), DomainError> {
    if !input.include_credentials {
        return Err(invalid(
            "Confirm encrypted sync of model keys and extension credentials",
        ));
    }
    let key = match input.mode {
        CloudConnectMode::Create => VaultKey::generate()?,
        _ => VaultKey::parse(&input.recovery_code)?,
    };
    Ok((
        input.mode,
        Credentials {
            url: input.url,
            account: input.account.trim().to_owned(),
            password: input.app_password,
            recovery_code: key.code(),
        },
        key,
    ))
}

async fn load_state(root: &Path) -> Result<State, DomainError> {
    read_json_file(&root.join("state.json")).await
}

async fn save_state(root: &Path, state: &State) -> Result<(), DomainError> {
    write_json_file(&root.join("state.json"), state).await
}

fn invalid(message: impl Into<String>) -> DomainError {
    DomainError::InvalidData(message.into())
}

fn now_ms() -> u64 {
    crate::sync_transfer::now_ms()
}

fn empty_summary() -> SyncJobSummary {
    SyncJobSummary::new(0, 0, 0)
}
