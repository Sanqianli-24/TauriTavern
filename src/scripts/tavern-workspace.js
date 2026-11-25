import { closeCurrentChat, getCurrentChatId } from '../script.js';
import { isTopLevelDrawerOpen, subscribeDrawerState } from './drawers.js';
import { initPopupMenu } from './popup-menu.js';
import { isMobileHost } from './util/host-identity.js';
import { isWindowPortrait, subscribeWindowSnapshot } from './util/window-layout.js';
import { pushBackNavigationHandler } from '../tauri/main/services/back-navigation/back-handler-stack.js';

/** Opens the existing character tools, preserving their selection and import handlers. */
function openCharacters() {
    if (!isTopLevelDrawerOpen(document.getElementById('right-nav-panel'))) {
        document.getElementById('rightNavDrawerIcon').click();
    }
    document.getElementById('rm_button_characters').click();
}

export function initTavernWorkspace(refreshSessions) {
    const sessionToggle = document.getElementById('tt-sessions-toggle');
    const sessionPanel = document.getElementById('tt-sessions-panel');
    const toolsToggle = document.getElementById('tt-tools-toggle');
    const toolsPanel = document.getElementById('top-settings-holder');
    const sessionMenu = initPopupMenu(sessionToggle, sessionPanel, {
        onOpen: refreshSessions,
        closesOnClick: target => sessionMenu.isOpen() && Boolean(target.closest('button')),
    });

    const desktopWidth = window.matchMedia('(min-width: 840px)');
    function updateLayout() {
        const sidebar = desktopWidth.matches && (!isMobileHost() || !isWindowPortrait());
        if (sidebar && sessionMenu.isOpen()) sessionMenu.close();
        document.documentElement.classList.toggle('tt-has-sidebar', sidebar);
    }
    desktopWidth.addEventListener('change', updateLayout);
    if (isMobileHost()) subscribeWindowSnapshot(updateLayout);
    updateLayout();

    const toolsOpen = () => toolsToggle.getAttribute('aria-expanded') === 'true';
    const setToolsOpen = open => toolsToggle.setAttribute('aria-expanded', String(open));
    const closeTools = () => {
        setToolsOpen(false);
        if (document.activeElement?.closest('#top-settings-holder .drawer-toggle')) toolsToggle.focus();
    };

    toolsToggle.addEventListener('click', () => setToolsOpen(!toolsOpen()));
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (toolsOpen() && (target.closest('#top-settings-holder .drawer-toggle')
            || (!toolsPanel.contains(target) && !toolsToggle.contains(target)))) closeTools();

        switch (target.closest('[data-tt-workspace-action]')?.getAttribute('data-tt-workspace-action')) {
            case 'home':
                if (getCurrentChatId()) void closeCurrentChat();
                break;
            case 'characters':
                if (target.closest('#tt-sessions-panel, #top-bar') && isTopLevelDrawerOpen(document.getElementById('right-nav-panel'))) {
                    document.getElementById('rightNavDrawerIcon').click();
                    break;
                }
                openCharacters();
                break;
            case 'import':
                document.getElementById('character_import_button').click();
                break;
            case 'world':
                document.getElementById('WIDrawerIcon').click();
                break;
            case 'settings':
                document.querySelector('#user-settings-button .drawer-icon').click();
                break;
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !toolsOpen()
            || document.querySelector('dialog[open], #top-settings-holder .openDrawer:not(.pinnedOpen)')) return;
        closeTools();
    });

    pushBackNavigationHandler(() => {
        if (document.querySelector('dialog[open]')) return false;
        if (sessionMenu.isOpen()) {
            sessionMenu.close();
            return true;
        }
        if (!toolsOpen() || toolsPanel.querySelector('.openDrawer:not(.pinnedOpen)')) return false;
        closeTools();
        return true;
    });

    for (const [action, panel] of [['characters', 'right-nav-panel'], ['world', 'WorldInfo'], ['settings', 'user-settings-block']]) {
        const drawer = document.getElementById(panel);
        const buttons = document.querySelectorAll(`[data-tt-workspace-action="${action}"]`);
        const update = () => {
            for (const button of buttons) button.setAttribute('aria-expanded', String(isTopLevelDrawerOpen(drawer)));
        };
        for (const button of buttons) button.setAttribute('aria-controls', panel);
        subscribeDrawerState(drawer, update);
        update();
    }
}
