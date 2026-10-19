# Taiwan railway adapters

Source investigation and live validation: 2026-10-16.

The Taipei metropolitan metro, Taichung and Kaohsiung are separate networks.
Taipei combines its three metro sources inside its adapter, as Guangzhou
normalizes its metropolitan/intercity source lines into ordinary canonical data.
The three regional railway networks below remain independently browsable and
routable. Core, API and web contain no Taiwan-specific routing branch.

| Network | Operating scope | Physical stations in validated snapshot |
| --- | --- | ---: |
| `cn-taiwan-railway` | 12 passenger corridors, including mountain/coast and branches | 240 |
| `cn-taiwan-hsr` | Nangang–Zuoying, all 12 stations | 12 |
| `cn-alishan-railway` | Main line, Shenmu, Zhaoping and Zhushan | 18 |

Published railway networks remain separate; no virtual network joins them to
the metropolitan metros. Through fares are not inferred. Names/city IDs follow the existing region
catalog conventions. These three regional networks use `CN-71`, TWD,
Asia/Taipei and explicitly labeled WGS84 positions.

## Taiwan Railway

Official sources, without credentials:

- [Chinese passenger station/route selector](https://www.railway.gov.tw/tra-tip-web/tip?lang=ZH_TW)
- [English station selector](https://www.railway.gov.tw/tra-tip-web/tip?lang=EN_US)
- [Station information and WGS84 map link, Taipei example](https://www.railway.gov.tw/tra-tip-web/tip/tip00H/tipH41/viewStaInfo/1000?lang=ZH_TW)
- [Dated station timetable, Taipei example](https://www.railway.gov.tw/tra-tip-web/tip/tip001/tip112/querybystationblank?rideDate=2026%2F10%2F16&station=1000-%E8%87%BA%E5%8C%97&lang=ZH_TW)

The [official OpenData schedule directory](https://ods.railway.gov.tw/tra-ods-web/ods/download/dataResource/railway_schedule/JSON/list)
was also investigated. Its downloads repeatedly reset connections from the
validation environments, so the adapter uses the accessible official website.
It does not depend on a third-party timetable mirror or TDX credentials.

Passenger route selectors contain historical/depot stations and a virtual
Taipei round-island booking code. Only current bookable station identities
with passenger calls in the requested window enter the operating graph.
Historical routes/depot tracks are excluded. The eastern selector's unusual
order is handled explicitly: Badu connects to Nuannuan, rather than directly
to Taitung. The coast line, Chengzhui, Su'ao, Pingxi, Shen'ao, Neiwan, Liujia,
Jiji and Shalun remain distinct alignments. Shared physical station identities
provide the existing model's directional transfers.

Station timetable pages use calendar dates. To publish service day D, the
adapter fetches D and D+1 and selects **03:00 on D through 03:00 on D+1**.
The latter calls are written as `24:xx`–`26:xx`; yesterday's late trains never
join today's origin calls. The 03:00 boundary is an explicit adapter snapshot
convention, not an operator-defined operating-day claim. Rows are valid only
on D. Calls outside the window remain as direction and terminal context; only
published departures are limited to the window. Train numbers and actual endpoints reconstruct call
order before projection onto physical corridors. Leaving and rejoining a
corridor does not produce a false through service over the intervening route.

Travel-time samples compare calls of the same train. They include known
intermediate dwell through departure-to-departure measurements, using arrival
at the final call. The graph stores the median in both directions; this is an
aggregate static route weight, not a timetable-aware promise for one train.
Unmeasured segments receive the existing explicitly tagged estimates.
TRA ticket prices are not available through this adapter: `fares.json` is a
correctly sized null matrix, and the fare sync layer is unsupported.

The original October 16 cold snapshot has 2,645 timetable rows: 2,596 for October 16 and 49
after-midnight departures assigned to October 15. The latter come from October
16's already-downloaded calendar pages, without additional requests. This keeps
the previous service day available when the daily job runs at 01:05. Dates are
part of record identity; source dates are never advanced to disguise stale data.
Structural coverage remains 484/484 departure directions.

The checked-in snapshot replays the same 722 original responses with the service-window
boundary fix: 2,642 rows, comprising 2,593 for October 16 and the same 49 for October 15.
Three truncated-destination rows are removed and four late departures now retain their
actual terminal, including Xincheng at `26:49`. Source hashes, retrieval dates and the
snapshot's service date are preserved; this is a normalization correction, not a new fetch.

## Taiwan High Speed Rail

- [Official timetable/fare query and station selector](https://www.thsrc.com.tw/ArticleContent/a3b630bb-1066-4352-a1ef-58c7b4e8ef7c)
- Public form endpoint: `POST https://www.thsrc.com.tw/TimeTable/Search`

The adapter reads current station query identifiers from the selector and
queries all 66 southbound station pairs for standard adult reserved-seat coach
fares. It also queries every northbound adjacent pair. Together these queries
cover all adjacent pairs in both directions, including trains that do not run
the entire Nangang–Zuoying distance. Public POST parameters, response hashes,
retrieval dates and original source URLs are retained in provenance.

Every returned train retains its actual calls. Empty express-passage cells
never become stops or first/last departures. Duplicate train numbers must have
identical calls across queries. Canonical travel times are measured only when
that train calls at adjacent physical stations; an express cannot provide a
fabricated local timing. All eleven adjacent segments have measured samples.
Fares exclude business class, unreserved products and discounts.

Station names/coordinates are matched only to the HSR operator's OSM nodes,
avoiding the colocated TRA/metro stations with the same names. The line uses
the existing `other` mode plus `extras.rail_service: "high_speed"`. The integrity
checker grants only explicitly marked high-speed corridors a bounded 150 km
adjacency ceiling; other mode ceilings remain unchanged. Railway distance
enrichment permits up to 200 km and labels straight-line distances as estimates.

Timetable validity is the queried calendar date; the upstream train call list
retains any overnight completion using service-day hour notation. The validated
snapshot has 40 first/last rows, 22/22 departure directions and all 66 fare pairs.
The routing graph models the complete station corridor using aggregate adjacent
weights; it does not choose reserved trains or calculate express itineraries.

The local resolver could not resolve `www.thsrc.com.tw` during validation.
A scratch-only transport used its then-current public DNS answer while retaining
HTTPS SNI/certificate validation to download the actual responses. No IP address
override or certificate bypass is part of the adapter.

## Alishan Forest Railway

- [Main-line train tables](https://afrch.forest.gov.tw/0000115)
- [Branch train tables and operating notices](https://afrch.forest.gov.tw/0000300)
- [Adult reserved-seat main-line and branch endpoint fares](https://afrch.forest.gov.tw/0000119)
- [Official main-line mileage matrix](https://afrch.forest.gov.tw/0000120)
- [Dated Zhushan announcement](https://afrch.forest.gov.tw/)

The main-line tables supply train IDs, real terminal arrivals and separate
arrival/departure times for the long Fenqihu dwell. Shenmu/Zhaoping tables
include their terminal arrivals. The monthly sunrise prediction table is
deliberately excluded from train parsing. Known dwell enters the timing samples;
the bidirectional median and any estimated gaps remain approximate, so the
route duration does not reproduce one specific train's full itinerary.

The Alishan–Duigaoyue–Zhushan alignment is included. A matching month/day
announcement provides Alishan's announced departure and Zhushan's last return,
valid only on the requested date. It does not provide every first/last time or
Duigaoyue's call times; those cells/records remain absent. A stale announcement
is ignored. Closed Mianyue and walking-only Shuishan are excluded.

Main-line reserved-seat adult fares and the three explicitly published branch
endpoint fares are preserved (94 covered station pairs in this snapshot).
Combined tickets and Duigaoyue prices remain null. The older official mileage
matrix is used only for pairs actually present in it. Other distances/times
remain tagged estimates. OSM enrichment retains the original node IDs and
snapshot timestamp, including the operator-specific Chiayi node and the
operator-name alias for Lumachan.

The corrected snapshot has 40 timetable rows and six patterns. The physical
main-line alignment is display-only; local and through trains use actual calling
sequences. No ride edge connects Shizilu directly to Erwanping, because no
published train calls at both. Four Zhushan directions still lack full windows.
Generic graph coverage labels ambiguous overlapping-service directions unknown;
that does not mean their published train calls are missing. For this explicit
rail service model, a published through pattern covering both endpoints is
preferred over mixing sparse trains merely to reduce estimated edge time.
Chiayi–Alishan therefore remains one through ride; Shizilu–Erwanping still
requires a service change. Durations remain static estimates, without departure
waits or guaranteed connections.

## Reproduction and automation

```bash
bun install --frozen-lockfile
bun run --cwd packages/core build
bun run data:sync --network cn-taiwan-railway --layer topology,timetables,enrichment
bun run data:sync --network cn-taiwan-hsr --layer topology,timetables,fares,enrichment
bun run data:sync --network cn-alishan-railway --layer topology,timetables,fares,enrichment
bun run scripts/write-quality-report.ts
bun run scripts/build-worker-data.ts
bun run data:verify
```

`OPENMETRO_SERVICE_DATE=YYYY-MM-DD` selects a reproducible date while the official
booking window permits it. The default is today in Asia/Taipei. A six-hour cache
under ignored `tmp/cache/<network>/` stores original resource bytes; POST bodies
and HTTP methods are part of cache identity. `OPENMETRO_REFRESH=1` bypasses this
cache after an upstream correction. Provenance records the source retrieval and OSM base
timestamps independently. Coordinates/names are OSM enrichment, not OSM-derived
timetables. `OVERPASS_URL` accepts comma-separated reachable endpoints. The
shared fetcher honors `OPENMETRO_REVERSE_PROXY`, retries transient HTTP 429,
and the rail enrichment can fail over on server outages.

The existing sync workflow adds a daily run at 17:05 UTC / 01:05 Asia/Taipei for
adapters declaring openmetro.syncFrequency = "daily"; the workflow does not
name cities or operators. Other networks stay weekly. One
workflow lock covers seeding through publication. Each network starts with its
last published snapshot and runs all requested layers once. Each network is
verified before artifact upload, so a malformed result fails only that matrix leg.
Successful networks replace their whole directory; absent/failed networks keep
their last publication. The combined tree is verified again before publication.
Networks within a run remain parallel. Long manual fare harvests delay daily
refreshes; GitHub retains only one pending run, so newer queued requests can
replace an older pending run. Fares remain manual opt-in; the unused monthly
schedule has been removed.
The verified tree includes `data/.snapshots/<network>.json` and a metadata index.
The Vercel API consumes these complete JSON snapshots with a five-minute cache;
sync completion also triggers a data-bundle release. Release builds overlay the
last published networks onto the triggering revision, preserving newly added
networks that have not yet reached the data branch. After this code is deployed,
no daily merge into main is required. Before the first publication or on refresh
failure, the API uses last-good/bundled data with original generation and validity
dates. A local checkout updates through the sync commands above.

The October 16 repair regenerated rail records from original cached responses.
This is a data correction, not proof of a fresh CI download. Official endpoints
and public Overpass availability depend on the runner's network/proxy settings;
successful local parsing does not establish their live availability.

Validate live source acquisition with the sync commands above, then run
`data:verify` on the resulting canonical data.

## Metropolitan interchanges

The [adapter-owned station-pair catalog](../packages/adapters/cn-taipei/src/interchanges.ts)
contains eleven documented passages between the Taipei, New Taipei and Airport
MRT sources. Paid-area station identities are merged during normalization;
station-exit passages remain normal directional transfer records. Source URLs
and whether walking time is published or estimated remain in canonical extras.

Connections to HSR, TRA and Alishan are not used to create cross-network routes.
Each of those networks can be viewed without planning a metropolitan journey.
The routing model remains static and cannot select a train by departure time
or prove that a connection is catchable.
