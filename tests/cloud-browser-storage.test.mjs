import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeEntry, decodeGraph, encodeEntry, encodeGraph } from '../src/tauri/main/services/cloud-sync/browser-format.js';

test('extension storage round-trips IndexedDB records with shared buffers, binary files and cycles', async () => {
    const buffer = new Uint8Array([0, 1, 2, 255]);
    const value = {
        view: new Uint8Array(buffer.buffer, 1, 2),
        buffer: buffer.buffer,
        date: new Date('2026-01-02T03:04:05Z'),
        attachment: new File(['test file'], 'save.txt', { type: 'text/plain', lastModified: 12 }),
        keys: new Map(),
        sparse: [1, , undefined],
        number: -0,
    };
    value.keys.set(value, new Set([4n]));
    const { root, nodes, binaries } = encodeGraph(value);
    const archive = encodeEntry({ kind: 'indexedDB', name: 'Test extension', root, nodes }, binaries);
    const decoded = await decodeEntry(archive);
    const restored = await decodeGraph(decoded.metadata.root, decoded.metadata.nodes, decoded.binaries);

    assert.equal(restored.view.buffer, restored.buffer);
    assert.deepEqual([...restored.view], [1, 2]);
    assert.deepEqual(restored.date, value.date);
    assert.equal(await restored.attachment.text(), 'test file');
    assert.equal(restored.attachment.name, 'save.txt');
    assert.equal(restored.attachment.type, 'text/plain');
    assert.equal(restored.attachment.lastModified, 12);
    assert.deepEqual(restored.keys.get(restored), new Set([4n]));
    assert.equal(1 in restored.sparse, false);
    assert.equal(2 in restored.sparse, true);
    assert.equal(Object.is(restored.number, -0), true);
});

test('device-bound IndexedDB values and truncated attachments fail before restoration', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    assert.throws(() => encodeGraph({ key }), /Unsupported IndexedDB value/);
    const entry = encodeEntry({ kind: 'file', path: ['extension', 'data.bin'] }, [new Blob([new Uint8Array([10, 20])])]);
    await assert.rejects(decodeEntry(entry.slice(0, entry.size - 1)), /Invalid browser storage attachment/);
});
