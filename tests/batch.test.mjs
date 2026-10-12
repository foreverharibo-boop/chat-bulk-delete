import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../batch.js', import.meta.url), 'utf8')
    .catch(() => readFile(new URL('../chat-bulk-delete/batch.js', import.meta.url), 'utf8'));
const { deleteSelected } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const make = () => {
    const calls = [];
    const api = {
        sameTarget: () => true, isGenerating: () => false, currentChat: () => 'active',
        saveChat: async () => calls.push('save'), listNames: async () => ['a', 'b', 'active'],
        remove: async (_, n) => calls.push(`remove:${n}`),
        afterDelete: async (_, n) => calls.push(`after:${n}`), finish: async () => calls.push('finish'),
    };
    return { api, calls };
};
let t = make();
let r = await deleteSelected(['active', 'a', 'a', 'b'], { active:'active' }, t.api, () => {}, () => false);
assert.deepEqual(r.deleted, ['a', 'b', 'active']);
assert.deepEqual(t.calls, ['save', 'remove:a', 'after:a', 'remove:b', 'after:b', 'remove:active', 'after:active', 'finish']);
t = make();
t.api.remove = async (_, n) => { if (n === 'a') throw new Error('HTTP 500'); };
r = await deleteSelected(['a', 'b', 'missing'], { active:'active' }, t.api, () => {}, () => false);
assert.deepEqual(r.deleted, ['b']); assert.equal(r.failed.length, 2);
t = make(); let stop = false;
t.api.afterDelete = async () => { stop = true; };
r = await deleteSelected(['a', 'b'], { active:'active' }, t.api, () => {}, () => stop);
assert.deepEqual(r.deleted, ['a']); assert.equal(r.stopped, true); assert.ok(t.calls.includes('finish'));
t = make(); t.api.afterDelete = async () => { throw new Error('UI error'); };
r = await deleteSelected(['a'], { active:'active' }, t.api, () => {}, () => false);
assert.deepEqual(r.deleted, ['a']); assert.equal(r.failed.length, 0); assert.equal(r.warnings.length, 1);
t = make(); t.api.sameTarget = () => false;
await assert.rejects(deleteSelected(['a'], { active:'active' }, t.api, () => {}, () => false));
assert.equal(t.calls.length, 0);
t = make(); t.api.isGenerating = () => true;
await assert.rejects(deleteSelected(['a'], { active:'active' }, t.api, () => {}, () => false));
assert.equal(t.calls.length, 0);
t = make(); let valid = true; t.api.sameTarget = () => valid;
t.api.afterDelete = async () => { valid = false; };
r = await deleteSelected(['a', 'b'], { active:'active' }, t.api, () => {}, () => false);
assert.deepEqual(r.deleted, ['a']); assert.equal(r.stopped, true); assert.ok(t.calls.includes('finish'));
console.log('PASS: ordered deletion, deduplication, failures, missing files, stop, UI errors, target changes, generation guard');
