<script lang="ts">
  import type { Feature, FeatureCollection, LineString } from 'geojson';
  import maplibregl from 'maplibre-gl';
  import { untrack } from 'svelte';
  import {
    type DrawnLinePath,
    routeGeometryForStationIds,
    smoothLine,
    smoothLineWithStops
  } from '$lib';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import type {
    ApiLine as Line,
    ApiPattern as Pattern,
    ApiRoutePlan as RoutePlan,
    ApiStation as Station,
    ApiStop as Stop
  } from 'openmetro-client';
  import { localizedName } from '$lib/format';
  import { i18n } from '$lib/i18n.svelte';
  import { patternVariantKey } from '$lib/patterns.js';
  import { app } from '$lib/state.svelte';

  let container: HTMLDivElement;
  let map = $state<maplibregl.Map | null>(null);
  let mapReady = $state(false);

  interface StationMarkerSet {
    selected: maplibregl.Marker | null;
    origin: maplibregl.Marker | null;
    destination: maplibregl.Marker | null;
  }

  // Plain (non-reactive) registry — maplibregl.Marker instances must not be
  // wrapped in $state proxies.
  const markers: StationMarkerSet = { selected: null, origin: null, destination: null };
  let routeAnimId = 0;
  /** Line geometries as drawn; routes clip these so they cannot drift off-line. */
  let drawnPathsByLine = new Map<string, DrawnLinePath[]>();

  function toQuadkey(z: number, x: number, y: number): string {
    let q = '';
    for (let i = z; i > 0; i--) {
      let b = 0;
      const mask = 1 << (i - 1);
      if (x & mask) b |= 1;
      if (y & mask) b |= 2;
      q += b;
    }
    return q;
  }

  // Bing market code for tile labels; rewritten into every tile request so the
  // basemap language follows the interface locale.
  let activeMkt = i18n.locale === 'zh' ? 'zh-CN' : 'en-US';
  const mktFor = (locale: string) => (locale === 'zh' ? 'zh-CN' : 'en-US');

  function transformRequest(url: string, resourceType?: string): maplibregl.RequestParameters {
    url = url.replace(/([?&])mkt=[^&]*/i, `$1mkt=${activeMkt}`);
    // Convert z/x/y back to quadkey for raster tile requests on ditu.live.com
    if (resourceType === 'Tile') {
      const m = url.match(/\/comp\/ch\/(\d+)\/(\d+)\/(\d+)\?/);
      if (m) {
        const qk = toQuadkey(+m[1], +m[2], +m[3]);
        return { url: url.replace(/\/comp\/ch\/\d+\/\d+\/\d+\?/, `/comp/ch/${qk}?`) };
      }
    }
    return { url };
  }

  async function loadBingStyle(): Promise<maplibregl.StyleSpecification> {
    const raw = await fetch('/bing-style.json').then((r) => r.json());
    const fixed = JSON.parse(
      JSON.stringify(raw).replaceAll('raster://', 'https://').replaceAll('{quadkey}', '{z}/{x}/{y}')
    );
    // Keep only vector layers + jk raster labels; strip other raster layers
    fixed.layers = fixed.layers.filter(
      (l: { type: string; source?: string }) => l.type !== 'raster' || l.source === 'jk'
    );
    // Remove Korea-only bounds from jk source so labels render globally
    if (fixed.sources.jk && 'bounds' in fixed.sources.jk) delete fixed.sources.jk.bounds;
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
        center: [112.5, 33.5],
        zoom: 4.2,
        attributionControl: { compact: true }
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

      map.on('load', () => {
        if (cancelled) return;
        setupLayers(map!);
        mapReady = true;
        syncMapData();
      });
    });

    const onFocus = (event: Event) => {
      const detail = (event as CustomEvent<{ bounds: [[number, number], [number, number]] }>)
        .detail;
      map?.fitBounds(detail.bounds, {
        padding: { top: 90, bottom: 60, left: 40, right: 40 },
        duration: 1200
      });
    };
    window.addEventListener('metro:focus-bounds', onFocus);

    return () => {
      cancelled = true;
      mapReady = false;
      window.removeEventListener('metro:focus-bounds', onFocus);
      stopRouteAnimation();
      map?.remove();
      map = null;
    };
  });

  // --- Basemap language follows the interface locale ---
  $effect(() => {
    if (!map || !mapReady) return;
    const mkt = mktFor(i18n.locale);
    if (mkt === activeMkt) return;
    activeMkt = mkt;
    // Re-assign each tiled source's tile URLs: this flushes the tile cache and
    // re-requests everything, and transformRequest injects the new mkt code.
    const sources = map.getStyle().sources ?? {};
    for (const id of Object.keys(sources)) {
      const source = map.getSource(id) as (
        | maplibregl.RasterTileSource
        | maplibregl.VectorTileSource
      ) & {
        tiles?: string[];
      };
      if (source && Array.isArray(source.tiles) && source.tiles.length > 0 && source.setTiles) {
        source.setTiles(source.tiles);
      }
    }
  });

  function setupLayers(m: maplibregl.Map): void {
    m.addSource('metro-lines', {
      type: 'geojson',
      data: emptyFeatureCollection()
    });
    m.addSource('metro-stations', {
      type: 'geojson',
      data: emptyFeatureCollection()
    });
    m.addSource('route-line', {
      type: 'geojson',
      data: emptyFeatureCollection()
    });

    m.addLayer({
      id: 'metro-lines-casing',
      type: 'line',
      source: 'metro-lines',
      minzoom: 5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 12, 9],
        'line-opacity': 0.9
      }
    });

    m.addLayer({
      id: 'metro-lines',
      type: 'line',
      source: 'metro-lines',
      minzoom: 5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 12, 5.5],
        'line-opacity': 0.9
      }
    });

    m.addLayer({
      id: 'metro-stations',
      type: 'circle',
      source: 'metro-stations',
      minzoom: 9.5,
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          10,
          ['case', ['==', ['get', 'interchange'], 1], 4.5, 3.5],
          12,
          ['case', ['==', ['get', 'interchange'], 1], 5, 4]
        ],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#334155',
        'circle-stroke-width': 1.4
      }
    });

    m.addLayer({
      id: 'metro-station-labels',
      type: 'symbol',
      source: 'metro-stations',
      minzoom: 10.5,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10.5, 14, 13],
        'text-anchor': 'top',
        'text-offset': [0, 0.9],
        'text-allow-overlap': false,
        'text-padding': 2
      },
      paint: {
        'text-color': '#0f172a',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.6
      }
    });

    m.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': 11,
        'line-opacity': 0.95
      }
    });

    m.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 7
      }
    });

    m.addLayer({
      id: 'route-dashes',
      type: 'line',
      source: 'route-line',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': 2.5,
        'line-dasharray': [0, 4, 3]
      }
    });

    m.on('click', 'metro-lines', (e) => {
      const feature = e.features?.[0];
      const lineId = feature?.properties?.line_id;
      if (typeof lineId === 'string') app.selectLine(lineId);
    });

    m.on('click', 'metro-stations', (e) => {
      const feature = e.features?.[0];
      const id = feature?.properties?.id;
      if (typeof id === 'string') app.selectStation(id);
    });

    // Clicking anywhere else on the map drops the line/station focus so every
    // line renders at equal opacity again.
    m.on('click', (e) => {
      const features = m.queryRenderedFeatures(e.point, {
        layers: ['metro-lines', 'metro-stations']
      });
      if (features.length === 0) app.selectLine(null);
    });

    for (const layerId of ['metro-lines', 'metro-stations']) {
      m.on('mouseenter', layerId, () => {
        m.getCanvas().style.cursor = 'pointer';
      });
      m.on('mouseleave', layerId, () => {
        m.getCanvas().style.cursor = '';
      });
    }
  }

  function emptyFeatureCollection(): FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }

  // --- Sync all network data onto the map ---
  let firstFitDone = $state(false);

  function syncMapData(): void {
    if (!map || !mapReady) return;
    const networks = app.networks;
    if (!networks.length) return;

    const locale = i18n.locale;
    const lineFeatures: Feature[] = [];
    const stationFeatures: Feature[] = [];
    const coordsAll: [number, number][] = [];
    const nextDrawnPaths = new Map<string, DrawnLinePath[]>();

    for (const net of networks) {
      const stationMap = new Map<string, Station>(net.stations.map((s) => [s.id, s]));
      const stopMap = new Map<string, Stop>(net.stops.map((s) => [s.id, s]));
      const lineById = new Map<string, Line>(net.lines.map((l) => [l.id, l]));

      for (const station of net.stations) {
        if (!station.location) continue;
        stationFeatures.push({
          type: 'Feature',
          properties: {
            id: station.id,
            label: localizedName(station.names, station.name, locale),
            interchange: station.is_interchange ? 1 : 0
          },
          geometry: {
            type: 'Point',
            coordinates: [station.location.lon, station.location.lat]
          }
        });
        coordsAll.push([station.location.lon, station.location.lat]);
      }

      // Draw each line once: the primary pattern is the trunk, and every
      // other pattern contributes only its branch-only run(s) leaving the
      // junction — so shared sections are never drawn twice. (Two patterns
      // over the same trunk would double-draw it, and with spline smoothing
      // the near-identical curves separate into visible "twin" lines.)
      for (const line of net.lines) {
        const linePatterns = (net.patterns as Pattern[]).filter((p) => p.line_id === line.id);
        if (!linePatterns.length) continue;
        const primary =
          linePatterns.find((p) => p.is_primary) ??
          [...linePatterns].sort((a, b) => b.stop_ids.length - a.stop_ids.length)[0];
        // Reverse alignments share the trunk geometry — drawing them invents
        // a second overlapping "branch".
        const drawable = linePatterns.filter((p) => patternVariantKey(p, primary) !== 'reverse');

        // Ordered unique station ids + coordinates along a pattern.
        const seqOf = (pattern: Pattern): { ids: string[]; coords: [number, number][] } => {
          const ids: string[] = [];
          const coords: [number, number][] = [];
          for (const stopId of pattern.stop_ids) {
            const stop = stopMap.get(stopId);
            const station = stop ? stationMap.get(stop.station_id) : undefined;
            if (!station?.location) continue;
            if (ids[ids.length - 1] === station.id) continue;
            ids.push(station.id);
            coords.push([station.location.lon, station.location.lat]);
          }
          return { ids, coords };
        };

        const pushSegment = (
          patternId: string,
          stationIds: string[],
          coords: [number, number][]
        ) => {
          if (coords.length < 2 || stationIds.length < 2) return;
          const { smoothed, stopIndices } = smoothLineWithStops(coords);
          lineFeatures.push({
            type: 'Feature',
            properties: {
              pattern_id: patternId,
              line_id: line.id,
              network_id: net.meta.id,
              color: line.color ?? '#64748b'
            },
            geometry: { type: 'LineString', coordinates: smoothed }
          });
          const list = nextDrawnPaths.get(line.id) ?? [];
          list.push({ lineId: line.id, stationIds, smoothed, stopIndices });
          nextDrawnPaths.set(line.id, list);
        };

        const trunk = seqOf(primary);
        if (trunk.coords.length < 2) continue;
        const trunkIds = [...trunk.ids];
        if (line.loop && trunk.coords.length >= 3) {
          trunk.coords.push(trunk.coords[0]);
          trunkIds.push(trunkIds[0]);
        }
        pushSegment(primary.id, trunkIds, trunk.coords);
        const mainSet = new Set(trunk.ids);
        const stopToStation = new Map<string, string>(
          stopMap ? [...stopMap.values()].map((s) => [s.id, s.station_id]) : []
        );

        for (const pattern of drawable) {
          if (pattern.id === primary.id) continue;
          const { ids, coords } = seqOf(pattern);
          if (coords.length < 2) continue;

          // Junction: explicit junction stop, else the trunk station that has a
          // branch-only neighbour on this pattern. Through-running branch
          // patterns include the shared trunk, so "last station shared with
          // the trunk" would pin the junction at the far terminus and drop the
          // spur (e.g. Hangzhou L6 双浦/霞鸣街 off 美院象山).
          let junctionIdx = pattern.junction_stop_id
            ? ids.indexOf(stopToStation.get(pattern.junction_stop_id) ?? '')
            : -1;
          if (junctionIdx === -1) {
            for (let i = 0; i < ids.length; i++) {
              if (!mainSet.has(ids[i])) continue;
              const prev = i > 0 ? ids[i - 1] : undefined;
              const next = i + 1 < ids.length ? ids[i + 1] : undefined;
              if ((prev && !mainSet.has(prev)) || (next && !mainSet.has(next))) {
                junctionIdx = i;
                break;
              }
            }
          }
          if (junctionIdx === -1) {
            // Fully disjoint or a pure reverse of the trunk: fall back to last shared.
            for (let i = ids.length - 1; i >= 0; i--) {
              if (mainSet.has(ids[i])) {
                junctionIdx = i;
                break;
              }
            }
          }
          if (junctionIdx === -1) {
            // Fully disjoint branch — nothing shared with the trunk, draw whole.
            pushSegment(pattern.id, ids, coords);
            continue;
          }

          // Walk outward from the junction on each side, stopping at the first
          // trunk station — what remains is exactly this branch's own geometry.
          const beforeIds: string[] = [];
          const before: [number, number][] = [];
          for (let i = junctionIdx - 1; i >= 0; i--) {
            if (mainSet.has(ids[i])) break;
            beforeIds.push(ids[i]);
            before.push(coords[i]);
          }
          const afterIds: string[] = [];
          const after: [number, number][] = [];
          for (let i = junctionIdx + 1; i < ids.length; i++) {
            if (mainSet.has(ids[i])) break;
            afterIds.push(ids[i]);
            after.push(coords[i]);
          }
          if (before.length) {
            pushSegment(
              pattern.id,
              [ids[junctionIdx], ...beforeIds],
              [coords[junctionIdx], ...before]
            );
          }
          if (after.length) {
            pushSegment(
              pattern.id,
              [ids[junctionIdx], ...afterIds],
              [coords[junctionIdx], ...after]
            );
          }
        }
      }
    }

    drawnPathsByLine = nextDrawnPaths;
    // Re-clip any active route against the fresh line geometry. Untracked so
    // this does not subscribe the sync effect to `app.route` (which would
    // re-run the full line rebuild whenever the route changes).
    untrack(() => applyRouteOverlay(app.route, false));

    const m = map;
    (m.getSource('metro-lines') as maplibregl.GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: lineFeatures
    });
    (m.getSource('metro-stations') as maplibregl.GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features: stationFeatures
    });

    if (!firstFitDone && coordsAll.length > 0) {
      firstFitDone = true;
      const bounds = new maplibregl.LngLatBounds();
      for (const c of coordsAll) bounds.extend(c);
      m.fitBounds(bounds, {
        padding: { top: 100, bottom: 60, left: 60, right: 60 },
        duration: 1600
      });
    }
  }

  // Reactive sync (locale changes, data arrivals). Belt and braces: syncMapData
  // is also invoked directly from the map 'load' handler, so data that arrived
  // before the style loaded (or while the tab was throttled) can never be missed.
  $effect(() => {
    if (!map || !mapReady) return;
    void app.loading;
    void app.networks;
    void i18n.locale;
    syncMapData();
  });

  // --- Highlight: dim everything that is not selected / on the route ---
  $effect(() => {
    if (!map || !mapReady) return;
    const selectedLineId = app.state.selectedLineId;
    const route = app.route;
    const keep = route
      ? [
          ...new Set(
            route.legs.filter((l) => l.kind === 'ride' && l.line_id).map((l) => l.line_id!)
          )
        ]
      : selectedLineId
        ? [selectedLineId]
        : null;
    const opacity = keep ? ['case', ['in', ['get', 'line_id'], ['literal', keep]], 1, 0.22] : 0.9;
    map.setPaintProperty('metro-lines', 'line-opacity', opacity);
    map.setPaintProperty('metro-lines-casing', 'line-opacity', keep ? 0.95 : 0.9);
  });

  // --- Zoom so the selected line fits to view ---
  let lastFittedLineId: string | null = null;
  $effect(() => {
    if (!map || !mapReady) return;
    const lineId = app.state.selectedLineId;
    if (!lineId) {
      lastFittedLineId = null;
      return;
    }
    if (lineId === lastFittedLineId) return;
    lastFittedLineId = lineId;
    const hit = app.findLine(lineId);
    if (!hit) return;
    const net = hit.network;
    const stopById = new Map(net.stops.map((s) => [s.id, s]));
    const stationById = new Map(net.stations.map((s) => [s.id, s]));
    const coords: [number, number][] = [];
    for (const pattern of net.patterns) {
      if (pattern.line_id !== lineId) continue;
      for (const stopId of pattern.stop_ids) {
        const stop = stopById.get(stopId);
        const station = stop ? stationById.get(stop.station_id) : undefined;
        if (station?.location) coords.push([station.location.lon, station.location.lat]);
      }
    }
    if (coords.length < 2) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const c of coords) bounds.extend(c);
    map.fitBounds(bounds, {
      padding: { top: 90, bottom: 120, left: 500, right: 80 },
      duration: 1100
    });
  });

  // --- Selected station pulse marker ---
  $effect(() => {
    if (!map || !mapReady) return;
    const selected = app.state.selectedStationId;
    const loc = app.stationLocation(selected);
    if (!loc) {
      markers.selected?.remove();
      markers.selected = null;
      return;
    }
    const el = document.createElement('div');
    el.className = 'station-pulse';
    markers.selected?.remove();
    markers.selected = new maplibregl.Marker({ element: el }).setLngLat(loc).addTo(map);
    map.flyTo({ center: loc, zoom: Math.max(map.getZoom(), 12.2), duration: 900, essential: true });
  });

  // --- Origin / destination markers ---
  $effect(() => {
    if (!map || !mapReady) return;
    const originLoc = app.stationLocation(app.state.originId);
    const destLoc = app.stationLocation(app.state.destinationId);

    for (const [id, loc, kind, letter] of [
      ['origin', originLoc, 'origin', 'A'],
      ['destination', destLoc, 'destination', 'B']
    ] as const) {
      if (!loc) {
        markers[id]?.remove();
        markers[id] = null;
        continue;
      }
      const el = document.createElement('div');
      el.className = `od-marker od-marker--${kind}`;
      el.innerHTML = `<div class="od-marker__ring"></div><div class="od-marker__core">${letter}</div>`;
      markers[id]?.remove();
      markers[id] = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat(loc)
        .addTo(map);
    }
  });

  // --- Route overlay with animated dashes ---
  /**
   * Draw the route by clipping already-drawn line splines.
   * `fit` is true only when the route itself changed — line-data refreshes
   * re-clip without stealing the camera.
   */
  function applyRouteOverlay(route: RoutePlan | null, fit: boolean): void {
    if (!map || !mapReady) return;
    const m = map;
    stopRouteAnimation();

    if (!route) {
      (m.getSource('route-line') as maplibregl.GeoJSONSource)?.setData(emptyFeatureCollection());
      return;
    }

    const features: Feature[] = [];
    for (const leg of route.legs) {
      if (leg.kind !== 'ride' || !leg.line_id) continue;
      const stationIds = leg.station_ids ?? [leg.from_station_id, leg.to_station_id];
      // Clip the already-drawn line geometry so the route follows the exact
      // spline used for the line, not a re-interpolation of the leg subset.
      const paths = drawnPathsByLine.get(leg.line_id) ?? [];
      let coords = routeGeometryForStationIds(stationIds, paths);
      if (coords.length < 2) {
        coords = [];
        for (const stationId of stationIds) {
          const loc = app.stationLocation(stationId);
          if (loc) coords.push(loc);
        }
        if (coords.length >= 3) coords = smoothLine(coords);
      }
      if (coords.length < 2) continue;
      features.push({
        type: 'Feature',
        properties: {
          color: app.lineColor(leg.line_id),
          leg: `${leg.from_station_id}->${leg.to_station_id}`
        },
        geometry: { type: 'LineString', coordinates: coords }
      });
    }
    (m.getSource('route-line') as maplibregl.GeoJSONSource)?.setData({
      type: 'FeatureCollection',
      features
    });

    // Fit to the whole route only when the journey itself changed.
    if (fit) {
      const allCoords = features.flatMap(
        (f) => (f.geometry as LineString).coordinates as [number, number][]
      );
      if (allCoords.length > 1) {
        const bounds = new maplibregl.LngLatBounds();
        for (const c of allCoords) bounds.extend(c as maplibregl.LngLatLike);
        map.fitBounds(bounds, {
          padding: { top: 160, bottom: 260, left: 80, right: 80 },
          duration: 1100
        });
      }
    }

    startRouteAnimation();
  }

  $effect(() => {
    if (!map || !mapReady) return;
    const route: RoutePlan | null = app.route;
    applyRouteOverlay(route, true);
  });

  function startRouteAnimation(): void {
    const dashArraySequence = [
      [0, 4, 3],
      [0.5, 4, 2.5],
      [1, 4, 2],
      [1.5, 4, 1.5],
      [2, 4, 1],
      [2.5, 4, 0.5],
      [3, 4, 0],
      [0, 0.5, 3, 3.5],
      [0, 1, 3, 3],
      [0, 1.5, 3, 2.5],
      [0, 2, 3, 2],
      [0, 2.5, 3, 1.5],
      [0, 3, 3, 1],
      [0, 3.5, 3, 0.5]
    ];
    let step = 0;
    const frame = () => {
      const dash = dashArraySequence[step % dashArraySequence.length];
      if (map?.getLayer('route-dashes')) {
        map.setPaintProperty('route-dashes', 'line-dasharray', dash);
      }
      step += 1;
      routeAnimId = requestAnimationFrame(frame);
    };
    routeAnimId = requestAnimationFrame(frame);
  }

  function stopRouteAnimation(): void {
    cancelAnimationFrame(routeAnimId);
    routeAnimId = 0;
  }
</script>

<!-- Wrapper needed: maplibre-gl.css sets `position: relative` on the map
     container, which would override a bare `absolute inset-0` on it. -->
<div class="absolute inset-0">
  <div bind:this={container} class="h-full w-full"></div>
</div>

{#if app.loading}
  <div
    class="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-background/40 backdrop-blur-[2px]"
  >
    <div class="flex items-center gap-3 rounded-2xl border bg-popover/90 px-6 py-4 shadow-xl">
      <span
        class="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent"
      ></span>
      <span class="text-sm font-medium">{i18n.t.map_loading()}</span>
    </div>
  </div>
{:else if app.error}
  <div class="pointer-events-none absolute inset-0 z-10 grid place-items-center">
    <div
      class="rounded-2xl border border-destructive/40 bg-popover/95 px-6 py-4 text-sm text-destructive shadow-xl"
    >
      {app.error}
    </div>
  </div>
{/if}
