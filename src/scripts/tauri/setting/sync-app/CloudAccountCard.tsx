import { useImperativeHandle, useRef, useState, useSyncExternalStore, type FormEvent, type Ref } from 'react';
import { isCloudRecoveryCode, type SyncTranslate } from './SyncContract';
import { SyncButton } from './SyncComponents';

type Mode = 'create' | 'merge' | 'restore';
type Credentials = {
    mode: Mode;
    url: string;
    account: string;
    appPassword: string;
    recoveryCode: string;
    includeCredentials: boolean;
};
type Preview = { localFiles: number; localBytes: number; cloudItems: number; cloudBytes: number };
type Recovery = { recoveryCode: string; qrSvg: string };
type Version = { id: string; device: string; modifiedMs: number; deleted: boolean };
type Conflict = { item: string; versions: Version[] };
type Snapshot = {
    status: null | {
        account: string | null;
        device: string | null;
        lastSyncedMs: number | null;
        pendingApply: boolean;
        pendingUpload: boolean;
        conflicts: Conflict[];
    };
    busy: boolean;
    dirty: boolean;
    error: string;
    storageIssues: string[];
};

export type CloudSyncController = {
    getSnapshot: () => Snapshot;
    subscribe: (subscriber: () => void) => () => void;
    preview: (input: Credentials) => Promise<Preview>;
    connect: (input: Credentials) => Promise<{ recoveryCode: string }>;
    disconnect: () => Promise<void>;
    recovery: () => Promise<Recovery>;
    sync: (options: { manual: boolean; selection?: { item: string; version: string; observedVersions: string[] } }) => Promise<void>;
};

export type CloudAccountCardHandle = {
    receiveRecoveryCode: (code: string) => void;
};

type Props = {
    ref: Ref<CloudAccountCardHandle>;
    controller: CloudSyncController;
    tr: SyncTranslate;
    scan: (() => Promise<string | null>) | undefined;
    copy: (text: string) => Promise<unknown>;
};

const defaults: Credentials = {
    mode: 'create', url: 'https://dav.jianguoyun.com/dav/', account: '', appPassword: '',
    recoveryCode: '', includeCredentials: false,
};

