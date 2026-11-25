use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tt_contracts::sync::{LocalAppliedChangeSummary, SyncJob, SyncJobSummary};
use tt_domain::errors::DomainError;
use ttsync_client::ClientWorkspace;
use ttsync_contract::manifest::ManifestEntryV2;
use ttsync_contract::path::SyncPath;
use ttsync_contract::plan::{PlanId, SyncPlan};
use ttsync_contract::sync::SyncPhase;
use ttsync_core::database::namespace_directory;
use uuid::Uuid;

use super::browser::{reset_dir, stage};
use super::crypto::VaultKey;
use super::model::{ApplyUnit, FileVersion, Stamp, State};
use super::packing::PackReader;
use super::workspace::{BROWSER_PREFIX, CloudWorkspace, scan_error, stamp};
use super::{CloudSyncRuntime, empty_summary, invalid, now_ms, save_state};
use crate::sync::http_client::sync_error_to_domain;

impl CloudSyncRuntime {
    pub(super) async fn apply(
        &self,
        job: &SyncJob,
        root: &Path,
        key: &VaultKey,
        state: &mut State,
        local: &mut LocalAppliedChangeSummary,
    ) -> Result<SyncJobSummary, DomainError> {
        if state.apply.is_empty() {
            return Ok(empty_summary());
        }
        let receiving_vectors = state
            .apply
            .iter()
            .any(|item| item.key.starts_with("default-user/vectors/"));
        let _vector = self
            .workspace
            .vector_database
            .prepare_sync(receiving_vectors)
            .await?;
        let db = self.workspace.database.prepare_sync(false).await?;
        let scan = self
            .workspace
            .scan(&mut *self.scan_cache.lock().await)
            .await?;
        drop(db);

        let scratch = root.join("apply");
        reset_dir(&scratch).await?;
        tokio::fs::create_dir_all(&scratch)
            .await
            .map_err(scan_error)?;
        let mut reader = PackReader::new(root.join("incoming"), key);
        let mut plan = std::mem::take(&mut state.apply);
        plan.sort_by_key(|item| item.fork);
        let mut pending = VecDeque::from(plan);
        let unavailable = self.browser.unavailable().await;
        let count = pending.len();
        let mut skipped = false;
        while let Some(item) = pending.pop_front() {
            if unavailable.contains(&item.key) {
                skipped = true;
                continue;
            }
            self.progress(
                job,
                SyncPhase::Downloading,
                count - pending.len() - 1,
                count,
            );
            let actual = stamp(scan.get(&item.key));
            let wanted = item.version.stamp();
            // A previous boot can have applied only part of this plan. Accept the recorded
            // source or destination of each file, and preserve any edit made after staging.
            if !item.fork && !still_matches(&actual, &item.expected, &wanted) {
                let interrupted_database_swap = actual.is_empty()
                    && is_database(&item.key)
                    && tokio::fs::try_exists(database_swap_marker(root, &item))
                        .await
                        .map_err(scan_error)?;
                if !interrupted_database_swap {
                    skipped = true;
                    continue;
                }
            }
            let result = async {
                if item.fork {
                    if actual.is_empty() {
                        apply_fork(&self.workspace, &scratch, &mut reader, &item, local).await?;
                    }
                    attach_group_fork(&self.workspace, &item, local).await?;
                    state.forks.insert(item.version.id);
                    return Ok(());
                }
                if actual != wanted {
                    if state.initial_restore {
                        backup_originals(
                            &self.workspace,
                            &root.join("before-first-restore"),
                            &actual,
                        )
                        .await?;
                    }
                    apply_unit(
                        &self.workspace,
                        root,
                        &scratch,
                        &mut reader,
                        &item,
                        &actual,
                        local,
                    )
                    .await?;
                }
                let known = &state.known[&item.key];
                state.local.insert(
                    item.key.clone(),
                    known
                        .iter()
                        .filter(|version| version.stamp() == wanted)
                        .cloned()
                        .collect(),
                );
                Ok::<_, DomainError>(())
            }
            .await;
            if let Err(error) = result {
                pending.push_front(item);
                state.apply = pending.into();
                save_state(root, state).await?;
                return Err(error);
            }
        }
        state.initial_restore = false;
        if !skipped {
            state.last_synced_ms = Some(now_ms());
        }
        save_state(root, state).await?;
        reset_dir(&scratch).await?;
        reset_dir(&root.join("database-swaps")).await?;
        reset_dir(&root.join("incoming")).await?;
        Ok(SyncJobSummary::new(
            local.files_written,
            local.bytes_written,
            local.files_deleted,
        ))
    }
}

fn still_matches(actual: &Stamp, expected: &Stamp, wanted: &Stamp) -> bool {
    actual
        .keys()
        .chain(expected.keys())
        .chain(wanted.keys())
        .all(|path| {
            let value = actual.get(path);
            value == expected.get(path) || value == wanted.get(path)
        })
}

fn is_database(key: &str) -> bool {
    namespace_directory(&format!("{key}/database.tdb")).is_some()
}

fn database_swap_marker(root: &Path, item: &ApplyUnit) -> PathBuf {
    root.join("database-swaps")
        .join(item.version.id.to_string())
}

