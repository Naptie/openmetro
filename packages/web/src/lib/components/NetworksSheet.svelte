<script lang="ts">
  import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
  import CrosshairIcon from '@lucide/svelte/icons/crosshair';
  import XIcon from '@lucide/svelte/icons/x';
  import { tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import LineDetail from '$lib/components/LineDetail.svelte';
  import * as Accordion from '$lib/components/ui/accordion/index.js';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { localizedName, networkName } from '$lib/format';
  import { createSheetSizer } from '$lib/hooks/use-sheet-resize.svelte';
  import { i18n } from '$lib/i18n.svelte';
  import { app } from '$lib/state.svelte';

  const t = $derived(i18n.t);
  const locale = $derived(i18n.locale);
  const view = $derived(app.state.selectedLineId);
  const sizer = createSheetSizer('networks');

  // Accordion value: networks stay collapsed so the full list stays scannable.
  // The focused network is only auto-expanded when the browser is opened via the
  // navbar Lines button (signalled through the expand token) — never reactively,
  // so manual browsing/collapsing is never overridden.
  let expandedNetwork = $state<string>('');
  let lastExpandToken = 0;

  $effect(() => {
    const token = app.state.networksExpandToken;
    if (token === lastExpandToken) return;
    lastExpandToken = token;
    if (!token) return;
    expandedNetwork = app.state.focusedNetworkId ?? '';
    const id = expandedNetwork;
    if (id) {
      tick().then(() => {
        setTimeout(() => {
          document
            .getElementById(`network-item-${id}`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 260);
      });
    }
  });

  function focusNetwork(networkId: string): void {
    app.focusNetwork(networkId);
    expandedNetwork = networkId;
    const net = app.networks.find((n) => n.meta.id === networkId);
    if (!net) return;
    const coords = net.stations
      .filter((s) => s.location)
      .map((s) => [s.location!.lon, s.location!.lat] as [number, number]);
    if (!coords.length) return;
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    window.dispatchEvent(
      new CustomEvent('metro:focus-bounds', {
        detail: {
          bounds: [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)]
          ]
        }
      })
    );
  }
</script>

<Sheet.Root bind:open={app.state.networksOpen}>
  <Sheet.Content
    side={sizer.isDesktop ? "left" : "bottom"}
    showCloseButton={false}
    class="w-full gap-0 p-0 data-[side=bottom]:rounded-t-2xl data-[side=left]:w-full data-[side=right]:w-full sm:max-w-md sm:data-[side=left]:max-w-md sm:data-[side=right]:max-w-md"
    style={sizer.style}
  >
    <!-- Mobile drawer handle (drag to resize height) -->
    <!-- biome-ignore lint/a11y/useSemanticElements: interactive resize handle, not a visual <hr> -->
    <div
      class="absolute top-1.5 left-1/2 z-20 h-6 w-12 -translate-x-1/2 cursor-row-resize touch-none sm:hidden"
      onpointerdown={(e) => sizer.startHeightResize(e, 1)}
      role="separator"
      aria-orientation="horizontal"
    >
      <div class="mx-auto mt-2 h-1 w-8 rounded-full bg-muted-foreground/40"></div>
    </div>
    <!-- Desktop width grip (drag to resize) -->
    <!-- biome-ignore lint/a11y/useSemanticElements: interactive resize handle, not a visual <hr> -->
    <div
      class="absolute inset-y-0 right-0 z-20 hidden w-1.5 cursor-col-resize touch-none hover:bg-primary/20 sm:block"
      onpointerdown={(e) => sizer.startWidthResize(e, 1)}
      role="separator"
      aria-orientation="vertical"
    ></div>

    <Sheet.Header class="border-b px-4 py-3">
      <div class="flex items-center gap-2">
        {#if view}
          <Button
            variant="ghost"
            size="icon-sm"
            onclick={() => app.selectLine(null)}
            aria-label={t.common_back()}
          >
            <ArrowLeftIcon class="size-4" />
          </Button>
          <Sheet.Title class="text-base">{t.line_metadata()}</Sheet.Title>
        {:else}
          <Sheet.Title class="text-base">{t.nav_lines()}</Sheet.Title>
        {/if}
        <Sheet.Close>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              class="ml-auto"
              aria-label={t.common_close()}
            >
              <XIcon class="size-4" />
            </Button>
          {/snippet}
        </Sheet.Close>
      </div>
      <Sheet.Description class="sr-only">{t.map_hint()}</Sheet.Description>
    </Sheet.Header>

    <div class="panel-scroll flex-1 overflow-y-auto p-4">
      {#if view}
        {@const hit = app.findLine(view)}
        {#if hit}
          <LineDetail line={hit.line} network={hit.network} />
        {/if}
      {:else}
        {#key `${locale}-${app.networks.length}`}
          <div in:fly={{ x: -24, duration: 250 }}>
            <Accordion.Root class="flex flex-col gap-2.25" type="single" bind:value={expandedNetwork}>
              {#each app.networks as net (net.meta.id)}
                <Accordion.Item
                  value={net.meta.id}
                  id="network-item-{net.meta.id}"
                  class="overflow-hidden rounded-xl border shadow-xs"
                >
                  <div class="relative flex w-full items-center">
                    <Accordion.Trigger
                      class="min-w-0 flex-1 items-center gap-2 rounded-none px-3.5 py-3 hover:no-underline"
                    >
                      <span class="block w-full min-w-0 pr-10 text-left">
                        <span class="block truncate text-sm font-bold">
                          {networkName(net.meta, locale)}
                        </span>
                        <span class="block truncate text-[11px] text-muted-foreground">
                          {net.meta.city.name[locale === "zh" ? "zh" : "en"]}
                          · {net.meta.country_code} ·
                          {t.network_lines_count({ count: net.lines.length })}
                          ·
                          {t.network_stations_count({ count: net.stations.length })}
                        </span>
                      </span>
                    </Accordion.Trigger>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      class="absolute top-1/2 right-9 -translate-y-1/2"
                      onclick={(e) => {
                        e.stopPropagation();
                        focusNetwork(net.meta.id);
                      }}
                      title={t.network_focus()}
                    >
                      <CrosshairIcon class="size-4" />
                    </Button>
                  </div>
                  <Accordion.Content class="px-1.5 pt-0 pb-1.5">
                    <div class="flex flex-col">
                      {#each net.lines as line (line.id)}
                        <button
                          type="button"
                          class="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
                          onclick={() => app.selectLine(line.id)}
                        >
                          <span
                            class="h-4 w-4 shrink-0 rounded-md border border-black/10"
                            style="background: {line.color ?? '#94a3b8'}"
                          ></span>
                          <span class="min-w-0 flex-1 truncate text-sm">
                            {localizedName(line.names, line.name, locale)}
                          </span>
                          {#if line.loop}
                            <Badge variant="secondary" class="px-1.5 py-0 text-[10px]"
                              >{t.line_loop()}</Badge
                            >
                          {/if}
                          {#if line.status && line.status !== "operating"}
                            <Badge variant="destructive" class="px-1.5 py-0 text-[10px]">
                              {t.status_other({ status: line.status })}
                            </Badge>
                          {/if}
                        </button>
                      {/each}
                    </div>
                  </Accordion.Content>
                </Accordion.Item>
              {/each}
            </Accordion.Root>
          </div>
        {/key}
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
