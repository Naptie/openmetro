# Taipei region adapters

Source investigation and live validation: 2026-10-15.

The Taipei adapter now publishes one ordinary metropolitan network, following
the Guangzhou adapter's normalization boundary. Taipei, New Taipei and Airport
MRT are source modules within the adapter; core and web do not recognize their
IDs or construct a regional virtual network. Taiwan-specific defaults and the
government calendar live in the private adapter-owned taiwan-shared package.

| Source | Scope | Source stations |
| --- | --- | --- |
| Taipei Metro | BR, R, G, O, BL and their shuttles/branches | 109 |
| New Taipei Metro | Danhai V, Ankeng K, Circular Y, Sanying LB | 48 |
| Airport MRT | Commuter and express services, including A14a/A22 | 22 |

The published network is cn-taipei: 11 lines, 175 physical stations and 200
line stops. Dapinglin, Jingan, Touqianzhuang and Dingpu share physical identities
across their paid-area platforms. Other documented metro passages remain
explicit out-of-station transfers in the adapter. The existing walking estimate
function supplies unpublished walking times. HSR, TRA, Alishan, Taichung and
Kaohsiung remain separate networks; there is no island-wide route endpoint.

Taoyuan commuter and express are separate labeled service lines,
sharing physical station identities. Express has its own seven-stop alignment
and first/last trains; the commuter subset canonicalization rule cannot erase it.
Its `geometry_reference_pattern_id` points to the commuter alignment for drawing
only. The map clips the same interpolated corridor curve, including skipped
stations as geometric waypoints, and uses small screen-space offsets for the
two colors. Express `stop_ids`, route adjacency and timetable calls remain the
seven actual stops. Route highlights use the same curve and offset in either
direction. The station-based curves remain an illustration, not surveyed rails.
References are validated against a linear primary alignment; trimmed branch and
loop references are rejected before publication rather than guessed on the map.
Only explicitly shared corridors opt into segmented highlights and curve-based
camera framing. Other lines keep their previous single-feature route stitching,
station-based framing and zero display offset, including existing coordinate gaps.

## Official sources

### Taipei Metro

The adapter discovers the current download URL from each dataset page, rather
than pinning a replaceable resource ID:

