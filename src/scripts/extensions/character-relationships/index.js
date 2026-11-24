import { getCurrentLocale, translate } from '../../i18n.js';
import { oai_settings } from '../../openai.js';
import { Popup, POPUP_TYPE } from '../../popup.js';
import { openKeyManagerDialog, secret_state, SECRET_KEYS } from '../../secrets.js';

const buttonId = 'tt_character_relationships';
const title = () => translate('Character relationships', 'character_relationships.title');

function hasDeepSeekKey() {
    return secret_state[SECRET_KEYS.DEEPSEEK]?.some(secret => secret.active) ?? false;
}

async function openRelationships(avatar) {
    const api = window.__TAURITAVERN__?.api?.characterCards?.relationships;
    if (!api) throw new Error('TauriTavern character relationship API is unavailable.');

    const { mountCharacterRelationships } = await import('./dist/index.bundle.js');
    const model = oai_settings.deepseek_model;
    const locale = getCurrentLocale();
    const container = document.createElement('div');
    const popup = new Popup(container, POPUP_TYPE.TEXT, '', {
        label: title(),
        wider: true,
        large: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        okButton: translate('Close'),
    });
    const unmount = mountCharacterRelationships(container, {
        model,
        hasKey: hasDeepSeekKey(),
        locale,
        translate,
        load: () => api.load(avatar),
        generate: includeLorebook => api.generate(avatar, { model, locale, includeLorebook }),
        manageKey: async () => {
            await openKeyManagerDialog(SECRET_KEYS.DEEPSEEK);
            return hasDeepSeekKey();
        },
    });
    try {
        await popup.show();
    } finally {
        unmount();
    }
}

function mountButton() {
    const anchor = document.getElementById('char_connections_button');
    if (!anchor || document.getElementById(buttonId)) return;

    const button = document.createElement('button');
    button.id = buttonId;
    button.type = 'button';
    button.className = 'menu_button fa-solid fa-diagram-project';
    button.title = title();
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-haspopup', 'dialog');
    let opening = false;
    button.addEventListener('click', async () => {
        const form = button.closest('form');
        const avatar = document.getElementById('avatar_url_pole')?.value;
        if (opening || !avatar || form?.getAttribute('actiontype') !== 'editcharacter') return;

        opening = true;
        try {
            await openRelationships(avatar);
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : String(error), title());
        } finally {
            opening = false;
        }
    });
    anchor.after(button);
}

mountButton();
