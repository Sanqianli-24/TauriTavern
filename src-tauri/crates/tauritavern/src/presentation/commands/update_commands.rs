use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::app::AppState;
use crate::presentation::commands::helpers::{
    ensure_ios_policy_allows, log_command, map_command_error,
};
use crate::presentation::errors::CommandError;
use tt_domain::models::update::{UpdateChannel, UpdateCheckResult};

#[derive(Serialize)]
pub struct UpdateCheckResponse {
    #[serde(flatten)]
    result: UpdateCheckResult,
    android_install_available: bool,
}

#[tauri::command]
pub async fn check_for_update(
    channel: UpdateChannel,
    app_state: State<'_, Arc<AppState>>,
) -> Result<UpdateCheckResponse, CommandError> {
    log_command("check_for_update");

    ensure_ios_policy_allows(
        &app_state.ios_policy,
        app_state.ios_policy.capabilities.updates.manual_check,
        "updates.manual_check",
    )?;

    let result = app_state
        .services
        .update_service
        .check_for_update(channel)
        .await
        .map_err(map_command_error("Failed to check for update"))?;

    #[cfg(all(android_local, target_arch = "aarch64"))]
    let android_install_available =
        crate::platform::android_update::installable_apk(&result).is_some();
    #[cfg(not(all(android_local, target_arch = "aarch64")))]
    let android_install_available = false;

    Ok(UpdateCheckResponse {
        result,
        android_install_available,
    })
}

#[cfg(all(android_local, target_arch = "aarch64"))]
#[tauri::command]
pub async fn install_android_update(
    release_token: String,
    progress: tauri::ipc::Channel<u8>,
    app: tauri::AppHandle,
    app_state: State<'_, Arc<AppState>>,
) -> Result<crate::platform::android_update::InstallOutcome, CommandError> {
    log_command("install_android_update");
    let result = app_state
        .services
        .update_service
        .check_for_update(UpdateChannel::Stable)
        .await
        .map_err(map_command_error("Failed to refresh the Android release"))?;
    if result.release_token.as_deref() != Some(release_token.as_str()) {
        return Err(CommandError::Conflict(
            "The latest release changed. Check for updates again.".into(),
        ));
    }
    crate::platform::android_update::install(&app, &result, progress)
        .await
        .map_err(map_command_error("Failed to install Android update"))
}
