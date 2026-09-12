<script lang="ts">
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Line, Pattern, Station, Stop } from "$lib/api-types";
import { client, get } from "$lib/client";

let {
  networkId,
  lines,
  stations,
  onStationSelect,
}: {
  networkId: string;
  lines: Line[];
  stations: Station[];
  onStationSelect: (s: Station) => void;
} = $props();

let container: HTMLDivElement;
let map = $state<maplibregl.Map | null>(null);
let mapLoaded = $state(false);

function toQuadkey(z: number, x: number, y: number): string {
  let q = "";
  for (let i = z; i > 0; i--) {
    let b = 0;
    const mask = 1 << (i - 1);
    if (x & mask) b |= 1;
    if (y & mask) b |= 2;
    q += b;
  }
  return q;
}

function transformRequest(url: string, resourceType?: string): maplibregl.RequestParameters {
  // Convert z/x/y back to quadkey for raster tile requests on ditu.live.com
  if (resourceType === "Tile") {
    const m = url.match(/\/comp\/ch\/(\d+)\/(\d+)\/(\d+)\?/);
    if (m) {
      const qk = toQuadkey(+m[1], +m[2], +m[3]);
      return { url: url.replace(/\/comp\/ch\/\d+\/\d+\/\d+\?/, `/comp/ch/${qk}?`) };
    }
  }
  return { url };
}

function stationLabel(s: Station): string {
  return s.names?.en ? `${s.names.zh} (${s.names.en})` : s.name;
}

async function loadBingStyle(): Promise<maplibregl.StyleSpecification> {
  const raw = await fetch("/bing-style.json").then((r) => r.json());

  // Fix protocol and tile format
  const fixed = JSON.parse(
    JSON.stringify(raw).replaceAll("raster://", "https://").replaceAll("{quadkey}", "{z}/{x}/{y}"),
  );

  // Keep only vector layers + jk raster labels; strip other raster layers
  fixed.layers = fixed.layers.filter(
    (l: { type: string; source?: string }) => l.type !== "raster" || l.source === "jk",
  );

  // Remove Korea-only bounds from jk source so labels render globally
  if (fixed.sources.jk && "bounds" in fixed.sources.jk) {
    delete fixed.sources.jk.bounds;
  }

  // Expand tile endpoints for CDN failover
  for (const source of Object.values(fixed.sources) as Record<string, unknown>[]) {
    if (Array.isArray(source.tiles)) {
      const expanded: string[] = [];
      for (const t of source.tiles as string[]) {
        expanded.push(t);
        for (let i = 1; i <= 3; i++) {
          expanded.push(t.replace(/dynamic\.t0\./, `dynamic.t${i}.`));
        }
      }
      source.tiles = expanded;
    }
  }

  return fixed;
}

