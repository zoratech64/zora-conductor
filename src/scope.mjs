export const normalize = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Glob -> RegExp. Supports **, *, ? ; a trailing "/" means "everything below". */
export function globToRegExp(glob) {
  let g = normalize(glob);
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matches(path, globs) {
  const target = normalize(path);
  return globs.some((glob) => {
    const g = normalize(glob);
    if (globToRegExp(g).test(target)) return true;
    // A bare directory name ("lib/features/auth") covers everything beneath it.
    return !/[*?]/.test(g) && target.startsWith(`${g.replace(/\/$/, '')}/`);
  });
}

/** Never writable by a worker, whatever the task says. */
export const DEFAULT_FORBIDDEN = [
  '.git/**', '**/.git/**', '.zc/**',
  '.env', '.env.*', '**/.env', '**/.env.*',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore',
  '**/id_rsa*', '**/id_ed25519*', '**/credentials.json', '**/service-account*.json'
];

const TEMPLATE_SUFFIX = /\.(example|sample|template)$/i;

export function isForbidden(path, extra = []) {
  const target = normalize(path);
  if (TEMPLATE_SUFFIX.test(target)) return matches(target, extra);
  return matches(target, [...DEFAULT_FORBIDDEN, ...extra]);
}

/** Split changed paths into in-scope, forbidden, and outside the task's allow-list. */
export function partitionByScope(paths, allowed, extraForbidden = []) {
  const forbidden = [];
  const outOfScope = [];
  for (const path of paths) {
    if (isForbidden(path, extraForbidden)) forbidden.push(path);
    else if (!matches(path, allowed)) outOfScope.push(path);
  }
  return { forbidden, outOfScope };
}
