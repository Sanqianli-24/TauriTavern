import { main_api } from '../script.js';
import { getControlLabel, getControlName } from './dom-handlers.js';
import { setInlineDrawerOpen } from './drawers.js';
import { getActiveExtensionNames, getExtensionManifest } from './extensions.js';
import { translate } from './i18n.js';
import { isChatCompletionControlAvailable } from './openai.js';

const controls = 'input:not([type="hidden"], [type="file"]), select, textarea, button, [role="button"]';

function normalize(text) {
    return text.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function termsFor(keys) {
    return keys.flatMap(key => [key, translate(key)]).filter(Boolean);
}

/** Capture legacy controls before the panel runtime parks any of the actual nodes. */
export function indexSettingControls(root, section) {
    const entries = [];
    for (const control of root.querySelectorAll(controls)) {
        if (control.closest('template, .template_element, [data-tt-sensitive], .drag-grabber')) continue;
        const label = getControlLabel(control) ?? control.closest('label');
        const title = getControlName(control) || label?.textContent.trim()
            || (control.matches('button, [role="button"]') && (control.textContent.trim() || control.title));
        if (!title) continue;
        const original = label?.querySelector('[data-i18n]:not([data-i18n^="["])')?.dataset.i18n
            ?? label?.dataset.i18n ?? control.getAttribute('data-i18n')?.match(/\[aria-label\]([^;]+)/)?.[1];
        const path = [];
        for (let node = control; node && node.id !== section.panel; node = node.parentElement) path.push(node);
        entries.push({
            section, title, targets: [control],
            terms: [title, ...(original && !original.startsWith('[') ? termsFor([original]) : [])],
            available: () => path.every(isSearchable),
        });
    }
    return entries;
}

function isSearchable(node) {
    if (node.dataset.ttSettingsApi !== undefined) return node.dataset.ttSettingsApi.split(',').includes(main_api);
    if (node.dataset.source !== undefined) return isChatCompletionControlAvailable(node);
    if (node.hasAttribute('data-tt-settings-group') || node.hasAttribute('data-tt-host-section') || node.matches('.inline-drawer-content')) return true;
    return !node.hidden && node.style.display !== 'none' && !node.classList.contains('displayNone');
}

function matchRank(terms, query) {
    const words = query.split(' ');
    const normalized = terms.map(normalize);
    if (normalized.includes(query)) return 0;
    if (normalized.some(term => term.startsWith(query))) return 1;
    if (normalized.some(term => term.includes(query) || words.every(word => term.includes(word)))) return 2;
    return Infinity;
}

export function extensionSettingsTarget(name) {
    const title = normalize(getExtensionManifest(name)?.display_name || name);
    const container = document.getElementById(name.split('/').at(-1).replaceAll('-', '_') + '_container');
    const candidates = [...(container?.querySelectorAll('.inline-drawer-toggle, h3, h4') ?? []),
        ...document.querySelectorAll('#rm_extensions_block .inline-drawer-toggle')];
    return candidates.find(element => normalize(element.textContent) === title)
        ?? (container && candidates.find(element => container.contains(element)))
        ?? document.getElementById('extensions_details');
}

export function searchSettings(query, categories, fields, sections) {
    const normalized = normalize(query);
    if (!normalized) return [];
    const destinations = categories.map(category => ({
        category, title: translate(category.title), terms: termsFor([category.title, category.summary]),
    }));
    for (const section of sections) {
        destinations.push({ section, title: translate(section.title), terms: termsFor([section.title, ...section.terms]) });
    }
    const installed = sections.find(section => section.id === 'installed');
    if (installed) {
        for (const name of getActiveExtensionNames()) {
            if (name === 'data-migration' || name === 'tauritavern-version') continue;
            const title = getExtensionManifest(name)?.display_name || name;
            destinations.push({ section: installed, title, terms: [title, name], targets: [() => extensionSettingsTarget(name)] });
        }
    }
    // Exact setting names lead to the controls even when several providers use the same label.
    const results = new Map();
    for (const entry of [...fields, ...destinations]) {
        if (entry.section && !sections.includes(entry.section)) continue;
        if (entry.available && !entry.available()) continue;
        const rank = matchRank(entry.terms, normalized);
        if (rank === Infinity) continue;
        const key = (entry.section?.id ?? entry.category.id) + ':' + normalize(entry.title);
        const previous = results.get(key);
        if (previous?.targets && entry.targets) {
            previous.targets.push(...entry.targets);
            continue;
        }
        if (!previous || rank < previous.rank || entry.targets) {
            results.set(key, { ...entry, rank, targets: entry.targets?.slice() });
        }
    }
    return [...results.values()].sort((a, b) => a.rank - b.rank || Number(!a.targets) - Number(!b.targets)).slice(0, 30);
}

function isRevealable(target, panel) {
    if (!target?.isConnected || !panel.contains(target)) return false;
    for (let node = target; node && node !== panel; node = node.parentElement) {
        if (node.hidden || node.classList.contains('displayNone')) return false;
        if (!node.matches('.inline-drawer-content, details > :not(summary)') && getComputedStyle(node).display === 'none') return false;
    }
    return true;
}

export function revealSetting(targets, panel) {
    const ordered = targets.slice().sort((a, b) => Number(a?.type === 'range') - Number(b?.type === 'range'));
    for (const getTarget of ordered) {
        let element = typeof getTarget === 'function' ? getTarget() : getTarget;
        if (element?.matches('.select2-hidden-accessible')) {
            element = element.nextElementSibling?.querySelector('.select2-selection');
        }
        if (!isRevealable(element, panel)) continue;
        if (element.matches('.inline-drawer-toggle') && element.closest('.inline-drawer')) {
            setInlineDrawerOpen(element.closest('.inline-drawer'), true);
        }
        for (let node = element.parentElement; node && node !== panel; node = node.parentElement) {
            if (node.matches('details')) node.open = true;
            if (node.matches('.inline-drawer-content')) setInlineDrawerOpen(node.closest('.inline-drawer'), true);
        }
        return element;
    }
    return null;
}
