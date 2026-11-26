import { Popper, getHljs } from '../lib.js';

import { eventSource, event_types, saveSettings, saveSettingsDebounced, getRequestHeaders, animation_duration, CLIENT_VERSION } from '../script.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { renderTemplate, renderTemplateAsync } from './templates.js';
import { delay, deleteValueByPath, equalsIgnoreCaseAndAccents, escapeHtml, isSubsetOf, sanitizeSelector, setValueByPath, versionCompare } from './utils.js';
import { getContext } from './st-context.js';
import { isAdmin } from './user.js';
import { addLocaleData, getCurrentLocale, t, translate } from './i18n.js';
import { debounce_timeout } from './constants.js';
import { accountStorage } from './util/AccountStorage.js';
import { stripCommandErrorPrefixes } from './util/command-error-utils.js';
import { toUserFacingErrorText } from './util/user-facing-error.js';
import { SimpleMutex } from './util/SimpleMutex.js';
import { initPopupMenu } from './popup-menu.js';
import { keepFocus } from './dom-handlers.js';
import { isControlDisabled } from './legacy-controls.js';
import { createThirdPartyStylesheetResolver } from './extensions/runtime/third-party-runtime.js';
import { createExtensionAssetLoader } from './extensions/runtime/asset-loader.js';
import { getExtensionResourceUrl, isThirdPartyExtension } from './extensions/runtime/resource-paths.js';

export {
    getContext,
    getApiUrl,
    SimpleMutex as ModuleWorkerWrapper,
};

/** @type {string[]} */
export let extensionNames = [];

/**
 * Holds the type of each extension.
 * Don't use this directly, use getExtensionType instead!
 * @type {Record<string, string>}
 */
export let extensionTypes = {};

/**
 * A list of active modules provided by the Extras API.
 * @type {string[]}
 */
export let modules = [];

/**
 * A set of active extensions.
 * @type {Set<string>}
 */
const activeExtensions = new Set();

/**
 * Load errors by extension name.
 * @type {Map<string, string>}
 */
const extensionLoadErrors = new Map();
const thirdPartyStylesheetResolver = createThirdPartyStylesheetResolver();
const extensionAssetLoader = createExtensionAssetLoader({
    sanitizeSelector,
    getExtensionResourceUrl,
    isThirdPartyExtension,
    resolveThirdPartyStylesheetUrl: thirdPartyStylesheetResolver.resolveStylesheetUrl,
});
const addExtensionScript = extensionAssetLoader.addExtensionScript;
const addExtensionStyle = extensionAssetLoader.addExtensionStyle;
let thirdPartyHljsPromise = null;

const getApiUrl = () => extension_settings.apiUrl;
const sortManifestsByOrder = (a, b) => parseInt(a.loading_order) - parseInt(b.loading_order) || String(a.display_name).localeCompare(String(b.display_name));
const sortManifestsByName = (a, b) => String(a.display_name).localeCompare(String(b.display_name)) || parseInt(a.loading_order) - parseInt(b.loading_order);
let connectedToApi = false;

/**
 * Holds manifest data for each extension.
 * @type {Record<string, object>}
 */
let manifests = {};
let offlineExtensionsDiscoveryPromise = null;
let offlineExtensionsPreparationPromise = null;
let offlineExtensionsDiscoveryGeneration = 0;

/**
 * Default URL for the Extras API.
 */
const defaultUrl = 'http://localhost:5100';

/**
 * Checks if the extension is officially supported by its URL pattern.
 * @param {string} url URL to check
 * @returns {boolean} True if the URL matches the pattern, false otherwise (or not a valid URL)
 */
export const isOfficialExtension = (url) => {
    try {
        return /^https:\/\/github\.com\/SillyTavern\/(.+)$/i.test(new URL(url).href);
    } catch (e) {
        return false;
    }
};

let requiresReload = false;
let stateChanged = false;
let saveMetadataTimeout = null;

export function cancelDebouncedMetadataSave() {
    if (saveMetadataTimeout) {
        console.debug('Debounced metadata save cancelled');
        clearTimeout(saveMetadataTimeout);
        saveMetadataTimeout = null;
    }
}

export function saveMetadataDebounced() {
    const context = getContext();
    const groupId = context.groupId;
    const characterId = context.characterId;

    cancelDebouncedMetadataSave();

    saveMetadataTimeout = setTimeout(async () => {
        const newContext = getContext();

        if (groupId !== newContext.groupId) {
            console.warn('Group changed, not saving metadata');
            return;
        }

        if (characterId !== newContext.characterId) {
            console.warn('Character changed, not saving metadata');
            return;
        }

        console.debug('Saving metadata...');
        await newContext.saveMetadata();
        console.debug('Saved metadata...');
    }, debounce_timeout.relaxed);
}

/**
 * Provides an ability for extensions to render HTML templates synchronously.
 * Templates sanitation and localization is forced.
 * @param {string} extensionName Extension name
 * @param {string} templateId Template ID
 * @param {object} templateData Additional data to pass to the template
 * @returns {string} Rendered HTML
 *
 * @deprecated Use renderExtensionTemplateAsync instead.
 */
export function renderExtensionTemplate(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplate(
        getExtensionResourceUrl(extensionName, `${templateId}.html`),
        templateData,
        sanitize,
        localize,
        true,
    );
}

/**
 * Provides an ability for extensions to render HTML templates asynchronously.
 * Templates sanitation and localization is forced.
 * @param {string} extensionName Extension name
 * @param {string} templateId Template ID
 * @param {object} templateData Additional data to pass to the template
 * @returns {Promise<string>} Rendered HTML
 */
export function renderExtensionTemplateAsync(extensionName, templateId, templateData = {}, sanitize = true, localize = true) {
    return renderTemplateAsync(
        getExtensionResourceUrl(extensionName, `${templateId}.html`),
        templateData,
        sanitize,
        localize,
        true,
    );
}

export const extension_settings = {
    apiUrl: defaultUrl,
    apiKey: '',
    autoConnect: false,
    notifyUpdates: false,
    disabledExtensions: [],
    expressionOverrides: [],
    memory: {},
    note: {
        default: '',
        chara: [],
        wiAddition: [],
    },
    caption: {
        refine_mode: false,
    },
    expressions: {
        /** @type {number} see `EXPRESSION_API` */
        api: undefined,
        /** @type {string[]} */
        custom: [],
        showDefault: false,
        translate: false,
        /** @type {string} */
        fallback_expression: undefined,
        /** @type {string} */
        llmPrompt: undefined,
        allowMultiple: true,
        rerollIfSame: false,
        promptType: 'raw',
    },
    connectionManager: {
        selectedProfile: '',
        selectedItem: null,
        /** @type {import('./extensions/connection-manager/index.js').ConnectionProfile[]} */
        profiles: [],
        /** @type {import('./extensions/connection-manager/index.js').LlmModelTarget[]} */
        modelTargets: [],
    },
    dice: {},
    /** @type {import('./char-data.js').RegexScriptData[]} */
    regex: [],
    /** @type {import('./extensions/regex/index.js').RegexPreset[]} */
    regex_presets: [],
    /** @type {string[]} */
    character_allowed_regex: [],
    /** @type {Record<string, string[]>} */
    preset_allowed_regex: {},
    tts: {},
    sd: {
        prompts: {},
        character_prompts: {},
        character_negative_prompts: {},
    },
    chromadb: {},
    translate: {},
    objective: {},
    quickReply: {},
    randomizer: {
        controls: [],
        fluctuation: 0.1,
        enabled: false,
    },
    speech_recognition: {},
    rvc: {},
    hypebot: {},
    vectors: {},
    variables: {
        global: {},
    },
    /**
     * @type {import('./chats.js').FileAttachment[]}
     */
    attachments: [],
    /**
     * @type {Record<string, import('./chats.js').FileAttachment[]>}
     */
    character_attachments: {},
    /**
     * @type {string[]}
     */
    disabled_attachments: [],
    gallery: {
        /** @type {{[characterKey: string]: string}} */
        folders: {},
        /** @type {string} */
        sort: 'dateAsc',
    },
    code_render: {
        enabled: false,
        replace_last_message_by_default: false,
    },
};

export function showHideExtensionsMenu() {
    // Get the number of menu items that are not hidden
    const hasMenuItems = $('#extensionsMenu').children().filter((_, child) => $(child).css('display') !== 'none').length > 0;

    // We have menu items, so we can stop checking
    if (hasMenuItems) {
        clearInterval(menuInterval);
    }

    // Show or hide the menu button
    $('#extensionsMenuButton').toggle(hasMenuItems);
}

// Periodically check for new extensions
const menuInterval = setInterval(showHideExtensionsMenu, 1000);

/**
 * Gets the type of an extension based on its external ID.
 * @param {string} externalId External ID of the extension (excluding or including the leading 'third-party/')
 * @returns {string} Type of the extension (global, local, system, or empty string if not found)
 */
function getExtensionType(externalId) {
    const id = Object.keys(extensionTypes).find(id => id === externalId || (id.startsWith('third-party') && id.endsWith(externalId)));
    return id ? extensionTypes[id] : '';
}

function isSystemExtension(name) {
    return getExtensionType(name) === 'system';
}

function isDeferredThirdPartyExtension(name) {
    const type = getExtensionType(name);
    return type === 'local' || type === 'global';
}

function hasPendingDeferredThirdPartyActivation() {
    return extensionNames.some((name) =>
        isDeferredThirdPartyExtension(name)
        && !extension_settings.disabledExtensions.includes(name)
        && !activeExtensions.has(name),
    );
}

/**
 * Performs a fetch of the Extras API.
 * @param {string|URL} endpoint Extras API endpoint
 * @param {RequestInit} args Request arguments
 * @returns {Promise<Response>} Response from the fetch
 */
