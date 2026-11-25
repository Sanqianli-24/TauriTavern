use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloudConnectMode {
    Create,
    Merge,
    Restore,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectInput {
    pub mode: CloudConnectMode,
    pub url: String,
    pub account: String,
    pub app_password: String,
    pub recovery_code: String,
    pub include_credentials: bool,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectPreview {
    pub local_files: usize,
    pub local_bytes: u64,
    pub cloud_items: usize,
    pub cloud_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnection {
    pub recovery_code: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncStatus {
    pub account: Option<String>,
    pub device: Option<String>,
    pub last_synced_ms: Option<u64>,
    pub pending_apply: bool,
    pub pending_upload: bool,
    pub conflicts: Vec<CloudConflict>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudConflict {
    pub item: String,
    pub versions: Vec<CloudVersion>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudVersion {
    pub id: String,
    pub device: String,
    pub modified_ms: u64,
    pub deleted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudResolution {
    pub item: String,
    pub version: String,
    pub observed_versions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "action", content = "selection", rename_all = "snake_case")]
pub enum CloudSyncOperation {
    Exchange,
    Resolve(CloudResolution),
    Apply,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CloudBrowserRequest {
    Begin {
        entries: Vec<String>,
        blocked: Vec<String>,
        retain_kinds: Vec<String>,
    },
    Append {
        batch: String,
        entry: String,
        data: String,
    },
    Finish {
        batch: String,
    },
    Abort {
        batch: String,
    },
    Pending,
    Read {
        entry: String,
        offset: u64,
    },
    Acknowledge {
        entry: String,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum CloudBrowserResponse {
    Batch(String),
    Changes(Vec<CloudBrowserChange>),
    Data(CloudBrowserFrame),
    Done(()),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBrowserChange {
    pub entry: String,
    pub deleted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBrowserFrame {
    pub data: String,
    pub done: bool,
}
