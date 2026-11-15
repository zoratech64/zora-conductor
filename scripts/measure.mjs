import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../src/args.mjs';
import { loadConfig } from '../src/config.mjs';
import { dispatch } from '../src/dispatch.mjs';
import { head } from '../src/gitx.mjs';
import { loadEccAssets, loadEccRules } from '../src/prompt.mjs';
import { parseTask } from '../src/task.mjs';

const USAGE = 'usage: node scripts/measure.mjs prompt [--project <dir>] [--packs <a,b>] <task.md>...';

function parsePacks(packs) {
  if (packs === undefined) return undefined;
  if (Array.isArray(packs)) return packs;
  return String(packs).split(',').map((p) => p.trim()).filter(Boolean);
}

export async function measurePrompts({ root, files = [], packs } = {}) {
  const projectRoot = resolve(root ?? process.cwd());
  if (!Array.isArray(files) || !files.length) {
    throw new Error('at least one task file required');
  }

  let commit = null;
  try {
    commit = head(projectRoot);
  } catch {
    commit = null;
  }

  const tasks = [];
  let finalConfig = null;

  for (const file of files) {
    const baseConfig = loadConfig(projectRoot);
    const overriddenPacks = parsePacks(packs);
    const config = {
      ...baseConfig,
      ecc: {
        ...baseConfig.ecc,
        rulePacks: overriddenPacks !== undefined ? overriddenPacks : baseConfig.ecc.rulePacks
      }
    };
    finalConfig = config;

    const filePath = existsSync(resolve(projectRoot, file))
      ? resolve(projectRoot, file)
      : resolve(file);

    const text = readFileSync(filePath, 'utf8');
    const task = parseTask(text, { fallbackId: basename(file).replace(/\.\w+$/, '') });

    const { prompt } = await dispatch({ root: projectRoot, task, config, dryRun: true });
    const eccRules = loadEccRules(config);
    const eccAssets = loadEccAssets(config, task);

    tasks.push({
      file,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      promptChars: prompt.length,
      eccRulesChars: eccRules.length,
      eccAssetsChars: eccAssets.length,
      rulesTruncated: eccRules.includes('[... ECC rules truncated')
    });
  }

  return {
    kind: 'prompt-size',
    generatedAt: new Date().toISOString(),
    commit,
    node: process.version,
    rulePacks: finalConfig.ecc.rulePacks,
    maxChars: finalConfig.ecc.maxChars,
    tasks
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand !== 'prompt') {
    console.error(USAGE);
    process.exit(1);
  }

  let opts;
  try {
    opts = parseArgs(rest);
  } catch (error) {
    console.error(`measure: ${error.message}`);
    process.exit(1);
  }

  if (!opts._.length) {
    console.error('measure: at least one task file required');
    process.exit(1);
  }

  try {
    const result = await measurePrompts({
      root: opts.project,
      files: opts._,
      packs: opts.packs
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`measure: ${error.message}`);
    process.exit(1);
  }
}
