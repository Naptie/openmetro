# Taiwan High Speed Rail

Official THSRC public timetable/fare queries for the complete twelve-station
corridor. Express passages stay distinct from actual calls. Standard adult
reserved-seat coach fares cover every pair; names/positions use attributed OSM
HSR station nodes.

```bash
bun run --cwd packages/core build
bun run --cwd packages/adapters/cn-taiwan-hsr normalize
```

`OPENMETRO_SERVICE_DATE` defaults to today in Asia/Taipei; timetable rows are
date-bound snapshots. Static adjacent-station routing does not calculate a
specific train or reservation.

See [sources, coverage and reproduction](../../../docs/taiwan-rail-sources.md).
