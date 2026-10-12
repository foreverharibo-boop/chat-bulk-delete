// Dependencies are supplied by index.js so deletion can be tested without chat data.
export async function deleteSelected(names, target, api, progress, shouldStop) {
    const deleted = [];
    const failed = [];
    const warnings = [];
    let stopped = false;
    const assertTarget = () => {
        if (!api.sameTarget(target) || api.isGenerating() || api.currentChat() !== target.active) {
            throw new Error('채팅 대상이 바뀌었거나 답변이 생성 중이라 삭제를 중단했어.');
        }
    };
    assertTarget();
    const unique = [...new Set(names)];
    // Flush ST's debounced save before deleting the open chat.
    // An unselected open chat must not be saved by this operation.
    if (unique.includes(target.active)) await api.saveChat();
    assertTarget();
    const available = new Set(await api.listNames(target));
    // Delete the currently displayed chat last to avoid saving it back to disk.
    const ordered = unique.filter(x => x !== target.active);
    if (unique.includes(target.active)) ordered.push(target.active);
    try {
        for (const name of ordered) {
            if (shouldStop()) { stopped = true; break; }
            assertTarget();
            if (!available.has(name)) {
                failed.push({ name, message: '현재 채팅 목록에서 찾을 수 없어.' });
                progress(deleted.length, failed.length, unique.length);
                continue;
            }
            // If the open chat changed externally, stop before another deletion.
            if (api.currentChat() !== target.active) {
                stopped = true;
                warnings.push('열려 있는 채팅이 바뀌어서 남은 삭제를 중단했어.');
                break;
            }
            try {
                await api.remove(target, name);
            } catch (error) {
                failed.push({ name, message: error.message });
                progress(deleted.length, failed.length, unique.length);
                continue;
            }
            deleted.push(name);
            // Disk deletion is already complete; later UI errors must not count it as failed.
            try { await api.afterDelete(target, name); }
            catch (error) { warnings.push(`${name}: ${error.message}`); }
            progress(deleted.length, failed.length, unique.length);
        }
    } catch (error) {
        stopped = true;
        warnings.push(error.message);
    } finally {
        if (deleted.length) {
            try { await api.finish(target, deleted); }
            catch (error) { warnings.push(`목록 갱신 오류: ${error.message}`); }
        }
    }
    return { deleted, failed, warnings, stopped, remaining: unique.filter(x => !deleted.includes(x)) };
}
