<script lang="ts">
import type { Station, StationDetail } from "$lib/api-types";
import { client, get } from "$lib/client";

let {
  station,
  networkId,
  originId,
  destinationId,
  onSetOrigin,
  onSetDestination,
}: {
  station: Station;
  networkId: string;
  originId: string;
  destinationId: string;
  onSetOrigin: (s: Station) => void;
  onSetDestination: (s: Station) => void;
} = $props();

let detail = $state<StationDetail | null>(null);

function stationLabel(s: Station): string {
  return s.names?.en ? `${s.names.zh} (${s.names.en})` : s.name;
}

function fmtTimeList(times: readonly string[]): string {
  if (times.length === 1) return times[0];
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return days.map((d, i) => `${d} ${times[i]}`).join(" · ");
}

$effect(() => {
  const id = station.id;
  const net = networkId;
  let cancelled = false;

  get(client.api.networks({ id: net }).stations({ stationId: id }).get()).then((d) => {
    if (!cancelled) {
      detail = d;
    }
  });

  return () => {
    cancelled = true;
  };
});

const statusByTimetable = $derived(
  detail ? new Map(detail.status.map((s) => [s.timetable_id, s])) : new Map(),
);
const inServiceCount = $derived(detail ? detail.status.filter((s) => s.is_in_service).length : 0);
</script>

<div class="mt-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
  <div class="flex items-start justify-between gap-3">
    <div>
      <h3 class="text-base font-semibold">
        {stationLabel(station)}
        {#if station.is_interchange}
          <span
            class="ml-1 align-middle rounded bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-white"
            >interchange</span
          >
        {/if}
      </h3>
      {#if station.names?.en}
        <p class="text-xs text-gray-500 mt-0.5">{station.name}</p>
      {/if}
    </div>
    <div class="flex flex-col items-end gap-1.5">
      <button
        type="button"
        class="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium hover:bg-gray-100"
        class:bg-orange-100={originId === station.id}
        class:border-orange-400={originId === station.id}
        class:text-orange-700={originId === station.id}
        onclick={() => onSetOrigin(station)}
      >
        {originId === station.id ? "Origin ✓" : "Set origin"}
      </button>
      <button
        type="button"
        class="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium hover:bg-gray-100"
        class:bg-blue-100={destinationId === station.id}
        class:border-blue-400={destinationId === station.id}
        class:text-blue-700={destinationId === station.id}
        onclick={() => onSetDestination(station)}
      >
        {destinationId === station.id ? "Destination ✓" : "Set destination"}
      </button>
    </div>
  </div>

  {#if station.location}
    <p class="text-xs text-gray-500 mt-2">
      {station.location.lat.toFixed(4)}, {station.location.lon.toFixed(4)}
    </p>
  {/if}

  {#if detail && detail.status.length > 0}
    <p class="text-xs text-gray-600 mb-2 mt-3">
      Now: {detail.status[0].now} ({detail.status[0].timezone}) — {inServiceCount} service(s) in operation
    </p>
  {/if}

  {#if detail && detail.timetables.length > 0}
    <div class="overflow-x-auto mt-2">
      <table class="w-full text-xs border-collapse">
        <thead>
          <tr class="border-b border-gray-300">
            <th class="text-left py-1 px-2 font-medium">Line</th>
            <th class="text-left py-1 px-2 font-medium">Destination</th>
            <th class="text-left py-1 px-2 font-medium">First</th>
            <th class="text-left py-1 px-2 font-medium">Last</th>
            <th class="text-left py-1 px-2 font-medium">In service</th>
          </tr>
        </thead>
        <tbody>
          {#each detail.timetables as t (t.id)}
            <tr class="border-b border-gray-100">
              <td class="py-1 px-2">{t.line_id}</td>
              <td class="py-1 px-2">{t.direction_label ?? t.destination_stop_id}</td>
              <td class="py-1 px-2">{fmtTimeList(t.first_train)}</td>
              <td class="py-1 px-2">{fmtTimeList(t.last_train)}</td>
              <td class="py-1 px-2">{statusByTimetable.get(t.id)?.is_in_service ? "yes" : "no"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
