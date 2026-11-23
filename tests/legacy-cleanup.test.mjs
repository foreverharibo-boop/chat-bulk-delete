import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../chat-data.js', import.meta.url), 'utf8');
const { cleanupLegacyTrash } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const statePath = 'user/files/cbd-v2-state.json';
function fixture() {
    const entries = ['a', 'b'].map((c, i) => ({ id: c.repeat(32), name: `old ${i}`,
        path: `${i ? '/' : ''}user/files/cbd-v2-trash-${c.repeat(32)}.json`,
        target: i ? { kind: 'group', id: 123 } : { kind: 'character', avatar: 'a.png' },
        status: i ? 'restored' : 'prepared' }));
    const files = new Map(entries.map(e => [e.path.replace(/^\//, ''), JSON.stringify({ ...e, version: 2, raw: 'saved chat' })]));
    files.set(statePath, JSON.stringify({ version: 2, entries, locks: { old: true } }));
    files.set('user/files/unrelated.json', 'keep');
    files.set('chats/a.png/live.jsonl', 'keep live chat');
    const calls = [];
    const options = {
        headers: () => ({ 'X-CSRF-Token': 'test' }),
        fetcher: async (url, opts) => {
            assert.equal(opts.cache, 'no-store'); assert.equal(opts.headers['X-CSRF-Token'], 'test');
            const path = url.slice(1);
            return { ok: files.has(path), status: files.has(path) ? 200 : 404, text: async () => files.get(path) };
        },
        post: async (url, body) => {
            assert.equal(url, '/api/files/delete');
            assert.match(body.path, /^user\/files\/cbd-v2-(state|trash-[a-f0-9]{32})\.json$/);
            calls.push(body.path); files.delete(body.path); return { ok: true };
        },
    };
    return { files, calls, entries, options };
}
let f = fixture();
assert.deepEqual(await cleanupLegacyTrash(f.options), { deleted: 2, cleaned: true });
assert.equal(f.calls.at(-1), statePath);
assert.deepEqual([...f.files.keys()], ['user/files/unrelated.json', 'chats/a.png/live.jsonl']);
assert.deepEqual(await cleanupLegacyTrash(f.options), { deleted: 0, cleaned: false });
assert.equal(f.calls.length, 3);

// Failure preserves the index; retry tolerates already-deleted backups.
for (const failure of ['offline', 'silent-success', 'lost-response']) {
    f = fixture(); const post = f.options.post; let n = 0;
    f.options.post = async (...args) => {
        if (++n === 2) {
            if (failure === 'silent-success') return { ok: true };
            if (failure === 'lost-response') await post(...args);
            throw Error('offline');
        }
        return post(...args);
    };
    await assert.rejects(cleanupLegacyTrash(f.options));
    assert.ok(f.files.has(statePath));
    f.options.post = post;
    await cleanupLegacyTrash(f.options);
    assert.equal(f.files.size, 2);
}
for (const corrupt of ['path', 'id', 'version', 'duplicate', 'record', 'json', 'read-error']) {
    f = fixture();
    const state = JSON.parse(f.files.get(statePath));
    if (corrupt === 'path') state.entries[0].path = 'user/files/../../chats/live.jsonl';
    if (corrupt === 'id') state.entries[0].id = '../other';
    if (corrupt === 'version') state.version = 99;
    if (corrupt === 'duplicate') state.entries.push(state.entries[0]);
    f.files.set(statePath, corrupt === 'json' ? 'broken' : JSON.stringify(state));
    if (corrupt === 'record') f.files.set(f.entries[0].path, JSON.stringify({ version: 2, id: 'wrong' }));
    if (corrupt === 'read-error') f.options.fetcher = async () => ({ ok: false, status: 403 });
    await assert.rejects(cleanupLegacyTrash(f.options));
    assert.equal(f.calls.length, 0);
}
f = fixture();
const fetcher = f.options.fetcher;
f.options.fetcher = async (url, opts) => {
    if (url.includes('trash-')) f.files.set(statePath, f.files.get(statePath) + ' ');
    return fetcher(url, opts);
};
await assert.rejects(cleanupLegacyTrash(f.options));
assert.equal(f.calls.length, 0);

// Startup invokes migration once even without an open character/history popup.
const index = (await readFile(new URL('../index.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
for (const failure of [false, true]) {
    let started = 0, warning = 0;
    const runtime = { document: { readyState: 'complete', getElementById: () => null },
        cleanupLegacyTrash: async () => { started++; if (failure) throw Error('offline'); return { cleaned: false }; },
        toastr: { warning: () => warning++ } };
    vm.createContext(runtime); vm.runInContext(index, runtime); vm.runInContext('initialize()', runtime);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 1); assert.equal(warning, failure ? 1 : 0);
}
console.log('PASS: startup cleanup, exact backup paths, unrelated/live-file preservation, idempotency, partial-failure retry, corruption and concurrent-index guards');
