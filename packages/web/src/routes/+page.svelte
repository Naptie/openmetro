<script lang="ts">
  import { onMount } from 'svelte';
  import MetroMap from '$lib/components/MetroMap.svelte';
  import NavigationBar from '$lib/components/NavigationBar.svelte';
  import NetworksSheet from '$lib/components/NetworksSheet.svelte';
  import RoutePanel from '$lib/components/RoutePanel.svelte';
  import StationSheet from '$lib/components/StationSheet.svelte';
  import { app } from '$lib/state.svelte';

  onMount(() => {
    app.loadAll();
  });

  // Whenever both endpoints are known, compute the route immediately.
  $effect(() => {
    if (app.state.originId && app.state.destinationId) {
      app.recalcRoute();
    }
  });
</script>

<div class="fixed inset-0 overflow-hidden">
  <MetroMap />
  <NavigationBar />
  <RoutePanel />
  <NetworksSheet />
  <StationSheet />
</div>