async fn backup_originals(
    workspace: &CloudWorkspace,
    backup: &Path,
    actual: &Stamp,
) -> Result<(), DomainError> {
    for path in actual.keys() {
        let source = workspace.checked_path(path).await?;
        let target = backup.join(path);
        if !tokio::fs::try_exists(&target).await.map_err(scan_error)? {
            let mut source = tokio::fs::File::open(&source).await.map_err(scan_error)?;
            crate::sync_fs::write_file_atomic(&target, &mut source, 0)
                .await
                .map_err(|error| sync_error_to_domain(error.into_error()))?;
        }
    }
    Ok(())
}

async fn apply_unit(
    workspace: &CloudWorkspace,
    root: &Path,
    scratch: &Path,
    reader: &mut PackReader<'_>,
    item: &ApplyUnit,
    actual: &Stamp,
    local: &mut LocalAppliedChangeSummary,
) -> Result<(), DomainError> {
    if is_database(&item.key) {
        return apply_database(workspace, root, scratch, reader, item, actual, local).await;
    }
    for (path, version) in &item.version.files {
        if actual.get(path) == Some(&version.hash) {
            continue;
        }
        let target = workspace.checked_path(path).await?;
        let file = unpack_to_scratch(scratch, reader, version).await?;
        if let Some(entry) = path.strip_prefix(BROWSER_PREFIX) {
            stage(root, entry, &file, false).await?;
        }
        write_regular(&target, &file, version.modified_ms, local).await?;
    }
    for path in actual
        .keys()
        .filter(|path| !item.version.files.contains_key(*path))
    {
        let target = workspace.checked_path(path).await?;
        if let Some(entry) = path.strip_prefix(BROWSER_PREFIX) {
            stage(root, entry, &target, true).await?;
        }
        if workspace.policy.contains_path(path) {
            let relative = SyncPath::new(path).map_err(|error| invalid(error.to_string()))?;
            workspace
                .base_workspace()
                .delete_file(&relative)
                .await
                .map_err(|error| {
                    local.target_changed |= error.target_changed();
                    sync_error_to_domain(error.into_error())
                })?;
        } else {
            tokio::fs::remove_file(&target).await.map_err(scan_error)?;
        }
        local.files_deleted += 1;
    }
    Ok(())
}

async fn apply_database(
    workspace: &CloudWorkspace,
    root: &Path,
    scratch: &Path,
    reader: &mut PackReader<'_>,
    item: &ApplyUnit,
    actual: &Stamp,
    local: &mut LocalAppliedChangeSummary,
) -> Result<(), DomainError> {
    let receiving = workspace
        .base_workspace()
        .prepare(workspace.policy.clone(), true)
        .await
        .map_err(sync_error_to_domain)?;
    let mut entries = Vec::new();
    for (path, version) in &item.version.files {
        workspace.checked_path(path).await?;
        entries.push(ManifestEntryV2 {
            path: SyncPath::new(path).map_err(|error| invalid(error.to_string()))?,
            size_bytes: version.len,
            modified_ms: version.modified_ms,
            content_hash: None,
        });
    }
    let mut deleted = Vec::new();
    for path in actual
        .keys()
        .filter(|path| !item.version.files.contains_key(*path))
    {
        workspace.checked_path(path).await?;
        deleted.push(SyncPath::new(path).map_err(|error| invalid(error.to_string()))?);
    }
    let plan = SyncPlan {
        plan_id: PlanId(item.version.id.to_string()),
        selection: workspace.policy.selection().clone(),
        files_total: entries.len(),
        bytes_total: entries.iter().map(|entry| entry.size_bytes).sum(),
        transfer: entries,
        delete: deleted,
    };
    receiving.set_plan(&plan);
    for entry in &plan.transfer {
        let version = &item.version.files[entry.path.as_str()];
        let file = unpack_to_scratch(scratch, reader, version).await?;
        let mut file = tokio::fs::File::open(file).await.map_err(scan_error)?;
        receiving
            .write_file(&entry.path, &mut file, version.modified_ms)
            .await
            .map_err(|error| sync_error_to_domain(error.into_error()))?;
    }
    // A process exit between the two namespace renames leaves the old directory
    // in staging. A resumed apply must distinguish that from a user's deletion.
    crate::json_file::write_json_file(&database_swap_marker(root, item), &true).await?;
    receiving.commit().await.map_err(|error| {
        local.target_changed |= error.target_changed();
        sync_error_to_domain(error.into_error())
    })?;
    local.files_written += plan.files_total;
    local.bytes_written += plan.bytes_total;
    local.files_deleted += plan.delete.len();
    Ok(())
}

async fn unpack_to_scratch(
    scratch: &Path,
    reader: &mut PackReader<'_>,
    version: &FileVersion,
) -> Result<PathBuf, DomainError> {
    let path = scratch.join("file");
    let mut file = tokio::fs::File::create(&path).await.map_err(scan_error)?;
    reader.unpack(version, &mut file).await?;
    Ok(path)
}

