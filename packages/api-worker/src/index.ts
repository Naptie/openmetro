import { createApiApp } from "../../core/src/api/app.js";
import { createMemoryNetworkSource } from "../../core/src/data/memory.js";
import { files } from "./data.generated.js";

/**
 * Cloudflare Worker entry point.
 *
 * The canonical dataset is bundled at build time (see
 * `scripts/build-worker-data.ts`); the app itself is the same `createApiApp`
 * used by the Node/Bun server, so routes and OpenAPI can never drift.
 *
 * The app is created lazily on the first request because the OpenAPI plugin
 * performs work that Workers disallow in the global scope.
 */
let app: ReturnType<typeof createApiApp> | undefined;

function getApp(): ReturnType<typeof createApiApp> {
  // Workers forbid `new Function`, so Elysia's AOT compiler is disabled.
  app ??= createApiApp(createMemoryNetworkSource(files), { aot: false });
  return app;
}

export default {
  fetch: (request: Request) => getApp().fetch(request),
} satisfies ExportedHandler;
