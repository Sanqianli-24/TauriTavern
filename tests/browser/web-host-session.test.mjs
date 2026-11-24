import assert from 'node:assert/strict';
import test from 'node:test';
import { waitFor } from '@testing-library/dom';
import { captureBrowserErrors, createBrowserRuntime } from './runtime.mjs';
import { HOSTS } from '../helpers/host-identity.mjs';

async function openSession(options) {
    const runtime = await createBrowserRuntime(options);
    const { window, load, getModule, startHost } = runtime;
    const { errors, failed } = captureBrowserErrors(window);
    try {
        await startHost();
        const main = (await load('script.js')).namespace;
        const { eventSource, event_types } = getModule('scripts/events.js').namespace;
        const ready = new Promise(resolve => eventSource.once(event_types.APP_READY, resolve));
        const extensionsLoaded = new Promise(resolve => eventSource.once(event_types.EXTENSION_SETTINGS_LOADED, resolve));
        const saved = new Promise(resolve => eventSource.once(event_types.SETTINGS_UPDATED, resolve));
        window.jQuery.holdReady(false);
        await Promise.race([Promise.all([ready, saved, extensionsLoaded]), failed]);
        assert.equal(window.document.getElementById('extensions_details').classList.contains('warning'), false);
        assert.equal(window.webHostFixtureActivated, true);
        return { ...runtime, main, errors, failed };
    } catch (error) {
        await window.happyDOM.close();
        throw error;
    }
}

for (const identity of [HOSTS.windows, HOSTS.android]) {
    test(`Web Host preserves ${identity.kind} session edits and replayed replies across reload`, async () => {
        const first = await openSession({ identity });
        const { window, fixture, main, getModule } = first;
        const invoke = window.__TAURI__.core.invoke;
        try {
            getModule('scripts/extensions.js').namespace.extension_settings.webHostSession = { enabled: true };
            assert.equal(await main.saveSettings(), true);
            await invoke('update_tauritavern_settings', { dto: { dynamic_theme: { day_theme: 'Dark Lite' } } });
            await invoke('update_tauritavern_settings', { dto: { dynamic_theme: { night_theme: 'Dark Lite' } } });
            await window.fetch('/api/themes/save', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Session theme', blur_strength: 17 }),
            });
            main.chat_metadata.variables = { score: 7 };
            await main.saveMetadata();
            const transport = getModule('scripts/tauri/chat/transport.js').namespace;
            await assert.rejects(transport.saveCharacterChatMetadata({
                avatarUrl: 'Review.png', fileName: 'review-chat', chatMetadata: { integrity: 'stale' },
            }), error => error.code === 'integrity');
            const card = JSON.parse(JSON.parse(fixture.backend.handle({ method: 'POST', url: '/api/characters/get', headers: {}, body: '{}' }).body).json_data);
            card.data.extensions.tavern_helper = { scripts: [{ id: 'script', content: 'console.log(1)' }], variables: { rank: 2 } };
            window.jQuery('#character_json_data').val(JSON.stringify(card));
            await Promise.race([main.createOrEditCharacter(), first.failed]);
            await getModule('scripts/extensions.js').namespace.writeExtensionField(0, 'merged', true);
            const quickReply = window.quickReplyApi.getSetByName('Review QR');
            quickReply.qrList[0].message = 'A saved quick reply';
            await quickReply.save();
            await Promise.race([window.jQuery('#api_button_openai').triggerHandler('click'), first.failed]);
            assert.notEqual(main.online_status, 'no_connection');
            window.jQuery('#send_textarea').val('Continue the story');
            await Promise.race([main.sendTextareaMessage(), first.failed]);
            await main.waitForGenerationIdle();
            assert.ok(main.chat.some(message => message.is_user && message.mes === 'Continue the story'));
            assert.equal(main.chat.at(-1).mes, 'A replayed reply.');

            const saved = fixture.chatFiles.get('review-chat');
            const corrupted = '{truncated header\n' + saved.split('\n').slice(1).join('\n');
            fixture.chatFiles.set('review-chat', corrupted);
            const repair = { avatarUrl: 'Review.png', fileName: 'review-chat', payload: saved.split('\n').map(line => JSON.parse(line)) };
            await assert.rejects(transport.saveCharacterChatPayload(repair), /400.*integrity/);
            assert.equal(fixture.chatFiles.get('review-chat'), corrupted);
            await transport.saveCharacterChatPayload({ ...repair, force: true });
            await Promise.race([first.host.exit(), first.failed]);
            assert.deepEqual(first.errors, []);
        } finally { await window.happyDOM.close(); }

        const second = await openSession({ identity, fixture });
        try {
            assert.equal(second.main.chat.at(-1).mes, 'A replayed reply.');
            assert.equal(second.main.chat_metadata.variables.score, 7);
            const settings = JSON.parse(JSON.parse(fixture.backend.handle({ method: 'POST', url: '/api/settings/get', headers: {}, body: '{}' }).body).settings);
            assert.deepEqual(settings.extension_settings.webHostSession, { enabled: true });
            const stored = await second.window.__TAURI__.core.invoke('get_tauritavern_settings');
            assert.equal(stored.dynamic_theme.day_theme, 'Dark Lite');
            assert.equal(stored.dynamic_theme.night_theme, 'Dark Lite');
            const response = JSON.parse(fixture.backend.handle({ method: 'POST', url: '/api/settings/get', headers: {}, body: '{}' }).body);
            assert.equal(response.themes.find(theme => theme.name === 'Session theme').blur_strength, 17);
            const card = JSON.parse(fixture.backend.handle({ method: 'POST', url: '/api/characters/get', headers: {}, body: '{}' }).body);
            assert.deepEqual(card.data.extensions.tavern_helper, { scripts: [{ id: 'script', content: 'console.log(1)' }], variables: { rank: 2 } });
            assert.equal(card.data.extensions.merged, true);
            assert.equal(second.window.quickReplyApi.getSetByName('Review QR').qrList[0].message, 'A saved quick reply');
            assert.deepEqual(second.errors, []);
        } finally { await second.window.happyDOM.close(); }
    });
}