export async function doExtrasFetch(endpoint, args = {}) {
    if (!args) {
        args = {};
    }

    if (!args.method) {
        Object.assign(args, { method: 'GET' });
    }

    if (!args.headers) {
        args.headers = {};
    }

    if (extension_settings.apiKey) {
        Object.assign(args.headers, {
            'Authorization': `Bearer ${extension_settings.apiKey}`,
        });
    }

    return await fetch(endpoint, args);
}

/**
 * Discovers extensions from the API.
 * @returns {Promise<{name: string, type: string}[]>}
 */
async function discoverExtensions() {
    const response = await fetch('/api/extensions/discover');
    if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Extension discovery failed: HTTP ${response.status}`);
    }

    return response.json();
}

export function startOfflineExtensionsDiscovery({ forceRefresh = false } = {}) {
    if (forceRefresh) {
        offlineExtensionsDiscoveryPromise = null;
        offlineExtensionsDiscoveryGeneration += 1;
    }

    if (offlineExtensionsDiscoveryPromise) {
        return offlineExtensionsDiscoveryPromise;
    }

    const generation = offlineExtensionsDiscoveryGeneration;
    offlineExtensionsDiscoveryPromise = (async () => {
        const extensions = await discoverExtensions();
        const nextManifests = await getManifests(extensions.map(x => x.name));
        if (generation !== offlineExtensionsDiscoveryGeneration) {
            return offlineExtensionsDiscoveryPromise ?? [];
        }

        const availableExtensions = extensions.filter(x => Object.hasOwn(nextManifests, x.name));
        extensionNames = availableExtensions.map(x => x.name);
        extensionTypes = Object.fromEntries(availableExtensions.map(x => [x.name, x.type]));
        manifests = nextManifests;
        return availableExtensions;
    })();

    return offlineExtensionsDiscoveryPromise;
}

async function prepareOfflineExtensionsActivation({
    versionChanged = false,
    enableAutoUpdate = false,
    forceRefresh = false,
} = {}) {
    if (forceRefresh) {
        offlineExtensionsPreparationPromise = null;
    }

    if (offlineExtensionsPreparationPromise) {
        return offlineExtensionsPreparationPromise;
    }

    offlineExtensionsPreparationPromise = (async () => {
        const uiReady = ensureExtensionsUiReady();

        extensionLoadErrors.clear();
        await eventSource.emit(event_types.EXTENSIONS_FIRST_LOAD);
        await startOfflineExtensionsDiscovery({ forceRefresh });

        if (versionChanged && enableAutoUpdate) {
            await autoUpdateExtensions(false);
        }

        await uiReady;
    })();

    return offlineExtensionsPreparationPromise;
}

/**
 * Checks whether an extension has a specific hook defined in its manifest.
 * @param {string} name Extension name (with or without 'third-party' prefix)
 * @param {'install' | 'update' | 'delete' | 'clean' | 'enable' | 'disable' | 'activate'} hookName The hook to check
 * @returns {boolean}
 */
function hasExtensionHook(name, hookName) {
    const fullName = name.startsWith('third-party') ? name : `third-party${name}`;
    const manifest = manifests[fullName];
    if (!manifest || !manifest.hooks || typeof manifest.hooks !== 'object') {
        return false;
    }
    const hookFunctionName = manifest.hooks[hookName];
    return typeof hookFunctionName === 'string' && hookFunctionName.length > 0;
}

/**
 * Calls a manifest hook for an extension.
 * Hooks are optional function names exported from the extension's JS entry point module.
 * The hook function can optionally return a Promise that will be awaited up to a diagnostic timeout.
 * @param {string} name Extension name
 * @param {'install' | 'update' | 'delete' | 'clean' | 'enable' | 'disable' | 'activate' | 'chatSurface'} hookName The hook to call
 * @returns {Promise<void>}
 */
async function callExtensionHook(name, hookName) {
    const manifest = manifests[name];

    if (!manifest) {
        console.debug(`callExtensionHook: Extension "${name}" has no manifest, skipping hook "${hookName}"`);
        return;
    }

    if (!manifest.hooks || typeof manifest.hooks !== 'object') {
        return;
    }

    if (!Object.hasOwn(manifest.hooks, hookName)) {
        return;
    }

    const hookFunctionName = manifest.hooks[hookName];

    if (typeof hookFunctionName !== 'string' || !hookFunctionName) {
        throw new Error(`Extension "${name}" hook "${hookName}" is not a valid string`);
    }

    if (!manifest.js) {
        throw new Error(`Extension "${name}" has hook "${hookName}" but no JS entry point defined in manifest`);
    }

    const url = getExtensionResourceUrl(name, manifest.js);
    console.debug(`callExtensionHook: Calling hook "${hookName}" (function "${hookFunctionName}") for extension "${name}"`);

    const module = await import(url);

    if (typeof module[hookFunctionName] !== 'function') {
        throw new Error(`Extension "${name}" hook "${hookName}" references "${hookFunctionName}" which is not an exported function`);
    }

    const hookCallResult = module[hookFunctionName]();

    if (hookName === 'chatSurface') {
        await hookCallResult;
        return;
    }

    const HOOK_TIMEOUT = 5000;
    const HOOK_RESULT = {
        OK: 'ok',
        TIMEOUT: 'timeout',
    };

    const result = await Promise.race([
        (hookCallResult instanceof Promise ? hookCallResult : Promise.resolve(hookCallResult)).then(() => HOOK_RESULT.OK),
        delay(HOOK_TIMEOUT).then(() => HOOK_RESULT.TIMEOUT),
    ]);

    if (result === HOOK_RESULT.TIMEOUT) {
        console.warn(`callExtensionHook: Hook "${hookName}" for extension "${name}" timed out after ${HOOK_TIMEOUT}ms; continuing without waiting for completion`);
        return;
    }

    console.debug(`callExtensionHook: Hook "${hookName}" completed for extension "${name}"`);
}

/**
 * Enables an extension by name.
 * @param {string} name Extension name
 * @param {boolean} [reload=true] If true, reload the page after enabling the extension
 */
export async function enableExtension(name, reload = true) {
    await callExtensionHook(name, 'enable');
    extension_settings.disabledExtensions = extension_settings.disabledExtensions.filter(x => x !== name);
    stateChanged = true;
    await saveSettings();
    if (reload) {
        location.reload();
    } else {
        requiresReload = true;
    }
}

/**
 * Disables an extension by name.
 * @param {string} name Extension name
 * @param {boolean} [reload=true] If true, reload the page after disabling the extension
 */
export async function disableExtension(name, reload = true) {
    await callExtensionHook(name, 'disable');
    extension_settings.disabledExtensions.push(name);
    stateChanged = true;
    await saveSettings();
    if (reload) {
        location.reload();
    } else {
        requiresReload = true;
    }
}

/**
 * Finds an extension by name, allowing omission of the "third-party/" prefix.
 *
 * @param {string} name - The name of the extension to find
 * @returns {{name: string, enabled: boolean}|null} Object with name and enabled properties, or null if not found
 */
export function findExtension(name) {
    const internalExtensionName = extensionNames.find(extName => {
        return equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`);
    });
    if (!internalExtensionName) return null;
    const isEnabled = !extension_settings.disabledExtensions.includes(internalExtensionName);
    return { name: internalExtensionName, enabled: isEnabled };
}

// An absent switch counts as enabled: both renderers default to rendering, and a
// missing schema must not silently admit two runtime claimants for one source.
export const CHAT_SURFACE_RENDERER_CAPABILITIES = Object.freeze([
    Object.freeze({
        extensionName: 'JS-Slash-Runner',
        participantId: 'js-slash-runner/message-runtime',
        rendersCodeBlocks: () => extension_settings.tavern_helper?.render?.enabled !== false,
    }),
    Object.freeze({
        extensionName: 'LittleWhiteBox',
        participantId: 'littlewhitebox/message-runtime',
        rendersCodeBlocks: () => extension_settings.LittleWhiteBox?.enabled !== false
            && extension_settings.LittleWhiteBox?.renderEnabled !== false,
    }),
]);

export function getEnabledChatSurfaceRendererCapabilities() {
    return CHAT_SURFACE_RENDERER_CAPABILITIES
        .map(capability => {
            const extension = findExtension(capability.extensionName);
            return extension?.enabled === true
                ? Object.freeze({ ...capability, internalName: extension.name })
                : null;
        })
        .filter(Boolean);
}

/**
 * Returns true when a known third-party message code renderer should own HTML/script code blocks.
 * @returns {boolean}
 */
export function isCodeRenderDelegatedToThirdPartyRenderer() {
    return getEnabledChatSurfaceRendererCapabilities().length > 0;
}

/**
 * Initializes ChatSurface hooks and the required renderer before the first projection.
 */
export async function activateRequiredChatSurfaceExtensions() {
    const enabled = getEnabledChatSurfaceRendererCapabilities();
    const codeRenderers = enabled.filter(capability => capability.rendersCodeBlocks());
    if (codeRenderers.length > 1) {
        throw new Error(
            'Bounded ChatSurface cannot start while multiple renderers have code block rendering enabled: '
            + codeRenderers.map(({ extensionName }) => extensionName).join(', '),
        );
    }
    const requiredNames = new Set(enabled.map(capability => capability.internalName));
    const contentExtensions = extensionNames.filter(name =>
        !extension_settings.disabledExtensions.includes(name)
        && Object.hasOwn(manifests[name]?.hooks ?? {}, 'chatSurface'))
        .sort((a, b) => sortManifestsByOrder(manifests[a], manifests[b]));
    for (const name of contentExtensions) {
        requiredNames.add(name);
    }
    await activateExtensions({
        parallelism: 1,
        includeExtension: name => requiredNames.has(name),
        resetErrors: false,
        throwOnError: true,
    });
    for (const name of contentExtensions) {
        if (!activeExtensions.has(name)) {
            throw new Error(`ChatSurface extension "${name}" could not activate`);
        }
        await callExtensionHook(name, 'chatSurface');
    }

    return Object.freeze(enabled.map(({ extensionName, participantId }) => Object.freeze({
        extensionName,
        participantId,
    })));
}

