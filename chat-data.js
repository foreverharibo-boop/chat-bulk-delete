// Chat read helpers and a narrowly scoped legacy-trash migration.
export const scopeKey = t => JSON.stringify([t.kind, t.kind === 'group' ? String(t.id) : t.avatar]);
export function parseChat(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(x => x.trim());
    if (!lines.length) throw new Error('빈 채팅 파일이라 내용을 확인할 수 없어.');
    const data = lines.map(line => JSON.parse(line));
    if (data.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error('채팅 파일 형식이 올바르지 않아.');
    return data;
}
export async function exportChat(t, name, post) {
    const response = await post('/api/chats/export', {
        is_group: t.kind === 'group', avatar_url: t.avatar || null,
        file: `${name}.jsonl`, exportfilename: `${name}.jsonl`, format: 'jsonl',
    });
    const result = await response.json();
    if (typeof result.result !== 'string' || !result.result.length) throw new Error('채팅 원본을 읽을 수 없어.');
    return result.result;
}

// No chat endpoints or directory-wide deletes: only validated v2 backup paths.
export async function cleanupLegacyTrash({ fetcher, headers, post }) {
    const statePath = 'user/files/cbd-v2-state.json';
    const read = async path => {
        const response = await fetcher('/' + path, { cache: 'no-store', headers: headers() });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`보관 파일 읽기 실패 (${response.status})`);
        return response.text();
    };
    const rawState = await read(statePath);
    if (rawState === null) return { deleted: 0, cleaned: false };
    const state = JSON.parse(rawState);
    if (state?.version !== 2 || !Array.isArray(state.entries)
        || !state.locks || typeof state.locks !== 'object' || Array.isArray(state.locks)) {
        throw new Error('예전 휴지통 목록 형식을 확인할 수 없어.');
    }
    const validTarget = t => t && (t.kind === 'character' ? typeof t.avatar === 'string' && t.avatar.length > 0
        : t.kind === 'group' && ['string', 'number'].includes(typeof t.id));
    const paths = new Set();
    const entries = state.entries.map(entry => {
        const path = `user/files/cbd-v2-trash-${entry?.id}.json`;
        if (!/^[a-f0-9]{32}$/.test(entry?.id) || typeof entry.path !== 'string'
            || entry.path.replace(/^\//, '') !== path || paths.has(path)
            || typeof entry.name !== 'string' || !validTarget(entry.target)) {
            throw new Error('예전 휴지통 보관 경로를 확인할 수 없어.');
        }
        paths.add(path);
        return { ...entry, path };
    });
    const assertUnchanged = async () => {
        if (await read(statePath) !== rawState) throw new Error('다른 창에서 휴지통 목록이 바뀌었어.');
    };
    const remove = async path => {
        const response = await post('/api/files/delete', { path });
        if (!response.ok || await read(path) !== null) throw new Error('예전 보관 파일 삭제를 확인할 수 없어.');
    };
    let deleted = 0;
    for (const entry of entries) {
        const raw = await read(entry.path);
        // A previous attempt may have deleted a file before losing its connection.
        if (raw === null) continue;
        const record = JSON.parse(raw);
        if (record?.version !== 2 || record.id !== entry.id || record.name !== entry.name
            || !validTarget(record.target) || scopeKey(record.target) !== scopeKey(entry.target)
            || typeof record.raw !== 'string') throw new Error('예전 휴지통 보관본 정보를 확인할 수 없어.');
        await assertUnchanged();
        await remove(entry.path);
        deleted++;
    }
    // Keep the index on any failure so the next startup can retry remaining files.
    await assertUnchanged();
    await remove(statePath);
    return { deleted, cleaned: true };
}
