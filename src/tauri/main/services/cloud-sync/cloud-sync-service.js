import { eventSource, event_types } from '../../../../scripts/events.js';
import { flushLifecycleState } from '../lifecycle/lifecycle-flush-service.js';
import { createBrowserStorageSync } from './browser-storage.js';
import { observeCloudSyncChanges } from './local-changes.js';

const POLL_MS = 45_000;
const SAVE_DELAY_MS = 1_500;
let controller;

export function getCloudSyncController() {
    return controller;
}

export async function initializeCloudSync(context) {
    if (controller) return;
    controller = createController(context);
    await controller.beforeAppReady();
}

function createController(context) {
    const invoke = (name, payload) => context.invokeTransport(name, payload);
    const browser = createBrowserStorageSync(request => invoke('cloud_sync_browser', { request }));
    const subscribers = new Set();
    let snapshot = { status: null, busy: false, dirty: false, error: '', storageIssues: [] };
    let dirty = 0;
    let running = null;
    let reloadBlocked = false;
    let ready = false;
    let lastInteraction = 0;
    let timer;
    let attemptTimer;

    const publish = change => {
        snapshot = { ...snapshot, ...change };
        for (const subscriber of subscribers) subscriber();
    };

    const getSnapshot = () => snapshot;
    const subscribe = subscriber => {
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
    };

    async function refresh() {
        const status = await invoke('cloud_sync_status');
        publish({ status });
        return status;
    }

    async function runJob(operation, automatic) {
        const report = await invoke('cloud_sync_run', { operation, automatic });
        if (report?.result?.status !== 'completed') {
            throw new Error(report?.result?.message || 'Cloud sync job did not complete');
        }
    }

    async function beforeAppReady() {
        try {
            const status = await refresh();
            if (status.account && status.pendingApply) {
                // Finish restoring a previous boot before capturing the current browser state.
                await browser.restore();
                const storageIssues = await browser.capture();
                await runJob({ action: 'apply' }, true);
                await browser.restore();
                publish({ storageIssues });
                await refresh();
            }
        } catch (error) {
            reloadBlocked = true;
            publish({ error: errorText(error) });
        }
        eventSource.once(event_types.APP_READY, () => {
            ready = true;
            schedule(0);
        });
        for (const event of [
            event_types.CHAT_DELETED, event_types.GROUP_CHAT_DELETED, event_types.CHAT_RENAMED,
            event_types.CHARACTER_EDITED, event_types.CHARACTER_DELETED, event_types.SETTINGS_UPDATED,
            event_types.WORLDINFO_UPDATED,
        ]) eventSource.on(event, markDirty);
        observeCloudSyncChanges(markDirty);
        timer = globalThis.setInterval(() => {
            if (!document.hidden) schedule(0);
        }, POLL_MS);
        window.addEventListener('online', () => schedule(0));
        window.addEventListener('focus', () => schedule(SAVE_DELAY_MS));
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) schedule(0);
            else if (snapshot.dirty && !running) void sync({ allowHidden: true });
        });
        for (const event of ['pointerdown', 'keydown', 'input']) {
            document.addEventListener(event, () => { lastInteraction = performance.now(); }, { capture: true, passive: true });
        }
        window.addEventListener('pagehide', () => {
            clearInterval(timer);
            clearTimeout(attemptTimer);
        }, { once: true });
    }

    function markDirty() {
        if (!snapshot.status?.account) return;
        dirty++;
        publish({ dirty: true });
        schedule(SAVE_DELAY_MS);
    }

    function schedule(delay) {
        if (!ready || !snapshot.status?.account || document.hidden) return;
        clearTimeout(attemptTimer);
        attemptTimer = globalThis.setTimeout(() => {
            if (!running) void sync();
        }, delay);
    }

    async function sync({ manual = false, allowHidden = false, selection } = {}) {
        if (running) return running;
        if (!snapshot.status?.account || (!allowHidden && document.hidden)) return;
        if (manual) reloadBlocked = false;
        const startEpoch = dirty;
        publish({ busy: true, error: '' });
        const task = (async () => {
            try {
                if (!snapshot.status.pendingApply) {
                    if (navigator.onLine === false) throw new Error('Cloud sync is waiting for an internet connection');
                    await flushLifecycleState('cloud-sync:exchange');
                    publish({ storageIssues: await browser.capture() });
                    await runJob(selection ? { action: 'resolve', selection } : { action: 'exchange' }, !manual);
                }
                const status = await refresh();
                if (status.pendingApply) {
                    await maybeReload(manual);
                } else if (dirty === startEpoch) {
                    publish({ dirty: false });
                }
            } catch (error) {
                publish({ error: errorText(error) });
                try { await refresh(); } catch { /* The operation error is already displayed. */ }
            } finally {
                publish({ busy: false });
            }
        })();
        running = task.finally(() => {
            running = null;
            if (dirty !== startEpoch && !snapshot.status?.pendingApply) schedule(SAVE_DELAY_MS);
        });
        return running;
    }

    async function maybeReload(manual) {
        if (reloadBlocked || document.hidden) return;
        const { isGenerating } = await import('../../../../script.js');
        const isIdle = () => {
            if (document.hidden || isGenerating() || document.querySelector('.edit_textarea, .reasoning_edit_textarea')) return false;
            if (document.querySelector('#send_textarea')?.value) return false;
            if (manual) return true;
            const field = document.activeElement;
            const editing = field?.id !== 'send_textarea' &&
                field?.matches('textarea, input:not([type=button]):not([type=checkbox]):not([type=radio]), [contenteditable=true]');
            return !document.querySelector('dialog[open]') &&
                !editing &&
                performance.now() - lastInteraction >= SAVE_DELAY_MS;
        };
        if (!isIdle() || !await invoke('cloud_sync_can_apply')) {
            schedule(3_000);
            return;
        }
        const activity = lastInteraction;
        await flushLifecycleState('cloud-sync:reload');
        if (isIdle() && activity === lastInteraction) location.reload();
        else schedule(3_000);
    }

    async function connect(input) {
        const result = await invoke('cloud_sync_connect', { input });
        browser.reset();
        publish({ error: '', dirty: true, storageIssues: [] });
        await refresh();
        schedule(0);
        return result;
    }

    async function disconnect() {
        await invoke('cloud_sync_disconnect');
        browser.reset();
        clearTimeout(attemptTimer);
        publish({ error: '', dirty: false, storageIssues: [] });
        await refresh();
    }

    return {
        beforeAppReady, connect, disconnect, getSnapshot, subscribe, sync,
        preview: input => invoke('cloud_sync_preview', { input }),
        recovery: () => invoke('cloud_sync_recovery'),
    };
}

function errorText(error) {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
        const [message] = Object.values(error);
        if (typeof message === 'string') return message;
    }
    return 'Cloud sync could not complete';
}
