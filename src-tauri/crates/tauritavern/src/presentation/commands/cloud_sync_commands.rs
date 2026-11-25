use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use tt_application::services::agent_workspace_lifecycle_service::AgentRunActivity;
use tt_application::services::cloud_sync_service::CloudSyncService;
use tt_contracts::cloud_sync::{
    CloudBrowserRequest, CloudBrowserResponse, CloudConnectInput, CloudConnectPreview,
    CloudConnection, CloudSyncOperation, CloudSyncStatus,
};
use tt_contracts::sync::SyncJobReport;

use crate::app::AppState;
use crate::presentation::commands::helpers::map_command_error;
use crate::presentation::errors::CommandError;

fn cloud(state: &AppState) -> Result<&CloudSyncService, CommandError> {
    state.services.cloud_sync_service.as_deref().ok_or_else(|| {
        CommandError::Unauthorized("WebDAV account sync is unavailable on this device".into())
    })
}

#[tauri::command]
pub async fn cloud_sync_status(
    state: State<'_, Arc<AppState>>,
) -> Result<CloudSyncStatus, CommandError> {
    cloud(&state)?
        .status()
        .await
        .map_err(map_command_error("Read cloud sync status"))
}

#[tauri::command]
pub async fn cloud_sync_preview(
    state: State<'_, Arc<AppState>>,
    input: CloudConnectInput,
) -> Result<CloudConnectPreview, CommandError> {
    cloud(&state)?
        .preview(input)
        .await
        .map_err(map_command_error("Check WebDAV account"))
}

#[tauri::command]
pub async fn cloud_sync_connect(
    state: State<'_, Arc<AppState>>,
    input: CloudConnectInput,
) -> Result<CloudConnection, CommandError> {
    cloud(&state)?
        .connect(input)
        .await
        .map_err(map_command_error("Connect WebDAV account"))
}

#[tauri::command]
pub async fn cloud_sync_disconnect(state: State<'_, Arc<AppState>>) -> Result<(), CommandError> {
    cloud(&state)?
        .disconnect()
        .await
        .map_err(map_command_error("Disconnect WebDAV account"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRecoveryDto {
    recovery_code: String,
    qr_svg: String,
}

#[tauri::command]
pub async fn cloud_sync_recovery(
    state: State<'_, Arc<AppState>>,
) -> Result<CloudRecoveryDto, CommandError> {
    let recovery_code = cloud(&state)?
        .recovery_code()
        .await
        .map_err(map_command_error("Read cloud recovery code"))?;
    let qr_svg = super::lan_sync_commands::generate_qr_svg(&recovery_code)
        .map_err(map_command_error("Generate recovery QR code"))?;
    Ok(CloudRecoveryDto {
        recovery_code,
        qr_svg,
    })
}

#[tauri::command]
pub async fn cloud_sync_can_apply(state: State<'_, Arc<AppState>>) -> Result<bool, CommandError> {
    cloud(&state)?;
    can_apply(&state).await
}

async fn can_apply(state: &AppState) -> Result<bool, CommandError> {
    state
        .services
        .agent_runtime_service
        .active_run_ids()
        .await
        .map(|runs| runs.is_empty())
        .map_err(map_command_error("Check for active assistant runs"))
}

#[tauri::command]
pub async fn cloud_sync_run(
    state: State<'_, Arc<AppState>>,
    operation: CloudSyncOperation,
    automatic: bool,
) -> Result<SyncJobReport, CommandError> {
    let service = cloud(&state)?;
    if matches!(operation, CloudSyncOperation::Apply) && !can_apply(&state).await? {
        return Err(CommandError::Conflict(
            "Wait for the active assistant to finish before applying cloud changes".into(),
        ));
    }
    Ok(service.run(operation, automatic).await)
}

#[tauri::command]
pub async fn cloud_sync_browser(
    state: State<'_, Arc<AppState>>,
    request: CloudBrowserRequest,
) -> Result<CloudBrowserResponse, CommandError> {
    // Errors never carry the bytes of an extension's saved data.
    cloud(&state)?
        .browser(request)
        .await
        .map_err(map_command_error("Sync extension browser storage"))
}
