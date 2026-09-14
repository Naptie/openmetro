/**
 * Stage a self-contained npm package for the typed Eden client under
 * `dist/client/` (runtime + types from the tsup build, manifest).
 *
 * The workflow then runs `npm pack dist/client` to produce the release tarball.
 *
 * Usage: `bun run scripts/build-client-package.ts [--out <dir>]`
 *
 * The package has two entries:
 * - `.` — the typed Eden Treaty factory (`.d.ts` + tiny `index.js`).
 * - `./schemas` — zod runtime validation schemas (`schemas.js` + `schemas.d.ts`),
 *   generated from the server's wire schemas. Imports `zod` externally, which is
 *   declared as an *optional* peer so the main entry stays installable without it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PACKAGE_NAME = 'openmetro-client';

async function readRequired(rel: string): Promise<string> {
  return readFile(join('packages/client/dist', rel), 'utf-8').catch(() => {
    throw new Error(`packages/client/dist/${rel} missing - run \`bun run build\` first`);
  });
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--out');
  const out = resolve(i >= 0 ? (process.argv[i + 1] ?? 'dist/client') : 'dist/client');

  const root = JSON.parse(await readFile('package.json', 'utf-8')) as { version: string };
  const [indexDts, indexJs, schemasDts, schemasJs] = await Promise.all([
    readRequired('index.d.ts'),
    readRequired('index.js'),
    readRequired('schemas.d.ts'),
    readRequired('schemas.js')
  ]);

  await mkdir(out, { recursive: true });
  await Promise.all([
    writeFile(join(out, 'index.d.ts'), indexDts, 'utf-8'),
    writeFile(join(out, 'index.js'), indexJs, 'utf-8'),
    writeFile(join(out, 'schemas.d.ts'), schemasDts, 'utf-8'),
    writeFile(join(out, 'schemas.js'), schemasJs, 'utf-8')
  ]);

  const manifest = {
    name: PACKAGE_NAME,
    version: root.version,
    description: 'Typed Eden Treaty client for the Open Metro API',
    type: 'module',
    main: 'index.js',
    types: 'index.d.ts',
    exports: {
      '.': { types: './index.d.ts', import: './index.js' },
      './schemas': { types: './schemas.d.ts', import: './schemas.js' }
    },
    files: ['index.js', 'index.d.ts', 'schemas.js', 'schemas.d.ts', 'README.md'],
    peerDependencies: {
      '@elysia/eden': '>=1.0.0',
      elysia: '>=1.0.0',
      // index.d.ts imports effect's Schema/Effect types (core's schemas are
      // effect classes), so consumers need effect resolvable for the types.
      effect: '>=3.0.0',
      // Only `openmetro-client/schemas` needs zod at runtime.
      zod: '>=3.0.0'
    },
    peerDependenciesMeta: {
      zod: { optional: true }
    }
  };
  await writeFile(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  await writeFile(
    join(out, 'README.md'),
    [
      `# ${PACKAGE_NAME}`,
      '',
      'Fully typed [Eden Treaty](https://elysiajs.com/eden/treaty/overview) client for',
      "the Open Metro API. Request and response types are generated from the server's",
      'own Elysia app — there is no hand-written contract.',
      '',
      '```bash',
      '# From the published client branch (preferred)',
      'npm install github:Naptie/openmetro#client elysia @elysia/eden effect',
      '',
      '# Or from a release tarball',
      `npm install <path-or-url-to>/${PACKAGE_NAME}-${root.version}.tgz`,
      'npm install elysia @elysia/eden effect',
      '```',
      '',
      '```ts',
      `import { createClient } from "${PACKAGE_NAME}";`,
      '',
      'const metro = createClient("http://127.0.0.1:8790");',
      'const { data } = await metro.api.networks({ id: "cn-bj" }).stations.get();',
      '```',
      '',
      '## Derived entity types',
      '',
      'Named response types are exported too, all inferred from the API:',
      '',
      '```ts',
      `import type { ApiLine, ApiRoutePlan, ApiStation } from "${PACKAGE_NAME}";`,
      '',
      'const mode: ApiLine["mode"] = "metro";',
      '```',
      '',
      '`ApiSuccess<Route>` unwraps the success payload of any route method:',
      '',
      '```ts',
      `import type { ApiSuccess, Client } from "${PACKAGE_NAME}";`,
      '',
      'type Networks = ApiSuccess<Client["api"]["networks"]["get"]>;',
      '```',
      '',
      '## Runtime validation schemas',
      '',
      'The `./schemas` subpath ships zod schemas for every documented response',
      'shape, generated from the same wire schemas the server validates against',
      '(single source of truth):',
      '',
      '```bash',
      'npm install zod  # optional peer, only needed for the ./schemas subpath',
      '```',
      '',
      '```ts',
      `import { apiRoutePlanSchema } from "${PACKAGE_NAME}/schemas";`,
      '',
      'const result = apiRoutePlanSchema.safeParse(plan);',
      'if (!result.success) console.log(result.error);',
      '```',
      '',
      'Every schema is also reachable through the `apiSchemas` map keyed by its',
      'wire name (`ApiLine`, `ApiRoutePlan`, ...).'
    ].join('\n'),
    'utf-8'
  );

  console.log(`client package: ${out} (${PACKAGE_NAME}@${root.version})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