test('Web Host stream reads replay an unacknowledged cursor and cancellation releases a blocked read', async context => {
    const { window, fixture } = await createBrowserRuntime();
    context.after(() => window.happyDOM.close());
    const handle = fixture.backend.handle.bind(fixture.backend);
    const cancelled = Promise.withResolvers();
    let producer;
    fixture.backend.handle = request => request.url === '/api/backends/chat-completions/generate'
        ? { status: 200, headers: { 'content-type': 'text/event-stream' }, body: new ReadableStream({
            start(controller) { producer = controller; },
            cancel() { cancelled.resolve(); },
        }) }
        : handle(request);
    const invoke = window.__TAURI__.core.invoke;
    await invoke('start_chat_completion_stream', { streamId: 'replay', dto: {} });
    const first = invoke('read_chat_completion_stream', { streamId: 'replay', afterSeq: 0 });
    producer.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
    const batch = await first;
    assert.equal(batch.events[0].seq, 1);
    assert.equal(batch.events[0].data, '{"choices":[]}');
    assert.deepEqual(await invoke('read_chat_completion_stream', { streamId: 'replay', afterSeq: 0 }), batch);
    const blocked = invoke('read_chat_completion_stream', { streamId: 'replay', afterSeq: 1 });
    await invoke('close_chat_completion_stream', { streamId: 'replay' });
    assert.equal((await blocked).status, 'cancelled');
    await cancelled.promise;
});

