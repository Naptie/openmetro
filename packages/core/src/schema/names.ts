import { Schema } from "effect";

/**
 * Multilingual name object. `zh` and `en` are mandatory; additional languages
 * are additive. When a source does not provide a name in a required language,
 * the adapter must look it up (e.g. on Wikidata) so every entity is fully
 * multilingual.
 */
export const MultilingualName = Schema.Struct({
  zh: Schema.String,
  en: Schema.String,
});

export type MultilingualName = Schema.Schema.Type<typeof MultilingualName>;

/** Optional extra languages beyond the required zh/en pair. */
export const MultilingualNameWithExtras = Schema.Struct({
  zh: Schema.String,
  en: Schema.String,
  rest: Schema.optionalWith(Schema.Record({ key: Schema.String, value: Schema.String }), {
    as: "Option",
  }),
});

/** Build a names object guaranteed to carry zh and en. */
export function makeNames(
  zh: string,
  en: string,
  extra?: Record<string, string>,
): MultilingualName {
  return { zh, en, ...extra };
}
