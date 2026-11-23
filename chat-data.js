// Chat read helpers; no backup, lock or trash state is read or written.
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
