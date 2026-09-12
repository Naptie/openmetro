<script lang="ts">
let { networks, value = $bindable() }: { networks: string[]; value: string } = $props();
</script>

<label class="flex items-center gap-2 text-sm font-medium">
  Network:
  <select
    class="rounded border border-gray-300 bg-white px-2 py-1 text-sm"
    bind:value
  >
    {#each networks as net}
      <option value={net}>{net}</option>
    {/each}
  </select>
</label>
