/**
 * Selects the first available theme while preserving missing higher-priority
 * references for explicit error reporting.
 *
 * @param {Array<{scope: 'chat'|'character'|'group'|'fallback', name: string|undefined}>} candidates
 * @param {string[]} availableThemeNames
 * @returns {{selected: {scope: 'chat'|'character'|'group'|'fallback', name: string}|null, missing: Array<{scope: 'chat'|'character'|'group'|'fallback', name: string}>}}
 */
export function resolveThemeBinding(candidates, availableThemeNames) {
    const availableThemes = new Set(availableThemeNames);
    const missing = [];

    for (const candidate of candidates) {
        if (!candidate.name) {
            continue;
        }
        if (availableThemes.has(candidate.name)) {
            return { selected: candidate, missing };
        }
        missing.push(candidate);
    }

    return { selected: null, missing };
}

// Factory palette immediately before Night Study. Settings saved before applying the
// old preset could use the stock CSS border at opacity .5 instead of the preset's 1.
const darkLitePalette = {
    main_text_color: '220,220,210,1',
    italics_text_color: '145,145,145,1',
    underline_text_color: '188,231,207,1',
    quote_text_color: '225,138,36,1',
    chat_tint_color: '23,23,23,1',
    blur_tint_color: '23,23,23,1',
    user_mes_blur_tint_color: '30,30,30,0.9',
    bot_mes_blur_tint_color: '30,30,30,0.9',
    shadow_color: '0,0,0,1',
    border_color: '0,0,0,1',
};

function rgbChannels(value) {
    const channels = /^rgba?\(([^)]+)\)$/i.exec(value)?.[1].split(',').map(channel => Number(channel.trim()));
    if (channels?.length === 3) channels.push(1);
    return channels?.join(',');
}

/** The startup migration changes only the factory palette and its global theme name. */
export function migrateNightStudyTheme(preferences, themes) {
    const replacement = themes.find(theme => theme.name === 'Night Study');
    if (!replacement || preferences.night_study_theme_migrated) return false;

    preferences.night_study_theme_migrated = true;
    if (preferences.theme !== 'Dark Lite' || preferences.theme_fallback !== 'Dark Lite' || preferences.custom_css) return true;

    const isFactory = Object.entries(darkLitePalette).every(([key, expected]) => {
        const actual = rgbChannels(preferences[key]);
        return actual === expected || (key === 'border_color' && actual === '0,0,0,0.5');
    });
    if (!isFactory) return true;

    const palette = Object.keys(darkLitePalette);
    if (!palette.every(key => typeof replacement[key] === 'string')) return true;
    for (const key of palette) preferences[key] = replacement[key];
    preferences.theme = replacement.name;
    preferences.theme_fallback = replacement.name;
    return true;
}
