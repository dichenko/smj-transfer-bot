// JSON.parse rounds MAX int64 identifiers. Quote integer tokens before parsing,
// leaving strings, fractions and exponents untouched.
export function parseMaxJson(raw) {
  let output = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < raw.length;) {
    const char = raw[index];
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      index += 1;
      continue;
    }
    if (char === '"') { quoted = true; output += char; index += 1; continue; }
    if (char === '-' || /[0-9]/.test(char)) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(index));
      if (match) {
        const value = match[0];
        output += /^-?\d+$/.test(value) && !Number.isSafeInteger(Number(value)) ? `"${value}"` : value;
        index += value.length;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return JSON.parse(output);
}
