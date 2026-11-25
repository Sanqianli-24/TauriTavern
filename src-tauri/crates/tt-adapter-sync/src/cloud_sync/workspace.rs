use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use aws_lc_rs::digest::{Context, SHA256};
use tokio::io::AsyncReadExt;
use tt_domain::errors::DomainError;
use tt_ports::database::DatabaseFileAccess;
use ttsync_contract::path::SyncPath;
use ttsync_core::database::namespace_directory;
use ttsync_core::dataset::{ResolvedDatasetPolicy, is_excluded, tauri_tavern_full_selection};

use crate::sync::workspace::TauriTavernSyncWorkspace;
use crate::tt_sync::fs::{inside_additions, scan_manifest_with_additions};

use super::browser::valid_entry;
use super::crypto::digest_text;
use super::invalid;
use super::model::{Catalog, Stamp};
use super::packing::{CHUNK_SIZE, PACK_SIZE};

const DIRECTORIES: &[&str] = &[
    "_tauritavern/agent-workspaces/sessions",
    "_tauritavern/agent-workspaces/index/session-runs",
    "_tauritavern/mcp/registrations",
    "default-user/snapshots",
];
const FILES: &[&str] = &["default-user/user/cache/chat_aliases_v1.json"];
pub(super) const BROWSER_PREFIX: &str = "_tauritavern/browser-storage/";

#[derive(Clone)]
pub(super) struct CloudWorkspace {
    root: PathBuf,
    browser: PathBuf,
    pub(super) database: Arc<dyn DatabaseFileAccess>,
    pub(super) vector_database: Arc<dyn DatabaseFileAccess>,
    pub(super) policy: ResolvedDatasetPolicy,
}

#[derive(Clone, Debug)]
pub(super) struct LocalFile {
    pub(super) path: PathBuf,
    pub(super) len: u64,
    pub(super) modified_ms: u64,
    pub(super) hash: String,
}

pub(super) type LocalUnit = BTreeMap<String, LocalFile>;
pub(super) type Scan = BTreeMap<String, LocalUnit>;
pub(super) type ScanCache = BTreeMap<String, (FileStamp, String)>;

#[derive(PartialEq, Eq)]
pub(super) struct FileStamp {
    size: u64,
    modified: SystemTime,
    #[cfg(unix)]
    inode_and_change_time: (u64, i64, i64),
    #[cfg(not(unix))]
    created: Option<SystemTime>,
}

impl CloudWorkspace {
    pub(super) fn new(
        root: PathBuf,
        browser: PathBuf,
        database: Arc<dyn DatabaseFileAccess>,
        vector_database: Arc<dyn DatabaseFileAccess>,
    ) -> Self {
        let policy = ResolvedDatasetPolicy::from_selection(&tauri_tavern_full_selection())
            .expect("full sync dataset is valid");
        Self {
            root,
            browser,
            database,
            vector_database,
            policy,
        }
    }

    pub(super) fn base_workspace(&self) -> Arc<TauriTavernSyncWorkspace> {
        Arc::new(TauriTavernSyncWorkspace::new(
            self.root.clone(),
            self.database.clone(),
        ))
    }

