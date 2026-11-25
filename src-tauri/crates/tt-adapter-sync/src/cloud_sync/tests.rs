use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State as AxumState};
use axum::http::{Response, StatusCode, header};
use axum_server::tls_rustls::{RustlsConfig, from_tcp_rustls};
use tokio::sync::Mutex;
use tt_contracts::cloud_sync::{CloudResolution, CloudSyncOperation};
use tt_contracts::sync::{
    LocalAppliedChangeSummary, ResolvedSyncPolicy, SyncEndpointRef, SyncExecutionKind, SyncIntent,
    SyncJob, SyncJobEvent, SyncOrigin,
};
use ttsync_http::tls::{SelfManagedTls, TlsProvider};
use uuid::Uuid;

use super::crypto::hash;
use super::model::{State, conflicts};
use super::packing::{CHUNK_SIZE, PACK_SIZE};
use super::*;

#[derive(Default)]
struct MemoryCredentials;

#[async_trait]
impl CloudCredentialStore for MemoryCredentials {
    async fn load(&self) -> Result<Option<String>, DomainError> {
        Ok(None)
    }
    async fn save(&self, _: String) -> Result<(), DomainError> {
        unreachable!()
    }
    async fn clear(&self) -> Result<(), DomainError> {
        unreachable!()
    }
}

struct NoEvents;

impl SyncJobEventPublisher for NoEvents {
    fn publish_sync_job(&self, _: SyncJobEvent) {}
}

struct Temp(PathBuf);

impl Temp {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("tt-cloud-sync-{}", Uuid::new_v4())))
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Default)]
struct Store {
    dirs: BTreeSet<String>,
    files: BTreeMap<String, Vec<u8>>,
    successful_pack_uploads: usize,
    fail_after_packs: Option<usize>,
}

struct Server {
    _task: tokio::task::JoinHandle<()>,
    url: String,
    certificate: Vec<u8>,
    data: Arc<Mutex<Store>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self._task.abort();
    }
}

impl Server {
    async fn start(root: &Path) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        let tls = SelfManagedTls::load_or_create(root).unwrap();
        let configuration = RustlsConfig::from_config(Arc::new(tls.server_config().unwrap()));
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let data = Arc::new(Mutex::new(Store::default()));
        data.lock().await.dirs.insert("/dav/".into());
        let router = Router::new().fallback(handle).with_state(data.clone());
        let server = from_tcp_rustls(listener, configuration).unwrap();
        let task =
            tokio::spawn(async move { server.serve(router.into_make_service()).await.unwrap() });
        let certificate = tokio::fs::read(root.join("tls/cert.pem")).await.unwrap();
        Self {
            _task: task,
            url: format!("https://localhost:{}/dav/", address.port()),
            certificate,
            data,
        }
    }

    fn credentials(&self, key: &VaultKey) -> Credentials {
        Credentials {
            url: self.url.clone(),
            account: "test".into(),
            password: "app-key".into(),
            recovery_code: key.code(),
        }
    }
}

async fn handle(
    AxumState(state): AxumState<Arc<Mutex<Store>>>,
    request: Request,
) -> Response<Body> {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path();
    if parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some("Basic dGVzdDphcHAta2V5")
    {
        return response(StatusCode::UNAUTHORIZED, "");
    }
    let mut state = state.lock().await;
    match parts.method.as_str() {
        "MKCOL" if state.dirs.insert(path.into()) => response(StatusCode::CREATED, ""),
        "MKCOL" => response(StatusCode::METHOD_NOT_ALLOWED, ""),
        "PROPFIND" if state.dirs.contains(path) => {
            let row = |href: &str, tag: &str| {
                format!(
                    "<D:response><D:href>{href}</D:href><D:propstat><D:prop><D:getetag>{tag}</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"
                )
            };
            let mut entries = row(path, "");
            if parts.headers.get("Depth").is_some_and(|depth| depth == "1") {
                for (name, bytes) in &state.files {
                    if name
                        .strip_prefix(path)
                        .is_some_and(|name| !name.contains('/'))
                    {
                        entries.push_str(&row(name, &hash(bytes)));
                    }
                }
            }
            response(
                StatusCode::MULTI_STATUS,
                format!("<D:multistatus xmlns:D=\"DAV:\">{entries}</D:multistatus>"),
            )
        }
        "PUT" => {
            if path.contains("/objects/") {
                let successful = state.successful_pack_uploads;
                if state.fail_after_packs == Some(successful) {
                    state.fail_after_packs = None;
                    return response(StatusCode::BAD_GATEWAY, "");
                }
                state.successful_pack_uploads += 1;
            }
            let bytes = to_bytes(body, 64 * 1024 * 1024).await.unwrap();
            state.files.insert(path.into(), bytes.to_vec());
            response(StatusCode::CREATED, "")
        }
        "GET" if state.files.contains_key(path) => {
            response(StatusCode::OK, state.files[path].clone())
        }
        _ => response(StatusCode::NOT_FOUND, ""),
    }
}

