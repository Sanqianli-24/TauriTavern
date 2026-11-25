use async_trait::async_trait;
use tt_contracts::cloud_sync::{
    CloudBrowserRequest, CloudBrowserResponse, CloudConnectInput, CloudConnectPreview,
    CloudConnection, CloudSyncStatus,
};
use tt_domain::errors::DomainError;

#[async_trait]
pub trait CloudCredentialStore: Send + Sync {
    async fn load(&self) -> Result<Option<String>, DomainError>;
    async fn save(&self, credentials: String) -> Result<(), DomainError>;
    async fn clear(&self) -> Result<(), DomainError>;
}

#[async_trait]
pub trait CloudAccountGateway: Send + Sync {
    async fn preview(&self, input: CloudConnectInput) -> Result<CloudConnectPreview, DomainError>;
    async fn connect(&self, input: CloudConnectInput) -> Result<CloudConnection, DomainError>;
    async fn disconnect(&self) -> Result<(), DomainError>;
    async fn recovery_code(&self) -> Result<String, DomainError>;
    async fn status(&self) -> Result<CloudSyncStatus, DomainError>;
    async fn browser(
        &self,
        request: CloudBrowserRequest,
    ) -> Result<CloudBrowserResponse, DomainError>;
}
