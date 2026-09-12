<script lang="ts">
import type { Line, Station, Stop } from "$lib/api-types";
import { client, get } from "$lib/client";
import LineChips from "$lib/components/LineChips.svelte";
import MetroMap from "$lib/components/MetroMap.svelte";
import NetworkSelector from "$lib/components/NetworkSelector.svelte";
import RoutePlanner from "$lib/components/RoutePlanner.svelte";
import StationCard from "$lib/components/StationCard.svelte";
import StationChips from "$lib/components/StationChips.svelte";
import StationSearch from "$lib/components/StationSearch.svelte";

let networks = $state<string[]>([]);
let currentNetwork = $state("");
let lines = $state<Line[]>([]);
let stations = $state<Station[]>([]);
let lineStationMap = $state<Map<string, Set<string>>>(new Map());
let selectedStation = $state<Station | null>(null);
let selectedLine = $state<string | null>(null);
let stationQuery = $state("");
let originId = $state("");
let destinationId = $state("");

async function loadNetwork(id: string) {
  const [ls, sts, stops] = await Promise.all([
    get(client.api.networks({ id }).lines.get()),
    get(client.api.networks({ id }).stations.get()),
    get(client.api.networks({ id }).stops.get()),
  ]);
  lines = ls;
  stations = [...new Map(sts.map((s) => [s.id, s])).values()];
  const map = new Map<string, Set<string>>();
  for (const stop of stops) {
    let set = map.get(stop.line_id);
    if (!set) {
      set = new Set();
      map.set(stop.line_id, set);
    }
    set.add(stop.station_id);
  }
  lineStationMap = map;
  selectedStation = null;
  selectedLine = null;
  stationQuery = "";
}

const filteredStations = $derived.by(() => {
  if (!selectedLine) return stations;
  const ids = lineStationMap.get(selectedLine);
  return ids ? stations.filter((s) => ids.has(s.id)) : stations;
});

$effect(() => {
  get(client.api.networks.get()).then((data) => {
    networks = data.networks.map((n) => n.id);
    if (networks.length > 0 && !currentNetwork) {
      currentNetwork = networks[0];
    }
  });
});

$effect(() => {
  const id = currentNetwork;
  if (id) {
    loadNetwork(id);
  }
});

function handleStationSelect(s: Station) {
  selectedStation = s;
}

function handleSetOrigin(s: Station) {
  originId = originId === s.id ? "" : s.id;
}

function handleSetDestination(s: Station) {
  destinationId = destinationId === s.id ? "" : s.id;
}

function handleLineSelect(lineId: string | null) {
  selectedLine = lineId;
  selectedStation = null;
}
</script>

<div class="max-w-screen mx-auto px-4 xl:px-12 py-8">
  <h1 class="text-2xl font-bold mb-6">Open Metro</h1>

  <section class="mb-6">
    <NetworkSelector bind:value={currentNetwork} {networks} />
  </section>

  <section class="mb-6">
    <MetroMap
      networkId={currentNetwork}
      {lines}
      {stations}
      onStationSelect={handleStationSelect}
    />
  </section>

  <section class="mb-6">
    <h2 class="text-lg font-semibold mb-3">Lines</h2>
    <LineChips {lines} {selectedLine} onSelect={handleLineSelect} />
  </section>

  <hr class="border-gray-200 mb-6" />

  <section class="mb-6">
    <h2 class="text-lg font-semibold mb-3">Stations</h2>
    <div class="mb-3">
      <StationSearch bind:value={stationQuery} />
    </div>
    <StationChips stations={filteredStations} query={stationQuery} onSelect={handleStationSelect} />
    {#if selectedStation}
      <StationCard
        station={selectedStation}
        networkId={currentNetwork}
        {originId}
        {destinationId}
        onSetOrigin={handleSetOrigin}
        onSetDestination={handleSetDestination}
      />
    {/if}
  </section>

  <hr class="border-gray-200 mb-6" />

  <section>
    <h2 class="text-lg font-semibold mb-3">Route</h2>
    <RoutePlanner {stations} networkId={currentNetwork} />
  </section>
</div>
