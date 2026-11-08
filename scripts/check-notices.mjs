// Check that every file under vendor/ is listed in THIRD_PARTY_NOTICES.md, so no third-party
// material is bundled without its source, licence and copyright being recorded. Run by `npm run check`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const NOTICES = 'THIRD_PARTY_NOTICES.md';
const VENDOR = 'vendor';

/** Every file (any depth, dotfiles included) under <root>/vendor, as forward-slash paths. */
function vendorFiles(root) {
  const out = [];
  const visit = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else out.push(child);
    }
  };
  if (existsSync(join(root, VENDOR))) visit(VENDOR);
  return out.sort();
}

/** The `vendor/...` paths listed as "- `vendor/...`" lines in the notices file. */
function listedFiles(text) {
  return [...text.replace(/\r/g, '').matchAll(/^- `(vendor\/[^`]+)`/gm)].map((m) => m[1]);
}

/** Returns { ok, problems }. */
export function checkNotices(root) {
  const problems = [];
  let text;
  try {
    text = readFileSync(join(root, NOTICES), 'utf8');
  } catch (error) {
    return { ok: false, problems: [`cannot read ${NOTICES}: ${error.code ?? error.message}`] };
  }
  const listed = listedFiles(text);
  const seen = new Set();
  for (const file of listed) {
    if (seen.has(file)) problems.push(`${file} is listed more than once in ${NOTICES}`);
    seen.add(file);
  }
  for (const file of vendorFiles(root)) {
    if (!seen.has(file)) problems.push(`${file} is not listed in ${NOTICES}`);
  }
  for (const file of seen) {
    if (!existsSync(join(root, file))) problems.push(`${file} is listed in ${NOTICES} but does not exist`);
  }
  return { ok: problems.length === 0, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..'));
  const result = checkNotices(root);
  if (result.ok) {
    console.log(`notices ok (${NOTICES})`);
  } else {
    for (const p of result.problems) console.error(`notices check: ${p}`);
    process.exitCode = 1;
  }
}