fn response(status: StatusCode, body: impl Into<Body>) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(body.into())
        .unwrap()
}

struct Replica {
    data: PathBuf,
    runtime: CloudSyncRuntime,
    vault: PathBuf,
}

impl Replica {
    async fn new(root: &Path, key: &VaultKey, restore: bool) -> Self {
        let data = root.join("data");
        let runtime = CloudSyncRuntime::new(
            data.clone(),
            root.join("private"),
            crate::sync::workspace::empty_database_access(),
            crate::sync::workspace::empty_database_access(),
            Arc::new(MemoryCredentials),
            Arc::new(NoEvents),
            "Cloud sync test",
        );
        let vault = runtime.vault(key);
        save_state(&vault, &State::new(restore)).await.unwrap();
        Self {
            data,
            runtime,
            vault,
        }
    }

    fn dav<'a>(&'a self, server: &Server, credentials: &'a Credentials, key: &VaultKey) -> Dav<'a> {
        let mut client = self.runtime.dav(credentials, key).unwrap();
        client.trust_test_server(&server.certificate);
        client
    }

    async fn write(&self, path: &str, value: &[u8]) {
        let path = self.data.join(path);
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(path, value).await.unwrap();
    }

    async fn exchange(
        &self,
        dav: &Dav<'_>,
        key: &VaultKey,
        operation: CloudSyncOperation,
    ) -> Result<(), DomainError> {
        let mut state = load_state(&self.vault).await.unwrap();
        self.runtime
            .exchange(
                &job(operation.clone()),
                &self.vault,
                key,
                dav,
                &mut state,
                operation,
            )
            .await?;
        Ok(())
    }

    async fn apply(&self, key: &VaultKey) {
        let mut state = load_state(&self.vault).await.unwrap();
        self.runtime
            .apply(
                &job(CloudSyncOperation::Apply),
                &self.vault,
                key,
                &mut state,
                &mut LocalAppliedChangeSummary::default(),
            )
            .await
            .unwrap();
    }
}

fn job(operation: CloudSyncOperation) -> SyncJob {
    SyncJob {
        id: Uuid::new_v4().to_string(),
        endpoint: SyncEndpointRef::CloudAccount,
        intent: SyncIntent::SynchronizeCloud,
        execution: SyncExecutionKind::Cloud,
        origin: SyncOrigin::Manual,
        policy: ResolvedSyncPolicy::Cloud { operation },
    }
}

const CHAT: &str = "default-user/chats/Alice/Story.jsonl";

fn chat(message: &str) -> Vec<u8> {
    format!("{{\"chat_metadata\":{{\"integrity\":\"original\"}}}}\n{{\"mes\":\"{message}\"}}\n")
        .into_bytes()
}