/**
 * Returns a deep clone of the manifest for the given extension name.
 * Accepts either the short name (e.g. `SillyTavern-MyExtension`) or the full internal key
 * (e.g. `third-party/SillyTavern-MyExtension`). Returns null if the extension is not found.
 * @param {string} name - Extension name or internal key
 * @returns {object|null} Cloned manifest object, or null if not found
 */
export function getExtensionManifest(name) {
    const found = extensionNames.find(extName =>
        equalsIgnoreCaseAndAccents(extName, name) || equalsIgnoreCaseAndAccents(extName, `third-party/${name}`),
    );
    const manifest = found ? manifests[found] : null;
    return manifest ? structuredClone(manifest) : null;
}

export function getActiveExtensionNames() {
    return [...activeExtensions];
}

/**
 * Loads manifest.json files for extensions.
 * @param {string[]} names Array of extension names
 * @returns {Promise<Record<string, object>>} Object with extension names as keys and their manifests as values
 */
async function getManifests(names) {
    const obj = {};
    await Promise.all(names.map(async name => {
        try {
            const response = await fetch(getExtensionResourceUrl(name, 'manifest.json'));
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const manifest = await response.json();
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
                throw new Error('manifest.json must contain a JSON object');
            }

            obj[name] = manifest;
        } catch (err) {
            console.warn('Could not load manifest.json for ' + name, err);
        }
    }));

    return obj;
}

/**
 * Tries to activate all available extensions that are not already active.
 * @returns {Promise<void>}
 */
async function activateExtensions({ parallelism = 1, includeExtension = () => true, resetErrors = true, throwOnError = false } = {}) {
    if (resetErrors) {
        extensionLoadErrors.clear();
    }

    const clientVersion = CLIENT_VERSION.split(':')[1];
    const discoveredExtensionNames = Object.keys(manifests);
    const extensions = Object.entries(manifests)
        .filter(([name, manifest]) => includeExtension(name, manifest))
        .sort((a, b) => sortManifestsByOrder(a[1], b[1]));

    const shouldActivateExtension = ({ name, manifest }) => {
        if (activeExtensions.has(name)) {
            return { activate: false, reason: 'already-active' };
        }

        const isDisabled = extension_settings.disabledExtensions.includes(name);
        if (isDisabled) {
            return { activate: false, reason: 'disabled' };
        }

        const extrasRequirements = manifest.requires;
        const extensionDependencies = manifest.dependencies;
        const minClientVersion = manifest.minimum_client_version;

        // Client version requirement: pass if 'minimum_client_version' is undefined or null.
        let meetsClientMinimumVersion = true;
        if (minClientVersion !== undefined) {
            meetsClientMinimumVersion = versionCompare(clientVersion, minClientVersion);
        }

        // Module requirements: pass if 'requires' is undefined, null, or not an array; check subset if it's an array
        let meetsModuleRequirements = true;
        let missingModules = [];
        if (extrasRequirements !== undefined) {
            if (Array.isArray(extrasRequirements)) {
                meetsModuleRequirements = isSubsetOf(modules, extrasRequirements);
                missingModules = extrasRequirements.filter(req => !modules.includes(req));
            } else {
                console.warn(`Extension ${name}: manifest.json 'requires' field is not an array. Loading allowed, but any intended requirements were not verified to exist.`);
            }
        }

        // Extension dependencies: pass if 'dependencies' is undefined or not an array; check subset and disabled status if it's an array
        let meetsExtensionDeps = true;
        let missingDependencies = [];
        let disabledDependencies = [];
        if (extensionDependencies !== undefined) {
            if (Array.isArray(extensionDependencies)) {
                // Check if all dependencies exist
                meetsExtensionDeps = isSubsetOf(discoveredExtensionNames, extensionDependencies);
                missingDependencies = extensionDependencies.filter(dep => !discoveredExtensionNames.includes(dep));
                // Check for disabled dependencies
                if (meetsExtensionDeps) {
                    disabledDependencies = extensionDependencies.filter(dep => extension_settings.disabledExtensions.includes(dep));
                    if (disabledDependencies.length > 0) {
                        // Fail if any dependencies are disabled
                        meetsExtensionDeps = false;
                    }
                }
            } else {
                console.warn(`Extension ${name}: manifest.json 'dependencies' field is not an array. Loading allowed, but any intended requirements were not verified to exist.`);
            }
        }

        if (!meetsModuleRequirements) {
            return { activate: false, reason: 'missing-modules', missingModules };
        }

        if (!meetsExtensionDeps) {
            return { activate: false, reason: 'missing-deps', missingDependencies, disabledDependencies };
        }

        if (!meetsClientMinimumVersion) {
            return { activate: false, reason: 'min-client-version', minClientVersion };
        }

        return { activate: true };
    };

    const activateSingleExtension = async ({ name, manifest }) => {
        const displayName = manifest.display_name || name;

        try {
            const decision = shouldActivateExtension({ name, manifest });
            if (!decision.activate) {
                if (decision.reason === 'missing-modules') {
                    console.warn(t`Extension "${name}" did not load. Missing required Extras module(s): "${decision.missingModules.join(', ')}"`);
                    extensionLoadErrors.set(name, t`Extension "${displayName}" did not load. Missing required Extras module(s): "${decision.missingModules.join(', ')}"`);
                } else if (decision.reason === 'missing-deps') {
                    if (decision.disabledDependencies.length > 0) {
                        console.warn(t`Extension "${name}" did not load. Required extensions exist but are disabled: "${decision.disabledDependencies.join(', ')}". Enable them first, then reload.`);
                        extensionLoadErrors.set(name, t`Extension "${displayName}" did not load. Required extensions exist but are disabled: "${decision.disabledDependencies.join(', ')}". Enable them first, then reload.`);
                    } else {
                        console.warn(t`Extension "${name}" did not load. Missing required extensions: "${decision.missingDependencies.join(', ')}"`);
                        extensionLoadErrors.set(name, t`Extension "${displayName}" did not load. Missing required extensions: "${decision.missingDependencies.join(', ')}"`);
                    }
                } else if (decision.reason === 'min-client-version') {
                    console.warn(t`Extension "${name}" did not load. Requires ST client version ${decision.minClientVersion}, but current version is ${clientVersion}.`);
                    extensionLoadErrors.set(name, t`Extension "${displayName}" did not load. Requires ST client version ${decision.minClientVersion}, but current version is ${clientVersion}.`);
                }

                return;
            }

            console.debug('Activating extension', name);
            if (isThirdPartyExtension(name)) {
                thirdPartyHljsPromise ??= getHljs();
                await thirdPartyHljsPromise;
            }
            await addExtensionLocale(name, manifest);
            await Promise.all([addExtensionScript(name, manifest), addExtensionStyle(name, manifest)]);
            await callExtensionHook(name, 'activate');
            activeExtensions.add(name);
        } catch (err) {
            console.log('Could not activate extension', name, err);
            extensionLoadErrors.set(name, t`Extension "${displayName}" failed to load: ${err}`);
            if (throwOnError) {
                throw err;
            }
        }
    };

    let currentGroup = [];
    let currentOrder = null;

    const flushGroup = async () => {
        if (currentGroup.length === 0) {
            return;
        }

        for (let i = 0; i < currentGroup.length; i += parallelism) {
            const chunk = currentGroup.slice(i, i + parallelism);
            await Promise.all(chunk.map((entry) => activateSingleExtension(entry)));

            await delay(0);
        }

        currentGroup = [];
    };

    for (const [name, manifest] of extensions) {
        const order = Number.parseInt(String(manifest.loading_order ?? '0'), 10) || 0;
        if (currentOrder === null) {
            currentOrder = order;
        }

        if (order !== currentOrder) {
            await flushGroup();
            currentOrder = order;
        }

        currentGroup.push({ name, manifest });
    }

    await flushGroup();
    $('#extensions_details').toggleClass('warning', extensionLoadErrors.size > 0);
}

async function connectClickHandler() {
    const baseUrl = String($('#extensions_url').val());
    extension_settings.apiUrl = baseUrl;
    const testApiKey = $('#extensions_api_key').val();
    extension_settings.apiKey = String(testApiKey);
    saveSettingsDebounced();
    await connectToApi(baseUrl);
}

function autoConnectInputHandler() {
    const value = $(this).prop('checked');
    extension_settings.autoConnect = !!value;

    if (value && !connectedToApi) {
        $('#extensions_connect').trigger('click');
    }

    saveSettingsDebounced();
}

async function addExtensionsButtonAndMenu() {
    const buttonHTML = await renderTemplateAsync('wandButton');
    const extensionsMenuHTML = await renderTemplateAsync('wandMenu');

    $(document.body).append(extensionsMenuHTML);
    $('#leftSendForm').append(buttonHTML);

    const button = $('#extensionsMenuButton');
    const dropdown = $('#extensionsMenu');

    let popper = Popper.createPopper(button.get(0), dropdown.get(0), {
        placement: 'top-start',
    });

    initPopupMenu(button[0], dropdown[0], {
        onOpen: () => { popper.update(); },
        closesOnClick: target => !target.closest('#sd_gen, #roll_dice'),
    });
}

let extensionsUiReadyPromise = null;

