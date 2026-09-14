/**
 * Generate zod runtime schemas for `openmetro-client/schemas`.
 *
 * The single source of truth is `packages/core/src/api/schema.ts` — the same
 * TypeBox wire schemas Elysia validates responses against and `openapi.json`
 * documents. This script walks them directly (no JSON round-trip) and emits a
 * standalone zod module into `packages/client/src/schemas.generated.ts`
 * (`*.generated.ts` keeps Biome out of it).
 *
 * The shapes are deliberately simple (objects, arrays, string-literal unions,
 * null unions, records, tuples, refs), so the converter is hand-rolled rather
 * than a json-schema-to-zod dependency. Output is deterministic: schemas are
 * emitted in dependency order (refs first) and re-running the script produces
 * an identical file.
 *
 * Usage: `bun run scripts/generate-client-schemas.ts [--check]`
 * `--check` regenerates in memory and fails when the committed file drifted.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiModels } from '../packages/core/src/api/schema.js';

const Kind = Symbol.for('TypeBox.Kind');
const OptionalKind = Symbol.for('TypeBox.Optional');

const MODELS = ApiModels as Record<string, TypeBoxSchema>;
const OUT = resolve(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'packages',
    'client',
    'src',
    'schemas.generated.ts'
  )
);

type TypeBoxSchema = {
  [Kind]?: string;
  [OptionalKind]?: string;
  $id?: string;
  $ref?: string;
  type?: string;
  const?: unknown;
  required?: string[];
  properties?: Record<string, TypeBoxSchema>;
  items?: TypeBoxSchema | TypeBoxSchema[];
  anyOf?: TypeBoxSchema[];
  patternProperties?: Record<string, TypeBoxSchema>;
  additionalProperties?: TypeBoxSchema;
};

interface Context {
  /** $id of a model schema -> emitted zod const name. */
  names: Map<string, string>;
  /** $id -> the model schema itself (for resolving refs during traversal). */
  models: Map<string, TypeBoxSchema>;
}

/** `ApiLine` -> `apiLineSchema`. */
function zodName(modelName: string): string {
  return `api${modelName.replace(/^Api/, '')}Schema`;
}

/** All `$ref` values referenced by a schema (for dependency ordering). */
function refsOf(schema: TypeBoxSchema, out: Set<string>): void {
  if (!schema || typeof schema !== 'object') return;
  if (typeof schema.$ref === 'string') out.add(schema.$ref);
  if (schema.items) {
    if (Array.isArray(schema.items))
      schema.items.forEach((i) => {
        refsOf(i, out);
      });
    else refsOf(schema.items, out);
  }
  if (schema.anyOf)
    schema.anyOf.forEach((m) => {
      refsOf(m, out);
    });
  if (schema.properties)
    Object.values(schema.properties).forEach((p) => {
      refsOf(p, out);
    });
  if (schema.patternProperties) {
    Object.values(schema.patternProperties).forEach((p) => {
      refsOf(p, out);
    });
  }
  if (schema.additionalProperties) refsOf(schema.additionalProperties, out);
}

/** Emit a zod expression for one TypeBox schema. */
function emit(schema: TypeBoxSchema, ctx: Context): string {
  const kind = schema[Kind];
  switch (kind) {
    case 'Object': {
      const required = new Set(schema.required ?? []);
      const props = Object.entries(schema.properties ?? {}).map(([name, prop]) => {
        const expr = emit(prop, ctx);
        const optional = prop[OptionalKind] !== undefined || !required.has(name);
        return `${JSON.stringify(name)}: ${optional ? `${expr}.optional()` : expr}`;
      });
      return `z.object({ ${props.join(', ')} })`;
    }
    case 'Array':
      return `z.array(${emit(schema.items as TypeBoxSchema, ctx)})`;
    case 'Union': {
      const members = schema.anyOf ?? [];
      // All string literals -> an enum (or a lone literal).
      if (members.length > 0 && members.every((m) => m[Kind] === 'Literal')) {
        const consts = members.map((m) => m.const);
        if (consts.every((c) => typeof c === 'string')) {
          if (consts.length === 1) return `z.literal(${JSON.stringify(consts[0])})`;
          return `z.enum([${consts.map((c) => JSON.stringify(c)).join(', ')}])`;
        }
      }
      const discriminator = unionDiscriminator(members, ctx);
      if (discriminator) {
        return `z.discriminatedUnion(${JSON.stringify(discriminator)}, [${members
          .map((m) => emit(m, ctx))
          .join(', ')}])`;
      }
      return `z.union([${members.map((m) => emit(m, ctx)).join(', ')}])`;
    }
    case 'Tuple':
      return `z.tuple([${(schema.items as TypeBoxSchema[]).map((i) => emit(i, ctx)).join(', ')}])`;
    case 'Record': {
      const value =
        (schema.patternProperties && Object.values(schema.patternProperties)[0]) ??
        schema.additionalProperties;
      if (!value) throw new Error('Record schema without a value type');
      return `z.record(z.string(), ${emit(value, ctx)})`;
    }
    case 'Literal':
      return `z.literal(${JSON.stringify(schema.const)})`;
    case 'String':
      return 'z.string()';
    case 'Number':
    case 'Integer':
      return 'z.number()';
    case 'Boolean':
      return 'z.boolean()';
    case 'Null':
      return 'z.null()';
    case 'Ref': {
      const name = ctx.names.get(schema.$ref ?? '');
      if (!name) throw new Error(`unresolvable ref "${schema.$ref}"`);
      return name;
    }
    default:
      throw new Error(`unsupported TypeBox kind "${kind}"`);
  }
}

