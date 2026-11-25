use std::collections::BTreeSet;
use std::path::Path;

use tt_contracts::cloud_sync::{CloudResolution, CloudSyncOperation};
use tt_contracts::sync::{SyncJob, SyncJobSummary};
use tt_domain::errors::DomainError;
use ttsync_contract::sync::SyncPhase;
use uuid::Uuid;

use super::browser::reset_dir;
use super::crypto::VaultKey;
use super::dav::{CIPHERTEXT_MARGIN, Dav, head_path};
use super::model::{
    ApplyUnit, Catalog, Files, Head, Outbox, Revision, State, different_versions, join,
};
use super::packing::{PackWriter, fetch_object, upload_object};
use super::workspace::{Scan, stamp};
use super::{CloudSyncRuntime, empty_summary, invalid, now_ms, save_state};
use crate::json_file::{read_json_file, write_json_file};

const HEAD_BYTES: usize = 48 * 1024 * 1024;

impl CloudSyncRuntime {
    pub(super) async fn exchange(
        &self,
        job: &SyncJob,
        root: &Path,
        key: &VaultKey,
        dav: &Dav<'_>,
        state: &mut State,
        operation: CloudSyncOperation,
    ) -> Result<SyncJobSummary, DomainError> {
        if !state.apply.is_empty() || !super::browser::pending(root).await?.is_empty() {
            return Ok(empty_summary());
        }
        self.publish_outbox(job, root, key, dav, state).await?;
        self.progress(job, SyncPhase::Scanning, 0, 0);
        self.read_heads(dav, key, state).await?;
        // Keep the database maintenance guard only while reading the live file set.
        let vector = self.workspace.vector_database.prepare_vector_sync().await?;
        let db = self.workspace.database.prepare_sync(false).await?;
        let scan = self
            .workspace
            .scan(&mut *self.scan_cache.lock().await, &vector)
            .await?;
        let resolution = match operation {
            CloudSyncOperation::Resolve(choice) => Some(choice),
            _ => None,
        };
        let unavailable = self.browser.unavailable().await;
        let outbox = build_outbox(root, key, state, &scan, &unavailable, resolution).await?;
        drop(db);
        drop(vector);
        state.outbox = outbox;
        save_state(root, state).await?;
        self.publish_outbox(job, root, key, dav, state).await?;

        let next = prepare_apply(state, &scan)
            .into_iter()
            .filter(|unit| !unavailable.contains(&unit.key))
            .collect::<Vec<_>>();
        drop(unavailable);
        let needed = next
            .iter()
            .flat_map(|item| item.version.files.values())
            .flat_map(|file| file.parts.iter().map(|part| part.object))
            .collect::<BTreeSet<_>>();
        for (index, object) in needed.iter().enumerate() {
            self.progress(job, SyncPhase::Downloading, index, needed.len());
            fetch_object(dav, key, &root.join("incoming"), *object).await?;
        }
        let summary = SyncJobSummary::new(
            next.iter().map(|item| item.version.files.len()).sum(),
            next.iter()
                .flat_map(|item| item.version.files.values())
                .map(|file| file.len)
                .sum(),
            next.iter()
                .filter(|item| item.version.files.is_empty())
                .count(),
        );
        state.apply = next;
        if state.apply.is_empty() {
            state.initial_restore = false;
            state.last_synced_ms = Some(now_ms());
            reset_dir(&root.join("incoming")).await?;
        }
        save_state(root, state).await?;
        Ok(summary)
    }

