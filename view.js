const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
export function fileSize(value) {
    const match = String(value).match(/([\d.,]+)\s*(B|KB|MB|GB|TB)/i);
    return match ? Number(match[1].replace(/,/g, '')) * 1024 ** ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(match[2].toUpperCase()) : 0;
}
export function arrange(items, { order = 'newest', filter = 'all', name = '' } = {}) {
    const query = name.normalize('NFC').toLocaleLowerCase('ko');
    const filtered = items.filter(x => x.name.normalize('NFC').toLocaleLowerCase('ko').includes(query)
        && (filter === 'all' || (filter === 'locked' && x.locked) || (filter === 'unlocked' && !x.locked)
            || (filter === 'empty' && x.count === 0) || (filter === 'duplicates' && x.duplicate)));
    return filtered.sort((a, b) => {
        if (order === 'name-asc') return collator.compare(a.name, b.name) || a.index - b.index;
        if (order === 'name-desc') return collator.compare(b.name, a.name) || a.index - b.index;
        if (order === 'oldest') return b.index - a.index;
        if (order === 'size') return b.size - a.size || a.index - b.index;
        if (order === 'messages') return b.count - a.count || a.index - b.index;
        return a.index - b.index;
    });
}
