const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(fs.existsSync('index.js') ? 'index.js' : 'chat-bulk-delete/index.js','utf8').replace(/^import .*;\n/gm,'');
class Node {
    constructor(tag='div') { this.tagName=tag.toUpperCase();this.attrs={};this.dataset={};this.children=[];this.style={setProperty:(k,v)=>{this.style[k]=v;},removeProperty:k=>{delete this.style[k];}};this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)}; }
    setAttribute(k,v){this.attrs[k]=String(v);}
    getAttribute(k){return this.attrs[k]??null;}
    append(el){el.row=this;this.children.push(el);}
    prepend(el){el.row=this;this.children.unshift(el);}
    remove(){this.row.children=this.row.children.filter(x=>x!==this);}
    closest(selector){if(selector==='[data-cbd-action]')return this.dataset.cbdAction?this:null;if(selector==='#select_chat_div .select_chat_block_wrapper')return this.row??null;return null;}
    matches(selector){return selector==='.cbd-check'&&this.className==='cbd-check';}
}
const controls={};
for(const name of ['toggle','all','clear','delete','permanent','stop','backup','trash']){const node=new Node('button');node.dataset.cbdAction=name;controls[name]=node;}
const status=new Node();const toolbarNode=new Node();
toolbarNode.querySelector=selector=>selector==='.cbd-status'?status:controls[selector.match(/"([^"]+)"/)[1]];
toolbarNode.querySelectorAll=()=>Object.values(controls);
toolbarNode.contains=el=>Object.values(controls).includes(el);
const rows=['방 A','방 B'].map(name=>{
    const row=new Node();row.row=row;const card=new Node();card.row=row;card.setAttribute('file_name',name);
    row.card=card;row.querySelector=sel=>sel==='.select_chat_block'?card:[...row.children,...card.children].find(x=>x.className?.split(' ').includes(sel.slice(1)))??null;
    return row;
});
const listNode={querySelectorAll:()=>rows};const popupNode=new Node();
let cancelCount=0,blockedCount=0;
const eventFor=target=>({target,preventDefault(){cancelCount++;},stopImmediatePropagation(){blockedCount++;}});
const runtime={console,Element:Node,Set,scopeKey:t=>JSON.stringify([t.kind,t.avatar]),document:{readyState:'loading',addEventListener(){},createElement:tag=>new Node(tag)},getContext:()=>({characterId:0,characters:[{avatar:'fixture.png',chat:'방 A'}]})};
vm.createContext(runtime);
vm.runInContext(source+'\nglobalThis.testUI={prepare:(t,l,p)=>{toolbar=t;list=l;popup=p;mode=true;target=captureTarget();vault={ready:true,isLocked:()=>false};render();},click:onClick,key:onKey,render,listChanged:onListChanged,selected:()=>Array.from(selected)};',runtime);
const ui=runtime.testUI;ui.prepare(toolbarNode,listNode,popupNode);
const checkbox=rows[0].querySelector('.cbd-check');
assert.equal(checkbox.tagName,'BUTTON');assert.equal(checkbox.type,'button');assert.equal(checkbox.getAttribute('role'),'checkbox');assert.equal(checkbox.getAttribute('aria-checked'),'false');
checkbox.click=()=>ui.click(eventFor(checkbox));
ui.click(eventFor(checkbox));
assert.equal(checkbox.getAttribute('aria-checked'),'true');assert.ok(rows[0].classes.has('cbd-selected'));assert.equal(controls.delete.textContent,'휴지통으로 (1)');
ui.click(eventFor(checkbox));assert.equal(checkbox.getAttribute('aria-checked'),'false');assert.equal(controls.delete.textContent,'휴지통으로 (0)');
ui.click(eventFor(rows[0].card));assert.equal(checkbox.getAttribute('aria-checked'),'true');
ui.key({...eventFor(checkbox),key:' '});assert.equal(checkbox.getAttribute('aria-checked'),'false');
ui.key({...eventFor(checkbox),key:'Enter'});assert.equal(checkbox.getAttribute('aria-checked'),'true');
ui.click(eventFor(controls.all));assert.ok(rows.every(row=>row.querySelector('.cbd-check').getAttribute('aria-checked')==='true'));assert.equal(controls.delete.textContent,'휴지통으로 (2)');
ui.click(eventFor(controls.clear));assert.ok(rows.every(row=>row.querySelector('.cbd-check').getAttribute('aria-checked')==='false'));assert.equal(ui.selected().length,0);
assert.ok(cancelCount>0&&blockedCount>0);
ui.click(eventFor(controls.all));
const removedRow=rows.shift();
ui.listChanged();
assert.equal(ui.selected().length,0);
assert.equal(controls.delete.textContent,'휴지통으로 (0)');
rows.unshift(removedRow);ui.listChanged();
assert.ok(rows.every(row=>row.querySelector('.cbd-check').getAttribute('aria-checked')==='false'));
vm.runInContext("vault.isLocked=(_,name)=>name==='방 A'",runtime);
ui.render();ui.click(eventFor(controls.all));
assert.deepEqual([...ui.selected()],['방 B']);
assert.equal(rows[0].querySelector('.cbd-lock').getAttribute('aria-pressed'),'true');
ui.click(eventFor(rows[0].card));
assert.deepEqual([...ui.selected()],['방 B','방 A']);
assert.equal(controls.delete.textContent,'휴지통으로 (1)');
assert.equal(controls.permanent.textContent,'영구 삭제 (1)');
assert.equal(controls.backup.disabled,false);
ui.click(eventFor(controls.clear));rows[1].hidden=true;
ui.click(eventFor(controls.all));assert.equal(ui.selected().length,0);
assert.equal(controls.permanent.disabled,true);
rows[1].hidden=false;
vm.runInContext("duplicateScope=scopeKey(captureTarget());duplicateGroups.set('방 A',{group:1,count:2});duplicateGroups.set('방 B',{group:1,count:2});render();",runtime);
assert.equal(rows[0].querySelector('.cbd-duplicate-badge').textContent,'같은 내용 1 · 2개');
assert.equal(rows[0].style['--cbd-duplicate-color'],rows[1].style['--cbd-duplicate-color']);
assert.equal(ui.selected().length,0);
vm.runInContext('clearDuplicates();render();',runtime);
assert.equal(rows[0].querySelector('.cbd-duplicate-badge'),null);
const css=fs.readFileSync(fs.existsSync('style.css') ? 'style.css' : 'chat-bulk-delete/style.css','utf8');
assert.match(css,/\.cbd-check\[aria-checked="true"\]::after\s*\{\s*opacity:1/);
assert.match(css,/color:var\(--SmartThemeBodyColor, currentColor\)/);
assert.match(css,/border:solid currentColor/);
assert.match(css,/background:var\(--SmartThemeBlurTintColor, transparent\)/);
console.log('PASS: controlled checkbox has no native rollback; box/card clicks, keyboard toggle, select all, clear, displayed count and theme-derived tick styles');
console.log('PASS: changing the displayed list clears hidden selections; returning rows remain unchecked');
console.log('PASS: select-all skips locked/hidden rows; locked chats can still be selected for backup but not deletion');
console.log('PASS: equal-content badges share a color without auto-selection and are removed on invalidation');
