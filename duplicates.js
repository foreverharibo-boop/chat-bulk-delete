// Read-only comparison of the selected conversation, not the entire backup file.
const attachmentKeys = ['image', 'file', 'files', 'media', 'video', 'audio'];
function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') {
        return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
}
export function conversationContent(raw) {
    const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) throw new Error('빈 파일이라 내용을 확인할 수 없어.');
    const messages = [];
    for (let i = 0; i < lines.length; i++) {
        const message = JSON.parse(lines[i]);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('올바른 채팅 파일이 아니야.');
        if (i === 0 && !Object.hasOwn(message, 'mes')
            && (Object.hasOwn(message, 'chat_metadata') || Object.hasOwn(message, 'user_name'))) continue;
        if (typeof message.mes !== 'string') throw new Error('메시지 본문을 확인할 수 없어.');
        // mes is the selected swipe's original text. Optional bookkeeping,
        // alternative swipes, translations and extension data are not this text.
        // Preserve every message (including hidden ones), whitespace and order.
        const content = {
            name: message.name ?? '', is_user: Boolean(message.is_user),
            is_system: Boolean(message.is_system), mes: message.mes,
            attachments: {},
        };
        for (const key of attachmentKeys) {
            const value = message.extra?.[key];
            if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
            content.attachments[key] = value;
        }
        messages.push(stable(content));
    }
    if (!messages.length) throw new Error('비교할 메시지가 없어.');
    return '[' + messages.join(',') + ']';
}
export async function findDuplicateChats(names, read, { hash, shouldStop = () => false, assertContext = () => {}, progress = () => {} }) {
    const buckets = new Map(), failed = [];
    const unique = [...new Set(names)];
    const check = () => { assertContext(); return shouldStop(); };
    for (let i = 0; i < unique.length; i++) {
        if (check()) return { groups: [], failed, stopped: true };
        const name = unique[i];
        try {
            const content = conversationContent(await read(name));
            if (check()) return { groups: [], failed, stopped: true };
            const key = await hash(content);
            if (check()) return { groups: [], failed, stopped: true };
            const bucket = buckets.get(key) || [];
            let match;
            for (const candidate of bucket) {
                if (candidate.invalid) continue;
                let reference;
                try { reference = conversationContent(await read(candidate.names[0])); }
                catch (error) {
                    candidate.invalid = true;
                    failed.push({ name: candidate.names[0], message: error.message });
                    continue;
                }
                if (check()) return { groups: [], failed, stopped: true };
                if (await hash(reference) !== key) {
                    candidate.invalid = true;
                    failed.push({ name: candidate.names[0], message: '검사 중 내용이 바뀌었어.' });
                    continue;
                }
                // Hashes only find candidates. Compare the entire content exactly.
                if (reference === content) { match = candidate; break; }
            }
            if (match) match.names.push(name);
            else bucket.push({ names: [name], invalid: false });
            buckets.set(key, bucket);
        } catch (error) {
            assertContext();
            failed.push({ name, message: error.message });
        }
        progress(i + 1, unique.length);
        // Give mobile browsers a chance to paint the progress and handle Stop.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (check()) return { groups: [], failed, stopped: true };
    return { groups: [...buckets.values()].flat().filter(x => !x.invalid && x.names.length > 1).map(x => x.names), failed, stopped: false };
}
