import { eventSource, event_types, getGeneratingModel, getMaxResponseTokens, main_api, online_status } from '../script.js';
import { isTopLevelDrawerOpen, setTopLevelDrawerOpen, subscribeDrawerState } from './drawers.js';
import { translate } from './i18n.js';
import { getChatCompletionModelControl, syncChatCompletionControlAvailability } from './openai.js';
import { Popup, POPUP_RESULT } from './popup.js';
import { power_user } from './power-user.js';
import { settingsCategories } from './settings-catalog.js';
import { indexSettingControls, revealSetting, searchSettings } from './settings-search.js';
import { runOrPopup } from './tauri/setting/setting-panel/popup-utils.js';
import { getActiveIosPolicyCapabilities } from './tauritavern/ios-policy.js';
import { isMobileHost } from './util/host-identity.js';

const sections = settingsCategories.flatMap(category => category.sections.map(section => ({ ...section, category })));
const sectionById = new Map(sections.map(section => [section.id, section]));
const home = { view: 'home' };
let controller;

function modelControls() {
    switch (main_api) {
        case 'openai': return [getChatCompletionModelControl()?.selector, '#chat_completion_source'];
        case 'novel': return ['#model_novel_select'];
        case 'koboldhorde': return ['#horde_model'];
        case 'textgenerationwebui': return [...document.querySelectorAll('#textgenerationwebui_api :is(select, input)[id*="model"]')];
        default: return ['#main_api'];
    }
}

const toControl = selector => typeof selector === 'string' ? document.querySelector(selector) : selector;

function quickSettings() {
    const connected = online_status !== 'no_connection';
    const tokens = getMaxResponseTokens();
    const number = new Intl.NumberFormat(document.documentElement.lang || undefined);
    const percent = new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'percent' });
    return [
        {
            section: 'connection', label: connected ? 'Current model' : 'Connect model', icon: 'fa-plug',
            value: connected ? String(getGeneratingModel() || online_status) : translate('Not connected'),
            targets: () => (connected ? [...modelControls(), '#main_api'] : ['#main_api']).filter(Boolean).map(toControl),
        },
        {
            section: 'presets', label: 'Reply length', icon: 'fa-ruler',
            value: tokens ? translate('{n} tokens').replace('{n}', number.format(tokens)) : '',
            targets: () => [document.getElementById(main_api === 'openai' ? 'openai_max_tokens' : 'amount_gen_counter')],
        },
        {
            section: 'reading', label: 'Font size', icon: 'fa-text-height', value: percent.format(power_user.font_scale),
            targets: () => ['#font_scale_counter', '#font_scale'].map(toControl),
        },
        {
            section: 'reading', label: 'Theme', icon: 'fa-palette', value: power_user.theme,
            targets: () => [document.getElementById('themes')],
        },
    ];
}

function sectionRoute(section, targets) {
    return { view: 'section', category: section.category, section, targets };
}

function navButton(title, { detail, icon, value } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tt-settings-link';
    if (icon) {
        const glyph = document.createElement('i');
        glyph.className = 'fa-solid ' + icon;
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph);
    }
    const text = document.createElement('span');
    text.className = 'tt-settings-link-text';
    const label = document.createElement('strong');
    label.textContent = title;
    text.append(label);
    if (detail || value) {
        const info = document.createElement('small');
        info.textContent = value || detail;
        text.append(info);
    }
    button.append(text);
    const arrow = document.createElement('i');
    arrow.className = 'fa-solid fa-chevron-right tt-settings-chevron';
    arrow.setAttribute('aria-hidden', 'true');
    button.append(arrow);
    return button;
}

export function handleSettingsDrawerToggle(panel, source) {
    return controller?.toggleDrawer(panel, source) ?? false;
}

