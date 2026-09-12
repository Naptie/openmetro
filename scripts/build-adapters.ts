/**
 * Build every discovered adapter package (`@openmetro/adapter-*`).
 * Discovers packages from packages/adapters/<network-id>/package.json.
 * Adding a city requires no change to this script or the root package.json.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTERS_DIR = join(ROOT, "packages/adapters");

async function discover(): Promise<{ dir: string; name: string }[]> {
  const entries = await readdir(ADAPTERS_DIR, { withFileTypes: true });
  const out: { dir: string; name: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkgPath = join(ADAPTERS_DIR, e.name, "package.json");
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
        name?: string;
        openmetro?: { networkId?: string };
      };
      if (pkg.name?.startsWith("@openmetro/adapter-") && pkg.openmetro?.networkId) {
        out.push({ dir: join(ADAPTERS_DIR, e.name), name: pkg.name });
      }
    } catch {
      // skip non-adapter dirs
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const adapters = await discover();
  if (adapters.length === 0) {
    console.error("no adapters found under packages/adapters/");
    process.exit(1);
  }
  console.log(`building ${adapters.length} adapter(s): ${adapters.map((a) => a.name).join(", ")}`);
  const { spawn } = await import("node:child_process");
  for (const a of adapters) {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("bun", ["run", "build"], { cwd: a.dir, stdio: "inherit", shell: true });
      child.on("exit", (code) =>
        code === 0 ? resolvePromise() : reject(new Error(`${a.name} build exited ${code}`)),
      );
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
