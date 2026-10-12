// Exercise the shipped adapter with simulated concurrent state changes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const fixtureCode = fs.readFileSync('tests/delete-scope.test.cjs', 'utf8').split('(async()=>{')[0];
const fixtures = { require, console, queueMicrotask };
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
    if (checks.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
