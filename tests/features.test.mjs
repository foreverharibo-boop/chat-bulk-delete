import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
const moduleFrom = async name => {
    const source = await readFile(new URL('../' + name, import.meta.url), 'utf8')
        .catch(() => readFile(new URL('../chat-bulk-delete/' + name, import.meta.url), 'utf8'));
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
};
const { ChatVault, scopeKey, parseChat } = await moduleFrom('vault.js');
const { makeZip, backupNames } = await moduleFrom('zip.js');
const { arrange } = await moduleFrom('view.js');
const t = { kind: 'character', avatar: 'a.png', id: 0, active: '현재' };
const other = { kind: 'character', avatar: 'b.png', id: 1, active: '현재' };
const group = { kind: 'group', id: 'g1', active: '현재' };
const raw = JSON.stringify({chat_metadata:{integrity:'kept',note:'한글'}})+'\n'+JSON.stringify({name:'김',mes:'보존해야 하는 대화 😊',swipes:['첫 번째','두 번째']})+'\n';
function setup() {
    const files = new Map(), chats = new Map(), calls = [];
    for (const scope of [t,other,group]) chats.set(scopeKey(scope)+'|현재',raw);
    const ctx = {characters:[{avatar:'a.png'},{avatar:'b.png'}],groups:[{id:'g1',chat_id:'현재',chats:['현재','다른 방'],past_metadata:{현재:{note:'group metadata'}}}],getRequestHeaders:()=>({})};
    let failure = '', corrupt = false;
    const fetcher = async path => ({ok:files.has(path),status:files.has(path)?200:404,text:async()=>corrupt?'bad':files.get(path)});
    const post = async (url, body) => {
        calls.push({url,body});
        if (failure && (url === failure || (failure === 'manifest' && body.name === 'cbd-v2-state.json'))) throw new Error('simulated offline');
        if(url === '/api/files/upload') {
            files.set('/user/files/'+body.name,Buffer.from(body.data,'base64').toString('utf8'));
            return {json:async()=>({path:'/user/files/'+body.name})};
        }
        if(url === '/api/files/delete') {
            assert.match(body.path, /^user\/files\/cbd-v2-trash-[a-f0-9]{32}\.json$/);
            const deleted = files.delete('/' + body.path);
            return {ok:deleted,status:deleted?200:404};
        }
        if(url === '/api/chats/export') {
            const scope=body.is_group ? scopeKey(group) : scopeKey({kind:'character',avatar:body.avatar_url});
            return {json:async()=>({result:chats.get(scope+'|'+body.file.slice(0,-6))})};
        }
        if(url === '/api/chats/save' || url === '/api/chats/group/save') {
            const scope=url.endsWith('/group/save')?scopeKey(group):scopeKey({kind:'character',avatar:body.avatar_url});
            const name=body.file_name??body.id;
            assert.ok(!chats.has(scope+'|'+name),'restore must never overwrite existing data');
            assert.equal(body.force,false);
            chats.set(scope+'|'+name,body.chat.map(x=>JSON.stringify(x)).join('\n'));
            return {json:async()=>({ok:true})};
        }
        if(url === '/api/groups/edit') return {json:async()=>({ok:true})};
        throw new Error('unexpected request: '+url);
    };
    const options={post,getContext:()=>ctx,fetcher};
    return {vault:new ChatVault(options),options,files,chats,calls,ctx,fail:value=>{failure=value;},corrupt:()=>{corrupt=true;}};
}
// Match the official /api/files/upload response and /user/files/* download route.
for (const prefix of ['/user/files/', 'user/files/']) {
    const f = setup();
    const post = async (url, body) => {
        const response = await f.options.post(url, body);
        return url === '/api/files/upload' ? {json:async()=>({path:prefix + body.name})} : response;
    };
    const vault = new ChatVault({...f.options, post});
    await vault.setLock(t, '다른 방', true);
    const entry = await vault.archive(t, '현재');
    const reloaded = new ChatVault({...f.options, post});
    await reloaded.load();
    assert.ok(reloaded.isLocked(t, '다른 방'));
    assert.equal(reloaded.state.entries[0].id, entry.id);
    assert.equal((await reloaded.readEntry(entry)).raw, raw);
    await reloaded.restore(entry);
    assert.equal(f.chats.get(scopeKey(t) + '|현재'), raw);
}
for (const path of ['/files/cbd-v2-check.json', '//evil.test/user/files/cbd-v2-check.json',
    'https://evil.test/user/files/cbd-v2-check.json', '/user/files/../cbd-v2-check.json',
    '/user/files/cbd-v2-check.json?x=1', '/user/files/other.json', null, {}]) {
    let reads = 0;
    const vault = new ChatVault({getContext:()=>({getRequestHeaders:()=>({})}),
        fetcher:async()=>{reads++; throw Error('must not read');}, post:async()=>({json:async()=>({path})})});
    await assert.rejects(vault.upload('cbd-v2-check.json', 'archive'), /저장 경로/);
    await assert.rejects(vault.read(path), /경로/);
    assert.equal(reads, 0);
}
console.log('PASS: official upload paths, server reload, locks, archive readback and restore; invalid paths rejected before fetch');
// Browser fetch requires Window as its receiver; arrow-only mocks hide this bug.
{
    const f = setup();
    const originalFetch = globalThis.fetch;
    const reads = [];
    globalThis.fetch = async function (path, options) {
        if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        reads.push(path);
        assert.equal(options.cache, 'no-store');
        assert.deepEqual(options.headers, f.ctx.getRequestHeaders());
        return f.options.fetcher(path, options);
    };
    try {
        const vault = new ChatVault({ post: f.options.post, getContext: f.options.getContext });
        await vault.load();
        assert.equal(vault.ready, true);
        await vault.setLock(t, '다른 방', true);
        const entry = await vault.archive(t, '현재');
        assert.equal((await vault.readEntry(entry)).raw, raw);
        await vault.restore(entry);
        assert.ok(reads.includes('/user/files/cbd-v2-state.json'));
        assert.ok(reads.includes(entry.path));
        assert.equal(f.chats.get(scopeKey(t) + '|현재'), raw);
        assert.equal(f.chats.get(scopeKey(other) + '|현재'), raw);
    } finally {
        globalThis.fetch = originalFetch;
    }
    console.log('PASS: default browser fetch keeps the global receiver for load, locks, archive verification and restore');
}
let f=setup();
await f.vault.setLock(t,'현재',true);
assert.ok(f.vault.isLocked(t,'현재'));
assert.equal(f.vault.isLocked(other,'현재'),false);
await assert.rejects(f.vault.archive(t,'현재'),/잠긴/);
await f.vault.renameLock(t,'현재','변경된 이름');
assert.ok(f.vault.isLocked(t,'변경된 이름'));assert.equal(f.vault.isLocked(t,'현재'),false);
const reloaded = new ChatVault(f.options);await reloaded.load();assert.ok(reloaded.isLocked(t,'변경된 이름'));
console.log('PASS: locks persist on server, follow renamed chats, and are scoped to exact character');
f=setup();
const entry=await f.vault.archive(t,'현재');
assert.equal((await f.vault.readEntry(entry)).raw,raw);
assert.ok(f.files.has('/user/files/cbd-v2-state.json'));
const beforeOther=f.chats.get(scopeKey(other)+'|현재');
await f.vault.mark(entry.id,'trashed');
const name=await f.vault.restore(entry);
assert.notEqual(name,'현재');assert.match(name,/복원/);
assert.deepEqual(parseChat(f.chats.get(scopeKey(t)+'|'+name)),parseChat(raw));
assert.equal(f.chats.get(scopeKey(t)+'|현재'),raw);
assert.equal(f.chats.get(scopeKey(other)+'|현재'),beforeOther);
assert.equal((await f.vault.readEntry(entry)).raw,raw);
assert.equal(f.vault.state.entries[0].status,'restored');
console.log('PASS: verified server archive, new-name restore, exact content, original/other-character files and archive preserved');
f=setup();let e=await f.vault.archive(group,'현재');await f.vault.restore(e);
assert.equal(f.ctx.groups[0].chats.length,3);
assert.deepEqual(f.ctx.groups[0].past_metadata[f.ctx.groups[0].chats.at(-1)],{note:'group metadata'});
console.log('PASS: group restore preserves group metadata and adds only the recovered chat');
for(const failure of ['/api/files/upload','manifest']) {
    f=setup();f.fail(failure);await assert.rejects(f.vault.archive(t,'현재'));
    assert.equal(f.chats.get(scopeKey(t)+'|현재'),raw);
}
f=setup();f.corrupt();await assert.rejects(f.vault.archive(t,'현재'));
f=setup();e=await f.vault.archive(t,'현재');f.fail('/api/chats/save');await assert.rejects(f.vault.restore(e));
assert.equal((await f.vault.readEntry(e)).raw,raw);
console.log('PASS: upload/index/read/restore failures keep original or archive intact');
const items=[{name:'방 10',index:0,count:10,size:200,locked:false},{name:'가나다',index:1,count:0,size:100,locked:true},{name:'방 2',index:2,count:2,size:300,locked:false}];
// Emptying one scope must never touch live/restored chats, other backups or locks.
{
    const f = setup();
    const first = await f.vault.archive(t, '현재');
    const second = await f.vault.archive(t, '현재');
    const otherEntry = await f.vault.archive(other, '현재');
    const groupEntry = await f.vault.archive(group, '현재');
    await f.vault.restore(first);
    await f.vault.setLock(other, '현재', true);
    const originalChats = [...f.chats], originalLocks = JSON.stringify(f.vault.state.locks);
    const callsBefore = f.calls.length;
    for (const entry of [first, second]) await f.vault.purgeEntry(t, entry);
    assert.deepEqual([...f.chats], originalChats);
    assert.equal(JSON.stringify(f.vault.state.locks), originalLocks);
    assert.deepEqual(f.vault.state.entries.map(x=>x.id), [otherEntry.id,groupEntry.id]);
    assert.ok(!f.files.has(first.path)); assert.ok(!f.files.has(second.path));
    assert.equal((await f.vault.readEntry(otherEntry)).raw, raw);
    assert.equal((await f.vault.readEntry(groupEntry)).raw, raw);
    assert.ok(f.calls.slice(callsBefore).every(x=>['/api/files/delete','/api/files/upload'].includes(x.url)));
}
for (const scenario of ['wrong-scope','wrong-path','changed-name','record-scope','offline','still-present','index-failure','cancelled']) {
    const f = setup(), entry = await f.vault.archive(t, '현재');
    const originalChats = [...f.chats];
    if (scenario === 'wrong-path') await f.vault.mutate(state=>{state.entries[0].path='/user/files/cbd-v2-state.json';});
    if (scenario === 'changed-name') await f.vault.mutate(state=>{state.entries[0].name='changed';});
    if (scenario === 'record-scope') {
        const record = JSON.parse(f.files.get(entry.path)); record.target = other;
        f.files.set(entry.path, JSON.stringify(record));
    }
    if (scenario === 'offline') f.fail('/api/files/delete');
    if (scenario === 'index-failure') f.fail('manifest');
    if (scenario === 'still-present') {
        const post = f.vault.post;
        f.vault.post = (url,body)=>url==='/api/files/delete'?Promise.resolve({ok:true}):post(url,body);
    }
    const before = f.calls.length;
    await assert.rejects(f.vault.purgeEntry(scenario==='wrong-scope'?other:t, entry,
        ()=>{if(scenario==='cancelled')throw Error('cancel');}));
    assert.deepEqual([...f.chats],originalChats);
    assert.ok(f.vault.state.entries.some(x=>x.id===entry.id));
    if (scenario !== 'index-failure') assert.ok(f.files.has(entry.path));
    if (['wrong-scope','wrong-path','changed-name','record-scope','cancelled'].includes(scenario)) {
        assert.ok(!f.calls.slice(before).some(x=>x.url==='/api/files/delete'));
    }
    if (scenario === 'index-failure') {
        assert.ok(!f.files.has(entry.path));
        f.fail('');
        await f.vault.purgeEntry(t,entry);
        assert.equal(f.vault.state.entries.length,0);
        assert.equal(f.calls.filter(x=>x.url==='/api/files/delete').length,1,'retry cleans only index');
    }
}
console.log('PASS: trash purge preserves live/restored/other-scope data and locks; stale/tampered paths, cancellation and server failures fail closed; index failure is retryable');
assert.deepEqual(arrange(items,{order:'name-asc'}).map(x=>x.name),['가나다','방 2','방 10']);
assert.deepEqual(arrange(items,{order:'name-desc'}).map(x=>x.name),['방 10','방 2','가나다']);
assert.deepEqual(arrange(items,{order:'oldest'}).map(x=>x.index),[2,1,0]);
assert.equal(arrange(items,{order:'size'})[0].name,'방 2');
assert.equal(arrange(items,{order:'messages'})[0].name,'방 10');
assert.deepEqual(arrange(items,{filter:'locked'}).map(x=>x.name),['가나다']);
assert.deepEqual(arrange(items,{filter:'empty'}).map(x=>x.name),['가나다']);
assert.equal(arrange(items,{name:'방',filter:'unlocked'}).length,2);
assert.deepEqual(arrange(items.map((item,i)=>({...item,duplicate:i<2})),{filter:'duplicates'}).map(x=>x.name),['방 10','가나다']);
console.log('PASS: Korean/numeric name ordering, reverse names, date/size/count sorts and combined filters');
const names=backupNames(['같은/이름','같은\\이름','한글 😊','CON','../경로','A','a']);
assert.equal(new Set(names.map(x=>x.toLowerCase())).size,names.length);
const texts=names.map((_,i)=>raw+'\n'+JSON.stringify({mes:'file '+i}));
const zip=makeZip(names.map((name,i)=>({name,text:texts[i]})));
const temp=await mkdtemp(join(tmpdir(),'cbd-zip-'));
try {
    await writeFile(join(temp,'backup.zip'),Buffer.from(await zip.arrayBuffer()));
    await writeFile(join(temp,'expected.json'),JSON.stringify({names,texts}));
    const result=spawnSync('python',['-c',`import json,zipfile,sys,pathlib
p=pathlib.Path(sys.argv[1]); expected=json.loads((p/'expected.json').read_text())
with zipfile.ZipFile(p/'backup.zip') as z:
 assert z.testzip() is None
 assert z.namelist()==expected['names']
 for n,t in zip(expected['names'],expected['texts']): assert z.read(n).decode('utf8')==t
print('PASS: Python zipfile independently verifies all separate UTF-8 JSONL entries and CRCs')`,temp],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);console.log(result.stdout.trim());
} finally {await rm(temp,{recursive:true,force:true});}
