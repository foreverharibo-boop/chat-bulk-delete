// Standard ZIP (stored entries, UTF-8 names). No CDN or external dependency.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
export function backupNames(names) {
    const used = new Set();
    return names.map(name => {
        const safe = Array.from(name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')).slice(0, 60).join('').replace(/[. ]+$/, '') || '채팅';
        const base = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(safe) ? `_${safe}` : safe;
        let candidate = `${base}.jsonl`, i = 2;
        while (used.has(candidate.normalize('NFC').toLowerCase())) candidate = `${base} (${i++}).jsonl`;
        used.add(candidate.normalize('NFC').toLowerCase());
        return candidate;
    });
}
export function makeZip(files) {
    if (files.length > 65535) throw new Error('한 번에 백업할 수 있는 파일 수를 넘었어. 나눠서 백업해줘.');
    const parts = [], directory = [];
    let offset = 0, directorySize = 0;
    for (const file of files) {
        const name = encoder.encode(file.name), bytes = encoder.encode(file.text);
        const crc = crc32(bytes);
        if (bytes.length > 0xffffffff || offset + bytes.length + name.length + 30 > 0xffffffff) throw new Error('ZIP이 너무 커. 나눠서 백업해줘.');
        const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
        h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
        h.setUint16(12, 33, true); // 1980-01-01
        h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true);
        h.setUint16(26, name.length, true); header.set(name, 30);
        const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
        c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
        c.setUint16(8, 0x800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true);
        c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true);
        c.setUint32(42, offset, true); central.set(name, 46);
        parts.push(header, bytes); directory.push(central);
        offset += header.length + bytes.length; directorySize += central.length;
    }
    if (offset + directorySize > 0xffffffff) throw new Error('ZIP이 너무 커. 나눠서 백업해줘.');
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
