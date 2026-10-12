import * as ST from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import * as Group from '../../../group-chats.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { deleteSelected } from './batch.js';
import { ChatVault, scopeKey, parseChat } from './vault.js';
import { makeZip, backupNames } from './zip.js';
import { arrange, fileSize } from './view.js';

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
let vault;
let filterControls;
let vaultLoading;
const getVault = () => vault ||= new ChatVault({ post, getContext });
const locked = (t, name) => Boolean(t && getVault().isLocked(t, name));
function currentTarget() { try { return captureTarget(); } catch { return null; } }
function visibleRows() { return rows().filter(row => !row.hidden); }
async function refreshVault() {
    if (vaultLoading) return vaultLoading;
    vaultLoading = getVault().load().then(() => render()).catch(error => {
        getVault().ready = false; notice('error', error.message);
    }).finally(() => { vaultLoading = null; });
    return vaultLoading;
}
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
    for (const action of ['all', 'clear', 'delete', 'backup']) toolbar.querySelector(`[data-cbd-action="${action}"]`).hidden = !mode;
    toolbar.querySelector('[data-cbd-action="stop"]').hidden = !busy;
    for (const el of toolbar.querySelectorAll('button')) {
        el.disabled = busy && el.dataset.cbdAction !== 'stop';
    }
    const scope = target || currentTarget();
    const deletable = [...selected].filter(name => !locked(scope, name)).length;
    toolbar.querySelector('[data-cbd-action="delete"]').textContent = `휴지통으로 (${deletable})`;
    toolbar.querySelector('[data-cbd-action="delete"]').disabled = busy || !getVault().ready || deletable === 0;
    toolbar.querySelector('[data-cbd-action="backup"]').disabled = busy || selected.size === 0;
    for (const control of filterControls?.querySelectorAll('input, select') || []) control.disabled = busy;
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
        let lock = row.querySelector('.cbd-lock');
        if (!lock) {
            lock = button('', 'lock', 'cbd-lock');
            row.append(lock);
        }
        const isLocked = locked(scope, name);
        lock.textContent = isLocked ? '🔒' : '🔓';
        lock.title = isLocked ? '잠금 해제' : '채팅 잠금';
        lock.setAttribute('aria-label', `${name} ${lock.title}`);
        lock.setAttribute('aria-pressed', String(isLocked));
        lock.disabled = busy || !getVault().ready;
        row.classList.toggle('cbd-locked', isLocked);
    }
    applyView();
}
function applyView() {
    if (!filterControls) return;
    const scope = target || currentTarget();
    const items = rows().map((row, index) => ({ row, index, name: rowName(row) || '',
        locked: locked(scope, rowName(row)),
        count: Number((row.querySelector('.chat_messages_num')?.textContent || '').match(/[\d,]+/)?.[0]?.replace(/,/g, '') || 0),
        size: fileSize(row.querySelector('.chat_file_size')?.textContent || ''),
    }));
    const visible = arrange(items, {
        order: filterControls.querySelector('[name="order"]').value,
        filter: filterControls.querySelector('[name="filter"]').value,
    });
    const shown = new Set(visible.map(x => x.row));
    for (const item of items) item.row.hidden = !shown.has(item.row);
    visible.forEach((item, index) => { item.row.style.order = String(index); });
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
        if (locked(t, name)) throw new Error('잠긴 채팅은 삭제할 수 없어.');
        if (t.kind === 'group') {
            const group = getContext().groups.find(g => String(g.id) === String(t.id));
            if (!group?.chats.includes(name)) throw new Error('그룹 채팅을 찾을 수 없어.');
            // Group chat files share a global directory, unlike character chats.
            if (getContext().groups.some(g => String(g.id) !== String(t.id)
                && (g.chats?.includes(name) || g.chat_id === name))) {
                throw new Error('다른 그룹에서도 사용하는 채팅 파일이라 삭제하지 않았어.');
            }
        }
        const entry = await getVault().archive(t, name);
        if (stopRequested) throw new Error('중단 요청으로 원본을 삭제하지 않았어. 보관본은 휴지통에 남아 있어.');
        if (!sameTarget(t) || api.currentChat() !== t.active || api.isGenerating()) {
            throw new Error('보관 중 채팅 상태가 바뀌어서 원본을 삭제하지 않았어.');
        }
        if (name === t.active) {
            const record = await getVault().readEntry(entry);
            verifyOpenChat(record.raw, t, name);
        }
        // Recheck locks after the archive upload, before the destructive request.
        await getVault().load();
        if (stopRequested) throw new Error('중단 요청으로 원본을 삭제하지 않았어.');
        if (locked(t, name)) throw new Error('채팅이 잠겨서 원본 삭제를 중단했어.');
        if (!sameTarget(t) || api.currentChat() !== t.active || api.isGenerating()) throw new Error('채팅 상태가 바뀌었어.');
        if (t.kind === 'group') {
            const group = getContext().groups.find(g => String(g.id) === String(t.id));
            if (!group?.chats.includes(name) || getContext().groups.some(g => String(g.id) !== String(t.id)
                && (g.chats?.includes(name) || g.chat_id === name))) throw new Error('그룹 파일 참조가 바뀌어서 삭제를 중단했어.');
            const response = await post('/api/chats/group/delete', { id: name });
            if ((await response.json()).ok !== true) throw new Error('삭제 응답을 확인할 수 없어. 휴지통 보관본은 유지돼.');
            const index = group.chats.indexOf(name);
            if (index !== -1) group.chats.splice(index, 1);
        } else {
            // Search returns the exact chat name without the file extension.
            const response = await post('/api/chats/delete', { avatar_url: t.avatar, chatfile: `${name}.jsonl` });
            if ((await response.json()).ok !== true) throw new Error('삭제 응답을 확인할 수 없어. 휴지통 보관본은 유지돼.');
        }
        // An interrupted status update must never lose the already verified copy.
        try { await getVault().mark(entry.id, 'trashed'); }
        catch (error) { notice('warning', `원본 삭제 후 상태 기록 실패: ${error.message} 휴지통의 확인 필요 항목에서 복원할 수 있어.`); }
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
    title.textContent = `선택한 채팅방 ${names.length}개를 휴지통으로 옮길까?`;
    const explanation = document.createElement('p');
    explanation.textContent = '서버에 보관본을 저장하고 다시 읽어 확인한 방만 원본을 삭제해. 휴지통에서 복원할 수 있어. 잠긴 방은 제외돼.';
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
        await getVault().load();
        if (!sameTarget(snapshot) || api.currentChat() !== snapshot.active
            || chosen.length !== selected.size || chosen.some(name => !selected.has(name))) {
            notice('warning', '채팅 상태나 선택이 바뀌었어. 다시 선택해줘.'); return;
        }
        names = chosen.filter(name => !locked(snapshot, name));
        if (!names.length) { notice('warning', '잠긴 방은 휴지통으로 이동할 수 없어.'); return; }
        const visibleNames = new Set(visibleRows().map(rowName));
        if (names.some(name => !visibleNames.has(name))) {
            onListChanged(); notice('warning', '현재 목록에 없는 선택이 있어서 해제했어. 다시 선택해줘.'); return;
        }
        result = await callGenericPopup(confirmContent(names), POPUP_TYPE.CONFIRM, '', {
            okButton: `${names.length}개 휴지통으로`, cancelButton: '취소',
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
    statusText = `보관 후 이동 중… 0 / ${names.length}`;
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
function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name;
    // Allow this programmatic download through the operation click guard.
    link.dataset.cbdDownload = 'true';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function withBusy(work) {
    if (busy || confirming) return;
    busy = true; stopRequested = false;
    document.body.classList.add('cbd-operation-running'); render();
    try { return await work(); }
    catch (error) { notice('error', error.message); }
    finally {
        busy = false; stopRequested = false;
        document.body.classList.remove('cbd-operation-running'); render();
    }
}
async function runBackup() {
    if (!target || !selected.size || !sameTarget(target)) return;
    const snapshot = { ...target }, names = [...selected];
    await withBusy(async () => {
        if (api.isGenerating()) throw new Error('답변 생성이 끝난 다음 백업해줘.');
        if (names.includes(snapshot.active)) await api.saveChat();
        const zipNames = backupNames(names), files = [];
        for (let i = 0; i < names.length; i++) {
            if (stopRequested) { statusText = '백업 중단 · ZIP은 생성하지 않았어.'; return; }
            if (!sameTarget(snapshot) || api.currentChat() !== snapshot.active || api.isGenerating()) throw new Error('채팅 상태가 바뀌어서 백업을 중단했어.');
            statusText = `백업 ${i + 1} / ${names.length}`; render();
            const text = await getVault().exportChat(snapshot, names[i]);
            verifyOpenChat(text, snapshot, names[i]);
            files.push({ name: zipNames[i], text });
        }
        if (stopRequested) { statusText = '백업 중단 · ZIP은 생성하지 않았어.'; return; }
        downloadBlob(makeZip(files), `채팅-개별백업-${Date.now()}.zip`);
        statusText = `${files.length}개 개별 JSONL 파일을 담은 ZIP 다운로드 요청 완료`;
        notice('success', statusText);
    });
}
async function toggleLock(name) {
    const snapshot = captureTarget();
    await withBusy(async () => {
        await getVault().load();
        if (!sameTarget(snapshot)) throw new Error('캐릭터가 바뀌었어. 다시 눌러줘.');
        const value = !locked(snapshot, name);
        await getVault().setLock(snapshot, name, value);
        selected.clear(); statusText = value ? '채팅을 잠갔어.' : '잠금을 해제했어.';
    });
}
async function showTrash() {
    if (busy || confirming) return;
    const snapshot = captureTarget();
    await getVault().load();
    const content = document.createElement('div'); content.className = 'cbd-trash';
    const title = document.createElement('h3'); title.textContent = '이 캐릭터 / 그룹의 휴지통';
    const help = document.createElement('p');
    help.textContent = '복원은 원래 캐릭터/그룹에 새 이름으로 저장해. 보관본은 복원 후에도 남아 있어. 자동 비우기는 하지 않아.';
    const entries = getVault().state.entries.filter(x => scopeKey(x.target) === scopeKey(snapshot)).sort((a, b) => b.created - a.created);
    content.append(title, help);
    if (!entries.length) {
        const empty = document.createElement('p'); empty.textContent = '휴지통이 비어 있어.'; content.append(empty);
    }
    for (const entry of entries) {
        const row = document.createElement('div'); row.className = 'cbd-trash-row';
        const label = document.createElement('p');
        const stateLabel = { prepared: '보관됨 · 원본 삭제 여부 확인 필요', trashed: '휴지통', restored: '복원 완료 · 보관본 유지' }[entry.status] || '확인 필요';
        label.textContent = `${entry.name}\n${new Date(entry.created).toLocaleString()} · ${stateLabel}`;
        const restore = button('복원', 'restore');
        restore.disabled = entry.status === 'restored';
        const save = button('JSONL 받기', 'download-trash');
        restore.addEventListener('click', () => void withBusy(async () => {
            if (!sameTarget(snapshot) || api.isGenerating()) throw new Error('원래 캐릭터/그룹을 열고 답변 생성이 끝난 후 복원해줘.');
            const name = await getVault().restore(entry);
            restore.disabled = true; label.textContent = `${entry.name}\n복원 완료: ${name}`;
            if (sameTarget(snapshot)) await ST.displayPastChats();
            notice('success', `복원 완료: ${name}`);
        }));
        save.addEventListener('click', () => void withBusy(async () => {
            const record = await getVault().readEntry(entry);
            downloadBlob(new Blob([record.raw], { type: 'application/jsonl' }), backupNames([entry.name])[0]);
        }));
        row.append(label, restore, save); content.append(row);
    }
    await callGenericPopup(content, POPUP_TYPE.TEXT, '', { okButton: '닫기', wide: true });
}
function onClick(event) {
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const action = element.closest('[data-cbd-action]')?.dataset.cbdAction;
    if (busy) {
        if (element.dataset.cbdDownload === 'true') return;
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
            for (const row of visibleRows()) { const name = rowName(row); if (name && !locked(target, name)) selected.add(name); }
            statusText = ''; render();
        } else if (action === 'clear') { selected.clear(); statusText = ''; render(); }
        else if (action === 'delete') void runDelete().catch(error => notice('error', error.message));
        else if (action === 'backup') void runBackup().catch(error => notice('error', error.message));
        else if (action === 'trash') void showTrash().catch(error => notice('error', error.message));
        return;
    }
    const row = element.closest('#select_chat_div .select_chat_block_wrapper');
    if (row && action === 'lock') {
        event.preventDefault(); event.stopImmediatePropagation();
        void toggleLock(rowName(row)).catch(error => notice('error', error.message)); return;
    }
    // Route the native history delete button through the same verified trash flow.
    if (row && element.closest('.PastChat_cross')) {
        event.preventDefault(); event.stopImmediatePropagation();
        const name = rowName(row);
        target = captureTarget();
        if (!getVault().ready) { notice('warning', '잠금 정보를 아직 읽지 못했어. 휴지통을 열어 연결을 확인해줘.'); return; }
        if (locked(target, name)) { notice('warning', '잠긴 방이야. 먼저 자물쇠를 눌러 해제해줘.'); return; }
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
    popup = document.getElementById('select_chat_popup');
    list = document.getElementById('select_chat_div');
    if (!popup || !list || document.getElementById('cbd-toolbar')) return;
    toolbar = document.createElement('div');
    toolbar.id = 'cbd-toolbar';
    toolbar.append(button('선택', 'toggle'), button('현재 목록 전체 선택', 'all'),
        button('선택 해제', 'clear'), button('휴지통으로 (0)', 'delete', 'cbd-delete'),
        button('선택 ZIP 백업', 'backup'), button('휴지통 / 복원', 'trash'), button('중단', 'stop'));
    const status = document.createElement('span');
    status.className = 'cbd-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    toolbar.append(status);
    list.before(toolbar);
    filterControls = document.createElement('div'); filterControls.id = 'cbd-filters';
    for (const [name, label, choices] of [
        ['order', '정렬', [['newest', '최신순'], ['oldest', '오래된순'], ['name-asc', '오름차순 (이름)'], ['name-desc', '내림차순 (이름)'], ['size', '용량 큰순'], ['messages', '메시지 많은순']]],
        ['filter', '필터', [['all', '전체'], ['locked', '잠긴 방'], ['unlocked', '안 잠긴 방']]],
    ]) {
        const wrapper = document.createElement('label'); wrapper.textContent = label;
        const select = document.createElement('select'); select.name = name; select.setAttribute('aria-label', label);
        for (const [value, text] of choices) {
            const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
        }
        wrapper.append(select); filterControls.append(wrapper);
    }
    filterControls.addEventListener('input', onListChanged);
    filterControls.addEventListener('change', onListChanged);
    list.before(filterControls);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    new MutationObserver(() => { onListChanged(); if (!busy) void refreshVault(); }).observe(list, { childList: true });
    document.getElementById('select_chat_search')?.addEventListener('input', onListChanged);
    const shadow = document.getElementById('shadow_select_chat_popup');
    if (shadow) new MutationObserver(() => {
        if (!busy && getComputedStyle(shadow).display === 'none') reset();
    }).observe(shadow, { attributes: true, attributeFilter: ['style', 'class'] });
    const ctx = getContext();
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => { if (!busy) reset(); });
    if (ctx.eventTypes.CHAT_RENAMED) ctx.eventSource.on(ctx.eventTypes.CHAT_RENAMED, async event => {
        const t = event.groupId ? { kind: 'group', id: event.groupId } : { kind: 'character', avatar: event.avatarId };
        try {
            const response = await post('/api/files/sanitize-filename', { fileName: event.newFileName });
            const renamed = (await response.json()).fileName;
            if (typeof renamed !== 'string' || !renamed) throw new Error('변경된 파일명을 확인할 수 없어.');
            await getVault().renameLock(t, event.oldFileName.replace(/\.jsonl$/, ''), renamed.replace(/\.jsonl$/, ''));
            onListChanged();
        } catch (error) { notice('error', `이름 변경 후 잠금 저장 실패: ${error.message} 새 이름의 잠금을 확인해줘.`); }
    });
    void refreshVault();
    render();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
