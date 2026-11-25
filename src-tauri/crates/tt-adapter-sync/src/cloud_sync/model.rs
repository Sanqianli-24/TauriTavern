use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use tt_contracts::cloud_sync::{CloudConflict, CloudVersion};
use tt_domain::errors::DomainError;
use uuid::Uuid;

use super::invalid;

pub(super) type Stamp = BTreeMap<String, String>;
pub(super) type Catalog = BTreeMap<String, Vec<Revision>>;
type Clock = BTreeMap<Uuid, u64>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) struct Part {
    pub(super) object: Uuid,
    pub(super) offset: usize,
    pub(super) len: usize,
    pub(super) hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) struct FileVersion {
    pub(super) hash: String,
    pub(super) len: u64,
    pub(super) modified_ms: u64,
    pub(super) parts: Vec<Part>,
}

pub(super) type Files = BTreeMap<String, FileVersion>;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) struct Revision {
    pub(super) id: Uuid,
    pub(super) author: Uuid,
    pub(super) modified_ms: u64,
    pub(super) files: Files,
    clock: Clock,
}

impl Revision {
    pub(super) fn new(
        device: Uuid,
        counter: u64,
        files: Files,
        predecessors: &[Self],
        modified_ms: u64,
    ) -> Self {
        let mut clock = Clock::new();
        for predecessor in predecessors {
            for (&device, &count) in &predecessor.clock {
                let previous = clock.entry(device).or_default();
                *previous = (*previous).max(count);
            }
        }
        clock.insert(device, counter);
        Self {
            id: Uuid::new_v4(),
            author: device,
            modified_ms,
            files,
            clock,
        }
    }

    pub(super) fn stamp(&self) -> Stamp {
        self.files
            .iter()
            .map(|(path, file)| (path.clone(), file.hash.clone()))
            .collect()
    }

    pub(super) fn valid_clock(&self) -> bool {
        !self.id.is_nil()
            && !self.author.is_nil()
            && self.clock.contains_key(&self.author)
            && self
                .clock
                .iter()
                .all(|(id, counter)| !id.is_nil() && *counter != 0)
    }

    pub(super) fn counter_for(&self, device: Uuid) -> u64 {
        self.clock.get(&device).copied().unwrap_or(0)
    }

    fn observes(&self, other: &Self) -> bool {
        other
            .clock
            .iter()
            .all(|(&device, &counter)| self.counter_for(device) >= counter)
    }
}

pub(super) fn join(catalog: &mut Catalog, incoming: Catalog) -> Result<(), DomainError> {
    for (item, candidates) in incoming {
        let versions = catalog.entry(item).or_default();
        for version in candidates {
            if let Some(existing) = versions
                .iter()
                .find(|existing| existing.id == version.id || existing.clock == version.clock)
            {
                if existing != &version {
                    return Err(invalid("Conflicting data for the same cloud revision"));
                }
                continue;
            }
            if versions.iter().any(|existing| existing.observes(&version)) {
                continue;
            }
            versions.retain(|existing| !version.observes(existing));
            versions.push(version);
        }
        versions.sort_by_key(|version| (version.files.is_empty(), version.id));
    }
    Ok(())
}

pub(super) fn different_versions(versions: &[Revision]) -> Vec<&Revision> {
    let mut seen = BTreeSet::new();
    versions
        .iter()
        .filter(|version| seen.insert(version.stamp()))
        .collect()
}

pub(super) fn conflicts(catalog: &Catalog) -> Vec<CloudConflict> {
    catalog
        .iter()
        .filter_map(|(item, versions)| {
            if versions.len() < 2 {
                return None;
            }
            let choices = different_versions(versions);
            (choices.len() > 1).then(|| CloudConflict {
                item: item.clone(),
                versions: choices
                    .into_iter()
                    .map(|version| CloudVersion {
                        id: version.id.to_string(),
                        device: version.author.simple().to_string()[..8].to_owned(),
                        modified_ms: version.modified_ms,
                        deleted: version.files.is_empty(),
                    })
                    .collect(),
            })
        })
        .collect()
}

#[derive(Serialize, Deserialize)]
pub(super) struct Head {
    pub(super) schema: u8,
    pub(super) catalog: Catalog,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ApplyUnit {
    pub(super) key: String,
    pub(super) expected: Stamp,
    pub(super) version: Revision,
    pub(super) fork: bool,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Outbox {
    pub(super) revisions: Catalog,
    pub(super) observed_local: Catalog,
    pub(super) objects: Vec<Uuid>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct State {
    pub(super) device: Uuid,
    pub(super) counter: u64,
    pub(super) known: Catalog,
    // Only versions represented by the user's local files belong here.
    pub(super) local: Catalog,
    pub(super) etags: BTreeMap<Uuid, String>,
    pub(super) outbox: Option<Outbox>,
    pub(super) apply: Vec<ApplyUnit>,
    pub(super) forks: BTreeSet<Uuid>,
    pub(super) initial_restore: bool,
    pub(super) last_synced_ms: Option<u64>,
}

impl State {
    pub(super) fn new(initial_restore: bool) -> Self {
        Self {
            device: Uuid::new_v4(),
            counter: 0,
            known: Catalog::new(),
            local: Catalog::new(),
            etags: BTreeMap::new(),
            outbox: None,
            apply: Vec::new(),
            forks: BTreeSet::new(),
            initial_restore,
            last_synced_ms: None,
        }
    }

    pub(super) fn tick(&mut self) -> Result<u64, DomainError> {
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or_else(|| invalid("Cloud revision counter exhausted"))?;
        Ok(self.counter)
    }
}
