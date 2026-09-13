/**
 * i18n message manager for packages/web/messages/*.json.
 *
 * Usage (from the repo root):
 *   bun run scripts/manage-messages.ts            # audit: duplicates, missing keys, placeholder mismatches
 *   bun run scripts/manage-messages.ts --fix      # sort keys alphabetically ($schema pinned first) and rewrite
 *
 * Exits non-zero when inconsistencies are found, so it can gate CI.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'packages', 'web');
const messagesDir = join(root, 'messages');
const settings = JSON.parse(
  readFileSync(join(root, 'project.inlang', 'settings.json'), 'utf8')
) as { baseLocale?: string };

const BASE = settings.baseLocale ?? 'en';

interface LocaleFile {
  locale: string;
  data: Record<string, string>;
  path: string;
}

const SCHEMA_KEY = '$schema';

function loadLocales(): LocaleFile[] {
  return readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const path = join(messagesDir, file);
      return {
        locale: file.replace(/\.json$/, ''),
        data: JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>,
        path
      };
    });
}

/** {param} placeholders appearing in a message. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function sortKeys(data: Record<string, string>): Record<string, string> {
  const schema = SCHEMA_KEY in data ? { [SCHEMA_KEY]: data[SCHEMA_KEY] } : {};
  const keys = Object.keys(data)
    .filter((k) => k !== SCHEMA_KEY)
    .sort((a, b) => a.localeCompare(b, 'en'));
  return { ...schema, ...Object.fromEntries(keys.map((k) => [k, data[k]])) };
}

function main() {
  const fix = process.argv.includes('--fix');
  const locales = loadLocales();
  if (locales.length === 0) {
    console.error('No message files found in', messagesDir);
    process.exit(1);
  }

  const base = locales.find((l) => l.locale === BASE);
  if (!base) {
    console.error(`Base locale "${BASE}" has no message file`);
    process.exit(1);
  }

  const problems: string[] = [];
  const warnings: string[] = [];

  for (const file of locales) {
    if (!fix) {
      const sorted = `${JSON.stringify(sortKeys(file.data), null, '\t')}\n`;
      const current = `${JSON.stringify(file.data, null, '\t')}\n`;
      if (sorted !== current) {
        problems.push(`[${file.locale}] keys are not sorted (run with --fix)`);
      }
    }
  }

  const baseKeys = Object.keys(base.data).filter((k) => k !== SCHEMA_KEY);

  for (const file of locales) {
    if (file.locale === BASE) continue;
    const keys = Object.keys(file.data).filter((k) => k !== SCHEMA_KEY);
    for (const key of baseKeys) {
      if (!(key in file.data)) problems.push(`[${file.locale}] missing key: ${key}`);
    }
    for (const key of keys) {
      if (!(key in base.data)) problems.push(`[${file.locale}] extra key (not in ${BASE}): ${key}`);
    }
    for (const key of keys.filter((k) => k in base.data)) {
      const a = placeholders(base.data[key]);
      const b = placeholders(file.data[key]);
      if (a.join(',') !== b.join(',')) {
        problems.push(
          `[${file.locale}] placeholder mismatch for ${key}: {${a.join(', ')}} vs {${b.join(', ')}}`
        );
      }
    }
  }

  // Duplicate values within one locale: two keys sharing identical text may be redundant.
  for (const file of locales) {
    const byValue = new Map<string, string[]>();
    for (const [key, value] of Object.entries(file.data)) {
      if (key === SCHEMA_KEY || !value.trim()) continue;
      const list = byValue.get(value) ?? [];
      list.push(key);
      byValue.set(value, list);
    }
    for (const [value, keys] of byValue) {
      if (keys.length > 1) {
        warnings.push(`[${file.locale}] duplicate value for ${keys.join(', ')}: "${value}"`);
      }
    }
    // Empty messages can only render blanks.
    for (const [key, value] of Object.entries(file.data)) {
      if (key !== SCHEMA_KEY && !value.trim()) {
        problems.push(`[${file.locale}] empty message: ${key}`);
      }
    }
  }

  // Same text in every locale may mean an untranslated message; informational only.
  const zhLike = locales.filter((l) => l.locale !== BASE);
  for (const key of baseKeys) {
    const baseValue = base.data[key];
    if (!baseValue.trim()) continue;
    const same = zhLike.filter((l) => l.data[key] === baseValue).map((l) => l.locale);
    if (zhLike.length > 0 && same.length === zhLike.length) {
      warnings.push(`[all locales] identical to ${BASE} (untranslated?): ${key} = "${baseValue}"`);
    }
  }

  if (fix) {
    for (const file of locales) {
      writeFileSync(file.path, `${JSON.stringify(sortKeys(file.data), null, '\t')}\n`);
    }
    console.log(
      `Sorted ${locales.length} message file(s): ${locales.map((l) => l.locale).join(', ')}`
    );
  }

  if (problems.length > 0) {
    console.error(`\ni18n audit: ${problems.length} problem(s)`);
    for (const p of problems) console.error('  ✗', p);
  }
  if (warnings.length > 0) {
    console.warn(`\ni18n audit: ${warnings.length} warning(s)`);
    for (const w of warnings) console.warn('  ⚠', w);
  }

  if (problems.length === 0 && warnings.length === 0) {
    console.log(`i18n audit: OK (${baseKeys.length} keys across ${locales.length} locales)`);
  }
  if (problems.length > 0 && !fix) process.exit(1);
}

main();