/**
 * Detect a shared `kind` discriminator across union members (used for the
 * route-plan legs): every member resolves to an object whose `kind` property
 * is a single distinct string literal.
 */
function unionDiscriminator(members: TypeBoxSchema[], ctx: Context): string | null {
  const targets = members.map((m) => {
    if (m[Kind] === 'Object') return m;
    if (m[Kind] === 'Ref') return ctx.models.get(m.$ref ?? '');
    return undefined;
  });
  if (targets.some((t) => t?.[Kind] !== 'Object')) return null;
  const kindProps = targets.map((t) => (t as TypeBoxSchema).properties?.kind);
  const constsOf = (k: TypeBoxSchema | undefined): unknown[] => {
    if (!k) return [];
    if (k[Kind] === 'Literal') return [k.const];
    if (k[Kind] === 'Union') {
      return (k.anyOf ?? []).filter((m) => m[Kind] === 'Literal').map((m) => m.const);
    }
    return [];
  };
  const literals = kindProps.map((k) => constsOf(k));
  if (literals.some((l) => l.length !== 1)) return null;
  const flat = literals.flat();
  if (new Set(flat).size !== flat.length) return null;
  return 'kind';
}

/** Deterministic dependency order: referenced schemas before referencers. */
function dependencyOrder(): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const deps = new Set<string>();
    refsOf(MODELS[name], deps);
    for (const dep of deps) {
      if (dep !== name && dep in MODELS) visit(dep);
    }
    ordered.push(name);
  };
  for (const name of Object.keys(MODELS)) visit(name);
  return ordered;
}

function generate(): string {
  const ctx: Context = {
    names: new Map(Object.keys(MODELS).map((name) => [name, zodName(name)])),
    models: new Map(Object.entries(MODELS))
  };

  const body: string[] = [];
  for (const name of dependencyOrder()) {
    body.push(`export const ${zodName(name)} = ${emit(MODELS[name], ctx)};`);
  }

  const mapEntries = Object.keys(MODELS)
    .map((name) => `  ${name}: ${zodName(name)}`)
    .join(',\n');

  return [
    '// @generated by scripts/generate-client-schemas.ts - do not edit by hand.',
    '//',
    '// Runtime validation schemas derived from the wire schemas in',
    '// `packages/core/src/api/schema.ts` (the single source of truth): the same',
    '// shapes Elysia validates responses against and `openapi.json` documents.',
    "import { z } from 'zod';",
    '',
    body.join('\n\n'),
    '',
    '/** Every generated schema, keyed by its wire name. */',
    'export const apiSchemas = {',
    mapEntries,
    '};',
    ''
  ].join('\n');
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const generated = generate();

  if (check) {
    const existing = await readFile(OUT, 'utf-8').catch(() => null);
    if (existing == null) {
      throw new Error(`--check: ${OUT} does not exist - run the generator`);
    }
    if (existing !== generated) {
      throw new Error(
        `--check: ${OUT} is stale - run \`bun run client:schemas\` and commit the diff`
      );
    }
    console.log(`client schemas: ${OUT} - up to date`);
    return;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, generated, 'utf-8');
  console.log(`client schemas: wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