function syncExtensionSettingsUi() {
    $('#extensions_url').val(extension_settings.apiUrl);
    $('#extensions_api_key').val(extension_settings.apiKey);
    $('#extensions_autoconnect').prop('checked', extension_settings.autoConnect);
    $('#extensions_notify_updates').prop('checked', extension_settings.notifyUpdates);
}

export async function ensureExtensionsUiReady() {
    if (extensionsUiReadyPromise) {
        return extensionsUiReadyPromise;
    }

    extensionsUiReadyPromise = (async () => {
        await addExtensionsButtonAndMenu();
        $('#extensionsMenuButton').css('display', 'flex');

        syncExtensionSettingsUi();

        $('#extensions_connect').on('click', connectClickHandler);
        $('#extensions_autoconnect').on('input', autoConnectInputHandler);
        $('#extensions_details').on('click', event => {
            if (!isControlDisabled(event.currentTarget) && !event.currentTarget.hidden) {
                return showExtensionsDetails();
            }
        });
        $('#extensions_notify_updates').on('input', notifyUpdatesInputHandler);
        $('#third_party_extension_button').on('click', () => openThirdPartyExtensionMenu());
    })();

    return extensionsUiReadyPromise;
}

function notifyUpdatesInputHandler() {
    extension_settings.notifyUpdates = !!$('#extensions_notify_updates').prop('checked');
    saveSettingsDebounced();

    if (extension_settings.notifyUpdates) {
        checkForExtensionUpdates(true);
    }
}

/**
 * Connects to the Extras API.
 * @param {string} baseUrl Extras API base URL
 * @returns {Promise<void>}
 */
async function connectToApi(baseUrl, { parallelism = 1, includeExtension = () => true, resetErrors = true } = {}) {
    if (!baseUrl) {
        return;
    }

    const url = new URL(baseUrl);
    url.pathname = '/api/modules';

    try {
        const getExtensionsResult = await doExtrasFetch(url);

        if (getExtensionsResult.ok) {
            const data = await getExtensionsResult.json();
            modules = data.modules;
            await activateExtensions({ parallelism, includeExtension, resetErrors });
            await eventSource.emit(event_types.EXTRAS_CONNECTED, modules);
        }

        updateStatus(getExtensionsResult.ok);
    } catch {
        updateStatus(false);
    }
}

/**
 * Updates the status of Extras API connection.
 * @param {boolean} success Whether the connection was successful
 */
function updateStatus(success) {
    connectedToApi = success;
    const _text = success ? t`Connected to API` : t`Could not connect to API`;
    const _class = success ? 'success' : 'failure';
    $('#extensions_status').text(_text);
    $('#extensions_status').attr('class', _class);
}

/**
 * Adds a localization data for an extension.
 * @param {string} name Extension name
 * @param {object} manifest Manifest object
 */
function addExtensionLocale(name, manifest) {
    if (!manifest.i18n || typeof manifest.i18n !== 'object') {
        return Promise.resolve();
    }

    const currentLocale = getCurrentLocale();
    const localeFile = manifest.i18n[currentLocale] || manifest.i18n.default;
    if (!localeFile) {
        return Promise.resolve();
    }

    return fetch(getExtensionResourceUrl(name, localeFile))
        .then(async response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (data && typeof data === 'object') {
                addLocaleData(currentLocale, data);
            }
        })
        .catch(err => {
            console.log('Could not load extension locale data for ' + name, err);
        });
}

function createExtensionManagerRow(name, type, openDetails) {
    const row = document.createElement('li');
    row.dataset.name = name;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'extension-manager-row';
    button.setAttribute('aria-controls', 'extension_manager_detail');
    const title = document.createElement('strong');
    const metadata = document.createElement('span');
    metadata.className = 'extension-manager-row-meta';
    const status = document.createElement('span');
    const update = document.createElement('span');
    update.className = 'extension-manager-update-available';
    update.textContent = translate('Update available');
    update.hidden = true;
    metadata.append(status, update);
    button.append(title, metadata);
    row.append(button);

    const isExternal = isThirdPartyExtension(name);
    const item = {
        name, type, isExternal, row, button, title, status, update,
        externalId: isExternal ? name.slice('third-party'.length) : '',
        manifest: null,
        searchText: '',
        check: null,
    };
    button.addEventListener('click', () => openDetails(item));
    return item;
}

/**
 * Gets the module information to be displayed.
 *
 * @return {HTMLElement} - The element containing the module information.
 */
function getModuleInformation() {
    const container = document.createElement('div');

    const heading = document.createElement('h3');
    heading.textContent = t`Modules provided by your Extras API:`;
    container.appendChild(heading);

    const moduleInfo = document.createElement('p');
    if (modules.length) {
        moduleInfo.textContent = modules.join(', ');
    } else {
        moduleInfo.classList.add('failure');
        moduleInfo.textContent = t`Not connected to the API!`;
    }
    container.appendChild(moduleInfo);

    return container;
}

/**
 * Generates HTMLElement for the extension load errors.
 * @returns {HTMLElement} - The element containing the extension load errors.
 */
function getExtensionLoadErrors() {
    if (extensionLoadErrors.size === 0) {
        return document.createElement('div');
    }

    const container = document.createElement('div');
    container.classList.add('info-block', 'error');

    for (const error of extensionLoadErrors.values()) {
        const errorElement = document.createElement('div');
        errorElement.textContent = error;
        container.appendChild(errorElement);
    }

    return container;
}

let extensionManagerOpen = false;

