// @ts-check
// Synchronous SHA-256 keeps the revision comparison and backend write in one task.
import { sha256 } from '../../../lib.js';
import { personaRecords } from '../../main/kernel/persona-projection.js';
import { characterAvatarFileNameFromStem, characterStemFromAvatarFileName } from '../../main/services/characters/character-identity.js';

/** @param {string} settings */
export function settingsRevision(settings) {
    return { hash_algorithm: 'web-host-settings-sha256-v1', settings_hash: sha256(settings) };
}

/** Keep ST's raw card body and metadata in the native command DTO. @param {any} character */
function characterDto(character) {
    return { ...character, extensions: character.data?.extensions, json_data: character.json_data ?? null };
}

/** Convert the upstream chat size label back to the byte count expected by the host route. @param {string|number} size */
function chatSizeBytes(size) {
    if (typeof size === 'number') return size;
    const match = /^([\d.]+)\s*([KMGT]?)B?$/i.exec(size);
    if (!match) return 0;
    return Math.round(Number(match[1]) * 1024 ** ['', 'K', 'M', 'G', 'T'].indexOf((match[2] ?? '').toUpperCase()));
}

/** @param {ReturnType<import('../backend.js').createBackend>} backend @param {string} name */
export function readCharacter({ json }, name) {
    const avatar = characterAvatarFileNameFromStem(name);
    const character = json('/api/characters/get', { avatar_url: avatar });
    if (typeof character.json_data !== 'string') throw new Error(`/api/characters/get (${avatar}): expected raw card text in json_data`);
    return characterDto(character);
}

/** @param {ReturnType<import('../backend.js').createBackend>} backend @returns {import('../install.js').CommandHandlers} */
export function createReadCommands(backend) {
    const { json } = backend;
    const getCharacters = () => json('/api/characters/all').map(characterDto);
    return {
        get_client_version: () => json('/version', undefined, 'GET'),
        list_active_agent_runs: () => [],
        get_bootstrap_metadata: () => ({
            characters: getCharacters(), groups: json('/api/groups/all'),
            avatars: json('/api/avatars/get'), secret_state: json('/api/secrets/read'),
        }),
        get_sillytavern_settings: () => {
            const response = json('/api/settings/get');
            response.tauritavern_settings_revision = settingsRevision(response.settings);
            return new TextEncoder().encode(JSON.stringify(response));
        },
        get_personas: () => personaRecords(JSON.parse(json('/api/settings/get').settings)),
        get_all_characters: getCharacters,
        get_all_groups: () => json('/api/groups/all'),
        read_secret_state: () => json('/api/secrets/read'),
        get_character: ({ name }) => readCharacter(backend, name),
        get_character_chats_by_id: ({ dto }) => {
            const chats = json('/api/characters/chats', { avatar_url: characterAvatarFileNameFromStem(dto.name), simple: dto.simple });
            if (!Array.isArray(chats)) throw new Error('/api/characters/chats: expected an array');
            return chats.map(chat => ({
                file_name: chat.file_name, file_size: chat.file_size, chat_items: chat.chat_items,
                last_message: chat.mes, last_message_date: chat.last_mes,
            }));
        },
        list_recent_chat_summaries: ({ max_entries, pinned, include_metadata }) => {
            const chats = json('/api/chats/recent', {
                max: max_entries,
                pinned: pinned.map(/** @param {{ character_name: string, file_name: string }} chat */ chat => ({
                    avatar: characterAvatarFileNameFromStem(chat.character_name),
                    file_name: chat.file_name.endsWith('.jsonl') ? chat.file_name : `${chat.file_name}.jsonl`,
                })),
                metadata: include_metadata,
            });
            if (!Array.isArray(chats)) throw new Error('/api/chats/recent: expected an array');
            return chats.filter(chat => chat.avatar && !chat.group).map(chat => ({
                character_name: characterStemFromAvatarFileName(chat.avatar, 'recent chat avatar', { required: true }),
                file_name: chat.file_name,
                file_size: chatSizeBytes(chat.file_size),
                message_count: chat.chat_items,
                preview: chat.mes,
                date: typeof chat.last_mes === 'number' ? chat.last_mes : (Date.parse(chat.last_mes) || 0),
                chat_metadata: chat.chat_metadata,
            }));
        },
        get_all_backgrounds: () => json('/api/backgrounds/all').images,
        get_background_folders: () => json('/api/backgrounds/folders'),
        get_all_background_metadata: args => json('/api/image-metadata/all', args),
        get_world_info: ({ dto }) => new TextEncoder().encode(JSON.stringify(json('/api/worldinfo/get', dto))),
    };
}
