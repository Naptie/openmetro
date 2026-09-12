import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";

const projectName = process.env.PAGES_PROJECT;
if (!projectName) {
  console.error("PAGES_PROJECT must be set (globally unique Cloudflare Pages project name).");
  process.exit(1);
}

if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(projectName)) {
  console.error(
    `PAGES_PROJECT must be lowercase alphanumeric with dashes only, got: ${projectName}`,
  );
  process.exit(1);
}

// Pages requires top-level `name`, does not expand env vars there, and
// rejects --config. Temporarily write the resolved name into wrangler.toml.
const webRoot = resolve(import.meta.dir, "..");
const configPath = join(webRoot, "wrangler.toml");
const original = readFileSync(configPath, "utf8");

try {
  writeFileSync(
    configPath,
    [
      `name = "${projectName}"`,
      `pages_build_output_dir = "build"`,
      `compatibility_date = "2025-06-27"`,
      "",
    ].join("\n"),
  );
  await $`bunx wrangler pages deploy build --branch=main`.cwd(webRoot);
} finally {
  writeFileSync(configPath, original);
}
