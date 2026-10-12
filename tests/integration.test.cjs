const vm = require('vm');
const fs = require('fs');
const assert = require('assert/strict');
const src = fs.readFileSync(fs.existsSync('index.js') ? 'index.js' : 'chat-bulk-delete/index.js','utf8').replace(/^import .*;\n/gm,'');
function setup(groupMode=false) {
 const disk=new Set(['active','a','b']); const requests=[]; const events=[];
 const ctx={characterId:0,groupId:groupMode?'g':null,characters:[{avatar:'fixture.png',chat:'active'}],
  groups:[{id:'g',chat_id:'active',chats:['active','a','b']}],
  get chatId(){return this.groupId?this.groups[0].chat_id:this.characters[this.characterId].chat;},
  getRequestHeaders:()=>({'X-CSRF-Token':'fixture'}),saveChat:async()=>requests.push('flush-save'),
  eventTypes:{CHAT_DELETED:'deleted',GROUP_CHAT_DELETED:'group-deleted'},eventSource:{emit:async(e,n)=>events.push([e,n])}};
 let failName=null;
 const runtime={console,Set,Element:class {},queueMicrotask,
  document:{readyState:'loading',addEventListener(){}},getContext:()=>ctx,
  ST:{isGenerating:()=>false,replaceCurrentChat:async()=>{requests.push('replace');ctx.characters[0].chat=[...disk][0]||'new';},displayPastChats:async()=>requests.push('refresh')},
  Group:{editGroup:async()=>requests.push('save-group'),openGroupChat:async(_,n)=>{ctx.groups[0].chat_id=n;},createNewGroupChat:async()=>{ctx.groups[0].chats.push('new');ctx.groups[0].chat_id='new';}},
  fetch:async(url,options)=>{
   const body=JSON.parse(options.body);requests.push({url,body,headers:options.headers});
   if(url==='/api/chats/search')return {ok:true,json:async()=>[...disk].map(file_name=>({file_name}))};
   const name=body.id??body.chatfile.slice(0,-6);
   if(name===failName)return {ok:false,status:500};
   if(!disk.has(name))return {ok:false,status:400};disk.delete(name);return {ok:true,status:200};
  }};
 vm.createContext(runtime);vm.runInContext(src+'\nglobalThis.testApi=api;globalThis.capture=captureTarget;',runtime);
 return {runtime,ctx,disk,requests,events,fail:n=>{failName=n;}};
}
(async()=>{
 const batch=fs.readFileSync(fs.existsSync('batch.js') ? 'batch.js' : 'chat-bulk-delete/batch.js','utf8');
 const {deleteSelected}=await import('data:text/javascript;base64,'+Buffer.from(batch).toString('base64'));
 let t=setup();let target=t.runtime.capture();
 let report=await deleteSelected(['active','a'],target,t.runtime.testApi,()=>{},()=>false);
 assert.deepEqual(report.deleted,['a','active']);assert.deepEqual([...t.disk],['b']);assert.equal(t.ctx.chatId,'b');
 const removals=t.requests.filter(x=>x.url==='/api/chats/delete');
 assert.deepEqual(removals.map(x=>x.body),[{avatar_url:'fixture.png',chatfile:'a.jsonl'},{avatar_url:'fixture.png',chatfile:'active.jsonl'}]);
 assert.equal(removals[0].headers['X-CSRF-Token'],'fixture');assert.deepEqual(t.events,[['deleted','a'],['deleted','active']]);
 t=setup();t.fail('a');target=t.runtime.capture();
 report=await deleteSelected(['a','b'],target,t.runtime.testApi,()=>{},()=>false);
 assert.deepEqual(report.deleted,['b']);assert.equal(report.failed.length,1);assert.ok(t.disk.has('a'));assert.equal(t.ctx.chatId,'active');
 t=setup(true);target=t.runtime.capture();
 report=await deleteSelected(['active','a','b'],target,t.runtime.testApi,()=>{},()=>false);
 assert.deepEqual(report.deleted,['a','b','active']);assert.equal(t.ctx.chatId,'new');assert.deepEqual(t.ctx.groups[0].chats,['new']);
 assert.ok(t.requests.includes('save-group'));assert.deepEqual(t.events,[['group-deleted','a'],['group-deleted','b'],['group-deleted','active']]);
 t=setup(true);t.fail('a');target=t.runtime.capture();
 report=await deleteSelected(['a','b'],target,t.runtime.testApi,()=>{},()=>false);
 assert.deepEqual(t.ctx.groups[0].chats,['active','a']);assert.ok(t.disk.has('a'));
 t=setup();target=t.runtime.capture();t.ctx.characters.push({avatar:'different.png',chat:'different'});t.ctx.characterId=1;
 await assert.rejects(t.runtime.testApi.afterDelete(target,'active'));
 assert.equal(t.ctx.chatId,'different');assert.equal(t.requests.length,0);
 console.log('PASS: real extension adapter, CSRF & API payloads, current-chat replacement, partial failures, group metadata, context-switch protection');
})().catch(e=>{console.error(e);process.exit(1)});
