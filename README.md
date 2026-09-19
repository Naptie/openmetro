# Open Metro

Open-source project that collects official metro map data for various cities and
reorganizes it into reusable, structured topological data (lines, stations,
timetables, fares, transfers, etc.).

## Architecture

```
packages/
  core/       # city-agnostic: schema, graph builder, Dijkstra routing, HTTP API,
              # geocoding (AMap subway → Overpass → Photon), Wikidata enrichment
  adapters/   # city-specific scrapers/normalizers (one package per network id)
    cn-bj/
    cn-sh/
    cn-gz/
    ...
  client/     # typed Eden Treaty client generated from the API app type
  api-worker/ # Cloudflare Worker build of the API
  web/        # SvelteKit demo frontend (Svelte 5 + Tailwind 4 + MapLibre GL)
data/
  <network-id>/
    network.json, lines.json, stations.json, stops.json, patterns.json,
    segments.json, transfers.json, timetables.json, fares.json
```

**Single source of truth:** canonical JSON under `data/<network-id>/` is the one
source of truth. It is produced by fetching the official sources and is
regenerated, never hand-edited.

**Decoupling:** source adapters are city-specific; `core`, schema, and API are
city-agnostic. Adding a city = adding an adapter package declaring
`openmetro.networkId` in its `package.json`; sync, verify, build and CI all
discover it statically — nothing else to register.

## Data model

Two-tier topology: a **Station** (physical place) and a **Stop** (a station's
presence on a specific line). This mirrors GTFS and handles per-line station
codes and line-to-line transfer walk times.

- `lines.json` — line metadata (names, color, mandatory `short_name`, mode, loop, geometry)
- `stations.json` — station identity + names (zh/en) + real-world location (GCJ-02)
- `stops.json` — per-line stop, official per-line code, sequence
- `patterns.json` — route alignments (service patterns): a line may branch, so it owns one
  primary pattern plus optional branch patterns; a junction stop appears in several patterns
- `segments.json` — ride edges (consecutive stops on a pattern) with travel time (s)
- `transfers.json` — directional walk edges (line A → line B at one station) with walk time (s)
- `timetables.json` — first/last train pairs per station per line + destination (unique id; 7-element weekday arrays when times differ)
- `fares.json` — symmetric origin-destination fare matrix scraped from each
  operator's official route/fare planner (optional layer; `null` where the
  operator publishes no fare for a pair)

Derived duplicates are intentionally absent: pattern membership lives only in
`patterns.json` (`stop_ids`), station line membership is derived from `stops.json`,
and interchange status is computed from it. `transfers.json` is the one
derivation shared by every adapter, so it can never drift from the stop/line
topology.

A line is no longer assumed to be a single chain. `patterns.json` is the source of
truth for topology: segments are the union of consecutive stop pairs across every
pattern, so branches meet their junction with correct three-way adjacency instead
of a phantom "bridge" segment. Timetables name a **destination stop** rather than
a forward/backward axis, which is meaningless on a branched line.

Every file is a versioned wrapper: `{ schema_version, network_id, generated_at, source, records }`.

City metadata (multilingual name, unique ID, currency, timezone) lives in
`network.json`:

```json
{
  "name": "北京地铁",
  "names": { "zh": "北京地铁", "en": "Beijing Subway" },
  "city": {
    "id": "CN-11",
    "name": { "zh": "北京", "en": "Beijing" },
    "country": "CN",
    "currency": "CNY",
    "timezone": "Asia/Shanghai"
  }
}
```

All coordinates carry a datum (`crs`). Chinese sources use **GCJ-02**; OSM
(Overpass) and Photon return **WGS-84** and are converted to GCJ-02 locally so
they align with the rest of the dataset. Never convert silently; store the datum.

## Coordinates, names & enrichment

Station coordinates and multilingual names are assembled by a geocoding chain in
`core` (no API key required anywhere):

1. **AMap subway dataset** (`map.amap.com/service/subway`) — every core-network
   station, unambiguous by name, GCJ-02 natively. Metro systems only.
