<script lang="ts">
import type { Line } from "$lib/api-types";

let {
  lines,
  selectedLine,
  onSelect,
}: {
  lines: Line[];
  selectedLine: string | null;
  onSelect: (lineId: string | null) => void;
} = $props();
</script>

<div class="flex flex-wrap gap-2">
  <button
    type="button"
    class="cursor-pointer px-2.5 py-1 text-xs font-medium rounded border transition-colors"
    class:bg-gray-900={selectedLine === null}
    class:text-white={selectedLine === null}
    class:border-gray-900={selectedLine === null}
    class:bg-white={selectedLine !== null}
    class:text-gray-700={selectedLine !== null}
    class:border-gray-300={selectedLine !== null}
    class:hover:bg-gray-100={selectedLine !== null}
    onclick={() => onSelect(null)}
  >
    All
  </button>
  {#each lines as line (line.id)}
    {@const active = selectedLine === line.id}
    <button
      type="button"
      class="cursor-pointer px-2.5 py-1 text-xs font-medium rounded transition-opacity"
      class:opacity-100={active}
      class:opacity-60={!active && selectedLine !== null}
      class:hover:opacity-100={selectedLine !== null && !active}
      style:background-color={line.color ?? "#e5e7eb"}
      style:color={line.color ? "#fff" : "#000"}
      onclick={() => onSelect(active ? null : line.id)}
    >
      {line.name}
    </button>
  {/each}
</div>
