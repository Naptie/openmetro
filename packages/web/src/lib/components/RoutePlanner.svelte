<script lang="ts">
import type { RoutePlan, Station } from "$lib/api-types";
import { client, get } from "$lib/client";

let { stations, networkId }: { stations: Station[]; networkId: string } = $props();

let fromId = $state("");
let toId = $state("");
let result = $state<RoutePlan | null>(null);
let loading = $state(false);

function stationLabel(s: Station): string {
  return s.names?.en ? `${s.names.zh} (${s.names.en})` : s.name;
}

const stationNames = $derived(new Map(stations.map((s) => [s.id, stationLabel(s)])));

const stationPath = $derived(
  result
    ? result.legs
        .flatMap((leg) => (leg.kind === "ride" ? (leg.station_ids ?? []) : []))
        .filter((id, i, all) => i === 0 || id !== all[i - 1])
    : [],
);

async function findRoute() {
  if (!fromId || !toId) return;
  loading = true;
  try {
    result = await get(
      client.api.networks({ id: networkId }).route.get({
        query: { from: fromId, to: toId, weight: "time" },
      }),
    );
  } finally {
    loading = false;
  }
}
</script>

<div class="flex flex-wrap items-end gap-3">
  <label class="flex flex-col gap-1 text-sm">
    From:
    <select class="rounded border border-gray-300 bg-white px-2 py-1 text-sm" bind:value={fromId}>
      <option value="">—</option>
      {#each stations as s (s.id)}
        <option value={s.id}>{stationLabel(s)}</option>
      {/each}
    </select>
  </label>

  <label class="flex flex-col gap-1 text-sm">
    To:
    <select class="rounded border border-gray-300 bg-white px-2 py-1 text-sm" bind:value={toId}>
      <option value="">—</option>
      {#each stations as s (s.id)}
        <option value={s.id}>{stationLabel(s)}</option>
      {/each}
    </select>
  </label>

  <button
    type="button"
    class="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
    disabled={loading || !fromId || !toId}
    onclick={findRoute}
  >
    {loading ? "Finding..." : "Find route"}
  </button>
</div>

{#if result}
  <div class="mt-3 rounded border border-gray-200 p-3 text-xs whitespace-pre-wrap">
    Travel time: {Math.round(result.total_seconds / 60)} min
    ({result.transfers} transfer{result.transfers === 1 ? "" : "s"})
    {stationPath.map((id) => stationNames.get(id) ?? id).join(" → ")}
  </div>
{/if}