- [Bilingual stations and WGS84 positions](https://data.taipei/dataset/detail?id=1eefa68d-7c8d-491b-8e75-66a161947426)
- [Operating route station sequences](https://data.taipei/dataset/detail?id=733ff034-5a2b-442f-832a-c7d89add0ccb)
- [First/last trains](https://data.taipei/dataset/detail?id=58e8be7e-3c77-4222-9d8c-26003c2a2cab)
- [Standard adult single fares](https://data.taipei/dataset/detail?id=4acb4911-0360-4063-808d-fcee629508b3)
- [Official interchange walking times](https://data.taipei/dataset/detail?id=782c2b71-8f5a-4575-9bf2-e86999be2863)

UTF8/Big5 decoding and quoted CSV fields are handled before interpreting the
operator's apostrophe/braced nested fields. Station codes sharing a physical
station are merged; route names resolve omitted interchange-code aliases.
Route alignments, not numeric code sorting, determine edges. Core pattern
canonicalization keeps branch spurs and drops reverse/short-turn duplicates.
Missing fare pairs and directions remain explicit gaps instead of preventing
publication of other valid layers. Unmapped fare names produce null rows, not
fabricated matches. Invalid numbers, conflicting values and foreign timetable
references are still rejected. Official interchange minutes replace defaults
on all 26 cross-line transfer edges. Each dataset records its actual resource
URL, original-byte SHA256, retrieval time and available update/effective dates.

Two published G03/G03A shuttle rows erroneously have identical boarding and
destination codes. The adapter corrects their boarding codes from the consistent
headsign/destination fields; it preserves the original code in `extras`.

### New Taipei Metro

- Station tables: [Danhai](https://www.ntmetro.com.tw/basic/?node=10136),
  [Ankeng](https://www.ntmetro.com.tw/basic/?node=10137),
  [Circular](https://www.ntmetro.com.tw/basic/?node=10138),
  [Sanying](https://www.ntmetro.com.tw/basic/?node=10164).
- Timetable categories: [Danhai](https://www.ntmetro.com.tw/basic/?mode=detail&node=460),
  [Ankeng](https://www.ntmetro.com.tw/basic/?mode=detail&node=602),
  [Circular](https://www.ntmetro.com.tw/basic/?mode=detail&node=796).
- Fare documents: [Danhai](https://www.ntmetro.com.tw/basic/?node=10105),
  [Ankeng](https://www.ntmetro.com.tw/basic/?node=10106),
  [Circular](https://www.ntmetro.com.tw/basic/?node=10107),
  [Sanying image](https://www.ntmetro.com.tw/basic/?node=10166).

Danhai/Ankeng departure paragraphs are extracted from linked ODT ZIPs. Hour
sequences must be parseable; any published direction keeps its weekday/weekend windows.
National holidays follow the operator's weekend schedule. The current-year
[official government calendar](https://data.taipei/dataset/detail?id=c30ca421-d935-4faa-b523-9c175c8de738)
is fetched automatically and checked for full-year weekend coverage. General
weekday holidays select the holiday slot; profession-specific days are excluded.
Weekend make-up workdays retain weekend service. Exceptional operating
announcements remain outside this static calendar.

Circular first/last trains are read automatically from the current linked PDF
images. Several accessible ODT files are stale, linked to the wrong station, or
have corrupted hour columns. The adapter renders PDFs locally and locates table
grid lines, then recognizes the boundary times with Tesseract's English digit
model. English and Traditional Chinese OCR also validate the source station,
destination and weekday/holiday headings. It validates hour labels, numeric
ranges, OCR confidence and direction count. Full boundary glyphs are preserved: a clipped 6
can otherwise be misread as 0. Recognition results are cached by source SHA256
and parser/model version and semantic context; changed images are re-read
automatically. There are no maintained per-station times or fixed source hashes.
The English and Traditional Chinese models download on first use. Multiple OCR
segmentations can still agree on an incorrect glyph. Unknown or inconsistent
headers fail synchronization.

The [Sanying timetable page](https://www.ntmetro.com.tw/basic/?mode=detail&node=863)
contains a complete aggregate image for all 12 stations: weekday/holiday first
trains, both directions, last trains, and a separate last Bannan-transfer cutoff.
The image is fetched and parsed automatically by its grid, with the transfer
column retained separately from `last_train`. No timetable waivers are required.
Transfer cutoffs are recognized independently and remain separate from the last
train; no global monotonic or per-cell golden-value gate blocks valid changes.

All four published [running-time matrices](https://www.ntmetro.com.tw/basic/?node=10097)
are used: Danhai 10097, Ankeng 10098, Circular 10103 and Sanying 10165. Numeric
cells for both orientations of each adjacent pair must agree. Source row/column
station codes are recognized independently of HTML station-table order, with
Danhai's branch identified as V28,V27,V26. Reordered caller input cannot relabel cells.
These 45 exact published ride times replace last-train inference/distance estimates.

All four current fare posters (nodes 10105/10106/10107/10166) are parsed as triangular
matrices, providing every intra-line fare pair, including Sanying. Current posters
are authoritative when historical text alternatives disagree. Fares across
separately ticketed services remain unknown unless published; they are not inferred
from a sum that might miss transfer discounts. Transfer walk times still use the
network's documented defaults.

### Taoyuan Metro

- [Official bilingual station picker](https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/road.php)
- Dated per-station pages `.../travel-guide/departure.php?station=A1&godate=YYYY-MM-DD`
  through the active station set.
- The same site's `fetch_data.php` public planner, POST
  `station_id=station_A1&kind=1`, returns all destination quotes for one origin.

The planner's operating station set excludes future A14/A23 even though they
appear in the website picker. `car_type=1` selects commuter trains and
`car_type=2` express. Express stopping stations are derived from planner quotes
and checked against dated timetable pages. They currently are A1, A3, A8, A12,
A13, A18 and A21. A1's first express departure is 05:30, distinct from the
commuter 06:08. Missing standard adult fares stay null; conflicting known
service-specific prices are rejected before sharing the physical-station matrix.

Synchronization queries a rolling two-week window, bounded by the operator's
published availability. The canonical timetable retains exact date overrides
and `valid_from`/`valid_to`, so a retrieved day is not silently treated as valid
forever. Unreadable station/date pages fail the sync; legitimate destination
changes and partial directions are retained by date. This window overlaps the weekly sync schedule. A stale snapshot is
not reported as currently in service after its validity ends.

Travel weights are differences of cumulative remaining times to each terminal.
They preserve terminal-bound journeys and are labeled derived, not direct
directional measurements. Rounding/dwell conventions mean arbitrary OD quotes
are not perfectly additive; A1–A13 express remains about two minutes from its
direct quote. This remains
a static first/last planner, not a train-by-train dispatch model. Additional
one-off or special stopping services remain subject to operator announcements.

The [Taoyuan government station XML catalog](https://opendata.tycg.gov.tw/datalist/b97daace-ff4d-4c6f-a036-80193992c21c)
and [fare catalog](https://opendata.tycg.gov.tw/datalist/166119b7-e7dc-4f73-86d6-a51b0f8e691a)
were investigated, but their download site timed out during this investigation.
The production adapter uses the operator's accessible public website instead.

## Enrichment and automation

Taipei positions/names come from its official CSV. New Taipei's English names
and station coordinates, and Taoyuan's coordinates, are supplemented from
OpenStreetMap/Overpass. OSM contributions have explicit source references and
ODbL attribution; coordinates stay WGS84. These values are reported as derived,
not official operator measurements. Source errors fail synchronization instead
of silently dropping stations or creating coordinates.
Raw Overpass responses are cached for 24 hours only when both source and cache
are fresh. During an outage, both ages must stay below 30 days. Missing, future
or older source timestamps are rejected, including supplied raw snapshots.
Bounded geographic POST queries validate completion counts and reject `remark`
responses before merging; the oldest actual source timestamp is retained.

The new packages participate in static adapter discovery, existing sync CI,
builds, and checks without adding city registries. All currently supported sync
layers refresh a coherent small dataset together. Public-source sync requires
no API key.
Fare-only CI jobs also publish complete network snapshots. Required files are
checked before replacement and the final combined tree is verified before push.
Coverage requirements depend on the existing line-mode rules, never a city or
timezone. Metro first/last-train gaps remain publication errors. Legacy
or ambiguous directions are reported as unknown rather than missing. Quality describes
structural coverage and provenance, not whether dated timetables are still valid.
The API refreshes complete JSON snapshots from the data branch, retaining the
last successful data and its original validity dates if a refresh fails.

API responses expose passenger `service_scope`, timetable descriptions and validity.
The adapter puts the Bannan connection cutoff in the existing timetable description,
so the API and website need no line-specific field. The website uses the API-selected local
service date rather than the final weekday-array element. After-midnight status
also displays the preceding service day's actual window. Client date fields
remain strings.

```sh
bun install --frozen-lockfile
bun run build
bun run data:sync --network cn-taipei
bun run data:verify
bun run test
```

Optional source/runtime settings:

- `OVERPASS_URL`: one to three comma-separated Overpass interpreter endpoints.
- `OPENMETRO_OSM_FILE`: a previously downloaded raw Overpass JSON response,
  for reproducible enrichment during an upstream outage. This is never canonical
  JSON read back as a source; its OSM timestamp must be within 30 days and is retained.
- `OPENMETRO_OCR_MODEL_DIR`: existing `eng.traineddata.gz` and `chi_tra.traineddata.gz` directory, if the OCR
  language model must be supplied offline. Otherwise the model and recognition
  receipts live under ignored `tmp/cache/cn-new-taipei/ocr/`.
- `OPENMETRO_OCR_REFRESH=1`: bypass recognition receipts and run the OCR engine
  again.

Validation during this implementation used live official feeds and an Overpass
response downloaded during the investigation; subsequent Overpass requests
intermittently returned server errors. This availability limit is distinct from
the official feed parsers.
