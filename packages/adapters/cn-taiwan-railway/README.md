# Taiwan Railway

Official passenger route selectors, bilingual station identities, WGS84 station
map links and dated station timetables. Includes twelve corridors and their
branches using the existing regional-rail topology model.

```bash
bun run --cwd packages/core build
bun run --cwd packages/adapters/cn-taiwan-railway normalize
```

`OPENMETRO_SERVICE_DATE` defaults to today in Asia/Taipei. Two calendar dates
supply the explicit 03:00–27:00 service-day snapshot; canonical rows are valid
only for that service date. Fare values are unavailable, never inferred.

See [sources, coverage and reproduction](../../../docs/taiwan-rail-sources.md).
