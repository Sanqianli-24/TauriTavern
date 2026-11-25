import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { migrateNightStudyTheme, resolveThemeBinding } from '../src/scripts/theme-binding-policy.js';

test('theme binding resolves chat, entity, then fallback and reports missing references', () => {
    const candidates = [
        { scope: 'chat', name: 'Missing chat theme' },
        { scope: 'character', name: 'Character theme' },
        { scope: 'fallback', name: 'Fallback theme' },
    ];

    assert.deepEqual(resolveThemeBinding(candidates, ['Character theme', 'Fallback theme']), {
        selected: candidates[1],
        missing: [candidates[0]],
    });
    assert.deepEqual(resolveThemeBinding(candidates, ['Fallback theme']), {
        selected: candidates[2],
        missing: candidates.slice(0, 2),
    });
    assert.deepEqual(resolveThemeBinding(candidates, []), {
        selected: null,
        missing: candidates,
    });
});

test('Night Study upgrades the stock palette once and preserves personal appearance', () => {
    const read = file => JSON.parse(readFileSync(new URL(`../default/content/${file}`, import.meta.url), 'utf8'));
    const oldTheme = read('themes/Dark Lite.json');
    const nightStudy = read('themes/Night Study.json');
    const newInstall = read('settings.json').power_user;
    assert.equal(newInstall.theme, nightStudy.name);
    for (const [key, value] of Object.entries(nightStudy)) {
        if (key !== 'name') assert.equal(newInstall[key], value);
    }
    assert.equal(migrateNightStudyTheme(newInstall, [nightStudy]), false);

    const stock = { ...oldTheme, theme: oldTheme.name, theme_fallback: oldTheme.name, font_scale: 1.25,
        border_color: 'rgba(0, 0, 0, 0.5)', theme_bindings: { characters: { 'A.png': oldTheme.name } } };
    const migrated = structuredClone(stock);
    assert.equal(migrateNightStudyTheme(migrated, [oldTheme, nightStudy]), true);
    assert.equal(migrated.theme_fallback, nightStudy.name);
    assert.equal(migrated.main_text_color, nightStudy.main_text_color);
    assert.equal(migrated.font_scale, stock.font_scale);
    assert.deepEqual(migrated.theme_bindings, stock.theme_bindings);
    Object.assign(migrated, stock);
    assert.equal(migrateNightStudyTheme(migrated, [oldTheme, nightStudy]), false);
    assert.equal(migrated.theme, oldTheme.name);

    for (const personal of [{ custom_css: 'body {}' }, { quote_text_color: 'rgb(60, 70, 80)' }, { theme_fallback: 'Azure' }]) {
        const preferences = { ...stock, ...personal };
        assert.equal(migrateNightStudyTheme(preferences, [oldTheme, nightStudy]), true);
        assert.deepEqual(preferences, { ...stock, ...personal, night_study_theme_migrated: true });
    }
});