export function initSettingsCenter() {
    const byId = id => document.getElementById(id);
    const holder = byId('top-settings-holder');
    const center = byId('tt-settings-center');
    const trigger = byId('tt-settings-toggle');
    const title = byId('tt-settings-title');
    const backButton = byId('tt-settings-back');
    const closeButton = byId('tt-settings-close');
    const search = byId('tt-settings-search');
    const rail = byId('tt-settings-rail');
    const scroll = byId('tt-settings-scroll');
    const pageTitle = byId('tt-settings-page-title');
    const list = byId('tt-settings-list');
    const noResults = byId('tt-settings-no-results');
    const content = byId('tt-settings-panels');
    const hostPanel = byId('tt-host-settings');
    const hostContent = byId('tt-host-settings-content');
    const hostStatus = byId('tt-host-settings-status');
    const retry = byId('tt-host-settings-retry');
    const syncPanel = byId('tt-settings-sync');
    const syncStatus = byId('tt-settings-sync-status');
    const syncRetry = byId('tt-settings-sync-retry');
    const saveBar = byId('tt-settings-save-bar');
    const saveButton = byId('tt-settings-save');
    const workspace = [byId('sheld'), byId('tt-sessions-panel'), byId('top-bar')];
    const panels = new Map([...new Set(sections.map(section => section.panel))].map(id => [id, byId(id)]));
    const drawerDestinations = new Map();
    const groups = [...holder.querySelectorAll('[data-tt-settings-group]')];
    const dynamicPanels = new Set([hostPanel.id, 'tt-settings-about', 'tt-settings-transfer']);
    const fields = sections.filter(section => !dynamicPanels.has(section.panel)).flatMap(section => {
        const roots = section.grouped ? groups.filter(group => group.dataset.ttSettingsGroup === section.id) : [panels.get(section.panel)];
        return roots.flatMap(root => indexSettingControls(root, section));
    });

    for (const section of sections) {
        const panel = panels.get(section.panel);
        if (!panel.classList.contains('drawer-content') || drawerDestinations.has(panel)) continue;
        drawerDestinations.set(panel, section);
        content.append(panel.closest('.drawer'));
    }

    let history = [];
    let activePanel;
    let native;
    let sync;
    let busy = false;
    let confirming = false;
    let opener;
    let highlighted;
    let focusFrame;
    const current = () => history.at(-1);
    const availableSections = () => sections.filter(section => {
        if (section.id === 'sync' && getActiveIosPolicyCapabilities()?.sync?.lan === false) return false;
        return !section.api || section.api === main_api;
    });
    title.tabIndex = -1;

    function addNavigation(parent, key, label, info, route, { replace = false } = {}) {
        const button = navButton(label, info);
        button.dataset.settingsKey = key;
        button.addEventListener('click', () => {
            if (busy || confirming) return;
            if (replace && route === home) {
                history.length = 1;
                render();
                return;
            }
            if (replace && history.length > 1) history.length = 1;
            visit(route, button);
        });
        parent.append(button);
        return button;
    }

    const railHome = addNavigation(rail, 'home', translate('Overview'), { icon: 'fa-list' }, home, { replace: true });
    const categoryButtons = new Map();
    for (const category of settingsCategories) {
        const route = categoryRoute(category);
        const button = addNavigation(rail, category.id, translate(category.title), { icon: category.icon }, route, { replace: true });
        categoryButtons.set(category.id, button);
    }

    function categoryRoute(category) {
        const matching = availableSections().filter(section => section.category === category);
        return matching.length === 1 ? sectionRoute(matching[0]) : { view: 'category', category };
    }

    function projectSaveBar() {
        saveBar.hidden = !native?.session?.isDirty();
        saveButton.disabled = busy;
        saveButton.textContent = translate(busy ? 'Saving…' : 'Save');
    }

    function activatePanel(section) {
        const next = section && panels.get(section.panel);
        const prior = activePanel;
        activePanel = next;
        if (prior && prior !== next) {
            if (drawerDestinations.has(prior)) setTopLevelDrawerOpen(prior, false);
            else prior.hidden = true;
            if (prior === syncPanel) {
                sync?.dispose?.();
                sync?.mount.remove();
                sync = null;
            }
        }
        for (const group of groups) group.hidden = group.dataset.ttSettingsGroup !== section?.id;
        if (!next) return;
        if (drawerDestinations.has(next)) setTopLevelDrawerOpen(next, true);
        else next.hidden = false;
        if (section.panel === 'left-nav-panel' && main_api === 'openai') syncChatCompletionControlAvailability(next);
        if (next === hostPanel) openNative(section);
        if (next === syncPanel) openSync();
    }

    function openSync() {
        if (sync) return;
        const mount = document.createElement('div');
        const request = { mount, dispose: null };
        sync = request;
        byId('tt-settings-sync-content').append(mount);
        syncStatus.hidden = false;
        syncStatus.textContent = translate('Loading sync…');
        syncRetry.hidden = true;
        void import('./tauri/setting/setting-panel/sync-popup.js')
            .then(({ mountSyncPanel }) => mountSyncPanel(mount))
            .then(dispose => {
                if (sync !== request) {
                    dispose();
                    return;
                }
                request.dispose = dispose;
                syncStatus.hidden = true;
            })
            .catch(error => {
                if (sync !== request) return;
                console.error('Could not open device sync', error);
                mount.remove();
                sync = null;
                syncStatus.textContent = translate('Could not load device sync.');
                syncRetry.hidden = false;
            });
    }

    function openNative(section) {
        if (native?.session) {
            native.session.setSection(section.id);
            return;
        }
        if (native) return;
        const mount = document.createElement('div');
        const request = { mount, session: null };
        native = request;
        hostContent.append(mount);
        hostStatus.hidden = false;
        hostStatus.textContent = translate('Loading settings…');
        retry.hidden = true;
        void import('./tauri/setting/setting-panel/settings-session.js')
            .then(({ mountSettingsSession }) => mountSettingsSession(mount, section.id))
            .then(session => {
                if (native !== request) {
                    session.unmount();
                    return;
                }
                request.session = session;
                hostStatus.hidden = true;
                session.subscribe(projectSaveBar);
                const route = current().route;
                if (route.section?.panel === hostPanel.id) {
                    session.setSection(route.section.id);
                    if (route.targets) focusPage(route);
                }
                projectSaveBar();
            })
            .catch(error => {
                if (native !== request) return;
                console.error('Could not open application settings', error);
                mount.remove();
                native = null;
                hostStatus.textContent = translate('Could not load application settings.');
                retry.hidden = false;
            });
    }

    function render({ restore = false, focus = true } = {}) {
        const { route, scrollTop, returnKey } = current();
        const { view, category, section } = route;
        activatePanel(section);
        center.dataset.view = view;
        if (view !== 'search' && search.value) search.value = '';
        if (view === 'search' && search.value !== route.query) search.value = route.query;
        pageTitle.hidden = view === 'home' || view === 'search';
        pageTitle.textContent = translate(section?.title ?? category?.title ?? 'Settings');
        backButton.setAttribute('aria-label', translate(history.length > 1 ? 'Back' : 'Return to chat'));
        noResults.hidden = true;
        list.className = '';
        list.replaceChildren();
        railHome.toggleAttribute('data-selected', view === 'home');
        for (const [id, button] of categoryButtons) {
            if (id === category?.id && view !== 'search') button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        }
        if (view === 'home') renderHome();
        if (view === 'category') renderSections(category);
        if (view === 'search') renderSearch(route.query);
        scroll.scrollTop = restore ? scrollTop : 0;
        if (focus && restore && returnKey) {
            const destination = [...center.querySelectorAll('[data-settings-key]')]
                .find(button => button.dataset.settingsKey === returnKey && button.getClientRects().length);
            if (destination) {
                destination.focus({ preventScroll: true });
                return;
            }
        }
        if (focus) focusPage(route);
    }

    function renderHome() {
        const heading = document.createElement('h2');
        heading.textContent = translate('Common settings');
        const quick = document.createElement('div');
        quick.className = 'tt-settings-quick';
        for (const item of quickSettings()) {
            const route = sectionRoute(sectionById.get(item.section), item.targets);
            addNavigation(quick, item.label, translate(item.label), item, route);
        }
        const categories = document.createElement('div');
        categories.className = 'tt-settings-categories';
        const categoriesTitle = document.createElement('h2');
        categoriesTitle.textContent = translate('Settings categories');
        for (const category of settingsCategories) {
            addNavigation(categories, category.id, translate(category.title), { icon: category.icon, detail: translate(category.summary) }, categoryRoute(category));
        }
        list.append(heading, quick, categoriesTitle, categories);
    }

    function renderSections(category) {
        list.className = 'tt-settings-destination-list';
        for (const section of availableSections().filter(item => item.category === category)) {
            addNavigation(list, section.id, translate(section.title), {}, sectionRoute(section));
        }
    }

    function renderSearch(query) {
        list.className = 'tt-settings-destination-list';
        const renderedFields = sections.filter(section => dynamicPanels.has(section.panel))
            .flatMap(section => {
                const panel = panels.get(section.panel);
                const group = panel.matches('#tt-host-settings') ? panel.querySelector('[data-tt-host-section="' + section.id + '"]') : panel;
                return group ? indexSettingControls(group, section) : [];
            });
        const matches = searchSettings(query, settingsCategories, [...fields, ...renderedFields], availableSections());
        noResults.hidden = matches.length > 0;
        for (const result of matches) {
            const category = result.section?.category ?? result.category;
            const route = result.section ? sectionRoute(result.section, result.targets) : categoryRoute(category);
            addNavigation(list, (result.section?.id ?? category.id) + ':' + result.title, result.title,
                { detail: translate(result.section ? (result.targets ? result.section.title : category.title) : category.summary) }, route);
        }
    }

    function focusPage(route) {
        cancelAnimationFrame(focusFrame);
        highlighted?.classList.remove('tt-setting-focused');
        highlighted = null;
        const heading = route.view === 'home' ? title : route.view === 'search' ? search : pageTitle;
        heading.focus({ preventScroll: true });
        if (!route.targets) return;
        focusFrame = requestAnimationFrame(() => {
            if (current()?.route !== route) return;
            const targets = typeof route.targets === 'function' ? route.targets() : route.targets;
            const target = revealSetting(targets, activePanel);
            if (!target) return;
            target.scrollIntoView({ block: 'center' });
            if (!isMobileHost()) target.focus({ preventScroll: true });
            target.classList.add('tt-setting-focused');
            highlighted = target;
        });
    }

    function visit(route, source) {
        if (busy || confirming) return;
        if (!current()) {
            opener = source?.getClientRects().length ? source : trigger;
            holder.classList.add('tt-settings-active');
            center.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            for (const element of workspace) element.inert = true;
            for (const other of holder.querySelectorAll(':scope > .drawer > .openDrawer:not(.pinnedOpen)')) {
                setTopLevelDrawerOpen(other, false);
            }
            history.push({ route: home, scrollTop: 0 });
        }
        if (current().route !== route) {
            current().scrollTop = scroll.scrollTop;
            current().returnKey = source?.dataset.settingsKey;
            history.push({ route, scrollTop: 0 });
        }
        render();
    }

    async function close() {
        if (!current() || busy || confirming) return;
        if (native?.session?.isDirty()) {
            confirming = true;
            try {
                const result = await Popup.show.confirm(translate('Close without saving?'), '', {
                    okButton: translate('Discard changes'),
                    cancelButton: translate('Keep editing'),
                });
                if (result !== POPUP_RESULT.AFFIRMATIVE) return;
            } finally {
                confirming = false;
            }
        }
        activatePanel();
        cancelAnimationFrame(focusFrame);
        highlighted?.classList.remove('tt-setting-focused');
        highlighted = null;
        native?.session?.unmount();
        native?.mount.remove();
        native = null;
        center.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        holder.classList.remove('tt-settings-active');
        for (const element of workspace) element.inert = false;
        history = [];
        (opener?.getClientRects().length ? opener : trigger).focus({ preventScroll: true });
    }

    function back() {
        if (busy || confirming) return;
        if (history.length > 1) {
            history.pop();
            render({ restore: true });
        } else runOrPopup(close);
    }

    function consumeBack() {
        if (!current() || document.querySelector('dialog[open]')) return false;
        const select = center.querySelector('select.select2-hidden-accessible:has(+ .select2-container--open)');
        if (select) $(select).select2('close');
        else back();
        return true;
    }

    trigger.addEventListener('click', () => visit(home, trigger));
    backButton.addEventListener('click', back);
    closeButton.addEventListener('click', () => runOrPopup(close));
    center.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !consumeBack()) return;
        event.preventDefault();
        event.stopPropagation();
    });
    search.addEventListener('input', () => {
        if (busy || confirming || !current()) return;
        const query = search.value.trim();
        if (current().route.view === 'search') {
            if (!query) {
                history.pop();
                render({ restore: true, focus: false });
                return;
            }
            current().route = { view: 'search', query: search.value };
        } else if (query) {
            current().scrollTop = scroll.scrollTop;
            history.push({ route: { view: 'search', query: search.value }, scrollTop: 0 });
        }
        render({ focus: false });
    });
    retry.addEventListener('click', () => openNative(current().route.section));
    saveButton.addEventListener('click', () => runOrPopup(async () => {
        if (busy || !native?.session?.isDirty()) return;
        busy = true;
        scroll.inert = true;
        projectSaveBar();
        try {
            await native.session.save();
        } finally {
            busy = false;
            scroll.inert = false;
            projectSaveBar();
            (saveBar.hidden ? (pageTitle.hidden ? title : pageTitle) : saveButton).focus({ preventScroll: true });
        }
    }));
    syncRetry.addEventListener('click', openSync);
    byId('tt-settings-extension-shortcuts').addEventListener('click', () => runOrPopup(async () => {
        const { openExtensionMenuShortcutsManager } = await import('./tauri/setting/extension-menu-shortcuts.js');
        await openExtensionMenuShortcutsManager();
    }));

    for (const [panel, section] of drawerDestinations) {
        subscribeDrawerState(panel, () => {
            const open = isTopLevelDrawerOpen(panel);
            if (open && activePanel !== panel) visit(sectionRoute(section));
            if (!open && activePanel === panel) back();
        });
    }
    for (const event of [event_types.ONLINE_STATUS_CHANGED, event_types.CHATCOMPLETION_MODEL_CHANGED, event_types.SETTINGS_UPDATED]) {
        eventSource.on(event, () => {
            if (current()?.route.view === 'home') {
                const focused = document.activeElement;
                if (!list.contains(focused)) render({ restore: true, focus: false });
            }
        });
    }

    controller = {
        consumeBack,
        toggleDrawer(panel, source) {
            const section = drawerDestinations.get(panel);
            if (!section) return false;
            if (activePanel === panel) back();
            else visit(sectionRoute(section), source);
            return true;
        },
    };
    return controller;
}
