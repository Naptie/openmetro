<script lang="ts">
  import './layout.css';
  import favicon from '$lib/assets/favicon.svg';

  let { children } = $props();
</script>

<svelte:head>
  <link rel="icon" href={favicon}>
  <title>Open Metro</title>
  <meta name="description" content="Open metro data at ease — explore metro networks, plan routes.">
  <meta name="theme-color" content="#0f172a">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</svelte:head>

{@render children()}
