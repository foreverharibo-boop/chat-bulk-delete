// Server-backed copies. No chat is removed by this module.
const STATE_FILE = 'cbd-v2-state.json';
const STATE_URL = `/files/${STATE_FILE}`;
export const scopeKey = t => JSON.stringify([t.kind, t.kind === 'group' ? String(t.id) : t.avatar]);
export const lockKey = (t, name) => JSON.stringify([scopeKey(t), name]);
export function uniqueId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}
export function parseChat(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(x => x.trim());
    if (!lines.length) throw new Error('빈 채팅 파일이라 자동 복원할 수 없어.');
    const data = lines.map(line => JSON.parse(line));
    if (data.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error('채팅 파일 형식이 올바르지 않아.');
    return data;
}
export function restoredName(name) {
    // Bounded UTF-8 filename plus random suffix; never restore over the old name.
    const prefix = Array.from(name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')).slice(0, 35).join('');
    return `${prefix || '채팅'} - 복원 ${uniqueId()}`;
}
function base64(text) {
    const data = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768));
    return btoa(binary);
}
export class ChatVault {
    constructor({ post, getContext, fetcher = fetch }) {
        this.post = post; this.getContext = getContext; this.fetcher = fetcher;
        this.state = { version: 2, revision: '', entries: [], locks: {} };
        this.ready = false;
        this.queue = Promise.resolve();
    }
    async read(path, missing = false) {
        // Only our own same-origin file namespace may be read.
        if (!/^\/?files\/cbd-v2-[a-zA-Z0-9_-]+\.json$/.test(path)) throw new Error('보관 파일 경로가 올바르지 않아.');
        const response = await this.fetcher('/' + path.replace(/^\//, ''), {
            cache: 'no-store', headers: this.getContext().getRequestHeaders(),
        });
        if (missing && response.status === 404) return null;
        if (!response.ok) throw new Error(`보관 파일 읽기 실패 (${response.status})`);
        return response.text();
    }
    async load() {
        const raw = await this.read(STATE_URL, true);
        const state = raw === null ? { version: 2, revision: '', entries: [], locks: {} } : JSON.parse(raw);
        if (state.version !== 2 || !Array.isArray(state.entries) || !state.locks || typeof state.locks !== 'object') {
            throw new Error('휴지통 목록을 읽을 수 없어. 안전을 위해 작업을 중단했어.');
        }
        this.state = state; this.ready = true;
        return state;
    }
    async upload(name, text) {
        const response = await this.post('/api/files/upload', { name, data: base64(text) });
        const result = await response.json();
        if (result.path?.replace(/^\//, '') !== `files/${name}`) throw new Error('보관 파일 저장 경로를 확인할 수 없어.');
        const saved = await this.read(result.path);
        if (saved !== text) throw new Error('보관 파일 검증에 실패했어. 원본을 삭제하지 않을게.');
        return result.path;
    }
    mutate(change) {
        const work = this.queue.then(async () => {
            await this.load();
            const next = JSON.parse(JSON.stringify(this.state));
            await change(next);
            next.revision = uniqueId();
            await this.upload(STATE_FILE, JSON.stringify(next));
            this.state = next;
            return next;
        });
        this.queue = work.catch(() => {});
        return work;
    }
    isLocked(t, name) { return Boolean(this.state.locks[lockKey(t, name)]); }
    async setLock(t, name, value) {
        await this.mutate(state => {
            if (value) state.locks[lockKey(t, name)] = true;
            else delete state.locks[lockKey(t, name)];
        });
    }
    async renameLock(t, oldName, newName) {
        await this.mutate(state => {
            if (state.locks[lockKey(t, oldName)]) {
                state.locks[lockKey(t, newName)] = true;
                delete state.locks[lockKey(t, oldName)];
            }
        });
    }
    async exportChat(t, name) {
        const response = await this.post('/api/chats/export', {
            is_group: t.kind === 'group', avatar_url: t.avatar || null,
            file: `${name}.jsonl`, exportfilename: `${name}.jsonl`, format: 'jsonl',
        });
        const result = await response.json();
        if (typeof result.result !== 'string' || !result.result.length) throw new Error('채팅 원본을 읽을 수 없어.');
        return result.result;
    }
    async archive(t, name) {
        await this.load();
        if (this.isLocked(t, name)) throw new Error('잠긴 채팅은 휴지통으로 이동할 수 없어.');
        const raw = await this.exportChat(t, name);
        const id = uniqueId();
        const group = t.kind === 'group' ? this.getContext().groups.find(g => String(g.id) === String(t.id)) : null;
        const record = {
            version: 2, id, target: { ...t }, name, raw, created: Date.now(),
            groupMetadata: group?.past_metadata?.[name] || (name === group?.chat_id ? group.chat_metadata : {}) || {},
        };
        const path = await this.upload(`cbd-v2-trash-${id}.json`, JSON.stringify(record));
        const entry = { id, target: { ...t }, name, path, created: record.created, status: 'prepared' };
        await this.mutate(state => {
            if (state.locks[lockKey(t, name)]) throw new Error('보관 중 채팅이 잠겨서 삭제를 중단했어.');
            state.entries.push(entry);
        });
        // Catch edits while uploading a large archive. A changed source stays intact.
        if (await this.exportChat(t, name) !== raw) throw new Error('보관 중 원본이 바뀌어서 삭제를 중단했어. 보관본은 휴지통에 남아 있어.');
        return entry;
    }
    async mark(id, status, extra = {}) {
        await this.mutate(state => {
            const entry = state.entries.find(x => x.id === id);
            if (!entry) throw new Error('휴지통 항목을 찾을 수 없어.');
            Object.assign(entry, extra, { status });
        });
    }
    async readEntry(entry) {
        const record = JSON.parse(await this.read(entry.path));
        if (record.id !== entry.id || record.name !== entry.name || scopeKey(record.target) !== scopeKey(entry.target)
            || typeof record.raw !== 'string') throw new Error('휴지통 파일과 목록 정보가 일치하지 않아.');
        return record;
    }
    async restore(entry) {
        const record = await this.readEntry(entry);
        const t = record.target;
        const ctx = this.getContext();
        const group = t.kind === 'group' ? ctx.groups.find(g => String(g.id) === String(t.id)) : null;
        if (t.kind === 'group' ? !group : !ctx.characters.some(c => c.avatar === t.avatar)) {
            throw new Error('원래 캐릭터/그룹을 찾을 수 없어. JSONL을 내려받아 직접 가져올 수 있어.');
        }
        const data = parseChat(record.raw);
        const name = restoredName(record.name);
        const response = await this.post(t.kind === 'group' ? '/api/chats/group/save' : '/api/chats/save',
            t.kind === 'group' ? { id: name, chat: data, force: false }
                : { avatar_url: t.avatar, file_name: name, chat: data, force: false });
        if ((await response.json()).ok !== true) throw new Error('복원 저장을 확인할 수 없어. 보관본은 유지돼.');
        const restored = parseChat(await this.exportChat(t, name));
        if (JSON.stringify(restored) !== JSON.stringify(data)) throw new Error('복원 내용 검증에 실패했어. 보관본은 유지돼.');
        if (group) {
            const updated = { ...group, chats: [...new Set([...group.chats, name])],
                past_metadata: { ...group.past_metadata, [name]: record.groupMetadata } };
            await this.post('/api/groups/edit', updated);
            Object.assign(group, updated);
        }
        // Retain the archive even after a successful restore. Never purge automatically.
        await this.mark(entry.id, 'restored', { restoredName: name, restoredAt: Date.now() });
        return name;
    }
}
