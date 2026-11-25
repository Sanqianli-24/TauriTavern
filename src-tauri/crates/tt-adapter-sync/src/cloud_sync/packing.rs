use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use aws_lc_rs::digest::{Context, SHA256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tt_domain::errors::DomainError;
use uuid::Uuid;

use super::crypto::{VaultKey, digest_text, hash};
use super::dav::{CIPHERTEXT_MARGIN, Dav, object_path};
use super::invalid;
use super::model::{FileVersion, Part};
use super::workspace::{LocalFile, changed_during_sync, scan_error};

pub(super) const CHUNK_SIZE: usize = 1024 * 1024;
pub(super) const PACK_SIZE: usize = 8 * CHUNK_SIZE;

pub(super) struct PackWriter<'a> {
    root: &'a Path,
    key: &'a VaultKey,
    objects: Vec<Uuid>,
    pack: Uuid,
    buffer: Vec<u8>,
    in_batch: BTreeMap<String, Part>,
}

impl<'a> PackWriter<'a> {
    pub(super) fn new(root: &'a Path, key: &'a VaultKey) -> Self {
        Self {
            root,
            key,
            objects: Vec::new(),
            pack: Uuid::new_v4(),
            buffer: Vec::new(),
            in_batch: BTreeMap::new(),
        }
    }

    pub(super) async fn add(
        &mut self,
        file: &LocalFile,
        previous: Option<&FileVersion>,
    ) -> Result<FileVersion, DomainError> {
        if let Some(old) =
            previous.filter(|old| old.hash == file.hash && old.logical_hash == file.logical_hash)
        {
            return Ok(old.clone());
        }
        let old_parts = previous
            .into_iter()
            .flat_map(|old| &old.parts)
            .map(|part| (part.hash.as_str(), part))
            .collect::<BTreeMap<_, _>>();
        let mut source = tokio::fs::File::open(&file.path)
            .await
            .map_err(scan_error)?;
        let mut digest = Context::new(&SHA256);
        let mut parts = Vec::new();
        let mut chunk = vec![0; CHUNK_SIZE];
        let mut remaining = file.len;
        while remaining > 0 {
            let len = remaining.min(CHUNK_SIZE as u64) as usize;
            let data = &mut chunk[..len];
            source.read_exact(data).await.map_err(scan_error)?;
            digest.update(data);
            let id = hash(data);
            let part = if let Some(existing) = old_parts
                .get(id.as_str())
                .copied()
                .or_else(|| self.in_batch.get(&id))
            {
                existing.clone()
            } else {
                if self.buffer.len() + len > PACK_SIZE {
                    self.flush().await?;
                }
                let part = Part {
                    object: self.pack,
                    offset: self.buffer.len(),
                    len,
                    hash: id.clone(),
                };
                self.in_batch.insert(id, part.clone());
                self.buffer.extend_from_slice(data);
                part
            };
            parts.push(part);
            remaining -= len as u64;
        }
        if source.read(&mut chunk[..1]).await.map_err(scan_error)? != 0
            || digest_text(digest.finish()) != file.hash
        {
            return Err(changed_during_sync());
        }
        Ok(FileVersion {
            hash: file.hash.clone(),
            logical_hash: file.logical_hash.clone(),
            len: file.len,
            modified_ms: file.modified_ms,
            parts,
        })
    }

    pub(super) async fn finish(mut self) -> Result<Vec<Uuid>, DomainError> {
        self.flush().await?;
        Ok(self.objects)
    }

    async fn flush(&mut self) -> Result<(), DomainError> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        tokio::fs::create_dir_all(self.root)
            .await
            .map_err(scan_error)?;
        let next = self.pack;
        let data = self.key.seal(&object_path(next), &self.buffer)?;
        store_ciphertext(&self.root.join(next.to_string()), data).await?;
        self.objects.push(next);
        self.pack = Uuid::new_v4();
        self.buffer.clear();
        Ok(())
    }
}

pub(super) async fn upload_object(dav: &Dav<'_>, root: &Path, id: Uuid) -> Result<(), DomainError> {
    let sealed = tokio::fs::read(root.join(id.to_string()))
        .await
        .map_err(scan_error)?;
    dav.put(&object_path(id), sealed).await
}

pub(super) async fn fetch_object(
    dav: &Dav<'_>,
    key: &VaultKey,
    root: &Path,
    id: Uuid,
) -> Result<(), DomainError> {
    let file = root.join(id.to_string());
    let path = object_path(id);
    match tokio::fs::read(&file).await {
        Ok(data) if key.open(&path, data.clone(), PACK_SIZE).is_ok() => return Ok(()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(scan_error(error)),
    }
    let sealed = dav.get(&path, PACK_SIZE + CIPHERTEXT_MARGIN).await?;
    key.open(&path, sealed.clone(), PACK_SIZE)?;
    store_ciphertext(&file, sealed).await
}

async fn store_ciphertext(path: &Path, data: Vec<u8>) -> Result<(), DomainError> {
    crate::sync_fs::write_file_atomic(path, &mut std::io::Cursor::new(data), 0)
        .await
        .map_err(|error| crate::sync::http_client::sync_error_to_domain(error.into_error()))
}

pub(super) struct PackReader<'a> {
    root: PathBuf,
    key: &'a VaultKey,
    pack: Option<(Uuid, Vec<u8>)>,
}

impl<'a> PackReader<'a> {
    pub(super) fn new(root: PathBuf, key: &'a VaultKey) -> Self {
        Self {
            root,
            key,
            pack: None,
        }
    }

    pub(super) async fn unpack(
        &mut self,
        version: &FileVersion,
        file: &mut tokio::fs::File,
    ) -> Result<(), DomainError> {
        let mut digest = Context::new(&SHA256);
        for part in &version.parts {
            if !self.pack.as_ref().is_some_and(|(id, _)| *id == part.object) {
                let sealed = tokio::fs::read(self.root.join(part.object.to_string()))
                    .await
                    .map_err(scan_error)?;
                let data = self
                    .key
                    .open(&object_path(part.object), sealed, PACK_SIZE)?;
                self.pack = Some((part.object, data));
            }
            let (_, data) = self.pack.as_ref().expect("pack loaded");
            let contents = data
                .get(part.offset..part.offset + part.len)
                .ok_or_else(|| invalid("Cloud sync data is missing from a packed object"))?;
            if hash(contents) != part.hash {
                return Err(invalid("Cloud sync chunk is corrupt"));
            }
            file.write_all(contents).await.map_err(scan_error)?;
            digest.update(contents);
        }
        if digest_text(digest.finish()) != version.hash {
            return Err(invalid("Cloud sync file is incomplete or corrupt"));
        }
        file.flush().await.map_err(scan_error)
    }
}
