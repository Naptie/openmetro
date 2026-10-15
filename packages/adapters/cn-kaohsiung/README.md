# Kaohsiung Metro (`cn-kaohsiung`)

Automated acquisition covers the Red Line, Orange Line and circular light rail.
No API key, browser session, OCR or manually maintained station/time/fare table
is required. Build, sync, API bundling and CI discover the package automatically.

```sh
# Weekly topology, coordinates and first/last trains; keeps existing fare quotes.
bun run data:sync --network cn-kaohsiung
# Full official single-ticket quotes within each of the two fare systems.
bun run data:sync --network cn-kaohsiung --layer "topology,timetables,enrichment,fares"
bun run scripts/verify-data.ts --network cn-kaohsiung
```

`bun run normalize` inside this package invokes the default root sync pipeline.
Use `HTTPS_PROXY` / `HTTP_PROXY` for a local forward proxy, or the project's
`OPENMETRO_REVERSE_PROXY` when required by the execution environment.

Sources and transformations:

- [Metro station guide](https://www.krtc.com.tw/Guide/station_guide) and
  [light rail station guide](https://www.krtc.com.tw/KLRT/station_guide): live
  operator UUIDs, codes and order. Station map pages supply official Chinese
  and English names. R10/O5 share an operator UUID and one physical station.
- [Metro service times](https://www.krtc.com.tw/Guide/first_and_last_train) and
  [light rail service times](https://www.krtc.com.tw/KLRT/first_and_last_train):
  query every line/stop, preserve both directions and map weekday, pre-holiday,
  Saturday and Sunday to a regular Monday–Sunday week. Exceptional public
  holidays are not represented by the project's seven-day timetable model.
- [Light rail travel matrix](https://www.krtc.com.tw/KLRT/time_between_train):
  parse the diagonal station order, both adjacent directions and the closing
  C37/C1 edges. The matrix includes C21A before C21; numeric code sorting would
  produce the wrong route.
- Operator homepage planner `Home/GetMTRLRT` / `Home/GetLRTPriceTime`: use the
  live form's station values, not guessed names/codes. Fetch each within-system
  station pair for full single-ticket fares. MRT adjacent travel times also
  come from these quotes. Zero or missing results fail the sync. Quotes use a
  24-hour cache under ignored `tmp/cache/cn-kaohsiung/`; `sources.json` there
  records the last successfully acquired input for diagnostics. Delete the
  scratch cache to force every planner request again.
- [Photon](https://photon.komoot.io/) / © OpenStreetMap contributors,
  [ODbL](https://www.openstreetmap.org/copyright): match railway POIs by exact
  station name within Kaohsiung. Operator embedded-map centres are only search
  hints: some are duplicated or mislabeled. WGS84 coordinates are marked as
  derived, and geocoding failure aborts the sync.

Distances are straight-line estimates. Same-station transfer time uses the
network default; nearby metro/light-rail stops within 400 m receive estimated
out-of-station walks derived from distance, without a hand-maintained pair list.
These estimates retain distinct provenance and quality status.

MRT and light rail have separate ticket systems. Their individual OD matrices
are published in one station index; cross-system fare cells are `null` rather
than a guessed combined ticket. Topology-only syncs retain prior fares by station
identity and preserve their original source retrieval dates. Fares are opt-in
in the existing CI workflow, so a newly added station's fares remain unknown
until the next explicit fare harvest.
