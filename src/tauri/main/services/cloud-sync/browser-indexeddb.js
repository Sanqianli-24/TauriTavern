import { decodeGraph, encodeEntry, encodeGraph } from './browser-format.js';

const REGENERABLE_DATABASES = new Set(['SillyTavern_Thumbnails', 'SillyTavern_ChatCompletions']);

export async function browserDatabaseNames(factory) {
    if (typeof factory?.databases !== 'function') throw new Error('IndexedDB database listing is unavailable');
    const databases = await factory.databases();
    return databases.map(database => database.name)
        .filter(name => typeof name === 'string' && !REGENERABLE_DATABASES.has(name) && !name.startsWith('tt-cloud-restore:'))
        .sort();
}

export async function captureDatabase(factory, name) {
    const db = await openDatabase(factory, name, undefined, () => {
        throw new Error('Database was deleted during capture');
    });
    try {
        const names = Array.from(db.objectStoreNames);
        const tx = names.length ? db.transaction(names, 'readonly') : null;
        const done = tx ? transactionDone(tx) : Promise.resolve();
        const records = tx ? Promise.all(names.map(async storeName => {
            const store = tx.objectStore(storeName);
            return { ...schemaOf(store), records: await readRecords(store) };
        })) : Promise.resolve([]);
        const [stores] = await Promise.all([records, done]);
        const { root, nodes, binaries } = encodeGraph(stores);
        return encodeEntry({ kind: 'indexedDB', name, databaseVersion: db.version, root, nodes }, binaries);
    } finally {
        db.close();
    }
}

export async function restoreDatabase(factory, metadata, binaries, deleted) {
    const { name, databaseVersion, root, nodes } = metadata;
    if (typeof name !== 'string' || REGENERABLE_DATABASES.has(name) || name.startsWith('tt-cloud-restore:')) {
        throw new Error('Invalid IndexedDB database name');
    }
    if (deleted) {
        await deleteDatabase(factory, name);
        return;
    }
    if (!Number.isSafeInteger(databaseVersion) || databaseVersion < 1) throw new Error('Invalid IndexedDB version');
    const stores = await decodeGraph(root, nodes, binaries);
    const existing = (await factory.databases()).find(database => database.name === name);
    if (!existing) {
        await createDatabase(factory, name, databaseVersion, stores);
        return;
    }
    const db = await openDatabase(factory, name);
    try {
        if (db.version === databaseVersion && sameSchema(db, stores)) {
            const names = Array.from(db.objectStoreNames);
            if (names.length === 0) return;
            const tx = db.transaction(names, 'readwrite');
            const done = transactionDone(tx);
            try {
                for (const store of stores) {
                    const target = tx.objectStore(store.name);
                    target.clear();
                    putRecords(target, store.records);
                }
            } catch (error) {
                tx.abort();
                await done.catch(() => {});
                throw error;
            }
            await done;
            return;
        }
    } finally {
        db.close();
    }
    if (existing.version < databaseVersion) {
        // A version-change transaction can replace the schema and records atomically.
        await createDatabase(factory, name, databaseVersion, stores);
        return;
    }
    // IDB cannot downgrade in place. Prove the new schema and records can open
    // before deleting the old database. The cloud inbox remains until success.
    const staging = `tt-cloud-restore:${crypto.randomUUID()}`;
    try {
        await createDatabase(factory, staging, databaseVersion, stores);
        await deleteDatabase(factory, name);
        await createDatabase(factory, name, databaseVersion, stores);
    } finally {
        await deleteDatabase(factory, staging);
    }
}

function schemaOf(store) {
    return {
        name: store.name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames, name => {
            const index = store.index(name);
            return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
        }),
    };
}

function sameSchema(db, stores) {
    const names = Array.from(db.objectStoreNames);
    if (!names.length) return stores.length === 0;
    const tx = db.transaction(names, 'readonly');
    const existing = names.map(name => schemaOf(tx.objectStore(name)));
    const restored = stores.map(({ name, keyPath, autoIncrement, indexes }) => ({ name, keyPath, autoIncrement, indexes }));
    return JSON.stringify(existing) === JSON.stringify(restored);
}

function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
}

function readRecords(store) {
    return new Promise((resolve, reject) => {
        const records = [];
        const request = store.openCursor();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
                resolve(records);
                return;
            }
            records.push([cursor.primaryKey, cursor.value]);
            cursor.continue();
        };
    });
}

function openDatabase(factory, name, version, upgrade) {
    return new Promise((resolve, reject) => {
        const request = factory.open(name, version);
        let error;
        request.onblocked = () => {
            error = new Error('Close other views using this IndexedDB database');
            reject(error);
        };
        request.onupgradeneeded = () => {
            try {
                if (error) throw error;
                upgrade?.(request.result, request.transaction);
            } catch (cause) {
                error = cause;
                request.transaction.abort();
            }
        };
        request.onerror = () => reject(error ?? request.error);
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            if (error) db.close();
            else resolve(db);
        };
    });
}

function deleteDatabase(factory, name) {
    return new Promise((resolve, reject) => {
        const request = factory.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Close other views using this IndexedDB database'));
    });
}

async function createDatabase(factory, name, version, stores) {
    const db = await openDatabase(factory, name, version, database => {
        for (const storeName of Array.from(database.objectStoreNames)) database.deleteObjectStore(storeName);
        for (const store of stores) {
            const target = database.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
            for (const index of store.indexes) target.createIndex(index.name, index.keyPath, index);
            putRecords(target, store.records);
        }
    });
    db.close();
}

function putRecords(store, records) {
    for (const [key, value] of records) {
        if (store.keyPath === null) store.put(value, key);
        else store.put(value);
    }
}
