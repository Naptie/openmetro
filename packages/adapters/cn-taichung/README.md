# Taichung Metro (`cn-taichung`)

All canonical JSON is regenerated from live official sources. No API key, browser,
OCR, manually entered station list, timetable or fare table is required.

From the repository root:

```sh
bun run data:sync --network cn-taichung --layer "topology,timetables,enrichment,fares"
bun run scripts/verify-data.ts --network cn-taichung
```

The adapter is discovered automatically by build, sync, API bundling and CI.
Its package-local `bun run normalize` also delegates to the root sync pipeline.

Sources:

- [TMRT station identities and order](https://www.tmrt.com.tw/metro-life/ride-time-and-fare):
  the server-rendered `__NEXT_DATA__` station list supplies UUIDs and unique
  official codes, bilingual names and sequence.
- [Current first/last trains](https://www.tmrt.com.tw/metro-life/first-last-train):
  live `__NEXT_DATA__` weekday/weekend fields, joined by UUID. The older open-data
  timetable CSV is not used: its 2023 values differ from current departures.
- [Station coordinates](https://data.gov.tw/dataset/144164),
  [full fares and distances](https://data.gov.tw/dataset/144176),
  and [directional running/dwell seconds](https://data.gov.tw/dataset/144228): official Taichung
  open-data CSV/JSON downloads, using WGS84 and TWD.

The station CSV currently repeats `G17` for Wuri and HSR Taichung. The adapter
joins its station URLs to the operator UUIDs and uses the operator's unique
codes (118 and 119), so no correction table is maintained. Missing joins,
running times, invalid service values or fare cells fail the sync.
Routing uses differences of live terminal-to-station journey durations, separately
in each direction, so intermediate dwell is included without summing rounded
adjacent quotes. Terminal anchors must exist and contain finite positive values;
conflicting quotes and non-positive adjacent differences fail. A complete OD
matrix is not required. These segment times are marked derived.
The older CSV running/dwell values and update date remain diagnostic extras.
After-midnight times use the project's `24:xx` service-day convention.

Canonical checks after live synchronization:

```sh
bun run data:verify --network cn-taichung
```

`data:verify` checks canonical schemas and references; live synchronization above
exercises current operator responses.

提供機關／臺中捷運股份有限公司：臺中捷運綠線車站資訊、站間票價、站間行車時間、
首末班車時刻表。此開放資料依[政府資料開放授權條款第1版](https://data.gov.tw/license)
釋出。資料經本專案轉換；營運方官網車站清單另保留為未知授權來源。