async function showExtensionsDetails() {
    if (extensionManagerOpen) return;
    extensionManagerOpen = true;
    const versionChecks = new AbortController();

    try {
        const markup = await renderTemplateAsync('manageExtensions');
        if (!markup) return;
        const menu = $(markup).get(0);
        const byId = id => menu.querySelector('#extension_manager_' + id);
        const list = byId('list');
        const details = byId('detail');
        const title = byId('name');
        const toggle = byId('toggle');
        const search = byId('search');
        const filter = byId('filter');
        const sort = byId('sort');
        const panes = list.parentElement;
        const thirdPartyGroup = byId('third_party');
        const builtInGroup = byId('built_in');
        const detailFields = new Map(Array.from(menu.querySelectorAll('[data-extension-field]'), field => [field.dataset.extensionField, field]));
        const controls = ['install', 'update', 'update_all', 'update_enabled', 'toggle_all', 'restore_toggles', 'branch', 'move', 'clean', 'delete'].map(byId);
        const sortOrderKey = 'extensions_sortByName';
        sort.value = accountStorage.getItem(sortOrderKey) === 'true' ? 'name' : 'order';

        const items = new Map();
        const pendingToggles = new Map();
        const individuallyToggled = new Set();
        let ordered = [];
        let selected;
        let busy = false;

        const configuredEnabled = name => !extension_settings.disabledExtensions.includes(name);
        const isEnabled = name => pendingToggles.get(name) ?? configuredEnabled(name);
        const hasUpdate = item => item.check?.data?.isUpToDate === false;
        const visibleRows = () => ordered.filter(item => !item.row.hidden).map(item => item.row);
        const rowKey = row => row.dataset.name;

        function statusText(item) {
            if (!isEnabled(item.name)) return translate('Disabled');
            return activeExtensions.has(item.name) || pendingToggles.has(item.name) || individuallyToggled.has(item.name)
                ? translate('Enabled')
                : translate('Inactive');
        }

        function renderRow(item) {
            item.status.textContent = statusText(item);
            item.update.hidden = !hasUpdate(item);
        }

        function writeField(key, value) {
            const field = detailFields.get(key);
            field.hidden = !value;
            field.lastElementChild.textContent = value || '';
        }

        function renderDetails() {
            byId('selection').hidden = !selected;
            if (!selected) {
                panes.dataset.view = 'list';
                return;
            }

            const { name, type, manifest, isExternal, externalId, check } = selected;
            const data = check?.data;
            const isActive = activeExtensions.has(name);
            const enabled = isEnabled(name);
            const needsReload = pendingToggles.has(name) || (individuallyToggled.has(name) && enabled !== isActive);
            const canToggle = isActive || !configuredEnabled(name) || individuallyToggled.has(name);
            const isAdminUser = isAdmin();

            title.textContent = selected.title.textContent;
            byId('status').textContent = statusText(selected);
            toggle.checked = enabled;
            toggle.disabled = busy || !canToggle;
            byId('pending').hidden = !needsReload;
            byId('update').hidden = !hasUpdate(selected);
            byId('more').hidden = !isExternal;
            byId('branch').hidden = !isAdminUser;
            byId('move').hidden = !isAdminUser;
            byId('clean').hidden = !isExternal || !hasExtensionHook(externalId, 'clean');
            const loadError = byId('load_error');
            loadError.textContent = extensionLoadErrors.get(name) || '';
            loadError.hidden = !loadError.textContent;

            const source = {
                system: translate('Built-in extension'),
                local: translate('Local extension'),
                global: translate('Global extension'),
            };
            writeField('source', source[type]);
            const author = typeof manifest.author === 'string' ? manifest.author : '';
            writeField('author', author || (data?.remoteUrl && getAuthorFromUrl(data.remoteUrl).name));
            writeField('version', manifest.version);
            writeField('branch', data?.currentBranchName);
            writeField('commit', data?.currentCommitHash?.slice(0, 7));

            const repository = detailFields.get('repository');
            const link = repository.querySelector('a');
            const remote = data?.remoteUrl;
            let remoteUrl;
            if (remote) {
                try {
                    const url = new URL(remote);
                    if (url.protocol === 'http:' || url.protocol === 'https:') remoteUrl = url.href;
                } catch {
                    // Some extensions do not have a browsable remote.
                }
            }
            repository.hidden = !remoteUrl;
            if (remoteUrl) link.href = remoteUrl;
            else link.removeAttribute('href');
            link.textContent = remoteUrl || '';

            const versionStatus = byId('version_status');
            versionStatus.textContent = check?.pending ? translate('Checking for extension updates…') : check?.error || '';
            versionStatus.hidden = !versionStatus.textContent;

            const requirements = isActive ? manifest.optional : manifest.requires;
            const missing = Array.isArray(requirements) ? requirements.filter(module => !modules.includes(module)) : [];
            const moduleStatus = byId('modules');
            moduleStatus.hidden = !missing.length || (!isActive && (!enabled || !loadError.hidden));
            const label = isActive ? translate('Optional modules:') : translate('Missing modules:');
            moduleStatus.textContent = missing.length ? label + ' ' + missing.join(', ') : '';
        }

        function selectItem(item) {
            if (selected !== item) {
                selected?.button.removeAttribute('aria-current');
                selected = item;
                selected?.button.setAttribute('aria-current', 'true');
                byId('more').open = false;
                details.scrollTop = 0;
            }
            renderDetails();
        }

        function renderVisibility() {
            const query = search.value.trim().toLocaleLowerCase();
            const option = filter.value;
            let firstMatch;
            let thirdPartyVisible = false;
            let builtInVisible = false;
            let checking = false;

            for (const item of ordered) {
                const matchesQuery = item.searchText.includes(query);
                const matchesFilter = option === 'all'
                    || (option === 'third-party' && item.isExternal)
                    || (option === 'built-in' && !item.isExternal)
                    || (option === 'updates' && hasUpdate(item));
                item.row.hidden = !matchesQuery || !matchesFilter;
                if (matchesQuery && item.check?.pending) checking = true;
                if (item.row.hidden) continue;
                firstMatch ??= item;
                if (item.isExternal) thirdPartyVisible = true;
                else builtInVisible = true;
            }

            thirdPartyGroup.parentElement.hidden = !thirdPartyVisible;
            builtInGroup.parentElement.hidden = !builtInVisible;
            const message = byId('list_message');
            message.hidden = Boolean(firstMatch);
            if (!firstMatch) {
                message.textContent = option === 'updates' && checking
                    ? translate('Checking for extension updates…')
                    : translate('No matching extensions');
            }
            const sameExtension = items.get(selected?.name);
            selectItem(sameExtension && !sameExtension.row.hidden ? sameExtension : firstMatch);
        }

        function preserveListFocus(write) {
            if (!keepFocus(visibleRows, rowKey, write)) filter.focus({ preventScroll: true });
        }

        function sortRows() {
            const compare = sort.value === 'name' ? sortManifestsByName : sortManifestsByOrder;
            preserveListFocus(() => {
                ordered = Array.from(items.values()).sort((left, right) =>
                    Number(right.isExternal) - Number(left.isExternal) || compare(left.manifest, right.manifest));
                for (const item of ordered) {
                    const group = item.isExternal ? thirdPartyGroup : builtInGroup;
                    group.append(item.row);
                }
                renderVisibility();
            });
        }

        function openDetails(item) {
            selectItem(item);
            panes.dataset.view = 'detail';
            if (getComputedStyle(byId('back')).display !== 'none') title.focus({ preventScroll: true });
        }

        function checkVersion(item) {
            const check = { pending: true, data: null, error: '' };
            item.check = check;
            const isCurrent = () => !versionChecks.signal.aborted && items.get(item.name) === item && item.check === check;
            void enqueueVersionCheck(async () => {
                if (!isCurrent()) return;
                try {
                    check.data = await getExtensionVersion(item.externalId, versionChecks);
                } catch (error) {
                    if (!isCurrent()) return;
                    console.error('Error checking for extension updates', error);
                    check.error = toUserFacingErrorText(error.message) || error.message || translate('Could not check for extension updates');
                } finally {
                    check.pending = false;
                    if (isCurrent()) {
                        renderRow(item);
                        if (filter.value === 'updates') preserveListFocus(renderVisibility);
                        else if (selected === item) renderDetails();
                    }
                }
            });
        }

        function reconcileItems() {
            for (const [name, item] of items) {
                if (Object.hasOwn(manifests, name)) continue;
                item.row.remove();
                items.delete(name);
                pendingToggles.delete(name);
                individuallyToggled.delete(name);
            }
            for (const [name, manifest] of Object.entries(manifests)) {
                let item = items.get(name);
                const type = getExtensionType(name);
                if (item?.type !== type) {
                    item?.row.remove();
                    item = createExtensionManagerRow(name, type, openDetails);
                    items.set(name, item);
                    if (item.isExternal) checkVersion(item);
                }
                item.manifest = manifest;
                const directory = item.isExternal ? item.externalId.slice(1) : name;
                const displayName = typeof manifest.display_name === 'string' && manifest.display_name.trim() || directory;
                item.title.textContent = displayName;
                item.searchText = (displayName + ' ' + directory).toLocaleLowerCase();
                renderRow(item);
            }

            byId('bulk').hidden = !Array.from(items.values()).some(item => item.isExternal);
            const diagnostics = byId('diagnostics');
            byId('diagnostics_content').replaceChildren(getExtensionLoadErrors(), getModuleInformation());
            if (extensionLoadErrors.size) diagnostics.open = true;
            sortRows();
        }

        function renderToggles() {
            for (const item of ordered) renderRow(item);
            byId('restore_toggles').hidden = pendingToggles.size === 0;
            renderDetails();
        }

        function setBusy(value) {
            busy = value;
            for (const control of controls) {
                if (value) control.setAttribute('aria-disabled', 'true');
                else control.removeAttribute('aria-disabled');
            }
            if (value) toggle.disabled = true;
        }

        async function runAction(action) {
            if (busy) return false;
            const previousManifests = manifests;
            setBusy(true);
            try {
                return await action();
            } catch (error) {
                console.error('Extension management action failed', error);
                toastr.error(toUserFacingErrorText(error.message) || error.message || translate('Extension operation failed'));
                return false;
            } finally {
                setBusy(false);
                if (manifests !== previousManifests) reconcileItems();
                renderToggles();
            }
        }

        const installButton = document.getElementById('third_party_extension_button');
        byId('install').hidden = installButton.hidden || isControlDisabled(installButton);
        byId('install').addEventListener('click', () => runAction(openThirdPartyExtensionMenu));

        list.addEventListener('focusin', () => { panes.dataset.view = 'list'; });
        details.addEventListener('focusin', () => { panes.dataset.view = 'detail'; });
        byId('back').addEventListener('click', () => {
            panes.dataset.view = 'list';
            selected?.button.focus({ preventScroll: true });
        });
        search.addEventListener('input', renderVisibility);
        filter.addEventListener('change', renderVisibility);
        sort.addEventListener('change', () => {
            accountStorage.setItem(sortOrderKey, sort.value === 'name' ? 'true' : 'false');
            sortRows();
        });

        toggle.addEventListener('change', () => {
            const item = selected;
            const enable = toggle.checked;
            if (!item) return;
            return runAction(async () => {
                if (enable !== configuredEnabled(item.name)) {
                    await (enable ? enableExtension : disableExtension)(item.name, false);
                    individuallyToggled.add(item.name);
                }
                pendingToggles.delete(item.name);
            });
        });
        byId('toggle_all').addEventListener('click', () => {
            if (busy) return;
            const thirdParty = ordered.filter(item => item.isExternal);
            const enable = !thirdParty.some(item => isEnabled(item.name));
            for (const { name } of thirdParty) {
                if (enable === configuredEnabled(name)) pendingToggles.delete(name);
                else pendingToggles.set(name, enable);
            }
            renderToggles();
        });
        byId('restore_toggles').addEventListener('click', () => {
            if (busy) return;
            pendingToggles.clear();
            renderToggles();
            byId('toggle_all').focus({ preventScroll: true });
        });

        const onSelected = (control, action) => byId(control).addEventListener('click', () => {
            const item = selected;
            if (!item?.isExternal) return;
            return runAction(() => action(item));
        });
        onSelected('update', async item => {
            if (item.type === 'global' && !isAdmin()) {
                toastr.error(translate("You don't have permission to update global extensions."));
                return;
            }
            if (await updateExtension(item.externalId, false)) {
                if (document.activeElement === byId('update')) title.focus({ preventScroll: true });
                checkVersion(item);
            }
        });
        onSelected('branch', async item => {
            if (await chooseExtensionBranch(item.externalId)) checkVersion(item);
        });
        onSelected('move', item => confirmExtensionMove(item.externalId));
        onSelected('clean', item => confirmExtensionCleanup(item.externalId));
        onSelected('delete', item => confirmExtensionDeletion(item.externalId));

        async function updateBatch(force) {
            const completed = await runAction(async () => {
                requiresReload = true;
                await autoUpdateExtensions(force);
                return true;
            });
            if (completed) await popup.completeAffirmative();
        }
        byId('update_all').addEventListener('click', () => updateBatch(true));
        byId('update_enabled').addEventListener('click', () => updateBatch(false));

        const popup = new Popup(menu, POPUP_TYPE.TEXT, '', {
            label: byId('title'),
            okButton: translate('Close'),
            onClosing: async () => {
                const saved = await runAction(async () => {
                    for (const [name, enable] of pendingToggles) {
                        if (enable !== configuredEnabled(name)) {
                            await (enable ? enableExtension : disableExtension)(name, false);
                        }
                        pendingToggles.delete(name);
                    }
                    if (stateChanged) {
                        const toast = toastr.info(translate('The page will be reloaded shortly...'), translate('Extensions state changed'));
                        try {
                            if (!await saveSettings()) throw new Error(translate('Could not save extension settings.'));
                            requiresReload = true;
                        } finally {
                            toastr.clear(toast);
                        }
                    }
                    return true;
                });
                if (saved) versionChecks.abort();
                return saved;
            },
        });
        popup.dlg.classList.add('extension-manager-popup');
        reconcileItems();
        await popup.show();
        if (requiresReload) location.reload();
    } catch (error) {
        toastr.error(translate('Error loading extensions. See browser console for details.'));
        console.error(error);
    } finally {
        versionChecks.abort();
        extensionManagerOpen = false;
    }
}