2. **Overpass (OpenStreetMap)** — fallback for stations AMap does not cover:
   trams, intercity/regional rail, newly opened lines. WGS-84 → GCJ-02.
3. **Photon (OSM-based)** — last resort for stations missing from both datasets.

Every result is sanity-checked against the city bounding box and the line
geometry before it is accepted. English/Chinese names are enriched from
**Wikidata** (with a deterministic fallback that derives English line names from
the Chinese name), and one-off official-feed errors are corrected in a central
hand-maintained override list in `core` (e.g. forced out-of-service stations,
decomposed rare CJK characters like 𧒽岗).

Official CN metro APIs are often unreachable from non-CN egress. Setting
`OPENMETRO_REVERSE_PROXY` makes every adapter and fare fetch rewrite origin URLs
to `{proxy}/?url={encoded}` via an IP reverse proxy.

## Routing weight

**Travel time is the canonical routing weight** (the default). Segment travel
times come from the source when available (Beijing publishes them). When a
source does not publish per-segment times (Shanghai, Guangzhou), the adapter
derives them from the **last-train** times of consecutive stops
(`travel_time_source: "last_train"`); a documented default estimate is
used only where no last-train chain is available. Distance is best-effort and
falls back to time to keep the graph connected.

Routing is performed on the **stop graph** (nodes are line-specific stops), so
a change of line is an explicit transfer edge charged at
`transfers.walk_time_seconds` — or `network.routing.default_transfer_seconds`
when the source does not publish one (Shanghai, Guangzhou). `network.json`
therefore carries a `routing` block (`weight`, `default_transfer_seconds`,
`max_transfer_seconds`) so the penalty is data, not a hardcoded constant.

## Data quality

Each network records per-layer precision and coverage in `network.json.quality`.
Per-layer detail lives in [data/QUALITY.md](data/QUALITY.md); the dashboard
below is the generated SVG asset (regenerated on data sync, not by editing
this README). A copy also sits at [data/quality.svg](data/quality.svg).

![Open Metro data quality](data/quality.svg)

## Tech stack

- **TypeScript** (strict) throughout.
- **Effect** for the pipeline (composable effects, typed errors, retry).
- **`@effect/schema`** (bundled in `effect`) for data validation.
- **Bun** workspaces · **tsup** build · **bun test** tests · **Biome** lint & format.
- **Elysia** + **`@elysiajs/openapi`** API · **Eden Treaty** typed client.
- **SvelteKit** (Svelte 5 + Tailwind CSS 4 + MapLibre GL) demo frontend with
  **shadcn-svelte** components and **Paraglide** i18n (zh/en).

## Getting started

```bash
bun install

# Build core, adapters and the typed client declarations
bun run build

# Typecheck everything
bun run typecheck

# Lint & format (Biome)
bun run lint
bun run format

# Regenerate canonical data for every discovered adapter (fetches official APIs)
bun run data:sync --list
bun run data:sync --layer topology,timetables,enrichment
bun run data:sync --network cn-sh --layer topology,timetables,enrichment
bun run data:sync --layer fares  # opt-in only: one planner query per OD pair, takes hours

# Or per package:
bun run --cwd packages/adapters/cn-bj normalize
bun run --cwd packages/adapters/cn-sh normalize
bun run --cwd packages/adapters/cn-gz normalize

# Validate every dataset and write a checksummed manifest
bun run data:verify

# Export the OpenAPI document
bun run openapi

# Regenerate published JSON Schemas (schemas/v1/) from the Effect schemas
bun run json-schemas

# Run tests
bun test

# Run the API (reads data/<network-id>); OpenAPI docs at /swagger
bun run api

# Run the demo frontend (proxies /api to the API on :8790)
bun run web:dev

# Audit the frontend i18n messages (duplicates, missing keys, placeholder
# mismatches, key order) — non-zero exit gates CI
bun run i18n
bun run i18n:fix  # sort keys alphabetically and rewrite
```

### Frontend

