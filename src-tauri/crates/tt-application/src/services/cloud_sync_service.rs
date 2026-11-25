use std::sync::Arc;

use tt_contracts::cloud_sync::{
    CloudBrowserRequest, CloudBrowserResponse, CloudConnectInput, CloudConnectPreview,
    CloudConnection, CloudSyncOperation, CloudSyncStatus,
};
use tt_contracts::sync::{
    ResolvedSyncPolicy, SyncEndpointRef, SyncIntent, SyncJobReport, SyncJobRequest, SyncOrigin,
};
use tt_domain::errors::DomainError;
use tt_ports::cloud_sync::CloudAccountGateway;

use super::sync_job_coordinator::SyncJobCoordinator;

pub struct CloudSyncService {
    account: Arc<dyn CloudAccountGateway>,
    jobs: Arc<SyncJobCoordinator>,
}

impl CloudSyncService {
    pub fn new(account: Arc<dyn CloudAccountGateway>, jobs: Arc<SyncJobCoordinator>) -> Self {
        Self { account, jobs }
    }

    pub async fn preview(
        &self,
        input: CloudConnectInput,
    ) -> Result<CloudConnectPreview, DomainError> {
        self.account.preview(input).await
    }

    pub async fn connect(&self, input: CloudConnectInput) -> Result<CloudConnection, DomainError> {
        self.account.connect(input).await
    }

    pub async fn disconnect(&self) -> Result<(), DomainError> {
        self.account.disconnect().await
    }

    pub async fn recovery_code(&self) -> Result<String, DomainError> {
        self.account.recovery_code().await
    }

    pub async fn status(&self) -> Result<CloudSyncStatus, DomainError> {
        self.account.status().await
    }

    pub async fn browser(
        &self,
        request: CloudBrowserRequest,
    ) -> Result<CloudBrowserResponse, DomainError> {
        self.account.browser(request).await
    }

    pub async fn run(&self, operation: CloudSyncOperation, automatic: bool) -> SyncJobReport {
        self.jobs
            .run(SyncJobRequest {
                endpoint: SyncEndpointRef::CloudAccount,
                intent: SyncIntent::SynchronizeCloud,
                origin: if automatic {
                    SyncOrigin::Scheduled
                } else {
                    SyncOrigin::Manual
                },
                policy: ResolvedSyncPolicy::Cloud { operation },
            })
            .await
    }
}