async fn write_regular(
    target: &Path,
    source: &Path,
    modified_ms: u64,
    local: &mut LocalAppliedChangeSummary,
) -> Result<(), DomainError> {
    let mut source = tokio::fs::File::open(source).await.map_err(scan_error)?;
    let len = source.metadata().await.map_err(scan_error)?.len();
    crate::sync_fs::write_file_atomic(target, &mut source, modified_ms)
        .await
        .map_err(|error| {
            local.target_changed |= error.target_changed();
            sync_error_to_domain(error.into_error())
        })?;
    local.files_written += 1;
    local.bytes_written += len;
    Ok(())
}

async fn apply_fork(
    workspace: &CloudWorkspace,
    scratch: &Path,
    reader: &mut PackReader<'_>,
    item: &ApplyUnit,
    local: &mut LocalAppliedChangeSummary,
) -> Result<(), DomainError> {
    let version = item
        .version
        .files
        .values()
        .next()
        .ok_or_else(|| invalid("A chat conflict version has no data"))?;
    let original = unpack_to_scratch(scratch, reader, version).await?;
    let fork = scratch.join("chat-fork");
    let source = tokio::fs::File::open(original).await.map_err(scan_error)?;
    let mut source = BufReader::new(source);
    let mut output = tokio::fs::File::create(&fork).await.map_err(scan_error)?;
    write_fork_header(&mut source, &mut output, item.version.id).await?;
    tokio::io::copy(&mut source, &mut output)
        .await
        .map_err(scan_error)?;
    output.flush().await.map_err(scan_error)?;
    let target = workspace.checked_path(&item.key).await?;
    write_regular(&target, &fork, version.modified_ms, local).await
}

async fn write_fork_header(
    source: &mut BufReader<tokio::fs::File>,
    output: &mut tokio::fs::File,
    id: Uuid,
) -> Result<(), DomainError> {
    let mut line = Vec::new();
    while source
        .read_until(b'\n', &mut line)
        .await
        .map_err(scan_error)?
        != 0
    {
        let json = line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&line);
        if json.iter().all(u8::is_ascii_whitespace) {
            output.write_all(&line).await.map_err(scan_error)?;
            line.clear();
            continue;
        }
        let mut header: serde_json::Value = serde_json::from_slice(json)
            .map_err(|_| invalid("A chat conflict version has an invalid JSONL header"))?;
        let fields = header
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid chat header"))?;
        let metadata = fields
            .entry("chat_metadata")
            .or_insert_with(|| serde_json::json!({}));
        if metadata.is_null() {
            *metadata = serde_json::json!({});
        }
        metadata
            .as_object_mut()
            .ok_or_else(|| invalid("Invalid chat metadata"))?
            .insert(
                "integrity".into(),
                serde_json::Value::String(id.to_string()),
            );
        let encoded =
            serde_json::to_vec(&header).map_err(|_| invalid("Cannot encode chat branch header"))?;
        output.write_all(&encoded).await.map_err(scan_error)?;
        output.write_all(b"\n").await.map_err(scan_error)?;
        return Ok(());
    }
    Ok(())
}

async fn attach_group_fork(
    workspace: &CloudWorkspace,
    item: &ApplyUnit,
    local: &mut LocalAppliedChangeSummary,
) -> Result<(), DomainError> {
    let Some(fork) = item
        .key
        .strip_prefix("default-user/group chats/")
        .and_then(|name| name.strip_suffix(".jsonl"))
    else {
        return Ok(());
    };
    let old = item
        .version
        .files
        .keys()
        .next()
        .and_then(|path| path.strip_prefix("default-user/group chats/"))
        .and_then(|name| name.strip_suffix(".jsonl"))
        .ok_or_else(|| invalid("Invalid group chat fork source"))?;
    let groups = workspace.checked_path("default-user/groups").await?;
    let mut files = match tokio::fs::read_dir(groups).await {
        Ok(files) => files,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(scan_error(error)),
    };
    while let Some(file) = files.next_entry().await.map_err(scan_error)? {
        let path = file.path();
        if path.extension().is_none_or(|extension| extension != "json")
            || !file.file_type().await.map_err(scan_error)?.is_file()
        {
            continue;
        }
        let mut group: serde_json::Value = crate::json_file::read_json_file(&path).await?;
        let selected = group
            .get("chat_id")
            .is_some_and(|id| chat_id_matches(id, old));
        let Some(chats) = group
            .as_object_mut()
            .map(|fields| {
                fields
                    .entry("chats")
                    .or_insert_with(|| serde_json::json!([]))
            })
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        if (selected || chats.iter().any(|id| chat_id_matches(id, old)))
            && !chats.iter().any(|id| id.as_str() == Some(fork))
        {
            chats.push(serde_json::Value::String(fork.to_owned()));
            crate::json_file::write_json_file(&path, &group).await?;
            local.files_written += 1;
        }
    }
    Ok(())
}

fn chat_id_matches(value: &serde_json::Value, id: &str) -> bool {
    match value {
        serde_json::Value::String(value) => value == id,
        serde_json::Value::Number(value) => id
            .parse::<i64>()
            .ok()
            .is_some_and(|id| value.as_i64() == Some(id)),
        _ => false,
    }
}
