# Dongguan Rail Transit (`cn-dongguan`)

```sh
bun run data:sync --network cn-dongguan --layer topology,timetables,enrichment
bun run data:sync --network cn-dongguan --layer fares
bun run scripts/verify-data.ts --network cn-dongguan
```

No API keys, manual station lists, time transcription, or OCR are required.
The normal sync and CI discover the adapter from `package.json`.

- The operator's [service-time index](https://www.dggdjt.com/node/121.htmx)
  links the timetable articles. Sync selects by publication date, skips announced
  future effective dates, and parses
  its four HTML tables (Lines 1/2, workdays/non-workdays). The tables also supply
  the operating station order. The old `/ext/schedule.htmx` API contains stale
  times and is deliberately unused.
- The public [AMap subway feed](https://webapi.amap.com/subway/data/4419_drw_dongguan.json)
  supplies GCJ-02 coordinates, English names, colors and schematic positions.
  Station IDs use AMap source IDs, independent of translated display names.
  Each operator station must match; missing stations, malformed times, incomplete
  calendars, ID collisions or invalid coordinates fail before data is written.
- City metadata is downloaded by the shared worldwide-regions pipeline using
  `CN-4419`. There is no hand-maintained city metadata or central registration.
- Segment times derive from both directions' consecutive last trains, with a
  distance-calibrated fallback for remaining gaps. Segment distances are straight-line
  estimates. The two Civic Center transfer directions use the network's default
  120-second routing penalty, not an operator measurement. Optional `gapfill`
  uses the existing core Baidu harvest (`OPENMETRO_BAIDU_AK`); subsequent ordinary
  syncs retain its measurements for unchanged edges.
- Weekly arrays map workdays to Monday–Friday and non-workdays to Saturday/Sunday.
  Statutory holidays, compensating workdays and temporary extensions are not
  expressible as a seven-day baseline. Midnight tails use `24:xx`.

## Fare coverage

Fares are opt-in. `/ext/line.htmx?lineId=1|2` discovers the operator's current
fare-station IDs; `/ext/ticketPrice.htmx?startId=...&endId=...` quotes exact pairs.
At the initial sync the legacy catalog exposes only 15 Line 2 stations: 105 of
741 physical-station OD pairs. Line 1 and cross-line fares remain `null`.
The operator publishes the full network fare table as a PNG in its ticketing
guide, but this adapter cannot safely extract that matrix as structured data.
No missing fare is inferred from straight-line distances. A future expanded
catalog is picked up automatically; unmatched catalog stations, coverage loss,
or malformed/failed quotes abort the harvest
and preserve the previous fare file.

These are **base fares**, excluding time-limited discounts and card concessions.
The undated fare-matrix schema cannot represent promotional validity periods.
The matrix's `basis: "base"` is exposed by fare APIs and as `fare_basis` on
routes; the frontend labels these prices accordingly.

Fixtures under `test/fixtures` were automatically captured from the operator's
2026-10-05 article and AMap on 2026-10-15; they are offline regression inputs,
never production fallbacks. `OPENMETRO_REVERSE_PROXY` is honored for live fetches.
