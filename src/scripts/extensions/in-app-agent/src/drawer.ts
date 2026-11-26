import { tr } from './i18n';

export type DrawerState = {
    isTopLevelDrawerOpen: (panel: HTMLElement) => boolean;
    subscribeDrawerState: (panel: HTMLElement, listener: () => void) => () => void;
};

export function installAssistantDrawer(drawers: DrawerState) {
    const panel = document.getElementById('tt-assistant-panel');
    const toggle = document.querySelector<HTMLElement>('#tt-assistant-drawer .drawer-toggle');
    const entry = document.getElementById('tt-assistant-entry');
    const status = document.getElementById('tt-assistant-activity');
    if (!panel || !toggle || !entry || !status) throw new Error('in-app-agent: Assistant drawer is unavailable');
    const mount = document.createElement('div');
    mount.id = 'tt-assistant';
    panel.append(mount);
    entry.hidden = false;

    return {
        mount,
        getSnapshot: () => drawers.isTopLevelDrawerOpen(panel),
        subscribe: (listener: () => void) => drawers.subscribeDrawerState(panel, listener),
        close() {
            if (!drawers.isTopLevelDrawerOpen(panel)) return;
            const restoreFocus = panel.contains(document.activeElement);
            toggle.click();
            if (restoreFocus) {
                const target = entry.getClientRects().length ? entry : document.getElementById('tt-sessions-toggle');
                target?.focus({ preventScroll: true });
            }
        },
        setActivity(activity: 'working' | 'unread' | '') {
            if (activity) entry.dataset.ttAssistantActivity = activity;
            else delete entry.dataset.ttAssistantActivity;
            status.textContent = activity ? tr(activity === 'working' ? 'workingBadge' : 'newReply') : '';
        },
        dispose() {
            entry.hidden = true;
            delete entry.dataset.ttAssistantActivity;
            status.textContent = '';
            mount.remove();
        },
    };
}
export type AssistantDrawer = ReturnType<typeof installAssistantDrawer>;