// --- Map init (runs once) ---
$effect(() => {
  if (!container) return;

  let cancelled = false;

  loadBingStyle().then((style) => {
    if (cancelled) return;

    map = new maplibregl.Map({
      container,
      transformRequest,
      style,
      center: [121.47, 31.23],
      zoom: 11,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    map.on("load", () => {
      mapLoaded = true;
    });
  });

  return () => {
    cancelled = true;
    mapLoaded = false;
    map?.remove();
  };
});

// --- Single effect: sync layers + fit bounds on network/data change ---
$effect(() => {
  if (!map || !mapLoaded) return;

  const nid = networkId;
  const lns = lines;
  const sts = stations;
  const select = onStationSelect;

  removeLayers(map);

  if (!sts.length || !lns.length) return;

  const stationMap = new Map(sts.map((s) => [s.id, s]));
  addStationLayer(map, sts, stationMap, select);

  let cancelled = false;
  Promise.all([
    get(client.api.networks({ id: nid }).stops.get()),
    get(client.api.networks({ id: nid }).patterns.get()),
  ]).then(([stops, patterns]) => {
    if (cancelled || !map || !map.getSource("stations")) return;
    addLineLayer(map, lns, stationMap, stops, patterns);
    fitBounds(map, lns, stationMap, stops);
  });

  return () => {
    cancelled = true;
  };
});

function removeLayers(m: maplibregl.Map) {
  for (const id of ["station-labels", "station-circles", "lines-layer"]) {
    if (m.getLayer(id)) m.removeLayer(id);
  }
  for (const id of ["stations", "lines"]) {
    if (m.getSource(id)) m.removeSource(id);
  }
}

function fitBounds(
  m: maplibregl.Map,
  lineList: Line[],
  stationMap: Map<string, Station>,
  stops: Stop[],
) {
  const stopsByLine = new Map<string, Stop[]>();
  for (const stop of stops) {
    const list = stopsByLine.get(stop.line_id) ?? [];
    list.push(stop);
    stopsByLine.set(stop.line_id, list);
  }

  const coords: [number, number][] = [];
  for (const line of lineList) {
    const lineStops = stopsByLine.get(line.id);
    if (!lineStops) continue;
    lineStops.sort((a, b) => a.sequence - b.sequence);
    for (const stop of lineStops) {
      const s = stationMap.get(stop.station_id);
      if (s?.location) coords.push([s.location.lon, s.location.lat]);
    }
  }

  if (coords.length === 0) return;
  const bounds = new maplibregl.LngLatBounds();
  for (const c of coords) bounds.extend(c);
  m.fitBounds(bounds, { padding: 40 });
}

function addStationLayer(
  m: maplibregl.Map,
  stationList: Station[],
  stationMap: Map<string, Station>,
  select: (s: Station) => void,
) {
  const features: {
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown };
  }[] = [];
  for (const s of stationList) {
    if (!s.location) continue;
    features.push({
      type: "Feature",
      properties: { id: s.id, label: stationLabel(s), interchange: s.is_interchange ? 1 : 0 },
      geometry: { type: "Point", coordinates: [s.location.lon, s.location.lat] },
    });
  }

  m.addSource("stations", {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });

  m.addLayer({
    id: "station-circles",
    type: "circle",
    source: "stations",
    paint: {
      "circle-radius": ["case", ["==", ["get", "interchange"], 1], 5, 3.5],
      "circle-color": "#fff",
      "circle-stroke-color": "#333",
      "circle-stroke-width": 1.5,
    },
  });

  m.addLayer({
    id: "station-labels",
    type: "symbol",
    source: "stations",
    layout: {
      "text-field": ["get", "label"],
      "text-size": 11,
      "text-anchor": "top",
      "text-offset": [0, 1],
      "text-allow-overlap": false,
      "text-ignore-placement": false,
    },
    paint: {
      "text-color": "#111",
      "text-halo-color": "#fff",
      "text-halo-width": 1.5,
    },
  });

  m.on("click", "station-circles", (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    const id = feature.properties?.id as string;
    const station = stationMap.get(id);
    if (station) select(station);
  });

  m.on("mouseenter", "station-circles", () => {
    m.getCanvas().style.cursor = "pointer";
  });

  m.on("mouseleave", "station-circles", () => {
    m.getCanvas().style.cursor = "";
  });
}

function addLineLayer(
  m: maplibregl.Map,
  lineList: Line[],
  stationMap: Map<string, Station>,
  stops: Stop[],
  patterns: Pattern[],
) {
  const lineById = new Map(lineList.map((l) => [l.id, l]));
  const stopById = new Map(stops.map((s) => [s.id, s]));

  const features: {
    type: "Feature";
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: unknown };
  }[] = [];
  for (const pattern of patterns) {
    const line = lineById.get(pattern.line_id);
    if (!line) continue;

    const coords: [number, number][] = [];
    for (const stopId of pattern.stop_ids) {
      const stop = stopById.get(stopId);
      const station = stop ? stationMap.get(stop.station_id) : undefined;
      if (station?.location) {
        coords.push([station.location.lon, station.location.lat]);
      }
    }

    if (coords.length >= 2) {
      if (line.loop && coords.length >= 3) {
        coords.push(coords[0]);
      }
      features.push({
        type: "Feature",
        properties: { color: line.color ?? "#666", name: pattern.name ?? line.name },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
  }

  if (features.length === 0) return;

  m.addSource("lines", {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });

  m.addLayer({
    id: "lines-layer",
    type: "line",
    source: "lines",
    paint: {
      "line-color": ["get", "color"],
      "line-width": 3,
      "line-opacity": 0.85,
    },
  });
}
</script>

<div bind:this={container} class="w-full h-[80vh] rounded border border-gray-200"></div>
