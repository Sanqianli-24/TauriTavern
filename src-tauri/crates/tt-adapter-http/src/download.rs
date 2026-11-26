use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufWriter};
use tt_domain::errors::DomainError;

use crate::{HttpClientPool, HttpClientProfile};

impl HttpClientPool {
    /// Reuse a cached download only when both its length and SHA-256 still match.
    pub async fn download_verified(
        &self,
        url: &str,
        destination: &Path,
        size: u64,
        sha256: &str,
        mut progress: impl FnMut(u64),
    ) -> Result<(), DomainError> {
        if matches_download(destination, size, sha256).await? {
            progress(size);
            return Ok(());
        }

        let partial = destination.with_extension("part");
        let result = self
            .download_partial(url, &partial, size, sha256, &mut progress)
            .await;
        if result.is_err() {
            let _ = fs::remove_file(&partial).await;
        }
        result?;
        fs::rename(&partial, destination).await.map_err(io_error)?;
        progress(size);
        Ok(())
    }

    async fn download_partial(
        &self,
        url: &str,
        path: &Path,
        size: u64,
        sha256: &str,
        progress: &mut impl FnMut(u64),
    ) -> Result<(), DomainError> {
        let client = self.client(HttpClientProfile::Download)?;
        let mut response = client
            .get(url)
            .timeout(Duration::from_secs(15 * 60))
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(io_error)?;

        let mut file = BufWriter::new(File::create(path).await.map_err(io_error)?);
        let mut received = 0;
        let mut digest = Sha256::new();

        while let Some(chunk) = response.chunk().await.map_err(io_error)? {
            received += chunk.len() as u64;
            if received > size {
                return Err(invalid_download());
            }
            file.write_all(&chunk).await.map_err(io_error)?;
            digest.update(&chunk);
            if received < size {
                progress(received);
            }
        }

        if received != size || !hex::encode(digest.finalize()).eq_ignore_ascii_case(sha256) {
            return Err(invalid_download());
        }
        file.flush().await.map_err(io_error)?;
        Ok(())
    }
}

async fn matches_download(path: &Path, size: u64, sha256: &str) -> Result<bool, DomainError> {
    let mut file = match File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error(error)),
    };
    if file.metadata().await.map_err(io_error)?.len() != size {
        return Ok(false);
    }

    let mut digest = Sha256::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).await.map_err(io_error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()).eq_ignore_ascii_case(sha256))
}

fn invalid_download() -> DomainError {
    DomainError::InvalidData("Download does not match the published size and SHA-256".into())
}

fn io_error(error: impl std::fmt::Display) -> DomainError {
    DomainError::InternalError(format!("Update download failed: {error}"))
}
