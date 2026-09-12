<script lang="ts">
let { value = $bindable() }: { value: string } = $props();
</script>

<input
  type="text"
  placeholder="Search stations..."
  class="w-full rounded border border-gray-300 px-3 py-1.5 text-sm"
  bind:value
/>
