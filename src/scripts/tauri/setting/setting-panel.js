import { eventSource, event_types } from '../../events.js';
import { installPairingListener } from './setting-panel/pairing-listener.js';
import { installSyncListeners } from './setting-panel/sync-listeners.js';

export async function installTauriTavernSettingsPanel() {
    const appReady = new Promise(resolve => eventSource.once(event_types.APP_READY, resolve));
    void Promise.all([installPairingListener(appReady), installSyncListeners(appReady)])
        .catch(error => console.error('Failed to install sync and pairing listeners:', error));

    await appReady;
    void import('./extension-menu-shortcuts.js')
        .then(({ renderExtensionMenuShortcuts }) => renderExtensionMenuShortcuts())
        .catch(error => console.error('Failed to install TauriTavern quick access menu:', error));

}
