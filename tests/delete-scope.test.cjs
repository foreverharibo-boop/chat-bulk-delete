// Verify the delivered implementation only deletes exact selected files in its captured scope.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const vaultSource = fs.readFileSync(fs.existsSync('vault.js') ? 'vault.js' : 'chat-bulk-delete/vault.js', 'utf8').replace(/^export /gm, '');
const source = vaultSource + '\n' + fs.readFileSync(fs.existsSync('index.js') ? 'index.js' : 'chat-bulk-delete/index.js', 'utf8').replace(/^import .*;\n/gm, '');
const names = ['현재 방', '전여친1', '김홍진 - imported', '전여친1 - Branch #1'];
function fixture(isGroup) {
    const stores = {
        'char:current.png': new Set(names), 'char:other.png': new Set(names),
        'group:g1': new Set(names.map(n => `g1-${n}`)),
        'group:g2': new Set(names.map(n => `g2-${n}`)),
        presets: new Set(['preset.json']), lorebooks: new Set(['world.json']), characters: new Set(['current.png','other.png']),
    };
    const currentNames = isGroup ? names.map(n => `g1-${n}`) : names;
    const calls = [];
    const archiveFiles = new Map();
    const raw = JSON.stringify({chat_metadata:{integrity:'fixture'}})+'\n'+JSON.stringify({name:'fixture',mes:'preserve me'});
    const ctx = {
        characterId:0, groupId:isGroup?'g1':null,
        characters:[{avatar:'current.png', chat:names[0]}, {avatar:'other.png',chat:names[0]}],
        groups:[{id:'g1',chat_id:currentNames[0],chats:[...currentNames]},{id:'g2',chat_id:`g2-${names[0]}`,chats:names.map(n=>`g2-${n}`)}],
        get chatId() { return this.groupId ? this.groups.find(g=>g.id===this.groupId).chat_id : this.characters[this.characterId].chat; },
        get chat() { return [{name:'fixture',mes:'preserve me'}]; },
        getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}), saveChat:async()=>{},
        eventTypes:{CHAT_DELETED:'deleted',GROUP_CHAT_DELETED:'group-deleted'},eventSource:{emit:async()=>{}},
    };
    let switchAfterList = false;
    const runtime = {
        console, Set, Element:class{}, queueMicrotask, TextEncoder, Uint8Array, btoa, crypto:require('node:crypto').webcrypto,
        document:{readyState:'loading',addEventListener(){}},getContext:()=>ctx,
        ST:{isGenerating:()=>false,displayPastChats:async()=>{},replaceCurrentChat:async()=>{ctx.characters[0].chat=[...stores['char:current.png']][0]||'new';}},
        Group:{editGroup:async()=>{},openGroupChat:async(id,n)=>{ctx.groups.find(g=>g.id===id).chat_id=n;},createNewGroupChat:async(id)=>{const g=ctx.groups.find(g=>g.id===id);g.chat_id='new';g.chats.push('new');}},
        fetch:async(url, opts)=>{
            if (url.startsWith('/files/')) return {ok:archiveFiles.has(url),status:archiveFiles.has(url)?200:404,text:async()=>archiveFiles.get(url)};
            const body = JSON.parse(opts.body);
            if(url === '/api/files/upload') { const path='/files/'+body.name; archiveFiles.set(path,Buffer.from(body.data,'base64').toString('utf8')); return {ok:true,json:async()=>({path})}; }
            if(url === '/api/chats/export') return {ok:true,json:async()=>({result:raw})};
            if (url === '/api/chats/search') {
                const scope = body.group_id ? `group:${body.group_id}` : `char:${body.avatar_url}`;
                const result = [...stores[scope]].map(file_name=>({file_name}));
                if(switchAfterList) {ctx.groupId=null;ctx.characterId=1;}
                return {ok:true,json:async()=>result};
            }
            assert.ok(['/api/chats/delete','/api/chats/group/delete'].includes(url), `unexpected mutation: ${url}`);
            let scope, name;
            if (url === '/api/chats/delete') {scope=`char:${body.avatar_url}`;assert.ok(body.chatfile.endsWith('.jsonl'));name=body.chatfile.slice(0,-6);}
            else {name=body.id;scope=Object.keys(stores).find(k=>k.startsWith('group:')&&stores[k].has(name));}
            calls.push({scope,name});
            const deleted=stores[scope]?.delete(name);
            return {ok:Boolean(deleted),status:deleted?200:400,json:async()=>({ok:Boolean(deleted)})};
        },
    };
    vm.createContext(runtime);
    vm.runInContext(source+'\nglobalThis.scopeApi=api;globalThis.scopeTarget=captureTarget;',runtime);
    return {stores,calls,ctx,runtime,currentNames,archiveFiles,switchAfterList:()=>{switchAfterList=true;}};
}
(async()=>{
    const batch = fs.readFileSync(fs.existsSync('batch.js') ? 'batch.js' : 'chat-bulk-delete/batch.js','utf8');
    const { deleteSelected } = await import('data:text/javascript;base64,'+Buffer.from(batch).toString('base64'));
    let combinations = 0;
    for(const isGroup of [false,true]) {
        for(let mask=0;mask<16;mask++) {
            const f=fixture(isGroup);
            const selected=f.currentNames.filter((_,i)=>mask&(1<<i));
            const expectedScope=isGroup?'group:g1':'char:current.png';
            const before=Object.fromEntries(Object.entries(f.stores).map(([k,v])=>[k,[...v]]));
            const report=await deleteSelected(selected,f.runtime.scopeTarget(),f.runtime.scopeApi,()=>{},()=>false);
            assert.equal(report.failed.length,0);
            assert.equal(f.calls.length,selected.length);
            assert.deepEqual([...f.calls.map(c=>c.name)].sort(),[...selected].sort());
            assert.ok(f.calls.every(c=>c.scope===expectedScope&&selected.includes(c.name)));
            assert.deepEqual([...f.stores[expectedScope]],f.currentNames.filter(n=>!selected.includes(n)));
            for(const [scope,original] of Object.entries(before)) {
                if(scope!==expectedScope) assert.deepEqual([...f.stores[scope]],original,scope);
            }
            combinations++;
        }
    }
    // Stale/injected name belonging exclusively to another scope is never sent for deletion.
    let f=fixture(false);f.stores['char:other.png'].add('다른 캐릭터 전용 방');
    let r=await deleteSelected(['전여친1','다른 캐릭터 전용 방'],f.runtime.scopeTarget(),f.runtime.scopeApi,()=>{},()=>false);
    assert.deepEqual(f.calls,[{scope:'char:current.png',name:'전여친1'}]);assert.equal(r.failed.length,1);
    assert.ok(f.stores['char:other.png'].has('다른 캐릭터 전용 방'));
    // Duplicates must not expand deletion scope or repeat requests.
    f=fixture(false);r=await deleteSelected(['전여친1','전여친1'],f.runtime.scopeTarget(),f.runtime.scopeApi,()=>{},()=>false);
    assert.equal(f.calls.length,1);assert.equal(r.deleted.length,1);
    // Switching character after the list returns must abort all deletions.
    f=fixture(false);f.switchAfterList();
    r=await deleteSelected(['전여친1'],f.runtime.scopeTarget(),f.runtime.scopeApi,()=>{},()=>false);
    assert.equal(f.calls.length,0);assert.equal(r.stopped,true);
    console.log(`PASS: ${combinations} exhaustive selection combinations; unselected files, same-named chats in other characters, other groups, character files, presets and lorebooks all preserved`);
    console.log('PASS: empty selection, duplicate selection, unavailable/other-scope filename, context change before deletion');
})().catch(e=>{console.error(e);process.exit(1);});
