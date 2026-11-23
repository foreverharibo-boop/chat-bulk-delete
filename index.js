import * as ST from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import * as Group from '../../../group-chats.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { deleteSelected } from './batch.js';
import { scopeKey, parseChat, exportChat, cleanupLegacyTrash } from './chat-data.js';
import * as STLib from '../../../../lib.js';
import { findDuplicateChats } from './duplicates.js';

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
let duplicateScope = null;
let duplicateGroups = new Map();
let duplicateRevision = 0;
let legacyCleanupStarted = false;
function clearDuplicates() {
    const hadResults = duplicateScope !== null;
    duplicateRevision++;
    duplicateScope = null;
    duplicateGroups.clear();
    if (hadResults) statusText = '중복 표시 해제 · 필요하면 다시 중복 확인을 눌러줘.';
}
function duplicateInfo(t, name) {
    return duplicateScope && t && scopeKey(t) === duplicateScope ? duplicateGroups.get(name) : null;
}
function currentTarget() { try { return captureTarget(); } catch { return null; } }
function visibleRows() { return rows().filter(row => !row.hidden); }
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
function onListChanged() {
    if (!busy) {
        const hadSelection = selected.size > 0;
        selected.clear();
        if (hadSelection) statusText = '목록이 바뀌어서 선택을 해제했어. 다시 선택해줘.';
    }
    render();
}
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
    toolbar.querySelector('[data-cbd-action="toggle"]').textContent = mode ? '선택 취소' : '선택';
    for (const action of ['all', 'clear', 'delete']) toolbar.querySelector(`[data-cbd-action="${action}"]`).hidden = !mode;
    toolbar.querySelector('[data-cbd-action="stop"]').hidden = !busy;
    for (const el of toolbar.querySelectorAll('button')) {
        el.disabled = busy && el.dataset.cbdAction !== 'stop';
    }
    const scope = target || currentTarget();
    toolbar.querySelector('[data-cbd-action="delete"]').textContent = `삭제 (${selected.size})`;
    toolbar.querySelector('[data-cbd-action="delete"]').disabled = busy || selected.size === 0;
    toolbar.querySelector('[data-cbd-action="stop"]').disabled = stopRequested;
    toolbar.querySelector('.cbd-status').textContent = statusText || (mode ? `${selected.size}개 선택` : '');
    for (const row of rows()) {
        const name = rowName(row);
        if (!name) continue;
        let checkbox = row.querySelector('.cbd-check');
        if (!checkbox) {
            // Native checkbox clicks are rolled back when selection mode cancels
            // the click to keep ST from opening the chat. Use a controlled button.
            checkbox = document.createElement('button');
            checkbox.type = 'button';
            checkbox.setAttribute('role', 'checkbox');
            checkbox.className = 'cbd-check';
            row.prepend(checkbox);
        }
        checkbox.setAttribute('aria-label', `${name} 선택`);
        checkbox.setAttribute('aria-checked', String(selected.has(name)));
        checkbox.disabled = busy;
        row.classList.toggle('cbd-selected', mode && selected.has(name));
        const duplicate = duplicateInfo(scope, name);
        let badge = row.querySelector('.cbd-duplicate-badge');
        row.classList.toggle('cbd-duplicate-row', Boolean(duplicate));
        if (duplicate) {
            if (!badge) {
                badge = document.createElement('span'); badge.className = 'cbd-duplicate-badge';
                row.querySelector('.select_chat_block').append(badge);
            }
            row.style.setProperty('--cbd-duplicate-color', `hsl(${(duplicate.group * 137.508 + 195) % 360} 65% 50%)`);
            badge.textContent = `같은 내용 ${duplicate.group} · ${duplicate.count}개`;
            badge.title = '대화 전체 원문·순서·발화자·숨김 상태·첨부 정보 기준 · 번역/다른 스와이프/방 설정은 다를 수 있음 · 삭제 전 확인';
        } else {
            badge?.remove();
            row.style?.removeProperty('--cbd-duplicate-color');
        }
    }
}
async function post(url, body) {
    const response = await fetch(url, {
        method: 'POST', headers: getContext().getRequestHeaders(), body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`서버 요청 실패 (${response.status})`);
    return response;
}
function verifyOpenChat(raw, t, name) {
    if (name !== t.active) return;
    const saved = parseChat(raw);
    const hasHeader = saved[0]?.chat_metadata !== undefined || saved[0]?.user_name !== undefined;
    const ctx = getContext();
    if (JSON.stringify(hasHeader ? saved.slice(1) : saved) !== JSON.stringify(ctx.chat)
        || (hasHeader && ctx.chatMetadata !== undefined && JSON.stringify(saved[0].chat_metadata || {}) !== JSON.stringify(ctx.chatMetadata))) {
        throw new Error('현재 대화와 저장된 파일이 달라서 중단했어. 저장 상태를 확인해줘.');
    }
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
            // Group chat files share a global directory, unlike character chats.
            if (getContext().groups.some(g => String(g.id) !== String(t.id)
                && (g.chats?.includes(name) || g.chat_id === name))) {
                throw new Error('다른 그룹에서도 사용하는 채팅 파일이라 삭제하지 않았어.');
            }
        }
        if (stopRequested) throw new Error('중단 요청으로 원본을 삭제하지 않았어.');
        if (!sameTarget(t) || api.currentChat() !== t.active || api.isGenerating()) {
            throw new Error('채팅 상태가 바뀌어서 원본을 삭제하지 않았어.');
        }
        if (name === t.active) {
            const raw = await exportChat(t, name, post);
            verifyOpenChat(raw, t, name);
        }
        // Recheck context after reading the active chat, before deletion.
        if (stopRequested) throw new Error('중단 요청으로 원본을 삭제하지 않았어.');
        if (!sameTarget(t) || api.currentChat() !== t.active || api.isGenerating()) throw new Error('채팅 상태가 바뀌었어.');
        if (t.kind === 'group') {
            const group = getContext().groups.find(g => String(g.id) === String(t.id));
            if (!group?.chats.includes(name) || getContext().groups.some(g => String(g.id) !== String(t.id)
                && (g.chats?.includes(name) || g.chat_id === name))) throw new Error('그룹 파일 참조가 바뀌어서 삭제를 중단했어.');
            const response = await post('/api/chats/group/delete', { id: name });
            if ((await response.json()).ok !== true) throw new Error('삭제 응답을 확인할 수 없어. 목록을 다시 확인해줘.');
            const index = group.chats.indexOf(name);
            if (index !== -1) group.chats.splice(index, 1);
        } else {
            // Search returns the exact chat name without the file extension.
            const response = await post('/api/chats/delete', { avatar_url: t.avatar, chatfile: `${name}.jsonl` });
            if ((await response.json()).ok !== true) throw new Error('삭제 응답을 확인할 수 없어. 목록을 다시 확인해줘.');
        }
    },
    async afterDelete(t, name) {
        clearDuplicates();
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
    async finish(t, deleted) {
        if (t.kind === 'group') await Group.editGroup(t.id, true, false);
        if (deleted.includes(t.active) && sameTarget(t) && getContext().chatId === t.active) {
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
    explanation.textContent = '휴지통에 보관하지 않고 아래 채팅 파일을 영구 삭제해. 이 작업은 되돌릴 수 없어.';
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
    const chosen = [...selected];
    const snapshot = { ...target };
    confirming = true;
    let result, names;
    try {
        if (!sameTarget(snapshot) || api.currentChat() !== snapshot.active
            || chosen.length !== selected.size || chosen.some(name => !selected.has(name))) {
            notice('warning', '채팅 상태나 선택이 바뀌었어. 다시 선택해줘.'); return;
        }
        names = chosen;
        const visibleNames = new Set(visibleRows().map(rowName));
        if (names.some(name => !visibleNames.has(name))) {
            onListChanged(); notice('warning', '현재 목록에 없는 선택이 있어서 해제했어. 다시 선택해줘.'); return;
        }
        result = await callGenericPopup(confirmContent(names), POPUP_TYPE.CONFIRM, '', {
            okButton: `${names.length}개 영구 삭제`, cancelButton: '취소',
        });
    } finally { confirming = false; }
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    if (!sameTarget(snapshot) || api.currentChat() !== snapshot.active || api.isGenerating()
        || chosen.length !== selected.size || chosen.some(name => !selected.has(name))) {
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
async function withBusy(work) {
    if (busy || confirming) return;
    busy = true; stopRequested = false;
    document.body.classList.add('cbd-operation-running'); render();
    try { return await work(); }
    catch (error) { statusText = error.message; notice('error', error.message); }
    finally {
        busy = false; stopRequested = false;
        document.body.classList.remove('cbd-operation-running'); render();
    }
}
async function runDuplicateScan() {
    const snapshot = captureTarget();
    await withBusy(async () => {
        if (api.isGenerating()) throw new Error('답변 생성이 끝난 다음 중복 확인을 눌러줘.');
        if (typeof STLib.sha256 !== 'function') throw new Error('이 실리 버전에서는 중복 확인에 필요한 기능을 찾을 수 없어.');
        clearDuplicates(); selected.clear();
        const revision = duplicateRevision;
        statusText = '중복 확인 · 채팅 목록을 읽는 중…'; render();
        const assertContext = () => {
            if (!sameTarget(snapshot) || api.currentChat() !== snapshot.active || api.isGenerating() || revision !== duplicateRevision) {
                throw new Error('채팅 상태가 바뀌어서 검사를 중단했어. 다시 확인해줘.');
            }
        };
        const names = await api.listNames(snapshot);
        assertContext();
        const result = await findDuplicateChats(names, async name => {
            assertContext();
            const raw = await exportChat(snapshot, name, post);
            assertContext(); verifyOpenChat(raw, snapshot, name);
            return raw;
        }, {
            hash: STLib.sha256, shouldStop: () => stopRequested, assertContext,
            progress: (done, total) => { statusText = `중복 확인 ${done} / ${total}`; render(); },
        });
        if (result.stopped) { statusText = '중복 확인 중단 · 표시를 적용하지 않았어.'; return; }
        assertContext();
        duplicateScope = scopeKey(snapshot);
        result.groups.forEach((names, index) => names.forEach(name => duplicateGroups.set(name, { group: index + 1, count: names.length })));
        statusText = `같은 내용 ${result.groups.length}묶음 · ${duplicateGroups.size}개 방`
            + (result.failed.length ? ` · 확인 실패 ${result.failed.length}건` : ' · 검사 완료');
        notice(result.failed.length ? 'warning' : 'success', statusText);
        if (result.failed.length) {
            notice('warning', '읽지 못했거나 검사 중 바뀐 방은 표시에서 제외했어. 잠시 후 다시 확인해줘.');
        }
    });
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
            for (const row of visibleRows()) { const name = rowName(row); if (name) selected.add(name); }
            statusText = ''; render();
        } else if (action === 'clear') { selected.clear(); statusText = ''; render(); }
        else if (action === 'delete') void runDelete().catch(error => notice('error', error.message));
        else if (action === 'duplicates') void runDuplicateScan().catch(error => notice('error', error.message));
        return;
    }
    const row = element.closest('#select_chat_div .select_chat_block_wrapper');
    // Native history deletion uses the same explicit permanent-delete confirmation.
    if (row && element.closest('.PastChat_cross')) {
        event.preventDefault(); event.stopImmediatePropagation();
        const name = rowName(row);
        target = captureTarget();
        mode = true; selected.clear(); selected.add(name); render();
        void runDelete().catch(error => notice('error', error.message)); return;
    }
    if (mode && row) {
        event.preventDefault(); event.stopImmediatePropagation();
        const name = rowName(row);
        if (name) { selected.has(name) ? selected.delete(name) : selected.add(name); statusText = ''; render(); }
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
    if (!legacyCleanupStarted) {
        legacyCleanupStarted = true;
        void cleanupLegacyTrash({ fetcher: (...args) => fetch(...args), headers: () => getContext().getRequestHeaders(), post })
            .then(result => {
                if (result.cleaned) notice('success', `예전 휴지통 보관본 ${result.deleted}개와 목록을 정리했어.`);
            })
            .catch(error => notice('warning', `예전 휴지통 정리를 마치지 못했어. 새로고침하면 다시 시도할게. ${error.message}`));
    }
    popup = document.getElementById('select_chat_popup');
    list = document.getElementById('select_chat_div');
    if (!popup || !list || document.getElementById('cbd-toolbar')) return;
    toolbar = document.createElement('div');
    toolbar.id = 'cbd-toolbar';
    toolbar.append(button('선택', 'toggle'), button('현재 목록 전체 선택', 'all'),
        button('선택 해제', 'clear'), button('삭제 (0)', 'delete', 'cbd-delete'),
        button('중복 확인', 'duplicates'), button('중단', 'stop'));
    const status = document.createElement('span');
    status.className = 'cbd-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    toolbar.append(status);
    list.before(toolbar);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    new MutationObserver(onListChanged).observe(list, { childList: true });
    document.getElementById('select_chat_search')?.addEventListener('input', onListChanged);
    const shadow = document.getElementById('shadow_select_chat_popup');
    if (shadow) new MutationObserver(() => {
        if (!busy && getComputedStyle(shadow).display === 'none') reset();
    }).observe(shadow, { attributes: true, attributeFilter: ['style', 'class'] });
    const ctx = getContext();
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => { clearDuplicates(); if (!busy) reset(); });
    for (const key of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'CHAT_DELETED', 'GROUP_CHAT_DELETED']) {
        if (ctx.eventTypes[key]) ctx.eventSource.on(ctx.eventTypes[key], () => { clearDuplicates(); render(); });
    }
    if (ctx.eventTypes.CHAT_RENAMED) ctx.eventSource.on(ctx.eventTypes.CHAT_RENAMED, () => { clearDuplicates(); onListChanged(); });
    render();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
