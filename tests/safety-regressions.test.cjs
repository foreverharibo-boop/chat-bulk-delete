// Exercise the shipped adapter with simulated concurrent state changes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const fixtureCode = fs.readFileSync('tests/delete-scope.test.cjs', 'utf8').split('(async()=>{')[0];
const fixtures = { require, console, queueMicrotask, setTimeout, TextEncoder, Uint8Array, btoa, Buffer };
vm.createContext(fixtures);
vm.runInContext(fixtureCode + '\nglobalThis.makeFixture = fixture;', fixtures);
(async () => {
    const source = fs.readFileSync(fs.existsSync('batch.js') ? 'batch.js' : 'chat-bulk-delete/batch.js', 'utf8');
    const { deleteSelected } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const checks = [];
    async function check(name, test) {
        try { await test(); console.log('PASS:', name); }
        catch (error) { checks.push(name); console.error('FAIL:', name, error.message); }
    }
    await check('does not save an unselected open chat', async () => {
        const f = fixtures.makeFixture(false);
        let saves = 0;
        f.ctx.saveChat = async () => { saves++; };
        await deleteSelected(['전여친1'], f.runtime.scopeTarget(), f.runtime.scopeApi, () => {}, () => false);
        assert.equal(saves, 0);
    });
    await check('does not replace an unselected open chat missing from search', async () => {
        const f = fixtures.makeFixture(false);
        const original = f.ctx.chatId;
        f.stores['char:current.png'].delete(original);
        await deleteSelected(['전여친1'], f.runtime.scopeTarget(), f.runtime.scopeApi, () => {}, () => false);
        assert.equal(f.ctx.chatId, original);
    });
    await check('concurrent group removal cannot splice the last unselected entry', async () => {
        const f = fixtures.makeFixture(true);
        const chosen = f.currentNames[1];
        const unselected = f.currentNames.at(-1);
        const fetch = f.runtime.fetch;
        f.runtime.fetch = async (url, options) => {
            const response = await fetch(url, options);
            if (url === '/api/chats/group/delete') {
                const chats = f.ctx.groups[0].chats;
                chats.splice(chats.indexOf(chosen), 1);
            }
            return response;
        };
        await f.runtime.scopeApi.remove(f.runtime.scopeTarget(), chosen);
        assert.ok(f.ctx.groups[0].chats.includes(unselected));
    });
    await check('refuses a group file also referenced by another group', async () => {
        const f = fixtures.makeFixture(true);
        const chosen = f.currentNames[1];
        f.ctx.groups[1].chats.push(chosen);
        await assert.rejects(f.runtime.scopeApi.remove(f.runtime.scopeTarget(), chosen));
        assert.equal(f.calls.length, 0);
        assert.ok(f.stores['group:g1'].has(chosen));
    });
    for (const failure of ['archive-upload', 'index-upload', 'archive-path', 'archive-read', 'source-change']) {
        await check(`${failure} prevents every destructive request`, async () => {
            const f = fixtures.makeFixture(false);
            const fetch = f.runtime.fetch;
            let exports = 0;
            f.runtime.fetch = async (url, options) => {
                const body = options?.body ? JSON.parse(options.body) : {};
                if (url === '/api/files/upload' && ((failure === 'archive-upload' && body.name.includes('trash-'))
                    || (failure === 'index-upload' && body.name === 'cbd-v2-state.json'))) throw new Error('offline');
                const response = await fetch(url, options);
                if (failure === 'archive-path' && url === '/api/files/upload') response.json = async () => ({path:'/user/files/cbd-v2-wrong.json'});
                if (failure === 'archive-read' && url.startsWith('/user/files/cbd-v2-trash-')) response.text = async () => 'truncated';
                if (url === '/api/chats/export') {
                    exports++;
                    if (failure === 'source-change' && exports > 1) response.json = async () => ({result:'changed'});
                }
                return response;
            };
            const report = await deleteSelected(['전여친1'], f.runtime.scopeTarget(), f.runtime.scopeApi, () => {}, () => false);
            assert.equal(report.failed.length, 1);
            assert.equal(f.calls.length, 0);
            assert.ok(f.stores['char:current.png'].has('전여친1'));
        });
    }
    await check('context change during archive upload prevents deletion', async () => {
        const f = fixtures.makeFixture(false), fetch = f.runtime.fetch;
        f.runtime.fetch = async (url, options) => {
            const response = await fetch(url, options);
            if (url === '/api/files/upload') f.ctx.characterId = 1;
            return response;
        };
        const report = await deleteSelected(['전여친1'], f.runtime.scopeTarget(), f.runtime.scopeApi, () => {}, () => false);
        assert.equal(report.failed.length, 1); assert.equal(f.calls.length, 0);
    });
    await check('server-persisted lock prevents deletion after reload', async () => {
        const f = fixtures.makeFixture(false), t = f.runtime.scopeTarget();
        const vault = vm.runInContext('getVault()', f.runtime);
        await vault.setLock(t, '전여친1', true);
        const report = await deleteSelected(['전여친1'], t, f.runtime.scopeApi, () => {}, () => false);
        assert.equal(report.failed.length, 1); assert.equal(f.calls.length, 0);
    });
    await check('duplicate scan only reads current-scope chats; never saves, archives, selects or deletes', async () => {
        const f = fixtures.makeFixture(false);
        let saves = 0;
        f.ctx.saveChat = async () => { saves++; };
        const requests = [], fetch = f.runtime.fetch;
        f.runtime.fetch = async (url, options) => { requests.push({url,body:options?.body?JSON.parse(options.body):null}); return fetch(url,options); };
        await vm.runInContext('runDuplicateScan()', f.runtime);
        assert.equal(saves, 0); assert.equal(f.calls.length, 0); assert.equal(f.archiveFiles.size, 0);
        assert.ok(requests.every(r=>r.url==='/api/chats/search'||r.url==='/api/chats/export'));
        assert.ok(requests.every(r=>r.body.avatar_url==='current.png'));
        assert.equal(vm.runInContext('duplicateGroups.size', f.runtime), 4);
        assert.equal(vm.runInContext('selected.size', f.runtime), 0);
    });
    if (checks.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
