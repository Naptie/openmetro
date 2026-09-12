<script lang="ts">
import type { Station } from "$lib/api-types";

let {
  stations,
  query,
  onSelect,
}: { stations: Station[]; query: string; onSelect: (s: Station) => void } = $props();

const filtered = $derived.by(() => {
  const q = query.toLowerCase();
  return q
    ? stations.filter((s) => stationLabel(s).toLowerCase().includes(q))
    : stations.slice(0, 80);
});

function stationLabel(s: Station): string {
  return s.names?.en ? `${s.names.zh} (${s.names.en})` : s.name;
}
</script>

<div class="flex flex-wrap gap-2">
  {#each filtered as s (s.id)}
    <button
      type="button"
      class="cursor-pointer rounded-full border border-gray-300 px-3 py-1 text-xs hover:bg-gray-100"
      title={s.is_interchange ? "Interchange" : ""}
      onclick={() => onSelect(s)}
    >
      {stationLabel(s)}
    </button>
  {/each}
</div>
