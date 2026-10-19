# Alishan Forest Railway

Official HTML tables supply main-line, Shenmu and Zhaoping passenger services,
reserved-seat adult fares, branch endpoint prices and available main-line
mileage. The Zhushan corridor retains date-bound sunrise announcements and
leaves unpublished first/last windows empty. Positions/names use attributed OSM
nodes. Closed and walking-only routes are excluded.

```bash
bun run --cwd packages/core build
bun run --cwd packages/adapters/cn-alishan-railway normalize
```

Known dwell enters the aggregate timing samples; static bidirectional route
weights remain approximate. Combined fares and unpublished train calls are not
inferred. `OPENMETRO_SERVICE_DATE` selects the date for sunrise announcements.

See [sources, coverage and reproduction](../../../docs/taiwan-rail-sources.md).