#[tokio::test]
async fn restores_two_workspaces_and_keeps_offline_chat_branches_and_a_chosen_settings_version() {
    let temp = Temp::new();
    let key = VaultKey::generate().unwrap();
    let server = Server::start(&temp.0).await;
    let credentials = server.credentials(&key);
    let first = Replica::new(&temp.0.join("tablet"), &key, false).await;
    let second = Replica::new(&temp.0.join("phone"), &key, true).await;
    let a = first.dav(&server, &credentials, &key);
    let b = second.dav(&server, &credentials, &key);
    a.check_account().await.unwrap();
    a.create(&key).await.unwrap();
    b.unlock(&key).await.unwrap();
    let wrong = VaultKey::generate().unwrap();
    assert!(
        second
            .dav(&server, &credentials, &wrong)
            .unlock(&wrong)
            .await
            .is_err()
    );

    first.write(CHAT, &chat("base")).await;
    first
        .write("default-user/characters/Alice.png", b"role card image")
        .await;
    first
        .write("default-user/secrets.json", b"secret-key-canary")
        .await;
    first
        .write(
            "default-user/settings/presets.json",
            br#"{"preset":"Base"}"#,
        )
        .await;
    second
        .write("default-user/worlds/Phone.json", b"phone-only")
        .await;
    first
        .exchange(&a, &key, CloudSyncOperation::Exchange)
        .await
        .unwrap();
    second
        .exchange(&b, &key, CloudSyncOperation::Exchange)
        .await
        .unwrap();
    second.apply(&key).await;
    assert_eq!(
        tokio::fs::read(second.data.join(CHAT)).await.unwrap(),
        chat("base")
    );
    assert_eq!(
        tokio::fs::read(second.data.join("default-user/secrets.json"))
            .await
            .unwrap(),
        b"secret-key-canary"
    );
    assert!(
        tokio::fs::try_exists(second.data.join("default-user/worlds/Phone.json"))
            .await
            .unwrap()
    );
    assert!(
        !server
            .data
            .lock()
            .await
            .files
            .values()
            .any(|value| value.windows(17).any(|part| part == b"secret-key-canary"))
    );

    first.write(CHAT, &chat("tablet branch")).await;
    second.write(CHAT, &chat("phone branch")).await;
    first
        .write(
            "default-user/settings/presets.json",
            br#"{"preset":"Tablet"}"#,
        )
        .await;
    second
        .write(
            "default-user/settings/presets.json",
            br#"{"preset":"Phone"}"#,
        )
        .await;
    first
        .exchange(&a, &key, CloudSyncOperation::Exchange)
        .await
        .unwrap();
    first.apply(&key).await;
    second
        .exchange(&b, &key, CloudSyncOperation::Exchange)
        .await
        .unwrap();
    second.apply(&key).await;
    first
        .exchange(&a, &key, CloudSyncOperation::Exchange)
        .await
        .unwrap();
    first.apply(&key).await;

    for replica in [&first, &second] {
        let directory = replica.data.join("default-user/chats/Alice");
        let mut records = Vec::new();
        let mut files = tokio::fs::read_dir(directory).await.unwrap();
        while let Some(file) = files.next_entry().await.unwrap() {
            records.push(tokio::fs::read_to_string(file.path()).await.unwrap());
        }
        assert_eq!(records.len(), 2);
        assert!(records.iter().any(|chat| chat.contains("tablet branch")));
        assert!(records.iter().any(|chat| chat.contains("phone branch")));
        assert_eq!(
            records
                .iter()
                .filter(|chat| chat.contains("\"original\""))
                .count(),
            1
        );
    }
    let state = load_state(&first.vault).await.unwrap();
    let preset = conflicts(&state.known)
        .into_iter()
        .find(|conflict| conflict.item.ends_with("/presets.json"))
        .unwrap();
    assert_eq!(preset.versions.len(), 2);
    first
        .exchange(
            &a,
            &key,
            CloudSyncOperation::Resolve(CloudResolution {
                item: preset.item,
                version: preset.versions[0].id.clone(),
                observed_versions: preset
                    .versions
                    .iter()
                    .map(|version| version.id.clone())
                    .collect(),
            }),
        )
        .await
        .unwrap();
    first.apply(&key).await;
    second
        .exchange(&b, &key, CloudSyncOperation::Exchange)
        .await
        .unwrap();
    second.apply(&key).await;
    assert_eq!(
        tokio::fs::read(first.data.join("default-user/settings/presets.json"))
            .await
            .unwrap(),
        tokio::fs::read(second.data.join("default-user/settings/presets.json"))
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn resumes_staged_large_upload_and_preserves_an_edit_made_after_download() {
    let temp = Temp::new();
    let key = VaultKey::generate().unwrap();
    let server = Server::start(&temp.0).await;
    let credentials = server.credentials(&key);
    let a = Replica::new(&temp.0.join("a"), &key, false).await;
    let b = Replica::new(&temp.0.join("b"), &key, false).await;
    let sender = a.dav(&server, &credentials, &key);
    let receiver = b.dav(&server, &credentials, &key);
    sender.create(&key).await.unwrap();
    let file = "default-user/user/files/attachment.bin";
    let bytes = (0..17)
        .flat_map(|part| std::iter::repeat_n(part, CHUNK_SIZE))
        .collect::<Vec<_>>();
    a.write(file, &bytes).await;
    a.write(CHAT, &chat("phone")).await;
    server.data.lock().await.fail_after_packs = Some(1);
    assert!(
        a.exchange(&sender, &key, CloudSyncOperation::Exchange)
            .await
            .is_err()
    );
    assert_eq!(server.data.lock().await.successful_pack_uploads, 1);
    assert!(receiver.heads().await.unwrap().is_empty());
    a.exchange(&sender, &key, CloudSyncOperation::Exchange)
        .await
        .unwrap();
    assert_eq!(
        server.data.lock().await.successful_pack_uploads,
        bytes.len().div_ceil(PACK_SIZE)
    );
    b.exchange(&receiver, &key, CloudSyncOperation::Exchange)
        .await
        .unwrap();
    b.write(CHAT, &chat("unsent tablet edit")).await;
    b.apply(&key).await;
    assert_eq!(tokio::fs::read(b.data.join(file)).await.unwrap(), bytes);
    assert_eq!(
        tokio::fs::read(b.data.join(CHAT)).await.unwrap(),
        chat("unsent tablet edit")
    );
}