/**
 * Updates a third-party extension via the API.
 * @param {string} extensionName Extension folder name
 * @param {boolean} quiet If true, don't show a success message
 * @returns {Promise<boolean>} Whether the update succeeded.
 */
async function updateExtension(extensionName, quiet) {
    try {
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            const normalized = stripCommandErrorPrefixes(text || response.statusText);
            const message = toUserFacingErrorText(normalized) || normalized || response.statusText;
            toastr.error(message, t`Extension update failed`, { timeOut: 5000 });
            console.error('Extension update failed', response.status, response.statusText, text);
            return false;
        }

        const data = await response.json();

        if (data.isUpToDate) {
            if (!quiet) {
                toastr.success('Extension is already up to date');
            }
        } else {
            const fullExtensionName = extensionName.startsWith('third-party') ? extensionName : `third-party${extensionName}`;
            await callExtensionHook(fullExtensionName, 'update');
            toastr.success(t`Extension ${extensionName} updated to ${data.shortCommitHash}`, t`Reload the page to apply updates`);
        }
        return true;
    } catch (error) {
        console.error('Extension update error:', error);
        if (!quiet) toastr.error(toUserFacingErrorText(error.message) || error.message || t`Extension update failed`);
        return false;
    }
}

/**
 * Handles the click event for the delete button of an extension.
 * This function makes a POST request to '/api/extensions/delete' with the extension's name.
 * If the extension is deleted, it displays a success message.
 * Creates a popup for the user to confirm before delete.
 * If the extension has a 'clean' hook, an optional checkbox to also run the cleanup is shown.
 * @param {string} extensionName Extension folder name
 */
async function confirmExtensionDeletion(extensionName) {
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to delete global extensions.`);
        return;
    }

    const hasCleanHook = hasExtensionHook(extensionName, 'clean');

    /** @type {import('./popup.js').CustomPopupInput[]} */
    const customInputs = hasCleanHook ? [{ id: 'extension_delete_cleanup', label: t`Also clean up extension data`, defaultState: false }] : null;

    const popup = new Popup(t`Are you sure you want to delete ${escapeHtml(extensionName)}?`, POPUP_TYPE.CONFIRM, '', { customInputs });
    const confirmation = await popup.show();
    if (confirmation === POPUP_RESULT.AFFIRMATIVE) {
        const shouldClean = hasCleanHook && Boolean(popup.inputResults?.get('extension_delete_cleanup'));
        await deleteExtension(extensionName, shouldClean);
    }
}

/**
 * Handles the click event for the clean button of an extension.
 * Runs the extension's 'clean' hook after user confirmation, then reloads the page.
 * @param {string} extensionName Extension folder name
 */
async function confirmExtensionCleanup(extensionName) {
    const confirmation = await Popup.show.confirm(t`Clean extension data`, t`Are you sure you want to clean up data for ${escapeHtml(extensionName)}? This action cannot be undone.`);
    if (!confirmation) {
        return;
    }

    await cleanExtension(extensionName);
}

/**
 * Runs the 'clean' hook for an extension and reloads the page.
 * @param {string} extensionName Extension name (without 'third-party' prefix)
 * @returns {Promise<void>}
 */
async function cleanExtension(extensionName) {
    const fullExtensionName = extensionName.startsWith('third-party') ? extensionName : `third-party${extensionName}`;
    await callExtensionHook(fullExtensionName, 'clean');

    // Clean might have updated settings, which could race with the page reload, so we'll force save here
    await saveSettings();

    toastr.success(t`Extension ${extensionName} data cleaned`);
    delay(1000).then(() => location.reload());
}

async function chooseExtensionBranch(extensionName) {
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to switch branch.`);
        return;
    }

    const branches = await getExtensionBranches(extensionName, isGlobal);
    const selectElement = document.createElement('select');
    selectElement.classList.add('text_pole', 'wide100p');
    for (const branch of branches) {
        const option = document.createElement('option');
        option.value = branch.name;
        const label = branch.label ? ` [${branch.label}]` : '';
        option.textContent = `${branch.name} (${branch.commit})${label}`;
        option.selected = branch.current;
        selectElement.appendChild(option);
    }

    const popup = new Popup(selectElement, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Switch`,
        cancelButton: t`Cancel`,
    });
    const popupResult = await popup.show();
    const newBranch = selectElement.value;

    if (!popupResult || !newBranch) {
        return false;
    }

    return switchExtensionBranch(extensionName, isGlobal, newBranch);
}

async function confirmExtensionMove(extensionName) {
    const isCurrentUserAdmin = isAdmin();
    const isGlobal = getExtensionType(extensionName) === 'global';
    if (isGlobal && !isCurrentUserAdmin) {
        toastr.error(t`You don't have permission to move extensions.`);
        return;
    }

    const source = getExtensionType(extensionName);
    const destination = source === 'global' ? 'local' : 'global';

    const confirmationHeader = t`Move extension`;
    const confirmationText = source == 'global'
        ? t`Are you sure you want to move ${escapeHtml(extensionName)} to your local extensions? This will make it available only for you.`
        : t`Are you sure you want to move ${escapeHtml(extensionName)} to the global extensions? This will make it available for all users.`;

    const confirmation = await Popup.show.confirm(confirmationHeader, confirmationText);

    if (!confirmation) {
        return;
    }

    await moveExtension(extensionName, source, destination);
}

/**
 * Moves an extension via the API.
 * @param {string} extensionName Extension name
 * @param {string} source Source type
 * @param {string} destination Destination type
 * @returns {Promise<void>}
 */
async function moveExtension(extensionName, source, destination) {
    try {
        const result = await fetch('/api/extensions/move', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                source,
                destination,
            }),
        });

        if (!result.ok) {
            const text = await result.text();
            toastr.error(text || result.statusText, t`Extension move failed`, { timeOut: 5000 });
            console.error('Extension move failed', result.status, result.statusText, text);
            return;
        }

        toastr.success(t`Extension ${extensionName} moved.`);
        await loadExtensionSettings({}, false, false);
    } catch (error) {
        console.error('Error:', error);
    }
}

/**
 * Deletes an extension via the API.
 * @param {string} extensionName Extension name to delete
 * @param {boolean} [shouldClean=false] Whether to also run the 'clean' hook before deleting
 */
export async function deleteExtension(extensionName, shouldClean = false) {
    const fullExtensionName = extensionName.startsWith('third-party') ? extensionName : `third-party${extensionName}`;

    if (shouldClean) {
        await callExtensionHook(fullExtensionName, 'clean');
    }

    await callExtensionHook(fullExtensionName, 'delete');

    try {
        await fetch('/api/extensions/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
        });
    } catch (error) {
        console.error('Error:', error);
    }

    // Delete or clean might have updated settings, which could race with the page reload, so we'll force save here
    await saveSettings();

    toastr.success(t`Extension ${extensionName} deleted`);
    delay(1000).then(() => location.reload());
}

/**
 * Fetches the version details of a specific extension.
 *
 * @param {string} extensionName - The name of the extension.
 * @param {AbortController} [abortController] - Abort controller for the operation.
 * @return {Promise<object|null>} - Version details or null when aborted.
 * This object includes the currentBranchName, currentCommitHash, isUpToDate, and remoteUrl.
 * @throws {Error} - When the fetch fails.
 */
async function getExtensionVersion(extensionName, abortController) {
    try {
        const response = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: getExtensionType(extensionName) === 'global',
            }),
            signal: abortController?.signal,
        });

        if (!response.ok) {
            const text = await response.text();
            const normalized = stripCommandErrorPrefixes(text || response.statusText);
            throw new Error(normalized || response.statusText);
        }

        const data = await response.json();
        return data;
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            return null;
        }
        throw error;
    }
}

/**
 * Gets the list of branches for a specific extension.
 * @param {string} extensionName The name of the extension
 * @param {boolean} isGlobal Whether the extension is global or not
 * @returns {Promise<ExtensionBranch[]>} List of branches for the extension
 * @typedef {object} ExtensionBranch
 * @property {string} name The name of the branch
 * @property {string} commit The commit hash of the branch
 * @property {boolean} current Whether this branch is the current one
 * @property {string} label The commit label of the branch
 */
