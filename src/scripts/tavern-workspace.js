import { closeCurrentChat, getCurrentChatId } from '../script.js';
import { isTopLevelDrawerOpen, subscribeDrawerState } from './drawers.js';
import { initPopupMenu } from './popup-menu.js';
import { initSettingsCenter } from './tavern-settings.js';
import { isMobileHost } from './util/host-identity.js';
import { isWindowPortrait, subscribeWindowSnapshot } from './util/window-layout.js';
import { pushBackNavigationHandler } from '../tauri/main/services/back-navigation/back-handler-stack.js';

export function initTavernWorkspace(refreshSessions) {
    const sessionToggle = document.getElementById('tt-sessions-toggle');
    const sessionPanel = document.getElementById('tt-sessions-panel');
    const sessionMenu = initPopupMenu(sessionToggle, sessionPanel, {
        onOpen: refreshSessions,
        closesOnClick: target => sessionMenu.isOpen() && Boolean(target.closest('button')),
    });
    const settings = initSettingsCenter();

    const desktopWidth = window.matchMedia('(min-width: 840px)');
    function updateLayout() {
        const sidebar = desktopWidth.matches && (!isMobileHost() || !isWindowPortrait());
        if (sidebar && sessionMenu.isOpen()) sessionMenu.close();
        document.documentElement.classList.toggle('tt-has-sidebar', sidebar);
    }
    desktopWidth.addEventListener('change', updateLayout);
    if (isMobileHost()) subscribeWindowSnapshot(updateLayout);
    updateLayout();

    const drawers = new Map([
        ['characters', ['right-nav-panel', '#rightNavDrawerIcon']],
        ['persona', ['PersonaManagement', '#persona-management-button .drawer-toggle']],
        ['world', ['WorldInfo', '#WIDrawerIcon']],
        ['assistant', ['tt-assistant-panel', '#tt-assistant-drawer .drawer-toggle']],
    ].map(([id, [panelId, selector]]) => [id, {
        panel: document.getElementById(panelId),
        toggle: document.querySelector(selector),
    }]));

    for (const [action, { panel }] of drawers) {
        const buttons = document.querySelectorAll('[data-tt-workspace-action="' + action + '"]');
        const update = () => {
            for (const button of buttons) button.setAttribute('aria-expanded', String(isTopLevelDrawerOpen(panel)));
        };
        for (const button of buttons) button.setAttribute('aria-controls', panel.id);
        subscribeDrawerState(panel, update);
        update();
    }

    document.addEventListener('click', event => {
        const button = event.target.closest?.('[data-tt-workspace-action]');
        if (!button) return;
        const action = button.dataset.ttWorkspaceAction;
        if (action === 'home' && getCurrentChatId()) {
            void closeCurrentChat();
        } else if (action === 'import') {
            document.getElementById('character_import_button').click();
        } else if (drawers.has(action)) {
            const { panel, toggle } = drawers.get(action);
            const alreadyOpen = isTopLevelDrawerOpen(panel);
            if (!alreadyOpen || button.closest('#tt-sessions-panel, #top-bar')) toggle.click();
            if (action === 'characters' && (!alreadyOpen || !button.closest('#tt-sessions-panel, #top-bar'))) {
                document.getElementById('rm_button_characters').click();
            }
        }
    });

    pushBackNavigationHandler(() => {
        if (document.querySelector('dialog[open]')) return false;
        if (settings.consumeBack()) return true;
        if (!sessionMenu.isOpen()) return false;
        sessionMenu.close();
        return true;
    });
}
