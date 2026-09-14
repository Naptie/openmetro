/**
 * Runtime validation schemas for the Open Metro wire shapes.
 *
 * Import from the `openmetro-client/schemas` subpath (never the main entry,
 * which stays dependency-free). The schemas are generated from
 * `packages/core/src/api/schema.ts` — the same TypeBox schemas Elysia validates
 * responses against — so validating a live response here proves doc, server
 * and client agree.
 *
 * Requires the optional `zod` peer dependency.
 */
export * from './schemas.generated.js';
