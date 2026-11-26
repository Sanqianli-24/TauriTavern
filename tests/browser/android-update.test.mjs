import assert from 'node:assert/strict';
import test from 'node:test';
import { HOSTS } from '../helpers/host-identity.mjs';
import { createBrowserRuntime } from './runtime.mjs';

test('Android startup and manual updates download in app and show progress', async () => {
    const { window, startHost, load, getModule } = await createBrowserRuntime({ identity: HOSTS.android });
    const core = window.__TAURI__.core;
    const invoke = core.invoke.bind(core);
    const releaseToken = 'stable:v2.5.0';
    const requested = [];
    const externalLinks = [];
    const release = {
        has_update: true,
        current_version: '2.4.6',
        channel: 'stable',
        release_token: releaseToken,
        android_install_available: true,
        latest_release: { version: '2.5.0', body: 'New features', html_url: 'https://github.com/example/app/releases/tag/v2.5.0' },
    };
    let downloadStarted = Promise.withResolvers();
    core.invoke = async (command, args, options) => {
        if (command === 'get_client_version') {
            return { ...await invoke(command, args, options), appName: 'NexusTavern' };
        }
        if (command === 'check_for_update') {
            return release;
        }
        if (command === 'install_android_update') {
            requested.push(args.releaseToken);
            args.progress.onmessage(42);
            const completed = Promise.withResolvers();
            downloadStarted.resolve(completed.resolve);
            return completed.promise;
        }
        if (command === 'plugin:opener|open_url') {
            externalLinks.push(args.url);
            return;
        }
        return invoke(command, args, options);
    };

    const { document } = window;
    function waitFor(match) {
        const current = match();
        if (current) return Promise.resolve(current);
        return new Promise(resolve => {
            const observer = new window.MutationObserver(() => {
                const result = match();
                if (result) {
                    observer.disconnect();
                    resolve(result);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        });
    }

    try {
        await startHost();
        await load('script.js');
        const { eventSource, event_types } = getModule('scripts/events.js').namespace;
        const ready = new Promise(resolve => eventSource.once(event_types.APP_READY, resolve));
        window.jQuery.holdReady(false);
        await ready;

        assert.equal(document.querySelector('.tt-workspace-brand').textContent, 'NexusTavern');
        const title = await waitFor(() => document.querySelector('dialog[open] .ttv-update-popup-title'));
        assert.match(title.textContent, /NexusTavern.*2\.5\.0/);
        title.closest('dialog').querySelector('.popup-button-ok').click();
        const finishStartupDownload = await downloadStarted.promise;
        assert.equal(document.querySelector('dialog[open] progress').value, 42);
        finishStartupDownload('installer_opened');
        await waitFor(() => !document.querySelector('dialog[open] progress'));

        const check = await waitFor(() => document.querySelector('#tauritavern_check_update'));
        check.click();
        await waitFor(() => !check.disabled);
        assert.equal(document.querySelector('#tauritavern_update_download').style.display, 'none');
        downloadStarted = Promise.withResolvers();
        document.querySelector('#tauritavern_update_install').click();
        const finishManualDownload = await downloadStarted.promise;
        assert.equal(document.querySelector('dialog[open] progress').value, 42);
        finishManualDownload('installer_opened');
        await waitFor(() => !document.querySelector('dialog[open] progress'));
        assert.deepEqual(requested, [releaseToken, releaseToken]);
        assert.deepEqual(externalLinks, []);
    } finally {
        await window.happyDOM.close();
    }
});
