import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = await readFile(new URL('../duplicates.js', import.meta.url), 'utf8')
    .catch(() => readFile(new URL('../chat-bulk-delete/duplicates.js', import.meta.url), 'utf8'));
const { conversationContent, findDuplicateChats } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const hash = s => createHash('sha256').update(s).digest('hex');
const message = {name:'홍진',is_user:false,is_system:false,mes:'같은 대화\n공백도 유지',swipes:['같은 대화\n공백도 유지','다른 답변'],swipe_id:0,extra:{display_text:'번역',file:'file.txt'}};
const file = (messages, header={chat_metadata:{id:1}}) => [header,...messages].map(x=>JSON.stringify(x)).join('\n');
const a = file([{...message,send_date:'yesterday',gen_started:100,gen_finished:101}]);
const b = file([{gen_finished:203,...message,send_date:'today',gen_started:200}],{chat_metadata:{id:2,branch:'new'}});
assert.equal(conversationContent(a),conversationContent(b));
assert.equal(conversationContent(a),conversationContent('\uFEFF'+a.replace(/\n/g,'\r\n')+'\r\n'));
for (const change of [
    {mes:message.mes+' '}, {name:'다른 사람'}, {is_user:true}, {is_system:true},
    {swipes:[message.mes,'새 답변']}, {swipe_id:1}, {extra:{display_text:'다른 번역',file:'file.txt'}},
]) assert.notEqual(conversationContent(a),conversationContent(file([{...message,...change}])));
assert.notEqual(conversationContent(a),conversationContent(file([message,{...message,mes:'분기 이후'}])));
assert.notEqual(conversationContent(file([message,{...message,mes:'두 번째'}])),conversationContent(file([{...message,mes:'두 번째'},message])));
assert.throws(()=>conversationContent('not json'));
assert.throws(()=>conversationContent(''));
console.log('PASS: full ordered conversation comparison; headers/timing ignored, text/speaker/role/swipes/translation differences preserved');
const texts = {a,b,c:file([{...message,mes:'분기 이후 달라짐'}]),d:file([{...message,mes:'분기 이후 달라짐'}]),broken:'invalid'};
const read = async name => texts[name];
let result = await findDuplicateChats(Object.keys(texts),read,{hash});
assert.deepEqual(result.groups,[['a','b'],['c','d']]);assert.equal(result.failed.length,1);
// Deliberately collide every fingerprint: exact comparison must still separate groups.
result=await findDuplicateChats(['a','b','c','d'],read,{hash:()=> 'same-hash'});
assert.deepEqual(result.groups,[['a','b'],['c','d']]);
let stop=false;
result=await findDuplicateChats(['a','b','c'],read,{hash,shouldStop:()=>stop,progress:done=>{if(done===2)stop=true;}});
assert.equal(result.stopped,true);assert.deepEqual(result.groups,[]);
let valid=true;
await assert.rejects(findDuplicateChats(['a','b'],async name=>{const raw=await read(name);valid=false;return raw;},{hash,assertContext:()=>{if(!valid)throw Error('context changed');}}));
let readA=0;
result=await findDuplicateChats(['a','b','c'],async name=>name==='a'&&++readA>1?texts.c:read(name),{hash});
assert.deepEqual(result.groups,[]);assert.equal(result.failed.length,1);
console.log('PASS: duplicate groups, corrupt-file exclusion, hash collision verification, cancelled/context-changed scan and changing reference');
