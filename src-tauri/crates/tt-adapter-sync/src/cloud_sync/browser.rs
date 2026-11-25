use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use base64::{Engine, engine::general_purpose::STANDARD};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tt_contracts::cloud_sync::{
    CloudBrowserChange, CloudBrowserFrame, CloudBrowserRequest, CloudBrowserResponse,
};
use tt_domain::errors::DomainError;
use uuid::Uuid;

use super::invalid;
use super::workspace::BROWSER_PREFIX;
use super::workspace::{hash_file, scan_error};

const FRAME_BYTES: usize = 48 * 1024;

pub(super) struct BrowserStorage {
    root: PathBuf,
    capture: Mutex<Option<Capture>>,
    unavailable: Mutex<Unavailable>,
}

struct Capture {
    id: Uuid,
    entries: BTreeSet<String>,
    unavailable: Unavailable,
}

#[derive(Default)]
pub(super) struct Unavailable {
    blocked: BTreeSet<String>,
    kinds: BTreeSet<String>,
}

impl Unavailable {
    pub(super) fn contains(&self, path: &str) -> bool {
        path.strip_prefix(BROWSER_PREFIX)
            .is_some_and(|entry| self.retains_entry(entry))
    }

    fn retains_entry(&self, entry: &str) -> bool {
        self.blocked.contains(entry) || self.kinds.iter().any(|kind| entry.starts_with(kind))
    }
}

impl BrowserStorage {
    pub(super) fn new(root: PathBuf) -> Self {
        Self {
            root,
            capture: Mutex::new(None),
            unavailable: Mutex::new(Unavailable::default()),
        }
    }

    pub(super) fn current(&self) -> PathBuf {
        self.root.join("browser-storage")
    }

    pub(super) async fn capturing(&self) -> bool {
        self.capture.lock().await.is_some()
    }

    pub(super) async fn unavailable(&self) -> tokio::sync::MutexGuard<'_, Unavailable> {
        self.unavailable.lock().await
    }

    pub(super) async fn command(
        &self,
        vault: &Path,
        request: CloudBrowserRequest,
    ) -> Result<CloudBrowserResponse, DomainError> {
        use CloudBrowserRequest as Request;
        use CloudBrowserResponse as Response;

        let mut capture = self.capture.lock().await;
        let source = self.root.join("browser-capture");
        match request {
            Request::Begin {
                entries,
                blocked,
                retain_kinds,
            } => {
                if entries.len() + blocked.len() > 200_000
                    || entries
                        .iter()
                        .chain(&blocked)
                        .any(|name| !valid_entry(name))
                    || retain_kinds
                        .iter()
                        .any(|kind| !matches!(kind.as_str(), "l-" | "i-" | "f-" | "d-"))
                {
                    return Err(invalid("Invalid browser storage inventory"));
                }
                if !pending(vault).await?.is_empty() {
                    return Err(DomainError::Conflict(
                        "Browser storage restoration is pending".into(),
                    ));
                }
                // The WebView can close during capture. Start a fresh projection on its next request.
                reset_dir(&source).await?;
                tokio::fs::create_dir_all(&source)
                    .await
                    .map_err(scan_error)?;
                let id = Uuid::new_v4();
                *capture = Some(Capture {
                    id,
                    entries: entries.into_iter().collect(),
                    unavailable: Unavailable {
                        blocked: blocked.into_iter().collect(),
                        kinds: retain_kinds.into_iter().collect(),
                    },
                });
                Ok(Response::Batch(id.to_string()))
            }
            Request::Append { batch, entry, data } => {
                let active = active_capture(&capture, &batch)?;
                if !active.entries.contains(&entry) || data.len() > FRAME_BYTES * 4 / 3 {
                    return Err(invalid("Invalid browser storage frame"));
                }
                let bytes = STANDARD
                    .decode(data)
                    .map_err(|_| invalid("Invalid browser storage frame encoding"))?;
                let mut file = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(source.join(entry))
                    .await
                    .map_err(scan_error)?;
                file.write_all(&bytes).await.map_err(scan_error)?;
                Ok(Response::Done(()))
            }
            Request::Finish { batch } => {
                let active = active_capture(&capture, &batch)?;
                let current = self.current();
                tokio::fs::create_dir_all(&current)
                    .await
                    .map_err(scan_error)?;
                let mut files = tokio::fs::read_dir(&source).await.map_err(scan_error)?;
                while let Some(file) = files.next_entry().await.map_err(scan_error)? {
                    let staged = file.path();
                    let target = current.join(file.file_name());
                    if tokio::fs::try_exists(&target).await.map_err(scan_error)?
                        && hash_file(&staged).await? == hash_file(&target).await?
                    {
                        continue;
                    }
                    tokio::fs::rename(staged, target)
                        .await
                        .map_err(scan_error)?;
                }
                let mut files = tokio::fs::read_dir(&current).await.map_err(scan_error)?;
                while let Some(file) = files.next_entry().await.map_err(scan_error)? {
                    if file.file_name().to_str().is_some_and(|name| {
                        !active.entries.contains(name) && !active.unavailable.retains_entry(name)
                    }) {
                        tokio::fs::remove_file(file.path())
                            .await
                            .map_err(scan_error)?;
                    }
                }
                let completed = capture.take().expect("active capture");
                *self.unavailable.lock().await = completed.unavailable;
                reset_dir(&source).await?;
                Ok(Response::Done(()))
            }
            Request::Abort { batch } => {
                active_capture(&capture, &batch)?;
                *capture = None;
                reset_dir(&source).await?;
                Ok(Response::Done(()))
            }
            Request::Pending => Ok(Response::Changes(pending(vault).await?)),
            Request::Read { entry, offset } => {
                let path = pending_entry(vault, &entry).await?;
                let mut file = tokio::fs::File::open(path).await.map_err(scan_error)?;
                let size = file.metadata().await.map_err(scan_error)?.len();
                if offset > size {
                    return Err(invalid("Invalid browser storage read offset"));
                }
                file.seek(std::io::SeekFrom::Start(offset))
                    .await
                    .map_err(scan_error)?;
                let mut buffer = vec![0; (size - offset).min(FRAME_BYTES as u64) as usize];
                file.read_exact(&mut buffer).await.map_err(scan_error)?;
                Ok(Response::Data(CloudBrowserFrame {
                    done: offset + buffer.len() as u64 == size,
                    data: STANDARD.encode(buffer),
                }))
            }
            Request::Acknowledge { entry } => {
                tokio::fs::remove_file(pending_entry(vault, &entry).await?)
                    .await
                    .map_err(scan_error)?;
                Ok(Response::Done(()))
            }
        }
    }
}

