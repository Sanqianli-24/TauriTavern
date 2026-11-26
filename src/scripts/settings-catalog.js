export const settingsCategories = [
    {
        id: 'model', title: 'Model & Replies', icon: 'fa-sliders', summary: 'API, presets, prompts',
        sections: [
            { id: 'connection', title: 'API connections and models', panel: 'rm_api_block', terms: ['API Connections', 'Connect model', 'Current model', 'API key', 'Model Target'] },
            { id: 'presets', title: 'Presets and reply length', panel: 'left-nav-panel', grouped: true, terms: ['AI Response Configuration', 'Reply length', 'Max Response Length (tokens)', 'Context Size (tokens)'] },
            { id: 'sampling', title: 'Sampling parameters', panel: 'left-nav-panel', grouped: true, terms: ['Temperature', 'Top P', 'Top K'] },
            { id: 'completion-prompts', title: 'Chat completion prompts', panel: 'left-nav-panel', grouped: true, api: 'openai', terms: ['Prompt Manager', 'System Prompt'] },
            { id: 'formatting', title: 'Reply formatting and context', panel: 'AdvancedFormatting', terms: ['AI Response Formatting', 'Advanced Formatting', 'Context Template', 'Instruct Template', 'Tokenizer'] },
            { id: 'model-options', title: 'Proxy, API keys and caching', panel: 'tt-host-settings', terms: ['Request Proxy', 'Allow Keys Exposure', 'Claude Prompt Cache'] },
        ],
    },
    {
        id: 'chat', title: 'Chat & Input', icon: 'fa-comment-dots', summary: 'Sending, swipes, persona',
        sections: [
            { id: 'messages', title: 'Messages and input', panel: 'user-settings-block', grouped: true, terms: ['User Settings', 'Chat/Message Handling', 'AutoComplete Settings', 'Send on Enter'] },
            { id: 'character-behavior', title: 'Character and persona preferences', panel: 'user-settings-block', grouped: true, terms: ['Character Handling', 'Auto-lock a chosen persona to the chat'] },
        ],
    },
    {
        id: 'appearance', title: 'Appearance & Reading', icon: 'fa-palette', summary: 'Font size, themes, wallpapers',
        sections: [
            { id: 'reading', title: 'Theme and reading', panel: 'user-settings-block', grouped: true, terms: ['Theme', 'UI Theme', 'Font size', 'Font Scale', 'Chat Width'] },
            { id: 'wallpapers', title: 'Wallpaper library', panel: 'Backgrounds', terms: ['Wallpaper', 'Backgrounds', 'Background Fitting'] },
            { id: 'dynamic-appearance', title: 'Day/night appearance and OLED', panel: 'tt-host-settings', terms: ['OLED Pure Black Background', 'Dynamic Theme & Wallpaper', 'Day Theme', 'Night Wallpaper'] },
            { id: 'layout', title: 'Layout and custom CSS', panel: 'user-settings-block', grouped: true, terms: ['MovingUI', 'Movable UI Panels', 'Custom CSS'] },
        ],
    },
    {
        id: 'extensions', title: 'Extensions & Tools', icon: 'fa-cubes', summary: 'Installed extensions, shortcuts',
        sections: [
            { id: 'installed', title: 'Installed extensions', panel: 'rm_extensions_block', terms: ['Manage extensions', 'Install extension', 'Manage Quick Access'] },
        ],
    },
    {
        id: 'data', title: 'Data & Sync', icon: 'fa-database', summary: 'Backups, device sync, import and export',
        sections: [
            { id: 'sync', title: 'Device sync and cloud account', panel: 'tt-settings-sync', terms: ['Sync', 'Cloud account', 'Recovery code', 'LAN Sync'] },
            { id: 'backups', title: 'Chat backups and storage', panel: 'tt-host-settings', terms: ['Chat Backups', 'Automatic Chat Backups', 'Data Directory', 'Backup storage limit', 'zstd Compression'] },
            { id: 'transfer', title: 'Import and export data', panel: 'tt-settings-transfer', terms: ['Data Migration', 'Import Data Archive', 'Export Current Data'] },
        ],
    },
    {
        id: 'app', title: 'App & Updates', icon: 'fa-circle-info', summary: 'Language, version, diagnostics',
        sections: [
            { id: 'about', title: 'Language and updates', panel: 'tt-settings-about', terms: ['Language', 'App Version', 'Installed version', 'Update', 'Update Channel', 'Check for updates', 'Update now'] },
            { id: 'performance', title: 'Performance and diagnostics', panel: 'tt-host-settings', terms: ['TauriTavern Settings', 'Panel Runtime', 'Embedded Runtime', 'CodeMirror Editor', 'Frontend Logs', 'Backend Logs', 'LLM API Logs'] },
            { id: 'scripting', title: 'Scripting', panel: 'user-settings-block', grouped: true, terms: ['STscript Settings'] },
        ],
    },
];
