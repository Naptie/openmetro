/**
 * Stage a self-contained npm package for the typed Eden client under
 * `dist/client/` (types from the tsup build, minimal runtime, manifest).
 *
 * The workflow then runs `npm pack dist/client` to produce the release tarball.
 *
 * Usage: `bun run scripts/build-client-package.ts [--out <dir>]`
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PACKAGE_NAME = "openmetro-client";

async function main(): Promise<void> {
  const i = process.argv.indexOf("--out");
  const out = resolve(i >= 0 ? (process.argv[i + 1] ?? "dist/client") : "dist/client");

  const root = JSON.parse(await readFile("package.json", "utf-8")) as { version: string };
  const types = await readFile("packages/client/dist/index.d.ts", "utf-8").catch(() => {
    throw new Error("packages/client/dist/index.d.ts missing — run `bun run build` first");
  });

  await mkdir(out, { recursive: true });
  await writeFile(join(out, "index.d.ts"), types, "utf-8");

  // Minimal runtime: consumers supply their own @elysia/eden install.
  await writeFile(
    join(out, "index.js"),
    [
      "import { treaty } from '@elysia/eden';",
      "export const createClient = (baseUrl, config) => treaty(baseUrl, config);",
      "",
    ].join("\n"),
    "utf-8",
  );

  const manifest = {
    name: PACKAGE_NAME,
    version: root.version,
    description: "Typed Eden Treaty client for the Open Metro API",
    type: "module",
    main: "index.js",
    types: "index.d.ts",
    exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    files: ["index.js", "index.d.ts", "README.md"],
    peerDependencies: {
      "@elysia/eden": ">=1.0.0",
      elysia: ">=1.0.0",
      // index.d.ts imports effect's Schema/Effect types (core's schemas are
      // effect classes), so consumers need effect resolvable for the types.
      effect: ">=3.0.0",
    },
  };
  await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

  await writeFile(
    join(out, "README.md"),
    [
      `# ${PACKAGE_NAME}`,
      "",
      "Fully typed [Eden Treaty](https://elysiajs.com/eden/treaty/overview) client for",
      "the Open Metro API. Types are generated from the server's own Elysia app.",
      "",
      "```bash",
      `npm install <path-or-url-to>/${PACKAGE_NAME}-${root.version}.tgz`,
      "npm install elysia @elysia/eden effect",
      "```",
      "",
      "```ts",
      `import { createClient } from "${PACKAGE_NAME}";`,
      "",
      'const metro = createClient("http://127.0.0.1:8790");',
      'const { data } = await metro.api.networks({ id: "cn-bj" }).stations.get();',
      "```",
      "",
    ].join("\n"),
    "utf-8",
  );

  console.log(`client package: ${out} (${PACKAGE_NAME}@${root.version})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