    pub(super) async fn scan(&self, cache: &mut ScanCache) -> Result<Scan, DomainError> {
        let manifest = scan_manifest_with_additions(
            self.root.clone(),
            self.policy.clone(),
            DIRECTORIES,
            FILES,
        )
        .await?;
        let mut paths = manifest
            .entries
            .into_iter()
            .map(|entry| entry.path.to_string())
            .collect::<Vec<_>>();
        match tokio::fs::read_dir(&self.browser).await {
            Ok(mut entries) => {
                while let Some(entry) = entries.next_entry().await.map_err(scan_error)? {
                    let name = entry.file_name();
                    if name
                        .to_str()
                        .is_some_and(|name| name.ends_with(".ttsync.tmp"))
                    {
                        continue;
                    }
                    let name = name
                        .to_str()
                        .filter(|name| valid_entry(name))
                        .ok_or_else(|| invalid("Invalid browser sync entry on disk"))?;
                    paths.push(format!("{BROWSER_PREFIX}{name}"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(scan_error(error)),
        }
        let mut scanned = Scan::new();
        let mut new_cache = ScanCache::new();
        for name in paths {
            let path = self.checked_path(&name).await?;
            let before = file_stamp(&path).await?;
            let hash = match cache.get(&name) {
                Some((old, hash)) if *old == before => hash.clone(),
                _ => {
                    let hash = hash_file(&path).await?;
                    if file_stamp(&path).await? != before {
                        return Err(changed_during_sync());
                    }
                    hash
                }
            };
            let modified_ms = before
                .modified
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|time| time.as_millis() as u64)
                .unwrap_or(0);
            let file = LocalFile {
                path,
                len: before.size,
                modified_ms,
                hash: hash.clone(),
            };
            new_cache.insert(name.clone(), (before, hash));
            scanned
                .entry(unit_key(&name).to_owned())
                .or_default()
                .insert(name, file);
        }
        *cache = new_cache;
        Ok(scanned)
    }

    pub(super) fn validate_catalog(&self, catalog: &Catalog) -> Result<(), DomainError> {
        for (key, versions) in catalog {
            let sample = format!("{key}/database.tdb");
            let grouped = self.contains(&sample) && unit_key(&sample) == key;
            if (!self.contains(key) && !grouped) || versions.is_empty() || versions.len() > 128 {
                return Err(invalid("Invalid unit in the cloud sync catalog"));
            }
            for version in versions {
                if !version.valid_clock() || version.modified_ms > i64::MAX as u64 {
                    return Err(invalid("Invalid cloud sync revision"));
                }
                for (path, file) in &version.files {
                    if !self.contains(path)
                        || unit_key(path) != key
                        || file.hash.len() != 43
                        || file.parts.iter().try_fold(0u64, |size, part| {
                            (!part.object.is_nil()
                                && (1..=CHUNK_SIZE).contains(&part.len)
                                && part.hash.len() == 43
                                && part
                                    .offset
                                    .checked_add(part.len)
                                    .is_some_and(|end| end <= PACK_SIZE))
                            .then(|| size.checked_add(part.len as u64))
                            .flatten()
                        }) != Some(file.len)
                    {
                        return Err(invalid("Invalid file in the cloud sync catalog"));
                    }
                }
            }
        }
        Ok(())
    }

    fn contains(&self, path: &str) -> bool {
        if !portable(path) || is_excluded(path) {
            return false;
        }
        if let Some(entry) = path.strip_prefix(BROWSER_PREFIX) {
            return valid_entry(entry);
        }
        FILES.contains(&path)
            || (!path.starts_with("default-user/user/cache/")
                && (inside_additions(path, DIRECTORIES) || self.policy.contains_path(path)))
    }

    pub(super) async fn checked_path(&self, path: &str) -> Result<PathBuf, DomainError> {
        if !self.contains(path) {
            return Err(invalid("Path is outside the cloud sync dataset"));
        }
        let (root, relative) = match path.strip_prefix(BROWSER_PREFIX) {
            Some(entry) => (&self.browser, entry),
            None => (&self.root, path),
        };
        let mut current = root.clone();
        for part in relative.split('/') {
            current.push(part);
            match tokio::fs::symlink_metadata(&current).await {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(invalid("Cloud sync cannot use symbolic links"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(scan_error(error)),
            }
        }
        Ok(current)
    }
}

pub(super) fn unit_key(path: &str) -> &str {
    const EXTENSIONS: &[&str] = &["extensions/third-party/", "default-user/extensions/"];
    if let Some(database) = namespace_directory(path) {
        return database;
    }
    for prefix in EXTENSIONS {
        if let Some(relative) = path.strip_prefix(prefix)
            && let Some((folder, _)) = relative.split_once('/')
        {
            return &path[..prefix.len() + folder.len()];
        }
    }
    path
}

fn portable(path: &str) -> bool {
    SyncPath::new(path).is_ok() && !path.contains('\0') && (!cfg!(windows) || !path.contains(':'))
}

pub(super) fn stamp(files: Option<&LocalUnit>) -> Stamp {
    files
        .into_iter()
        .flatten()
        .map(|(path, file)| (path.clone(), file.hash.clone()))
        .collect()
}

async fn file_stamp(path: &Path) -> Result<FileStamp, DomainError> {
    let metadata = tokio::fs::metadata(path).await.map_err(scan_error)?;
    if !metadata.is_file() {
        return Err(invalid("Cloud sync expected a regular file"));
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    Ok(FileStamp {
        size: metadata.len(),
        modified: metadata.modified().map_err(scan_error)?,
        #[cfg(unix)]
        inode_and_change_time: (metadata.ino(), metadata.ctime(), metadata.ctime_nsec()),
        #[cfg(not(unix))]
        created: metadata.created().ok(),
    })
}

pub(super) async fn hash_file(path: &Path) -> Result<String, DomainError> {
    let mut file = tokio::fs::File::open(path).await.map_err(scan_error)?;
    let mut buffer = vec![0; 128 * 1024];
    let mut digest = Context::new(&SHA256);
    loop {
        let len = file.read(&mut buffer).await.map_err(scan_error)?;
        if len == 0 {
            return Ok(digest_text(digest.finish()));
        }
        digest.update(&buffer[..len]);
    }
}

pub(super) fn changed_during_sync() -> DomainError {
    DomainError::transient(
        "Local data changed during the sync scan. The next sync will pick up the edits.",
    )
}

pub(super) fn scan_error(error: std::io::Error) -> DomainError {
    DomainError::transient(format!("Cloud sync local storage: {error}"))
}