    pub(super) async fn read_heads(
        &self,
        dav: &Dav<'_>,
        key: &VaultKey,
        state: &mut State,
    ) -> Result<(), DomainError> {
        let mut seen = std::collections::BTreeMap::new();
        for (device, etag) in dav.heads().await? {
            if etag
                .as_ref()
                .is_none_or(|tag| state.etags.get(&device) != Some(tag))
            {
                let path = head_path(device);
                let sealed = dav.get(&path, HEAD_BYTES + CIPHERTEXT_MARGIN).await?;
                let plain = key.open(&path, sealed, HEAD_BYTES)?;
                let head: Head = serde_json::from_slice(&plain)
                    .map_err(|_| invalid("Invalid cloud sync head"))?;
                if head.schema != 1 {
                    return Err(invalid("This cloud sync format requires an app update"));
                }
                self.workspace.validate_catalog(&head.catalog)?;
                join(&mut state.known, head.catalog)?;
            }
            if let Some(etag) = etag {
                seen.insert(device, etag);
            }
        }
        state.etags = seen;
        state.counter = state.counter.max(
            state
                .known
                .values()
                .flatten()
                .map(|version| version.counter_for(state.device))
                .max()
                .unwrap_or(0),
        );
        Ok(())
    }

    async fn publish_outbox(
        &self,
        job: &SyncJob,
        root: &Path,
        key: &VaultKey,
        dav: &Dav<'_>,
        state: &mut State,
    ) -> Result<(), DomainError> {
        let Some(outbox) = state.outbox.as_ref() else {
            return Ok(());
        };
        let outgoing = root.join("outgoing");
        let progress_file = outgoing.join("sent.json");
        let mut sent: BTreeSet<Uuid> = match read_json_file(&progress_file).await {
            Ok(entries) => entries,
            Err(DomainError::NotFound(_)) => BTreeSet::new(),
            Err(error) => return Err(error),
        };
        for &object in &outbox.objects {
            if !sent.contains(&object) {
                self.progress(job, SyncPhase::Uploading, sent.len(), outbox.objects.len());
                upload_object(dav, &outgoing, object).await?;
                sent.insert(object);
                write_json_file(&progress_file, &sent).await?;
            }
        }

        let mut catalog = state.known.clone();
        join(&mut catalog, outbox.revisions.clone())?;
        let path = head_path(state.device);
        let head = serde_json::to_vec(&Head { schema: 1, catalog })
            .map_err(|_| invalid("Cannot encode cloud sync head"))?;
        if head.len() > HEAD_BYTES {
            return Err(invalid(
                "The cloud sync catalog exceeds the format size limit",
            ));
        }
        dav.put(&path, key.seal(&path, &head)?).await?;
        let outbox = state.outbox.take().expect("published outbox");
        join(&mut state.known, outbox.revisions)?;
        state.local.extend(outbox.observed_local);
        state.etags.remove(&state.device);
        save_state(root, state).await?;
        // A lost response can replay exactly this batch. Local scratch is disposable once the state was saved.
        reset_dir(&outgoing).await?;
        Ok(())
    }
}

