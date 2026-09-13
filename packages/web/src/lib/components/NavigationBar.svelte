<script lang="ts">
  // Navigation bar adapted from nearcade (github.com/Naptie/nearcade):
  // stacked backdrop-blur layers with a gradient mask produce a smooth
  // "liquid glass" fade over the map, with no edge artifacts.

  import ListIcon from '@lucide/svelte/icons/list';
  import RouteIcon from '@lucide/svelte/icons/route';
  import TrainFrontIcon from '@lucide/svelte/icons/train-front';
  import LocaleSwitch from '$lib/components/LocaleSwitch.svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { i18n } from '$lib/i18n.svelte';
  import { app } from '$lib/state.svelte';

  const maxRadius = 64;
  const iterations = 16;
  const blurLayers = Array.from({ length: iterations }, (_, i) => ({
    blur: maxRadius / (4 * maxRadius) ** (i / (iterations - 1)),
    maskStops: [
      Math.max(0, ((i - 2) * 100) / iterations),
      Math.max(0, ((i - 1) * 100) / iterations),
      (i * 100) / iterations,
      ((i + 1) * 100) / iterations
    ]
  }));

  const mask = (stops: number[]) =>
    `linear-gradient(to bottom, rgba(0,0,0,0) ${stops[0]}%, rgba(0,0,0,1) ${stops[1]}%, rgba(0,0,0,1) ${stops[2]}%, rgba(0,0,0,0) ${stops[3]}%)`;
</script>

<nav
  class="nav-bar fixed top-0 z-999 flex w-full items-center gap-2 bg-linear-to-t from-transparent to-background/70 px-3 py-2 sm:px-5"
>
  <div class="pointer-events-none absolute inset-0 z-0">
    {#each blurLayers as layer, index (index)}
      <div
        class="absolute inset-0"
        style="backdrop-filter: blur({layer.blur}px); -webkit-backdrop-filter: blur({layer.blur}px); mask-image: {mask(layer.maskStops)}; -webkit-mask-image: {mask(layer.maskStops)};"
      ></div>
    {/each}
  </div>

  <div class="relative z-10 flex min-w-0 flex-1 items-center gap-2.5">
    <span
      class="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-md"
    >
      <TrainFrontIcon class="size-5" />
    </span>
    <div class="min-w-0 leading-tight">
      <p class="truncate text-base font-bold tracking-tight">{i18n.t.app_name()}</p>
      <p class="hidden truncate text-[11px] text-muted-foreground sm:block">
        {i18n.t.app_tagline()}
      </p>
    </div>
  </div>

  <div class="relative z-10 flex items-center gap-0.5 md:gap-1">
    <Button variant="ghost" size="sm" onclick={() => app.openNetworks()} title={i18n.t.nav_lines()}>
      <ListIcon class="size-4" />
      <span class="hidden sm:inline">{i18n.t.nav_lines()}</span>
    </Button>
    <Button
      variant="ghost"
      size="sm"
      onclick={() => app.toggleRoutePanel()}
      title={i18n.t.nav_route()}
    >
      <RouteIcon class="size-4" />
      <span class="hidden sm:inline">{i18n.t.nav_route()}</span>
    </Button>
    <LocaleSwitch />
  </div>
</nav>