fn active_capture<'a>(
    capture: &'a Option<Capture>,
    batch: &str,
) -> Result<&'a Capture, DomainError> {
    let id = Uuid::parse_str(batch).map_err(|_| invalid("Invalid browser storage capture"))?;
    capture
        .as_ref()
        .filter(|active| active.id == id)
        .ok_or_else(|| invalid("Browser storage capture is no longer active"))
}

pub(super) fn valid_entry(entry: &str) -> bool {
    matches!(
        entry.as_bytes().get(..2),
        Some(b"l-" | b"i-" | b"f-" | b"d-")
    ) && entry.len() == 66
        && entry.as_bytes()[2..]
            .iter()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(ch))
}

pub(super) async fn stage(
    vault: &Path,
    entry: &str,
    file: &Path,
    deleted: bool,
) -> Result<(), DomainError> {
    let directory = vault.join("browser-restore");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(scan_error)?;
    let destination = directory.join(format!(
        "{}.{}",
        entry,
        if deleted { "delete" } else { "write" }
    ));
    let mut source = tokio::fs::File::open(file).await.map_err(scan_error)?;
    crate::sync_fs::write_file_atomic(&destination, &mut source, 0)
        .await
        .map_err(|error| crate::sync::http_client::sync_error_to_domain(error.into_error()))
}

async fn pending_entry(vault: &Path, entry: &str) -> Result<PathBuf, DomainError> {
    if !valid_entry(entry) {
        return Err(invalid("Invalid browser storage entry"));
    }
    let directory = vault.join("browser-restore");
    let write = directory.join(format!("{entry}.write"));
    if tokio::fs::try_exists(&write).await.map_err(scan_error)? {
        return Ok(write);
    }
    Ok(directory.join(format!("{entry}.delete")))
}

pub(super) async fn pending(vault: &Path) -> Result<Vec<CloudBrowserChange>, DomainError> {
    let mut directory = match tokio::fs::read_dir(vault.join("browser-restore")).await {
        Ok(dir) => dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(scan_error(error)),
    };
    let mut changes = Vec::new();
    while let Some(file) = directory.next_entry().await.map_err(scan_error)? {
        let name = file.file_name();
        if let Some((entry, action)) = name.to_str().and_then(|name| name.split_once('.'))
            && valid_entry(entry)
            && matches!(action, "write" | "delete")
        {
            changes.push(CloudBrowserChange {
                entry: entry.to_owned(),
                deleted: action == "delete",
            });
        }
    }
    changes.sort_by(|left, right| {
        // OPFS files are removed before their parent directories and written after directory creation.
        let rank =
            |change: &CloudBrowserChange| match (change.deleted, change.entry.starts_with("d-")) {
                (true, false) => 0,
                (true, true) => 1,
                (false, true) => 2,
                (false, false) => 3,
            };
        rank(left)
            .cmp(&rank(right))
            .then_with(|| left.entry.cmp(&right.entry))
    });
    Ok(changes)
}

pub(super) async fn reset_dir(path: &Path) -> Result<(), DomainError> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(scan_error(error)),
    }
}