The demo is a full-screen map app: every network is drawn at once; clicking a
line opens its metadata, service patterns, station list and a schematic topo
map (straight trunk, branches angling off their junction); clicking a station
opens its details with first/last trains and lets you set it as origin or
destination. With both endpoints set the route is computed immediately and
drawn on the map with an animated overlay, plus a fare/time/transfer summary.

Interface strings live in `packages/web/messages/{en,zh.json}` (Paraglide v2,
compiled by a Vite plugin — no inlang account needed). Entities use their
localized names everywhere, including map labels. The locale switch in the nav
bar changes language in place without losing app state.

Env vars:
- `OPENMETRO_DATA_ROOT` — data directory (default `data`).
- `PORT` — API port (default `8790`).
- `OPENMETRO_REVERSE_PROXY` — optional IP reverse proxy base URL; official
  source requests are rewritten through it (used by CI syncs, see below).
- `OVERPASS_URL` — Overpass API endpoint (default `https://overpass-api.de/api/interpreter`).
- `VITE_API_URL` — API base URL baked into the frontend build (defaults to same-origin).

## API

Responses are **lean projections** of the canonical records: provenance
(`source`, `source_ids`, `extras`) and derived duplicates are omitted, while
every dataset and every derived artifact is reachable.

- `GET /api/health` — liveness probe
- `GET /api/networks` — list available networks (`cn-bj`, `cn-sh`, `cn-gz`) with metadata
- `GET /api/networks/:id` — one network's metadata (city, currency, timezone,
  routing defaults) plus `synced_at`, when the canonical data was last
  synchronized (max `generated_at` across its files; only filled by the detail
  route — the list route does not load full data)
- `GET /api/networks/:id/lines` — every line carries `short_name`, the compact
  display code used for map-style badges (`1`, `S1`, `APM`, `广惠`). It is
  **mandatory**: when the operator publishes no numeric code, the official
  short label (e.g. `浦江线`, `首都机场`) is used instead. Not guaranteed
  ASCII — badge components must handle CJK
