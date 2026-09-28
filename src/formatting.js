export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tags(entity, text) {
  const names = { bold: 'b', italic: 'i', underline: 'u', strikethrough: 's',
    code: 'code', pre: 'pre', blockquote: 'blockquote' };
  const name = names[entity.type];
  if (name) return [`<${name}>`, `</${name}>`];
  const url = entity.type === 'text_link' ? entity.url
    : entity.type === 'url' ? text.slice(entity.offset, entity.offset + entity.length) : null;
  if (url && /^https?:\/\//i.test(url)) return [`<a href="${escapeHtml(url)}">`, '</a>'];
  return null;
}

export function telegramToMaxHtml(text, entities = []) {
  const source = String(text);
  const starts = new Map();
  const ends = new Map();
  for (const entity of entities) {
    if (!Number.isInteger(entity.offset) || !Number.isInteger(entity.length)
        || entity.offset < 0 || entity.length <= 0 || entity.offset + entity.length > source.length) continue;
    const pair = tags(entity, source);
    if (!pair) continue;
    const start = starts.get(entity.offset) ?? [];
    start.push({ length: entity.length, open: pair[0] });
    starts.set(entity.offset, start);
    const end = ends.get(entity.offset + entity.length) ?? [];
    end.push({ length: entity.length, close: pair[1] });
    ends.set(entity.offset + entity.length, end);
  }
  let output = '';
  for (let offset = 0; offset <= source.length; offset += 1) {
    for (const item of (ends.get(offset) ?? []).sort((a, b) => a.length - b.length)) output += item.close;
    for (const item of (starts.get(offset) ?? []).sort((a, b) => b.length - a.length)) output += item.open;
    if (offset < source.length) output += escapeHtml(source[offset]);
  }
  return output;
}