test('Extension management keeps the update target and bulk changes when the tablet list is filtered', async context => {
    const { window, fixture, getModule } = await openSession({ identity: HOSTS.android });
    context.after(() => window.happyDOM.close());
    const extensions = getModule('scripts/extensions.js').namespace;
    const { Popup } = getModule('scripts/popup.js').namespace;
    const installed = 'third-party/web-host-fixture';
    const other = 'third-party/another-extension';
    const versionStarted = Promise.withResolvers();
    const versionReady = Promise.withResolvers();
    const updateStarted = Promise.withResolvers();
    const updateReady = Promise.withResolvers();
    const versionRequests = [];
    let hasUpdate = true;
    let reloads = 0;
    window.location.reload = () => { reloads++; };

    const fetch = window.fetch.bind(window);
    const respond = data => new window.Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    window.fetch = async (url, options) => {
        if (url === '/api/extensions/discover') {
            const existing = await (await fetch(url, options)).json();
            return respond([...existing, { name: other, type: 'local' }]);
        }
        if (url === '/scripts/extensions/' + other + '/manifest.json') {
            return respond({ display_name: 'Another extension', loading_order: 200 });
        }
        if (url === '/api/extensions/version') {
            const name = JSON.parse(options.body).extensionName;
            versionRequests.push({ name, signal: options.signal });
            versionStarted.resolve();
            await versionReady.promise;
            return respond({ isUpToDate: name !== '/web-host-fixture' || !hasUpdate, currentBranchName: 'main', currentCommitHash: '123456789' });
        }
        if (url === '/api/extensions/update') {
            updateStarted.resolve(JSON.parse(options.body));
            await updateReady.promise;
            hasUpdate = false;
            return respond({ isUpToDate: false, shortCommitHash: '1234567' });
        }
        return fetch(url, options);
    };

    await extensions.startOfflineExtensionsDiscovery({ forceRefresh: true });
    const closed = window.jQuery('#extensions_details').triggerHandler('click');
    await versionStarted.promise;
    const manager = Popup.util.popups.at(-1);
    const control = id => manager.dlg.querySelector('#extension_manager_' + id);
    const enterSearch = value => {
        control('search').value = value;
        control('search').dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    enterSearch('web-host-fixture');
    assert.equal(control('name').textContent, 'Web Host fixture', 'the list is usable before version checks complete');
    control('sort').value = 'name';
    control('sort').dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(Popup.util.popups.at(-1), manager);
    assert.equal(control('search').value, 'web-host-fixture');
    assert.equal(versionRequests.length, 2, 'query and sort reuse the existing requests');

    control('toggle_all').click();
    enterSearch('another-extension');
    assert.equal(control('name').textContent, 'Another extension');
    assert.equal(control('toggle').checked, false, 'bulk toggle included an item hidden by the search');
    assert.equal(extensions.extension_settings.disabledExtensions.includes(other), false, 'the bulk change is pending');
    control('restore_toggles').click();
    assert.equal(control('toggle').checked, true);
    control('toggle_all').click();

    enterSearch('web-host-fixture');
    versionReady.resolve();
    await waitFor(() => assert.equal(control('update').hidden, false), { container: manager.dlg });
    control('update').click();
    assert.deepEqual(await updateStarted.promise, { extensionName: '/web-host-fixture', global: false });
    enterSearch('another-extension');
    updateReady.resolve();
    await waitFor(() => assert.equal(control('install').hasAttribute('aria-disabled'), false), { container: manager.dlg });
    assert.equal(Popup.util.popups.at(-1), manager);
    assert.equal(control('name').textContent, 'Another extension');
    assert.equal(control('toggle').checked, false, 'updating a different extension preserves the pending bulk change');
    assert.deepEqual(versionRequests.map(request => request.name).sort(), ['/another-extension', '/web-host-fixture', '/web-host-fixture']);

    await manager.completeAffirmative();
    await closed;
    assert.equal(reloads, 1);
    assert.ok(versionRequests.every(request => request.signal.aborted));
    const response = fixture.backend.handle({ method: 'POST', url: '/api/settings/get', headers: {}, body: '{}' });
    const saved = JSON.parse(JSON.parse(response.body).settings);
    assert.ok(saved.extension_settings.disabledExtensions.includes(installed));
    assert.ok(saved.extension_settings.disabledExtensions.includes(other));
});
