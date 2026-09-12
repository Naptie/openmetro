import { Schema } from "effect";

/**
 * A coordinate datum/crs. `schematic` and `none` cover sources that only
 * provide a map pixel space or no real-world coordinates at all.
 */
export const Crs = Schema.Literal("wgs84", "gcj02", "bd09", "schematic", "none");

export type Crs = Schema.Schema.Type<typeof Crs>;

/** Real-world geographic coordinate with its datum. */
export const GeoPoint = Schema.Struct({
  lon: Schema.Number,
  lat: Schema.Number,
  crs: Crs,
});

export type GeoPoint = Schema.Schema.Type<typeof GeoPoint>;

/** Source-map pixel-space coordinate (schematic maps). */
export const SchematicPoint = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  crs: Crs,
});

export type SchematicPoint = Schema.Schema.Type<typeof SchematicPoint>;

/** A coordinate object: either geographic or schematic. */
export const Location = Schema.Union(GeoPoint, SchematicPoint);

export type Location = Schema.Schema.Type<typeof Location>;