export function CloudAccountCard({ ref, controller, tr, scan, copy }: Props) {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const section = useRef<HTMLElement>(null);
    const [setupOpen, setSetupOpen] = useState(false);
    const [form, setForm] = useState(defaults);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [recovery, setRecovery] = useState<Recovery | null>(null);
    const [recoveryNotice, setRecoveryNotice] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [disconnecting, setDisconnecting] = useState(false);
    const [copied, setCopied] = useState(false);
    const { status } = snapshot;
    const disabled = snapshot.busy || busy;

    function edit(input: Partial<Credentials>) {
        setForm(previous => ({ ...previous, ...input }));
        setPreview(null);
        setRecoveryNotice('');
    }

    function receiveRecoveryCode(code: string) {
        if (status?.account) {
            setRecoveryNotice('This device is already connected. Enter the recovery code in Cloud account on your other device.');
        } else {
            if (busy) {
                throw new Error(tr('Checking cloud account…'));
            }
            edit({ mode: form.mode === 'create' ? 'merge' : form.mode, recoveryCode: code });
            setSetupOpen(true);
            setError('');
            setRecoveryNotice('Recovery code filled in. Check the account and app password, then preview the first sync.');
        }
        section.current?.focus({ preventScroll: true });
        section.current?.scrollIntoView({ block: 'start' });
    }

    useImperativeHandle(ref, () => ({ receiveRecoveryCode }));

    async function perform(action: () => Promise<void>) {
        setBusy(true);
        setError('');
        try {
            await action();
        } catch (failure) {
            const message: unknown = failure instanceof Error ? failure.message :
                typeof failure === 'string' ? failure :
                    typeof failure === 'object' && failure ? Object.values(failure)[0] : undefined;
            setError(typeof message === 'string' ? message : 'Cloud sync could not complete');
        } finally {
            setBusy(false);
        }
    }

    function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        void perform(async () => {
            if (!preview) {
                setPreview(await controller.preview(form));
                return;
            }
            const result = await controller.connect(form);
            setForm(defaults);
            setPreview(null);
            setRecoveryNotice('');
            if (result.recoveryCode) {
                setRecovery({ recoveryCode: result.recoveryCode, qrSvg: '' });
                setRecovery(await controller.recovery());
            }
        });
    }

    function copyCode(code: string) {
        void perform(async () => {
            await copy(code);
            setCopied(true);
        });
    }

    const conflictList = status?.conflicts ?? [];
    const statusText = snapshot.busy ? 'Cloud sync in progress'
        : status?.pendingApply ? 'Cloud changes ready to apply'
            : snapshot.error ? 'Cloud sync needs attention'
                : snapshot.dirty || status?.pendingUpload ? 'Waiting to upload'
                    : status?.lastSyncedMs ? 'Cloud sync up to date' : 'Connected';

    return (
        <section ref={section} tabIndex={-1} aria-label={tr('Cloud account')} className="tt-sync-section tt-cloud-sync">
            <div className="tt-sync-section-header">
                <b>{tr('Cloud account')}</b>
                {status?.account && (
                    <SyncButton
                        label={tr(status.pendingApply ? 'Apply cloud changes' : 'Sync now')}
                        icon="fa-arrows-rotate"
                        disabled={disabled}
                        onClick={() => void controller.sync({ manual: true })}
                    />
                )}
            </div>
            {recoveryNotice && <div role="status" className="tt-sync-muted">{tr(recoveryNotice)}</div>}
            {(error || snapshot.error) && <div role="alert" className="tt-sync-auto-warning">{tr(error || snapshot.error)}</div>}
            {status?.account ? (
                <>
                    <div role="status">
                        <strong>{tr(statusText)}</strong>
                        <div className="tt-sync-muted">{status.account}</div>
                        {status.lastSyncedMs !== null && <small>{new Date(status.lastSyncedMs).toLocaleString()}</small>}
                    </div>
                    {status.pendingApply && <small>{tr('Cloud changes apply when editing and generation have stopped.')}</small>}
                    <div className="tt-sync-actions">
                        <SyncButton
                            label={tr(recovery ? 'Hide recovery code' : 'Show recovery code')}
                            icon="fa-key"
                            disabled={busy}
                            onClick={() => {
                                setCopied(false);
                                if (recovery) setRecovery(null);
                                else void perform(async () => setRecovery(await controller.recovery()));
                            }}
                        />
                        <SyncButton
                            label={tr('Disconnect cloud account')}
                            icon="fa-link-slash"
                            disabled={disabled}
                            onClick={() => setDisconnecting(value => !value)}
                        />
                    </div>
                    {disconnecting && (
                        <div className="tt-cloud-sync-form">
                            <small>{tr('Disconnecting keeps the data on this device and in your drive.')}</small>
                            <SyncButton label={tr('Disconnect')} icon="fa-link-slash" disabled={disabled} onClick={() => {
                                void perform(async () => {
                                    await controller.disconnect();
                                    setRecovery(null);
                                    setRecoveryNotice('');
                                    setDisconnecting(false);
                                });
                            }} />
                        </div>
                    )}
                    {recovery && (
                        <div className="tt-cloud-sync-form">
                            <small>{tr('Save this code and enter it in Cloud account on your other device. Any device with the code and drive access can decrypt your data.')}</small>
                            <code className="tt-cloud-recovery-code">{recovery.recoveryCode}</code>
                            {recovery.qrSvg && (
                                <img
                                    className="tt-cloud-recovery-qr"
                                    alt={tr('Cloud recovery QR code')}
                                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(recovery.qrSvg)}`}
                                />
                            )}
                            <SyncButton label={tr(copied ? 'Copied' : 'Copy recovery code')} icon="fa-copy"
                                disabled={busy} onClick={() => copyCode(recovery.recoveryCode)} />
                        </div>
                    )}
                    {snapshot.storageIssues.length > 0 && (
                        <details>
                            <summary>{tr('Some browser data is unavailable on this device')}</summary>
                            <ul>{snapshot.storageIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>
                        </details>
                    )}
                    {conflictList.length > 0 && (
                        <details>
                            <summary>{tr('Sync conflicts')} ({conflictList.length})</summary>
                            {conflictList.map(conflict => (
                                <div key={conflict.item} className="tt-cloud-sync-conflict">
                                    <code>{conflict.item}</code>
                                    {conflict.item.endsWith('.jsonl') && conflict.versions.filter(version => !version.deleted).length > 1 &&
                                        <small>{tr('Chat branches are kept beside the original chat.')}</small>}
                                    {conflict.versions.map(version => (
                                        <SyncButton
                                            key={version.id}
                                            label={[
                                                tr(version.deleted ? 'Keep deletion' : 'Use version'),
                                                version.device === status.device ? tr('This device') : version.device,
                                                new Date(version.modifiedMs).toLocaleString(),
                                            ].join(' · ')}
                                            icon="fa-code-branch"
                                            disabled={disabled || status.pendingApply}
                                            onClick={() => void controller.sync({
                                                manual: true,
                                                selection: { item: conflict.item, version: version.id, observedVersions: conflict.versions.map(choice => choice.id) },
                                            })}
                                        />
                                    ))}
                                </div>
                            ))}
                        </details>
                    )}
                </>
            ) : (
                <details open={setupOpen} onToggle={event => setSetupOpen(event.currentTarget.open)}>
                    <summary>{tr('Connect Nutstore or WebDAV')}</summary>
                    <form className="tt-cloud-sync-form" onSubmit={submit}>
                        <label>
                            <span>{tr('First sync')}</span>
                            <select value={form.mode} disabled={busy} onChange={event => edit({ mode: event.target.value as Mode })}>
                                <option value="create">{tr('Create a cloud vault')}</option>
                                <option value="merge">{tr('Join and merge both devices')}</option>
                                <option value="restore">{tr('Restore to a new device')}</option>
                            </select>
                        </label>
                        <label><span>{tr('WebDAV address')}</span>
                            <input className="text_pole" type="url" value={form.url} required disabled={busy}
                                onChange={event => edit({ url: event.target.value })} />
                        </label>
                        <label><span>{tr('WebDAV account')}</span>
                            <input className="text_pole" autoCapitalize="off" value={form.account} required disabled={busy}
                                onChange={event => edit({ account: event.target.value })} />
                        </label>
                        <label><span>{tr('WebDAV app password')}</span>
                            <input className="text_pole" type="password" autoComplete="off" value={form.appPassword} required disabled={busy}
                                onChange={event => edit({ appPassword: event.target.value })} />
                        </label>
                        {form.mode !== 'create' && (
                            <>
                                <label><span>{tr('Cloud recovery code')}</span>
                                    <input className="text_pole" type="password" autoComplete="off" value={form.recoveryCode}
                                        required disabled={busy} onChange={event => edit({ recoveryCode: event.target.value })} />
                                </label>
                                {scan && <SyncButton label={tr('Scan recovery QR code')} icon="fa-qrcode" disabled={busy}
                                    onClick={() => void perform(async () => {
                                        const code = (await scan())?.trim();
                                        if (!code) return;
                                        if (!isCloudRecoveryCode(code)) {
                                            throw new Error(tr('Scan the recovery QR code shown in Cloud account on a connected device.'));
                                        }
                                        receiveRecoveryCode(code);
                                    })} />}
                            </>
                        )}
                        <label className="checkbox_label">
                            <input type="checkbox" checked={form.includeCredentials} required disabled={busy}
                                onChange={event => edit({ includeCredentials: event.target.checked })} />
                            <span>{tr('Encrypt and sync model keys and extension tokens')}</span>
                        </label>
                        {preview && (
                            <div role="status" className="tt-cloud-sync-form">
                                <small>{tr('Local files')} · {preview.localFiles} · {size(preview.localBytes)}</small>
                                <small>{tr('Cloud items')} · {preview.cloudItems} · {size(preview.cloudBytes)}</small>
                                <small>{tr('Estimated transfer limit')} · {size(preview.localBytes + preview.cloudBytes)}</small>
                                <small>{tr(form.mode === 'restore'
                                    ? 'Matching items will use the cloud copy. Items only on this device are kept.'
                                    : 'Items from both devices are kept. Conflicting versions can be reviewed after syncing.')}</small>
                            </div>
                        )}
                        <button className="menu_button tt-sync-button" type="submit" disabled={busy || status === null}>
                            {tr(busy ? 'Checking cloud account…' : preview ? 'Connect and sync' : 'Preview cloud sync')}
                        </button>
                    </form>
                </details>
            )}
        </section>
    );
}

function size(bytes: number) {
    return new Intl.NumberFormat(undefined, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
        .format(bytes / 1_000_000);
}
