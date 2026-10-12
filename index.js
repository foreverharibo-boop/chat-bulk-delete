import * as ST from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import * as Group from '../../../group-chats.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { deleteSelected } from './batch.js';

const selected = new Set();
let mode = false;
let busy = false;
let confirming = false;
let stopRequested = false;
let target = null;
let toolbar;
let list;
let popup;
let statusText = '';
const notice = (kind, message) => globalThis.toastr?.[kind]?.(message, '채팅방 일괄 삭제');
const button = (text, action, className = '') => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `menu_button cbd-button ${className}`;
    el.textContent = text;
    el.dataset.cbdAction = action;
    return el;
};
function captureTarget() {
    const ctx = getContext();
    if (ctx.groupId) {
        const group = ctx.groups.find(g => String(g.id) === String(ctx.groupId));
        if (!group) throw new Error('그룹을 찾을 수 없어.');
        return { kind: 'group', id: group.id, active: group.chat_id };
    }
    const char = ctx.characters[ctx.characterId];
    if (!char) throw new Error('먼저 캐릭터 채팅을 열어줘.');
    return { kind: 'character', id: ctx.characterId, avatar: char.avatar, active: char.chat };
}
function sameTarget(t) {
    const ctx = getContext();
    return t.kind === 'group'
        ? String(ctx.groupId) === String(t.id)
        : !ctx.groupId && ctx.characters[ctx.characterId]?.avatar === t.avatar;
}
function rowName(row) { return row.querySelector('.select_chat_block')?.getAttribute('file_name'); }
function rows() { return [...list.querySelectorAll('.select_chat_block_wrapper')]; }
function reset() {
    if (busy) return;
    mode = false;
    target = null;
    selected.clear();
    statusText = '';
    render();
}
function render() {
    if (!toolbar) return;
    popup.classList.toggle('cbd-selection-mode', mode);
    popup.classList.toggle('cbd-busy', busy);
    toolbar.querySelector('[data-cbd-action="toggle"]').textContent = mode ? '선택 취소' : '여러 개 선택';
    for (const action of ['all', 'clear', 'delete']) toolbar.querySelector(`[data-cbd-action="${action}"]`).hidden = !mode;
    toolbar.querySelector('[data-cbd-action="stop"]').hidden = !busy;
    for (const el of toolbar.querySelectorAll('button')) {
        el.disabled = busy && el.dataset.cbdAction !== 'stop';
    }
    toolbar.querySelector('[data-cbd-action="delete"]').textContent = `선택 삭제 (${selected.size})`;
    toolbar.querySelector('[data-cbd-action="delete"]').disabled = busy || selected.size === 0;
    toolbar.querySelector('[data-cbd-action="stop"]').disabled = stopRequested;
    toolbar.querySelector('.cbd-status').textContent = statusText || (mode ? `${selected.size}개 선택` : '');
    for (const row of rows()) {
        const name = rowName(row);
        if (!name) continue;
        let checkbox = row.querySelector('.cbd-check');
        if (!checkbox) {
            checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'cbd-check';
            row.prepend(checkbox);
        }
        checkbox.setAttribute('aria-label', `${name} 선택`);
        checkbox.checked = selected.has(name);
        checkbox.disabled = busy;
        row.classList.toggle('cbd-selected', mode && selected.has(name));
    }
}
async function post(url, body) {
    const response = await fetch(url, {
        method: 'POST', headers: getContext().getRequestHeaders(), body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`서버 요청 실패 (${response.status})`);
    return response;
}
const api = {
    sameTarget,
    isGenerating: () => typeof ST.isGenerating === 'function'
        ? ST.isGenerating() : Boolean(ST.is_send_press || Group.is_group_generating),
    currentChat: () => getContext().chatId,
    saveChat: () => getContext().saveChat(),
    async listNames(t) {
        const response = await post('/api/chats/search', {
            query: '', avatar_url: t.kind === 'character' ? t.avatar : null,
            group_id: t.kind === 'group' ? t.id : null,
        });
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('채팅 목록 응답이 올바르지 않아.');
        return data.map(chat => chat.file_name);
    },
    async remove(t, name) {
        if (!sameTarget(t)) throw new Error('채팅 대상이 바뀌었어.');
        if (t.kind === 'group') {
            const group = getContext().groups.find(g => String(g.id) === String(t.id));
            if (!group?.chats.includes(name)) throw new Error('그룹 채팅을 찾을 수 없어.');
            await post('/api/chats/group/delete', { id: name });
            group.chats.splice(group.chats.indexOf(name), 1);
        } else {
            // Search returns the exact chat name without the file extension.
            await post('/api/chats/delete', { avatar_url: t.avatar, chatfile: `${name}.jsonl` });
        }
    },
    async afterDelete(t, name) {
        if (name === t.active) {
            if (!sameTarget(t) || getContext().chatId !== t.active) {
                throw new Error('삭제 중 채팅이 바뀌어 현재 화면을 갱신하지 않았어.');
            }
            if (t.kind === 'character') {
                await ST.replaceCurrentChat();
            } else {
                const group = getContext().groups.find(g => String(g.id) === String(t.id));
                if (group.chats.length) await Group.openGroupChat(t.id, group.chats.at(-1));
                else await Group.createNewGroupChat(t.id);
            }
        }
        const ctx = getContext();
        const event = t.kind === 'group' ? ctx.eventTypes.GROUP_CHAT_DELETED : ctx.eventTypes.CHAT_DELETED;
        if (event) await ctx.eventSource.emit(event, name);
    },
    async finish(t) {
        if (t.kind === 'group') await Group.editGroup(t.id, true, false);
        if (sameTarget(t) && getContext().chatId === t.active) {
            const remaining = await api.listNames(t);
            if (!remaining.includes(t.active)) {
                if (t.kind === 'character') await ST.replaceCurrentChat();
                else {
                    const group = getContext().groups.find(g => String(g.id) === String(t.id));
                    if (group.chats.length) await Group.openGroupChat(t.id, group.chats.at(-1));
                    else await Group.createNewGroupChat(t.id);
                }
            }
        }
        if (sameTarget(t)) await ST.displayPastChats();
    },
};
function confirmContent(names) {
    const content = document.createElement('div');
    content.className = 'cbd-confirm';
    const title = document.createElement('h3');
    title.textContent = `선택한 채팅방 ${names.length}개를 삭제할까?`;
    const explanation = document.createElement('p');
    explanation.textContent = '채팅방의 대화 전체가 삭제돼. 이 확장에는 실행 취소 기능이 없어.';
    const ul = document.createElement('ul');
    for (const name of names) {
        const li = document.createElement('li');
        li.textContent = name + (name === target.active ? ' (현재 열린 채팅)' : '');
        ul.append(li);
    }
    content.append(title, explanation, ul);
    return content;
}
async function runDelete() {
    if (busy || confirming || !target || selected.size === 0) return;
    if (!sameTarget(target)) { reset(); notice('warning', '채팅 대상이 바뀌었어. 다시 선택해줘.'); return; }
    if (api.isGenerating()) { notice('warning', '답변 생성이 끝난 다음 삭제해줘.'); return; }
    if (typeof ST.replaceCurrentChat !== 'function' || typeof ST.displayPastChats !== 'function') {
        notice('error', '이 실리태번 버전에서는 필요한 채팅 기능을 찾을 수 없어.'); return;
    }
    const names = [...selected];
    const snapshot = { ...target };
    confirming = true;
    let result;
    try {
        result = await callGenericPopup(confirmContent(names), POPUP_TYPE.CONFIRM, '', {
            okButton: `${names.length}개 삭제`, cancelButton: '취소',
        });
    } finally { confirming = false; }
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    if (!sameTarget(snapshot) || api.currentChat() !== snapshot.active || api.isGenerating()) {
        reset(); notice('warning', '확인하는 동안 채팅 상태가 바뀌었어. 다시 선택해줘.'); return;
    }
    busy = true;
    stopRequested = false;
    document.body.classList.add('cbd-operation-running');
    statusText = `삭제 중… 0 / ${names.length}`;
    render();
    toolbar.querySelector('[data-cbd-action="stop"]').focus();
    try {
        const report = await deleteSelected(names, snapshot, api, (done, failed, total) => {
            statusText = `처리 ${done + failed} / ${total} · 삭제 ${done} · 실패 ${failed}`;
            render();
        }, () => stopRequested);
        for (const name of report.deleted) selected.delete(name);
        statusText = `삭제 ${report.deleted.length}개` + (report.failed.length ? ` · 실패 ${report.failed.length}개` : '')
            + (report.stopped ? ' · 중단됨' : ' · 완료');
        notice(report.failed.length || report.warnings.length || report.stopped ? 'warning' : 'success', statusText);
        if (report.failed.length || report.warnings.length) {
            const details = document.createElement('div');
            details.className = 'cbd-report';
            for (const text of [statusText, ...report.failed.map(x => `${x.name}: ${x.message}`), ...report.warnings]) {
                const line = document.createElement('p'); line.textContent = text; details.append(line);
            }
            // Unlock before the report popup so its buttons remain usable.
            busy = false;
            document.body.classList.remove('cbd-operation-running');
            render();
            await callGenericPopup(details, POPUP_TYPE.TEXT, '', { okButton: '확인' });
        }
    } catch (error) {
        statusText = '삭제를 진행하지 못했어.';
        notice('error', error.message);
    } finally {
        busy = false;
        stopRequested = false;
        document.body.classList.remove('cbd-operation-running');
        if (!sameTarget(snapshot)) reset();
        else {
            target = captureTarget();
            render();
        }
    }
}
function onClick(event) {
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const action = element.closest('[data-cbd-action]')?.dataset.cbdAction;
    if (busy) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (action === 'stop') { stopRequested = true; statusText = '현재 요청이 끝나면 중단할게…'; render(); }
        return;
    }
    if (action && toolbar.contains(element)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (action === 'toggle') {
            if (mode) reset();
            else {
                try { target = captureTarget(); mode = true; statusText = ''; render(); }
                catch (error) { notice('warning', error.message); }
            }
        } else if (action === 'all') {
            for (const row of rows()) { const name = rowName(row); if (name) selected.add(name); }
            statusText = ''; render();
        } else if (action === 'clear') { selected.clear(); statusText = ''; render(); }
        else if (action === 'delete') void runDelete().catch(error => notice('error', error.message));
        return;
    }
    const row = element.closest('#select_chat_div .select_chat_block_wrapper');
    if (mode && row) {
        event.preventDefault(); event.stopImmediatePropagation();
        const name = rowName(row);
        if (name) { selected.has(name) ? selected.delete(name) : selected.add(name); statusText = ''; render(); }
        // preventDefault reverts native checkbox toggling after this handler finishes.
        queueMicrotask(render);
    }
}
function onKey(event) {
    if (busy) {
        if (event.target instanceof Element && event.target.closest('[data-cbd-action="stop"]')
            && (event.key === ' ' || event.key === 'Enter')) return;
        event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (mode && event.target instanceof Element && event.target.matches('.cbd-check')
        && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault(); event.stopImmediatePropagation(); event.target.click();
    }
}
function initialize() {
    popup = document.getElementById('select_chat_popup');
    list = document.getElementById('select_chat_div');
    if (!popup || !list || document.getElementById('cbd-toolbar')) return;
    toolbar = document.createElement('div');
    toolbar.id = 'cbd-toolbar';
    toolbar.append(button('여러 개 선택', 'toggle'), button('현재 목록 전체 선택', 'all'),
        button('선택 해제', 'clear'), button('선택 삭제 (0)', 'delete', 'cbd-delete'), button('중단', 'stop'));
    const status = document.createElement('span');
    status.className = 'cbd-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    toolbar.append(status);
    list.before(toolbar);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    new MutationObserver(render).observe(list, { childList: true });
    const shadow = document.getElementById('shadow_select_chat_popup');
    if (shadow) new MutationObserver(() => {
        if (!busy && getComputedStyle(shadow).display === 'none') reset();
    }).observe(shadow, { attributes: true, attributeFilter: ['style', 'class'] });
    const ctx = getContext();
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => { if (!busy) reset(); });
    render();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