- `GET /api/networks/:id/stations` — station coords + `lines` + computed `is_interchange`
- `GET /api/networks/:id/stations/:stationId` — detail + transfers + timetables + in-service status
- `GET /api/networks/:id/stops` — per-line stop occurrences
- `GET /api/networks/:id/patterns` — route alignments (main + branches)
- `GET /api/networks/:id/segments` — ride edges with `travel_time_seconds`
- `GET /api/networks/:id/transfers` — directional walk edges with `walk_time_seconds`
- `GET /api/networks/:id/timetables` — all first/last train pairs
- `GET /api/networks/:id/fares` — symmetric origin-destination fare matrix (`?from=<stationId>` for one row)
- `GET /api/networks/:id/nearest?lon=&lat=&k=` — nearest stations to an arbitrary coordinate
- `GET /api/networks/:id/graph?weight=time|distance` — assembled **stop graph** (nodes + ride/transfer edges); the index artifact
- `GET /api/networks/:id/route?from=<stationId>&to=<stationId>&weight=time|distance` — legs with line + transfer breakdown + fare.
  Ride legs carry **service-aware fields**: `pattern_id` (the route alignment
  the leg rides; on shared trunks the primary pattern), and a headsign —
  `headsign_station_id` + `headsign_names` — which is the destination the
  operator's published timetables give for the train you board at the leg's
  first stop (absent on loop lines). Legs are **split at junctions** where the
  boarding service cannot carry them through: a same-station transfer with
  `same_line_direction_change: true` separates the two services (e.g. Line 11
  花桥 → 嘉定北 becomes "ride to 嘉定新城 toward 迪士尼, direction change, ride
  toward 嘉定北" — there is no through train)
- `GET /api/networks/:id/travel-times?from=<stationId>&within=<seconds>&weight=time` — isochrone: seconds from one station to every other

Routing endpoints default `weight` to the network's `routing.weight`. CORS is
unrestricted (any origin may call the public read-only API; methods are
`GET`/`OPTIONS`, no credentials).

**Error contract.** Every non-2xx response body is `{ "error": "<message>" }`.
Unknown network ids are `404` on every `/api/networks/:id/*` route (collection
routes used to 500 on an id that did not exist); unknown stations are `404` on
the detail, fare-row, route and travel-times routes.

**Schemas are the compatibility surface.** Every response body is validated
against the named schemas in `components.schemas` before it is sent — the
server cannot emit a shape that violates its own doc. The projected entity
schemas are `ApiLine`, `ApiNetwork`, `ApiStation`, `ApiStop`, `ApiPattern`,
`ApiSegment`, `ApiTransfer`, `ApiTimetable`, `ApiStationDetail`, `ApiFareMatrix`
/ `ApiFareRow`, `ApiStopGraph`, `ApiRoutePlan`, `ApiTravelTimes`,
`ApiNearestStations`, plus list wrappers (`ApiLineList`, …) and `ApiError`.
Fields whose value may be absent on the wire are optional keys (`color?`,
`location?`, …); `null` is used only where a value is *expected but unknown*
(e.g. `fare`, `within`).

Interactive OpenAPI docs are served at `/swagger` (JSON at `/swagger/json`).
The document is exported to `dist/openapi.json` on every release with all
`$ref`s normalized to `#/components/schemas/<name>` pointers — this is the
artifact consumers codegen from (`openapi-typescript`, `zod-openapi`, …).
`bun run openapi --check` fails CI when the committed document has drifted
from the running app.

## Typed client

A fully typed [Eden Treaty](https://elysiajs.com/eden/treaty/overview) client is
generated from the server's own Elysia app type (`packages/client`), so request
params and responses are checked end to end with no hand-written contract.

Install it straight from the published `client` branch (no registry needed),
plus the peer deps it expects:

```bash
npm install github:Naptie/openmetro#client elysia @elysia/eden effect
# or: bun add github:Naptie/openmetro#client elysia @elysia/eden effect
```

The same package is also attached to each GitHub Release as
`openmetro-client-<version>.tgz`.

```ts
import { createClient } from "openmetro-client";

const metro = createClient("http://127.0.0.1:8790");
const { data: stations } = await metro.api.networks({ id: "cn-bj" }).stations.get();
const { data: plan } = await metro.api
  .networks({ id: "cn-bj" })
  .route.get({ query: { from: "cn-bj-pingguoyuan", to: "cn-bj-xizhimen" } });
```

Response entity types are derived from the same client and exported for use in
your own code. They are never hand-written, so a schema or handler change
re-types every consumer automatically:

```ts
import type { ApiLine, ApiRoutePlan, ApiStation } from "openmetro-client";

const mode: ApiLine["mode"] = "metro"; // "metro" | "suburban_rail" | ...
```

`ApiSuccess<Route>` unwraps the success payload of any route, covering cases the
named aliases don't:

```ts
import type { ApiSuccess, Client } from "openmetro-client";

type Networks = ApiSuccess<Client["api"]["networks"]["get"]>; // { networks: ApiNetwork[] }
```

### Runtime validation schemas (`openmetro-client/schemas`)

The same package ships zod schemas for every documented response shape via the
`./schemas` subpath. They are **generated** from the wire schemas in
`packages/core/src/api/schema.ts` — the exact shapes the server validates its
responses against and `openapi.json` documents — so a runtime check here is the
single source of truth, not a hand-written revalidation layer:

```bash
npm install openmetro-client zod  # zod is an optional peer, only needed for ./schemas
```

```ts
import { apiRoutePlanSchema } from "openmetro-client/schemas";

const { data: plan } = await metro.api
  .networks({ id: "cn-bj" })
  .route.get({ query: { from: "cn-bj-pingguoyuan", to: "cn-bj-xizhimen" } });

const result = apiRoutePlanSchema.safeParse(plan);
if (!result.success) {
  // result.error — typed validation issues, walkable like zod errors
}
```

Every schema is also reachable through the `apiSchemas` map keyed by the wire
name it documents (`apiSchemas.ApiLine`, `apiSchemas.ApiRoutePlan`, …). The main
entry (`import "openmetro-client"`) does **not** import zod, so it stays
installable without it.

## Releases

Pushes to `main` that touch release inputs (`data/`, `packages/core`,
`packages/client`, the release build scripts, root `package.json`, or the
workflow itself) run `.github/workflows/release.yml`. The job validates the
canonical data, builds the artifacts, and publishes a GitHub Release only when
their contents actually changed versus the latest release (compared by a
content fingerprint of the data `aggregate`, OpenAPI document, and staged
client package — packed tarball checksums are ignored because `tar`/`npm pack`
embed mtimes). Manual `workflow_dispatch` can force a publish.

On the same gate, the staged client package is force-pushed onto an orphan
`client` branch, so consumers can depend on
`"openmetro-client": "github:Naptie/openmetro#client"` without waiting for a
registry publish.

A release contains:

- `openmetro-data.tar.gz` — the canonical dataset;
- `openmetro-client-<version>.tgz` — the typed Eden client (also on the
  `client` branch);
- `openapi.json` — the OpenAPI 3.0 document;
- `data-manifest.json` + `SHA256SUMS.txt` — per-file checksums and a content
  `aggregate` hash for integrity verification.

`bun run data:verify` enforces schema decoding, referential integrity
(stops→stations/lines, segments/transfers/patterns→stops, timetables→stops) and
full-schema coverage (operating stations have coords + zh/en names, interchanges
have complete directional transfer pairs, fares matrices match `stations.json`
exactly), and prints the same `aggregate` hash locally, so a checkout can be
compared against a release.

## CI/CD

- `checks.yml` — every PR and push to `main`: lint, build (incl. a dry-run
  Worker bundle), typecheck, tests, `data:verify` and `openapi` export
  (manifests uploaded as artifacts).
- `sync.yml` — scheduled data sync: weekly (Mon 03:17 UTC) topology +
  timetables + enrichment and on-demand fares per network, each network an
  independent matrix job. Changed datasets are staged as artifacts and pushed
  onto the long-lived `data` branch (merge into `main` manually). Uses secrets
  `REVERSE_PROXY` (optional CN egress proxy) and `AMAP_KEY`.
- `release.yml` — release bundle when release inputs change and artifacts
  differ from the latest release; also force-pushes the typed client onto the
  `client` branch (below).
- `deploy-workers.yml` / `deploy-pages.yml` — deploy on push to `main`
  (path-filtered) and on manual dispatch (below).

## Deployment (Cloudflare)

Live:

- API — <https://openmetro.phi.zone/api> (OpenAPI at `/swagger`)
- Frontend — <https://openmetro.phi.zone>

The API runs as a Cloudflare Worker (`packages/api-worker`) and the demo as a
Cloudflare Pages static site (`packages/web`). Both use the same `createApiApp`
over a pluggable data source: Node/Bun reads `data/` from disk, the Worker gets
the canonical JSON bundled at build time (no filesystem at the edge).

```bash
# API worker (local workerd, no account needed)
bun run worker:dev            # http://127.0.0.1:8787
bun run worker:build          # dry-run bundle (size check)

# Frontend (point it at a running API)
VITE_API_URL=http://127.0.0.1:8787 bun run web:build

# Deploy (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)
# Pages project names are globally unique (*.pages.dev) — set yours first:
export PAGES_PROJECT=your-unique-pages-project
bun run worker:deploy
bun run web:deploy
```

CI/CD: `.github/workflows/deploy-workers.yml` and `deploy-pages.yml` deploy on
push to `main` (path-filtered) and on manual dispatch; see **CI/CD** above for
the full workflow list.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN` — Workers Scripts:Edit + Cloudflare Pages:Edit
- `CLOUDFLARE_ACCOUNT_ID` — the target account id

Required repository variables:

- `PAGES_PROJECT` — Cloudflare Pages project name (globally unique); used by
  `deploy-pages.yml` and `packages/web` deploy
