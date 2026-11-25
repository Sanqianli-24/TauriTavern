import { sha256 } from '../../../../lib.js';
import { decodeBase64ToBytes, encodeBytesToBase64 } from '../../binary-utils.js';
import { browserDatabaseNames, captureDatabase, restoreDatabase } from './browser-indexeddb.js';
import { decodeEntry, encodeEntry } from './browser-format.js';

const FRAME_BYTES = 48 * 1024;
const DEVICE_STORAGE = new Set([
    'tt:perf', 'tt:embeddedRuntimeProfile', 'tt:panelRuntimeProfile',
]);

function isPortableKey(key) {
    return !DEVICE_STORAGE.has(key) && !key.startsWith('tt:sync') && !key.startsWith('tt:cloud-sync:');
}

function entryId(kind, name) {
    return kind + '-' + sha256(JSON.stringify(name));
}

async function hashBlob(blob) {
    const hash = sha256.create();
    for await (const chunk of blob.stream()) hash.update(chunk);
    return hash.hex();
}

export function createBrowserStorageSync(command) {
    let saved = new Map();

    async function capture() {
        const entries = new Map();
        const blocked = [];
        const retainKinds = [];
        const issues = [];
        try {
            for (let index = 0; index < localStorage.length; index++) {
                const key = localStorage.key(index);
                if (key === null || !isPortableKey(key)) continue;
                const value = localStorage.getItem(key);
                if (value !== null) {
                    entries.set(entryId('l', key), encodeEntry({ kind: 'localStorage', key, value }));
                }
            }
        } catch {
            retainKinds.push('l-');
            issues.push('localStorage');
        }

        try {
            for (const name of await browserDatabaseNames(globalThis.indexedDB)) {
                const id = entryId('i', name);
                try {
                    entries.set(id, await captureDatabase(globalThis.indexedDB, name));
                } catch (error) {
                    blocked.push(id);
                    issues.push(`IndexedDB ${name} (${error.message})`);
                }
            }
        } catch {
            retainKinds.push('i-');
            issues.push('IndexedDB');
        }

        if (typeof navigator.storage?.getDirectory === 'function'
            && typeof globalThis.FileSystemFileHandle?.prototype.createWritable === 'function') {
            try {
                await captureFileSystem(await navigator.storage.getDirectory(), [], entries);
            } catch {
                retainKinds.push('f-', 'd-');
                issues.push('OPFS');
            }
        } else {
            retainKinds.push('f-', 'd-');
            issues.push('OPFS');
        }

        const batch = await command({ action: 'begin', entries: [...entries.keys()], blocked, retainKinds });
        const digests = new Map();
        try {
            for (const [entry, blob] of entries) {
                const digest = await hashBlob(blob);
                digests.set(entry, digest);
                if (saved.get(entry) === digest) continue;
                for (let offset = 0; offset < blob.size; offset += FRAME_BYTES) {
                    const bytes = new Uint8Array(await blob.slice(offset, offset + FRAME_BYTES).arrayBuffer());
                    await command({ action: 'append', batch, entry, data: encodeBytesToBase64(bytes) });
                }
            }
            await command({ action: 'finish', batch });
            saved = digests;
        } catch (error) {
            await command({ action: 'abort', batch }).catch(() => {});
            saved.clear();
            throw error;
        }
        return issues;
    }

    async function restore() {
        const changes = await command({ action: 'pending' });
        const directories = [];
        for (const change of changes.filter(change => change.deleted)) {
            if (change.entry.startsWith('d-')) {
                directories.push({ change, entry: await loadEntry(change.entry) });
            } else {
                await restoreOne(change, await loadEntry(change.entry));
            }
        }
        // Delete an OPFS directory only after planned descendant removals.
        directories.sort((left, right) => right.entry.metadata.path.length - left.entry.metadata.path.length);
        for (const { change, entry } of directories) await restoreOne(change, entry);
        for (const change of changes.filter(change => !change.deleted)) {
            await restoreOne(change, await loadEntry(change.entry));
        }
    }

    async function loadEntry(entry) {
        const pieces = [];
        let offset = 0;
        for (;;) {
            const frame = await command({ action: 'read', entry, offset });
            const bytes = decodeBase64ToBytes(frame.data);
            if (bytes.byteLength === 0 && !frame.done) throw new Error('Browser storage stream stalled');
            pieces.push(bytes);
            offset += bytes.byteLength;
            if (frame.done) return decodeEntry(new Blob(pieces));
        }
    }

    async function restoreOne(change, entry) {
        const { metadata, binaries } = entry;
        switch (metadata.kind) {
            case 'localStorage': {
                if (typeof metadata.key !== 'string' || typeof metadata.value !== 'string' ||
                    !isPortableKey(metadata.key) || change.entry !== entryId('l', metadata.key)) {
                    throw new Error('Invalid localStorage entry');
                }
                if (change.deleted) localStorage.removeItem(metadata.key);
                else localStorage.setItem(metadata.key, metadata.value);
                break;
            }
            case 'indexedDB':
                if (change.entry !== entryId('i', metadata.name)) throw new Error('Invalid IndexedDB entry');
                await restoreDatabase(globalThis.indexedDB, metadata, binaries, change.deleted);
                break;
            case 'directory':
            case 'file':
                if (change.entry !== entryId(metadata.kind === 'directory' ? 'd' : 'f', metadata.path)) {
                    throw new Error('Invalid OPFS storage entry');
                }
                await restorePath(metadata, binaries, change.deleted);
                break;
            default:
                throw new Error('Unknown browser storage entry type');
        }
        await command({ action: 'acknowledge', entry: change.entry });
        saved.delete(change.entry);
    }

    return { capture, restore, reset: () => saved.clear() };
}

async function captureFileSystem(directory, parents, entries) {
    const children = [];
    for await (const [name, handle] of directory.entries()) children.push([name, handle]);
    children.sort(([left], [right]) => left.localeCompare(right));
    for (const [name, handle] of children) {
        const path = [...parents, name];
        if (handle.kind === 'directory') {
            entries.set(entryId('d', path), encodeEntry({ kind: 'directory', path }));
            await captureFileSystem(handle, path, entries);
        } else {
            entries.set(entryId('f', path), encodeEntry({ kind: 'file', path }, [await handle.getFile()]));
        }
    }
}

async function restorePath({ kind, path }, binaries, deleted) {
    if (!Array.isArray(path) || path.length === 0 || path.some(name => typeof name !== 'string' ||
        name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))) {
        throw new Error('Invalid OPFS path');
    }
    const name = path.at(-1);
    let directory = await navigator.storage.getDirectory();
    try {
        for (const parent of path.slice(0, -1)) directory = await directory.getDirectoryHandle(parent, { create: !deleted });
        if (deleted) {
            await directory.removeEntry(name);
        } else if (kind === 'directory') {
            await directory.getDirectoryHandle(name, { create: true });
        } else {
            if (binaries.length !== 1) throw new Error('Invalid OPFS file contents');
            const handle = await directory.getFileHandle(name, { create: true });
            const writer = await handle.createWritable();
            await binaries[0].stream().pipeTo(writer);
        }
    } catch (error) {
        if (deleted && error.name === 'NotFoundError') return;
        throw error;
    }
}