async function getExtensionBranches(extensionName, isGlobal) {
    try {
        const response = await fetch('/api/extensions/branches', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                global: isGlobal,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension branches fetch failed`);
            console.error('Extension branches fetch failed', response.status, response.statusText, text);
            return [];
        }

        return await response.json();
    } catch (error) {
        console.error('Error:', error);
        return [];
    }
}

/**
 * Switches the branch of an extension.
 * @param {string} extensionName The name of the extension
 * @param {boolean} isGlobal If the extension is global
 * @param {string} branch Branch name to switch to
 * @returns {Promise<boolean>} Whether the branch switch succeeded.
 */
async function switchExtensionBranch(extensionName, isGlobal, branch) {
    try {
        const response = await fetch('/api/extensions/switch', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName,
                branch,
                global: isGlobal,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            toastr.error(text || response.statusText, t`Extension branch switch failed`);
            console.error('Extension branch switch failed', response.status, response.statusText, text);
            return false;
        }

        toastr.success(t`Extension ${extensionName} switched to ${branch}`, t`Reload the page to apply updates`);
        await loadExtensionSettings({}, false, false);
        return true;
    } catch (error) {
        console.error('Error:', error);
        return false;
    }
}

/**
 * Installs a third-party extension via the API.
 * @param {string} url Extension repository URL
 * @param {boolean} global Is the extension global?
 * @param {string} [branch] Optional branch to install, if not provided the default branch will be used
 * @returns {Promise<boolean>} True if the extension was installed successfully, false otherwise
 */
function getExtensionInstallToastMessage(value) {
    const normalized = stripCommandErrorPrefixes(value);
    return normalized ? translate(normalized) : t`Unknown error`;
}

export async function installExtension(url, global, branch = '') {
    try {
        const parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Invalid URL protocol');
        }

        // Normalize the URL (resolve relative paths, remove redundant segments, etc.)
        url = parsedUrl.href;
    } catch {
        console.error('Invalid extension URL');
        toastr.error(t`Only valid HTTP and HTTPS URLs are allowed.`, t`Invalid URL`);
        return false;
    }

    if (!isOfficialExtension(url)) {
        const extensionInstallationWarningKey = 'extensionInstallationWarningShown';
        if (accountStorage.getItem(extensionInstallationWarningKey)) {
            console.debug('Bypassed URL check for third-party extension (account preference).');
        } else {
            let dismissWarning = false;
            const confirmation = await Popup.show.confirm(
                t`Install a third-party extension?`,
                await renderTemplateAsync('thirdPartyExtensionWarning'),
                {
                    customInputs: [{ id: 'dontAskAgain', type: 'checkbox', label: t`Don't show this warning again`, defaultState: false }],
                    onClose: (popup) => {
                        if (!popup.result) {
                            return;
                        }
                        dismissWarning = Boolean(popup.inputResults?.get('dontAskAgain') ?? false);
                    },
                    okButton: t`Yes, install it`,
                    cancelButton: t`No, cancel`,
                });
            if (!confirmation) {
                return false;
            }
            if (dismissWarning) {
                accountStorage.setItem(extensionInstallationWarningKey, '1');
            }
        }
    }

    console.debug('Extension installation started');

    toastr.info(t`Please wait...`, t`Installing extension`);

    let request;
    try {
        request = await fetch('/api/extensions/install', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                url,
                global,
                branch,
            }),
        });
    } catch (error) {
        const message = String(error?.message || error || '');
        toastr.warning(getExtensionInstallToastMessage(message), t`Extension installation failed`, { timeOut: 5000 });
        console.error('Extension installation failed', error);
        return false;
    }

    if (!request.ok) {
        const text = await request.text();
        toastr.warning(getExtensionInstallToastMessage(text || request.statusText), t`Extension installation failed`, { timeOut: 5000 });
        console.error('Extension installation failed', request.status, request.statusText, text);
        return false;
    }

    const response = await request.json();
    toastr.success(t`Extension '${response.display_name}' has been installed successfully!`, t`Extension installation successful`);
    console.debug(`Extension "${response.display_name}" has been installed successfully at ${response.extensionPath}`);
    await loadExtensionSettings({}, false, false);
    await eventSource.emit(event_types.EXTENSION_SETTINGS_LOADED, response);

    if (response.folderName) {
        const extensionName = `third-party/${response.folderName}`;
        await callExtensionHook(extensionName, 'install');
    }

    return true;
}

/**
 * Loads extension settings from the app settings.
 * @param {object} settings App Settings
 * @param {boolean} versionChanged Is this a version change?
 * @param {boolean} enableAutoUpdate Enable auto-update
 */
export function applyExtensionSettings(settings) {
    if (settings.extension_settings) {
        Object.assign(extension_settings, settings.extension_settings);
    }

    syncExtensionSettingsUi();
}

export async function activateStartupSystemExtensions({
    versionChanged,
    enableAutoUpdate,
    parallelism = 1,
    forceRefresh = false,
} = {}) {
    await prepareOfflineExtensionsActivation({
        versionChanged,
        enableAutoUpdate,
        forceRefresh,
    });

    await activateExtensions({
        parallelism,
        includeExtension: (name) => isSystemExtension(name),
        resetErrors: true,
    });

    if (extension_settings.autoConnect && extension_settings.apiUrl) {
        await connectToApi(extension_settings.apiUrl, {
            parallelism,
            includeExtension: (name) => isSystemExtension(name),
            resetErrors: true,
        });
    }

    return hasPendingDeferredThirdPartyActivation();
}

export async function activateDeferredThirdPartyExtensions({ parallelism = 1 } = {}) {
    await prepareOfflineExtensionsActivation();

    if (!hasPendingDeferredThirdPartyActivation()) {
        return;
    }

    if (!connectedToApi && extension_settings.autoConnect && extension_settings.apiUrl) {
        await connectToApi(extension_settings.apiUrl, {
            parallelism,
            includeExtension: (name) => isDeferredThirdPartyExtension(name),
            resetErrors: false,
        });

        if (connectedToApi) {
            return;
        }

        console.error(
            `Extras API auto-connect failed; proceeding with third-party extension activation without Extras.`,
        );
    }

    await activateExtensions({
        parallelism,
        includeExtension: (name) => isDeferredThirdPartyExtension(name),
        resetErrors: false,
    });
}

export async function activateOfflineExtensions({ versionChanged, enableAutoUpdate, parallelism = 1, forceRefresh = false } = {}) {
    await prepareOfflineExtensionsActivation({
        versionChanged,
        enableAutoUpdate,
        forceRefresh,
    });

    await activateExtensions({ parallelism, resetErrors: true });
    if (extension_settings.autoConnect && extension_settings.apiUrl) {
        await connectToApi(extension_settings.apiUrl, {
            parallelism,
            resetErrors: true,
        });
    }
}

export async function loadExtensionSettings(settings, versionChanged, enableAutoUpdate, options = {}) {
    applyExtensionSettings(settings);
    await activateOfflineExtensions({
        versionChanged,
        enableAutoUpdate,
        forceRefresh: true,
        parallelism: Number(options.parallelism) || 1,
    });
}

export function doDailyExtensionUpdatesCheck() {
    setTimeout(() => {
        if (extension_settings.notifyUpdates) {
            checkForExtensionUpdates(false);
        }
    }, 1);
}

const concurrencyLimit = 5;
let activeRequestsCount = 0;
const versionCheckQueue = [];

function enqueueVersionCheck(fn) {
    return new Promise((resolve, reject) => {
        versionCheckQueue.push({ fn, resolve, reject });
        processVersionCheckQueue();
    });
}

function processVersionCheckQueue() {
    if (activeRequestsCount >= concurrencyLimit || versionCheckQueue.length === 0) {
        return;
    }

    activeRequestsCount++;
    const item = versionCheckQueue.shift();
    item
        .fn()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
        activeRequestsCount--;
        processVersionCheckQueue();
    });
}

/**
 * Checks if there are updates available for enabled 3rd-party extensions.
 * @param {boolean} force Skip nag check
 * @returns {Promise<any>}
 */
async function checkForExtensionUpdates(force) {
    if (!force) {
        const STORAGE_NAG_KEY = 'extension_update_nag';
        const currentDate = new Date().toDateString();

        // Don't nag more than once a day
        if (accountStorage.getItem(STORAGE_NAG_KEY) === currentDate) {
            return;
        }

        accountStorage.setItem(STORAGE_NAG_KEY, currentDate);
    }

    const isCurrentUserAdmin = isAdmin();
    const updatesAvailable = [];
    const promises = [];

    for (const [id, manifest] of Object.entries(manifests)) {
        const isDisabled = extension_settings.disabledExtensions.includes(id);
        if (isDisabled) {
            console.debug(`Skipping extension: ${manifest.display_name} (${id}) for non-admin user`);
            continue;
        }
        const isGlobal = getExtensionType(id) === 'global';
        if (isGlobal && !isCurrentUserAdmin) {
            console.debug(`Skipping global extension: ${manifest.display_name} (${id}) for non-admin user`);
            continue;
        }

        if (manifest.auto_update && id.startsWith('third-party')) {
            const promise = enqueueVersionCheck(async () => {
                try {
                    const data = await getExtensionVersion(id.replace('third-party', ''));
                    if (!data) {
                        return;
                    }
                    if (!data.isUpToDate) {
                        updatesAvailable.push(manifest.display_name);
                    }
                } catch (error) {
                    console.error('Error checking for extension updates', error);
                }
            });
            promises.push(promise);
        }
    }

    await Promise.allSettled(promises);

    if (updatesAvailable.length > 0) {
        toastr.info(`${updatesAvailable.map(x => `• ${x}`).join('\n')}`, t`Extension updates available`);
    }
}

/**
 * Updates all enabled 3rd-party extensions that have auto-update enabled.
 * @param {boolean} forceAll Include disabled and not auto-updating
 * @returns {Promise<void>}
 */
async function autoUpdateExtensions(forceAll) {
    if (!Object.values(manifests).some(x => x.auto_update)) {
        return;
    }

    const banner = toastr.info(t`Auto-updating extensions. This may take several minutes.`, t`Please wait...`, { timeOut: 10000, extendedTimeOut: 10000 });
    const isCurrentUserAdmin = isAdmin();
    try {
        for (const [id, manifest] of Object.entries(manifests)) {
            const isDisabled = extension_settings.disabledExtensions.includes(id);
            if (!forceAll && isDisabled) {
                console.debug(`Skipping extension: ${manifest.display_name} (${id}) for non-admin user`);
                continue;
            }
            const isGlobal = getExtensionType(id) === 'global';
            if (isGlobal && !isCurrentUserAdmin) {
                console.debug(`Skipping global extension: ${manifest.display_name} (${id}) for non-admin user`);
                continue;
            }
            if ((forceAll || manifest.auto_update) && id.startsWith('third-party')) {
                console.debug(`Auto-updating 3rd-party extension: ${manifest.display_name} (${id})`);
                await updateExtension(id.replace('third-party', ''), true);
            }
        }
    } finally {
        toastr.clear(banner);
    }
}