async fn build_outbox(
    root: &Path,
    key: &VaultKey,
    state: &mut State,
    scan: &Scan,
    unavailable: &super::browser::Unavailable,
    resolution: Option<CloudResolution>,
) -> Result<Option<Outbox>, DomainError> {
    let outgoing = root.join("outgoing");
    reset_dir(&outgoing).await?;
    let mut packs = PackWriter::new(&outgoing, key);
    let mut revisions = Catalog::new();
    let mut observed_local = Catalog::new();
    let keys = scan
        .keys()
        .chain(state.local.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    for item in keys {
        if unavailable.contains(&item) {
            continue;
        }
        let files = scan.get(&item);
        let actual = stamp(files);
        let base = state
            .local
            .get(&item)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if base.first().map(Revision::stamp).unwrap_or_default() == actual {
            continue;
        }
        if let Some(known) = state.known.get(&item) {
            let identical = known
                .iter()
                .filter(|version| version.stamp() == actual)
                .cloned()
                .collect::<Vec<_>>();
            if !identical.is_empty() {
                state.local.insert(item, identical);
                continue;
            }
            if state.initial_restore && base.is_empty() {
                continue;
            }
        }
        let mut values = Files::new();
        for (path, file) in files.into_iter().flatten() {
            let prior = base.iter().find_map(|version| version.files.get(path));
            values.insert(path.clone(), packs.add(file, prior).await?);
        }
        let base = base.to_vec();
        let version = Revision::new(state.device, state.tick()?, values, &base, now_ms());
        revisions.insert(item.clone(), vec![version.clone()]);
        observed_local.insert(item, vec![version]);
    }
    if let Some(choice) = resolution {
        if unavailable.contains(&choice.item) {
            return Err(DomainError::Conflict(
                "This browser storage entry cannot be applied on this device".into(),
            ));
        }
        if revisions.contains_key(&choice.item) {
            return Err(DomainError::Conflict(
                "Local data changed. Sync it before choosing a conflict version.".into(),
            ));
        }
        let predecessors = state.known.get(&choice.item).cloned().unwrap_or_default();
        let visible = different_versions(&predecessors);
        let picked = visible
            .iter()
            .find(|version| version.id.to_string() == choice.version);
        let actual = visible
            .iter()
            .map(|version| version.id.to_string())
            .collect::<BTreeSet<_>>();
        if actual.len() < 2
            || actual != choice.observed_versions.into_iter().collect()
            || picked.is_none()
        {
            return Err(DomainError::Conflict(
                "Cloud conflict changed. Refresh it and choose a version again.".into(),
            ));
        }
        let selected = picked.expect("validated choice").files.clone();
        let version = Revision::new(
            state.device,
            state.tick()?,
            selected,
            &predecessors,
            now_ms(),
        );
        revisions.insert(choice.item, vec![version]);
    }
    if revisions.is_empty() {
        return Ok(None);
    }
    Ok(Some(Outbox {
        revisions,
        observed_local,
        objects: packs.finish().await?,
    }))
}

fn prepare_apply(state: &mut State, scan: &Scan) -> Vec<ApplyUnit> {
    let mut next = Vec::new();
    for (item, versions) in &state.known {
        let actual = stamp(scan.get(item));
        let choices = different_versions(versions);
        let canonical = choices[0];
        let desired = if choices.len() > 1 && !is_chat(item) {
            choices
                .iter()
                .copied()
                .find(|version| version.stamp() == actual)
                .unwrap_or(canonical)
        } else {
            canonical
        };
        let wanted = desired.stamp();
        if actual != wanted {
            next.push(ApplyUnit {
                key: item.clone(),
                expected: actual,
                version: desired.clone(),
                fork: false,
            });
        } else {
            state.local.insert(
                item.clone(),
                versions
                    .iter()
                    .filter(|version| version.stamp() == wanted)
                    .cloned()
                    .collect(),
            );
        }
        if is_chat(item) {
            for version in choices
                .into_iter()
                .skip(1)
                .filter(|version| !version.files.is_empty())
            {
                let fork = chat_fork_path(item, version.id);
                if !state.forks.contains(&version.id)
                    && !state.known.contains_key(&fork)
                    && !scan.contains_key(&fork)
                {
                    next.push(ApplyUnit {
                        key: fork,
                        expected: Default::default(),
                        version: version.clone(),
                        fork: true,
                    });
                }
            }
        }
    }
    next
}

fn is_chat(path: &str) -> bool {
    path.ends_with(".jsonl")
        && (path
            .strip_prefix("default-user/chats/")
            .is_some_and(|rest| rest.split('/').count() == 2)
            || path
                .strip_prefix("default-user/group chats/")
                .is_some_and(|rest| !rest.contains('/')))
}

fn chat_fork_path(path: &str, id: Uuid) -> String {
    let (directory, file) = path.rsplit_once('/').expect("chat path has directory");
    let mut stem = file.strip_suffix(".jsonl").unwrap_or(file).to_owned();
    while stem.len() > 190 {
        stem.pop();
    }
    format!("{directory}/{stem} [sync {}].jsonl", id.simple())
}
