const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const VIEWS = new Map([
    DataView, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
].map(Type => [Type.name, Type]));

export function encodeEntry(metadata, binaries = []) {
    const text = new TextEncoder().encode(JSON.stringify({
        version: 1,
        ...metadata,
        sizes: binaries.map(part => part.size),
    }));
    if (text.byteLength > MAX_HEADER_BYTES) throw new Error('Browser storage metadata is too large');
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, text.byteLength);
    return new Blob([prefix, text, ...binaries]);
}

export async function decodeEntry(blob) {
    if (blob.size < 4) throw new Error('Incomplete browser storage entry');
    const length = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0);
    if (length > MAX_HEADER_BYTES || length + 4 > blob.size) throw new Error('Invalid browser storage entry length');
    const metadata = JSON.parse(await blob.slice(4, 4 + length).text());
    if (metadata.version !== 1 || !Array.isArray(metadata.sizes)) throw new Error('Unsupported browser storage format');
    let offset = 4 + length;
    const binaries = metadata.sizes.map(size => {
        if (!Number.isSafeInteger(size) || size < 0 || size > blob.size - offset) throw new Error('Invalid browser storage attachment');
        const part = blob.slice(offset, offset + size);
        offset += size;
        return part;
    });
    if (offset !== blob.size) throw new Error('Unexpected browser storage attachment');
    return { metadata, binaries };
}

// Preserve IndexedDB's structured-clone types and references, with binary
// values streamed alongside the JSON metadata.
export function encodeGraph(root) {
    const nodes = [];
    const binaries = [];
    const seen = new Map();
    const addBinary = value => binaries.push(value) - 1;
    const properties = value => Object.entries(value).map(([key, item]) => [key, visit(item)]);

    function visit(value) {
        if (seen.has(value)) return seen.get(value);
        const id = nodes.length;
        nodes.push(null);
        if (value !== null && typeof value === 'object') seen.set(value, id);
        nodes[id] = describe(value);
        return id;
    }

    function describe(value) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return ['value', value];
        if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
        if (typeof value === 'bigint') return ['bigint', String(value)];
        if (typeof value === 'undefined') return ['undefined'];
        if (Array.isArray(value)) return ['array', value.length, properties(value)];
        if (value instanceof Date) return ['date', String(value.valueOf())];
        if (value instanceof RegExp) return ['regexp', value.source, value.flags];
        if (value instanceof Map) return ['map', Array.from(value, ([key, item]) => [visit(key), visit(item)])];
        if (value instanceof Set) return ['set', Array.from(value, visit)];
        if (value instanceof File) return ['file', addBinary(value), value.name, value.type, value.lastModified];
        if (value instanceof Blob) return ['blob', addBinary(value), value.type];
        if (value instanceof ArrayBuffer) return ['buffer', addBinary(new Blob([value]))];
        if (ArrayBuffer.isView(value) && VIEWS.has(value.constructor.name)) {
            return ['view', value.constructor.name, visit(value.buffer), value.byteOffset, value instanceof DataView ? value.byteLength : value.length];
        }
        if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
            return ['object', properties(value)];
        }
        throw new Error(`Unsupported IndexedDB value (${Object.prototype.toString.call(value)})`);
    }

    return { root: visit(root), nodes, binaries };
}

export async function decodeGraph(root, nodes, binaries) {
    if (!Array.isArray(nodes)) throw new Error('Invalid IndexedDB storage graph');
    const values = [];
    function attachment(id) {
        const part = binaries[id];
        if (!part) throw new Error('Missing IndexedDB attachment');
        return part;
    }
    for (const [tag, first, second, third, fourth] of nodes) {
        switch (tag) {
            case 'value': values.push(first); break;
            case 'number': values.push(Number(first)); break;
            case 'bigint': values.push(BigInt(first)); break;
            case 'undefined': case 'view': values.push(undefined); break;
            case 'date': values.push(new Date(Number(first))); break;
            case 'regexp': values.push(new RegExp(first, second)); break;
            case 'array': values.push(new Array(first)); break;
            case 'object': values.push({}); break;
            case 'map': values.push(new Map()); break;
            case 'set': values.push(new Set()); break;
            case 'buffer': values.push(await attachment(first).arrayBuffer()); break;
            case 'blob': values.push(attachment(first).slice(0, undefined, second)); break;
            case 'file': values.push(new File([attachment(first)], second, { type: third, lastModified: fourth })); break;
            default: throw new Error('Unsupported IndexedDB value format');
        }
    }

    for (const [index, [tag, name, reference, offset, length]] of nodes.entries()) {
        if (tag === 'view') {
            const Type = VIEWS.get(name);
            if (!Type || !(values[reference] instanceof ArrayBuffer)) throw new Error('Invalid IndexedDB binary view');
            values[index] = new Type(values[reference], offset, length);
        }
    }
    const at = id => {
        if (!Number.isSafeInteger(id) || id < 0 || id >= values.length) throw new Error('Invalid IndexedDB reference');
        return values[id];
    };
    const property = (value, key, ref) => Object.defineProperty(value, key, {
        value: at(ref), enumerable: true, writable: true, configurable: true,
    });
    for (const [index, [tag, first, second]] of nodes.entries()) {
        const value = values[index];
        switch (tag) {
            case 'array': for (const [key, ref] of second) property(value, key, ref); break;
            case 'object': for (const [key, ref] of first) property(value, key, ref); break;
            case 'map': for (const [key, ref] of first) value.set(at(key), at(ref)); break;
            case 'set': for (const ref of first) value.add(at(ref)); break;
        }
    }
    return at(root);
}
