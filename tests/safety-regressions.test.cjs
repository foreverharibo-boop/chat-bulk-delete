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
    await check('active chat export failure or state change prevents deletion', async () => {
        for (const scenario of ['read-failure','changed-content','scope-change','generation','stop']) {
            const f = fixtures.makeFixture(false), fetch = f.runtime.fetch;
            f.runtime.fetch = async (url,options) => {
                if (url === '/api/chats/export' && scenario === 'read-failure') throw Error('offline');
                const response = await fetch(url,options);
                if(url === '/api/chats/export') {
                    if(scenario === 'changed-content') response.json=async()=>({result:JSON.stringify({mes:'different'})});
                    if(scenario === 'scope-change') f.ctx.characterId=1;
                    if(scenario === 'generation') f.runtime.ST.isGenerating=()=>true;
                    if(scenario === 'stop') vm.runInContext('stopRequested=true',f.runtime);
                }
                return response;
            };
            await assert.rejects(f.runtime.scopeApi.remove(f.runtime.scopeTarget(), f.ctx.chatId));
            assert.equal(f.calls.length,0);
        }
    });
    await check('legacy trash and lock files are untouched and not loaded by deletion or duplicate scans', async () => {
        const f = fixtures.makeFixture(false);
        f.archiveFiles.set('/user/files/cbd-v2-state.json', '{"locks":{"old":"locked"}}');
        f.archiveFiles.set('/user/files/cbd-v2-trash-old.json', 'saved conversation');
        const before=[...f.archiveFiles],fetch=f.runtime.fetch;
        f.runtime.fetch=async(url,options)=>{
            assert.ok(!url.startsWith('/user/files/')&&!url.startsWith('/api/files/'));
            return fetch(url,options);
        };
        await vm.runInContext('runDuplicateScan()',f.runtime);
        await deleteSelected(['전여친1'],f.runtime.scopeTarget(),f.runtime.scopeApi,()=>{},()=>false);
        assert.equal(f.calls.length,1);assert.deepEqual([...f.archiveFiles],before);
    });
    await check('permanent confirmation cancels without deletion; confirmed operation skips trash; changed selection aborts', async () => {
        for (const scenario of ['cancel','confirm','selection-change','scope-change']) {
            const f = fixtures.makeFixture(false);
            f.runtime.document.createElement = tag => ({tag,children:[],append(...children){this.children.push(...children);}});
            f.runtime.POPUP_TYPE = {CONFIRM:1,TEXT:2}; f.runtime.POPUP_RESULT = {AFFIRMATIVE:1};
            f.runtime.deleteSelected = deleteSelected;
            f.runtime.callGenericPopup = async (content,type,text,options) => {
                assert.equal(type,1); assert.match(options.okButton,/영구 삭제/);
                assert.match(content.children[1].textContent,/휴지통에 보관하지 않고/);
                assert.deepEqual(content.children[2].children.map(x=>x.textContent),['전여친1']);
                if(scenario==='selection-change') vm.runInContext("selected.add('김홍진 - imported')",f.runtime);
                if(scenario==='scope-change') f.ctx.characterId=1;
                return scenario==='cancel'?0:1;
            };
            vm.runInContext("render=()=>{};target=captureTarget();selected.add('전여친1');toolbar={querySelector:()=>({focus(){}})};list={querySelectorAll:()=>[{querySelector:()=>({getAttribute:()=> '전여친1'})}]};",f.runtime);
            await vm.runInContext('runDelete()',f.runtime);
            assert.equal(f.calls.length,scenario==='confirm'?1:0);
            assert.equal(f.archiveFiles.size,0);
        }
    });
    if (checks.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
