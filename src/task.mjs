import { parseMinutes } from './limits.mjs';
/** Shell-like splitting for verify commands. No expansion, no operators: argv only. */
export function splitArgv(text) {
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) current += text[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) { out.push(current); current = ''; started = false; }
    } else {
      current += c;
      started = true;
    }
  }
  if (quote) throw new Error(`unterminated quote in command: ${text}`);
  if (started) out.push(current);
  return out;
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/** Minimal front matter: `key: value`, `key:` + `- item` lines, or `key: [a, b]`. */
function parseFrontMatter(block) {
  const meta = {};
  let listKey = null;
  for (const raw of block.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey) { meta[listKey].push(unquote(item[1])); continue; }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') { meta[key] = []; listKey = key; continue; }
    listKey = null;
    meta[key] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map(unquote).filter(Boolean)
      : unquote(value);
  }
  return meta;
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function parseTask(text, { fallbackId = 'task' } = {}) {
  let meta = {};
  let body = text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match) {
    meta = parseFrontMatter(match[1]);
    body = text.slice(match[0].length);
  }
  const id = String(meta.id ?? fallbackId).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || fallbackId;
  return {
    meta: {
      id,
      title: meta.title ? String(meta.title) : '',
      allowed: asList(meta.allowed).map(String),
      verify: asList(meta.verify).map((line) => splitArgv(String(line))).filter((argv) => argv.length),
      ecc: asList(meta.ecc).map(String),
      minutes: meta.minutes === undefined ? undefined : parseMinutes(meta.minutes, 'task minutes'),
      model: meta.model ? String(meta.model) : undefined
    },
    body: body.trim()
  };
}