/**
 * Runs the generate interceptors for all extensions.
 * @param {any[]} chat Chat array
 * @param {number} contextSize Context size
 * @param {string} type Generation type
 * @returns {Promise<boolean>} True if generation should be aborted
 */
export async function runGenerationInterceptors(chat, contextSize, type) {
    let aborted = false;
    let exitImmediately = false;

    const abort = (/** @type {boolean} */ immediately) => {
        aborted = true;
        exitImmediately = immediately;
    };

    for (const manifest of Object.values(manifests).filter(x => x.generate_interceptor).sort((a, b) => sortManifestsByOrder(a, b))) {
        const interceptorKey = manifest.generate_interceptor;
        if (typeof globalThis[interceptorKey] === 'function') {
            try {
                await globalThis[interceptorKey](chat, contextSize, abort, type);
            } catch (e) {
                console.error(`Failed running interceptor for ${manifest.display_name}`, e);
            }
        }

        if (exitImmediately) {
            break;
        }
    }

    return aborted;
}

/**
 * Sentinel value that signals a field should be completely removed (unset)
 * from the character card rather than being set to any value. Pass this as
 * the `value` argument to {@link writeExtensionField} or
 * {@link writeExtensionFieldBulk} to delete the key entirely.
 *
 * Using `null` as a value will set the field to `null` (the key remains).
 * Using this sentinel will delete the key from the character card.
 * @type {string}
 */
export const UNSET_VALUE = '__@@UNSET@@__';

/**
 * Writes a field to the character's data extensions object.
 * @param {number|string} characterId Index in the character array
 * @param {string} key Field name
 * @param {any} value Field value
 * @returns {Promise<void>} When the field is written
 */
export async function writeExtensionField(characterId, key, value) {
    const context = getContext();
    const character = context.characters[characterId];
    if (!character) {
        console.warn('Character not found', characterId);
        return;
    }
    const extensionPath = `data.extensions.${key}`;
    const isUnset = value === UNSET_VALUE;

    if (isUnset) {
        deleteValueByPath(character, extensionPath);
    } else {
        setValueByPath(character, extensionPath, value);
    }

    // Process JSON data
    if (character.json_data) {
        const jsonData = JSON.parse(character.json_data);
        if (isUnset) {
            deleteValueByPath(jsonData, extensionPath);
        } else {
            setValueByPath(jsonData, extensionPath, value);
        }
        character.json_data = JSON.stringify(jsonData);

        // Make sure the data doesn't get lost when saving the current character
        if (Number(characterId) === Number(context.characterId)) {
            $('#character_json_data').val(character.json_data);
        }
    }

    // Save data to the server
    const saveDataRequest = {
        avatar: character.avatar,
        data: {
            extensions: {
                [key]: value,
            },
        },
    };
    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(saveDataRequest),
    });

    if (!mergeResponse.ok) {
        console.error('Failed to save extension field', mergeResponse.statusText);
    }
}

/**
 * @typedef {object} BulkExtensionFieldResult
 * @property {string[]} updated  Avatar filenames that were successfully updated
 * @property {string[]} skipped  Avatar filenames skipped (filter didn't match or unreadable)
 * @property {string[]} failed   Avatar filenames where the update failed
 */

/**
 * Writes (or deletes) an extension field for multiple characters in a single
 * bulk request. Unlike {@link writeExtensionField}, this sends one API call
 * for all characters, and the server processes them in parallel.
 *
 * When `value` is {@link UNSET_VALUE} the extension key is **deleted** from
 * each matching character card. Passing `null` sets the field to `null`
 * (the key is preserved).
 *
 * @param {string[]|null} avatars Avatar filenames to update. Pass `null` or an
 *   empty array to target **all** characters in the user's character directory.
 * @param {string} key Extension field name (e.g. "greeting_tools")
 * @param {any} value Field value, `null` to set null, or
 *   {@link UNSET_VALUE} to delete the key entirely
 * @param {object} [options={}] Optional settings
 * @param {string} [options.filterPath] Dot-path filter — the server will only
 *   update characters where this path is present and not `undefined`;
 *   `null` still counts as a match. Useful when the frontend has shallow
 *   character data and cannot pre-filter.
 *   Defaults to `data.extensions.<key>` when unsetting, so deletion requests
 *   automatically skip characters where the field is missing/`undefined`.
 * @returns {Promise<BulkExtensionFieldResult>} Summary of the bulk operation
 */
export async function writeExtensionFieldBulk(avatars, key, value, { filterPath } = {}) {
    const context = getContext();
    const extensionPath = `data.extensions.${key}`;
    const isUnset = value === UNSET_VALUE;

    // Build the server request
    const requestBody = {
        avatars: Array.isArray(avatars) && avatars.length > 0 ? avatars : [],
        data: {
            data: {
                extensions: {
                    [key]: value,
                },
            },
        },
    };

    // Default filter: when unsetting, only touch characters that have the field
    const resolvedFilterPath = filterPath ?? (isUnset ? extensionPath : undefined);
    if (resolvedFilterPath) {
        requestBody.filter = { path: resolvedFilterPath };
    }

    const mergeResponse = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
    });

    if (!mergeResponse.ok) {
        console.error('Bulk extension field update failed', mergeResponse.statusText);
        return { updated: [], skipped: [], failed: [] };
    }

    /** @type {BulkExtensionFieldResult} */
    const result = await mergeResponse.json();

    // Sync in-memory character objects for successfully updated characters
    const updatedSet = new Set(result.updated);
    for (const character of context.characters) {
        if (!character || !updatedSet.has(character.avatar)) continue;

        if (isUnset) {
            deleteValueByPath(character, extensionPath);
        } else {
            setValueByPath(character, extensionPath, value);
        }

        // Keep json_data in sync
        if (character.json_data) {
            const jsonData = JSON.parse(character.json_data);
            if (isUnset) {
                deleteValueByPath(jsonData, extensionPath);
            } else {
                setValueByPath(jsonData, extensionPath, value);
            }
            character.json_data = JSON.stringify(jsonData);
        }
    }

    // If the currently active character was updated, sync the hidden input
    if (context.characterId !== undefined) {
        const activeChar = context.characters[context.characterId];
        if (activeChar && updatedSet.has(activeChar.avatar) && activeChar.json_data) {
            $('#character_json_data').val(activeChar.json_data);
        }
    }

    return result;
}

/**
 * Prompts the user to enter the Git URL of the extension to import.
 * After obtaining the Git URL, makes a POST request to '/api/extensions/install' to import the extension.
 * If the extension is imported successfully, a success message is displayed.
 * If the extension import fails, an error message is displayed and the error is logged to the console.
 * After successfully importing the extension, the extension settings are reloaded and a 'EXTENSION_SETTINGS_LOADED' event is emitted.
 * @param {string} [suggestUrl] Suggested URL to install
 * @returns {Promise<void>}
 */
export async function openThirdPartyExtensionMenu(suggestUrl = '') {
    const isCurrentUserAdmin = isAdmin();
    const html = await renderTemplateAsync('installExtension', { isCurrentUserAdmin });
    const okButton = isCurrentUserAdmin ? t`Install just for me` : t`Install`;

    let global = false;
    const installForAllButton = {
        text: t`Install for all users`,
        appendAtEnd: false,
        action: async () => {
            global = true;
            await popup.complete(POPUP_RESULT.AFFIRMATIVE);
        },
    };
    /** @type {import('./popup.js').CustomPopupInput} */
    const branchNameInput = {
        id: 'extension_branch_name',
        label: t`Branch or tag name (optional)`,
        type: 'text',
        tooltip: 'e.g. main, dev, v1.0.0',
    };

    const customButtons = isCurrentUserAdmin ? [installForAllButton] : [];
    const customInputs = [branchNameInput];
    const popup = new Popup(html, POPUP_TYPE.INPUT, suggestUrl ?? '', { okButton, customButtons, customInputs });
    const input = await popup.show();

    if (!input) {
        console.debug('Extension install cancelled');
        return;
    }

    const url = String(input).trim();
    const branchName = String(popup.inputResults.get('extension_branch_name') ?? '').trim();
    await installExtension(url, global, branchName);
}

/**
 * Sentinel value representing an empty author, used when author information cannot be extracted from a URL.
 * @type {{name: string, url: string}}
 */
export const EMPTY_AUTHOR = Object.freeze({
    name: '',
    url: '',
});

/**
 * Extracts the repository author from a given URL.
 * @param {string} url - The URL of the repository.
 * @returns {{name: string, url: string}} Object containing the author's name and URL, or empty strings if not found.
 */
export function getAuthorFromUrl(url) {
    const result = structuredClone(EMPTY_AUTHOR);

    try {
        const parsedUrl = new URL(url);
        const pathSegments = parsedUrl.pathname.split('/').filter(s => s.length > 0);

        // TODO: Handle non-GitHub URLs if needed
        if (parsedUrl.host === 'github.com' && pathSegments.length >= 2) {
            result.name = pathSegments[0];
            result.url = `${parsedUrl.protocol}//${parsedUrl.hostname}/${result.name}`;
        }
    } catch (error) {
        console.debug('Error parsing URL:', error);
    }

    return result;
}

export async function initExtensions() {
    eventSource.once(event_types.APP_READY, () => {
        void (async () => {
            await delay(0);
            await ensureExtensionsUiReady();
        })();
    });
}
