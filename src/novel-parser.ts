export type Chapter = { title: string; text: string };
export type Novel = { id: string; title: string; chapters: Chapter[]; chapter: number; paragraph: number };
const xml = (text: string) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw Error('EPUB 内部文档格式不完整。');
  return doc;
};
const elements = (doc: Document, name: string) => [...doc.getElementsByTagNameNS('*', name)];

async function epub(file: File): Promise<{ title: string; chapters: Chapter[] }> {
  const bytes = new Uint8Array(await file.arrayBuffer()), v = new DataView(bytes.buffer);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65557) throw Error('无法读取 EPUB 压缩目录。');
  const count = v.getUint16(end + 10, true);
  if (count > 4000 || v.getUint16(end + 4, true)) throw Error('EPUB 文件结构暂不支持。');
  const entries = new Map<string, { start: number; size: number; packed: number; method: number }>();
  let offset = v.getUint32(end + 16, true), total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.length || v.getUint32(offset, true) !== 0x02014b50) throw Error('EPUB 目录损坏。');
    const length = v.getUint16(offset + 28, true), extra = v.getUint16(offset + 30, true), comment = v.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + length));
    const size = v.getUint32(offset + 24, true), packed = v.getUint32(offset + 20, true);
    if (v.getUint16(offset + 8, true) & 1) throw Error('暂不支持加密 EPUB。');
    total += size; if (total > 100 * 1048576) throw Error('EPUB 解压后超过 100 MB，请使用较小的文件。');
    entries.set(name, { start: v.getUint32(offset + 42, true), size, packed, method: v.getUint16(offset + 10, true) });
    offset += 46 + length + extra + comment;
  }
  const read = async (name: string) => {
    const e = entries.get(name); if (!e) throw Error('EPUB 缺少章节：' + name);
    if (e.size > 8 * 1048576 || e.start + 30 > bytes.length || v.getUint32(e.start, true) !== 0x04034b50) throw Error('EPUB 章节过大或损坏。');
    const start = e.start + 30 + v.getUint16(e.start + 26, true) + v.getUint16(e.start + 28, true);
    if (start + e.packed > bytes.length) throw Error('EPUB 章节不完整。');
    const blob = new Blob([bytes.slice(start, start + e.packed)]);
    if (e.method === 0) return blob.text();
    if (e.method !== 8) throw Error('不支持此 EPUB 压缩方式。');
    const reader = blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = []; let size = 0;
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > e.size || size > 8 * 1048576) throw Error('EPUB 章节大小异常。'); chunks.push(new Uint8Array(r.value)); } }
    finally { await reader.cancel(); }
    if (size !== e.size) throw Error('EPUB 章节解压不完整。');
    return new Blob(chunks).text();
  };
  const container = xml(await read('META-INF/container.xml'));
  const packagePath = elements(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!packagePath) throw Error('EPUB 没有书籍目录。');
  const pkg = xml(await read(packagePath));
  const items = new Map(elements(pkg, 'item').map(e => [e.getAttribute('id'), e]));
  const chapters: Chapter[] = [];
  for (const ref of elements(pkg, 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = items.get(ref.getAttribute('idref')), href = item?.getAttribute('href');
    if (!href || !/html/.test(item?.getAttribute('media-type') ?? '')) continue;
    const url = new URL(href, 'https://book.local/' + packagePath);
    if (url.origin !== 'https://book.local') continue;
    const doc = xml(await read(decodeURIComponent(url.pathname.slice(1))));
    for (const tag of ['script','style','nav','svg']) elements(doc, tag).forEach(n => n.remove());
    const body = elements(doc, 'body')[0]; if (!body) continue;
    for (const tag of ['p','div','h1','h2','h3','li','br']) elements(doc, tag).forEach(n => n.append(doc.createTextNode('\n')));
    const text = (body.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
    if (text) chapters.push({ title: (elements(doc, 'h1')[0]?.textContent || elements(doc, 'h2')[0]?.textContent || elements(doc, 'title')[0]?.textContent || '第 ' + (chapters.length + 1) + ' 节').trim().slice(0, 100), text });
  }
  if (!chapters.length) throw Error('EPUB 没有可朗读的文字章节。');
  return { title: elements(pkg, 'title')[0]?.textContent?.trim() || file.name.replace(/\.epub$/i, ''), chapters };
}

export async function parseNovel(file: File): Promise<Novel> {
  if (file.size > 30 * 1048576) throw Error('请导入 30 MB 以内的 TXT 或 EPUB。');
  let result: { title: string; chapters: Chapter[] };
  if (/\.epub$/i.test(file.name)) result = await epub(file);
  else if (/\.txt$/i.test(file.name)) {
    const bytes = await file.arrayBuffer(); let text: string;
    const mark = new Uint8Array(bytes);
    if (mark[0] === 255 && mark[1] === 254) text = new TextDecoder('utf-16le').decode(bytes);
    else if (mark[0] === 254 && mark[1] === 255) text = new TextDecoder('utf-16be').decode(bytes);
    else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gb18030').decode(bytes); } }
    const chapters: Chapter[] = []; let title = '正文', lines: string[] = [];
    const flush = () => { const text = lines.join('\n').trim(); if (text) chapters.push({ title, text }); lines = []; };
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
      if (/^\s*(第[零〇一二三四五六七八九十百千万两\d]+[章回节卷部].{0,65}|序章|序言|楔子|尾声|后记|chapter\s+\d+.{0,65})\s*$/i.test(line)) { flush(); title = line.trim(); }
      lines.push(line);
    }
    flush(); result = { title: file.name.replace(/\.txt$/i, ''), chapters };
  } else throw Error('请选择 TXT 或 EPUB 文件。');
  if (!result.chapters.length) throw Error('文件里没有可朗读的文字。');
  return { id: crypto.randomUUID(), ...result, chapter: 0, paragraph: 0 };
}

export function speechParts(text: string) { return text.match(/[^。！？!?\n]{1,160}[。！？!?\n]?|[。！？!?\n]/g)?.map(s => s.trim()).filter(Boolean) ?? []; }
