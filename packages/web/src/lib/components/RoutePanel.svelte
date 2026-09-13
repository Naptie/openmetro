<script lang="ts">
  import ArrowDownUpIcon from '@lucide/svelte/icons/arrow-down-up';
  import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import ClockIcon from '@lucide/svelte/icons/clock';
  import CoinsIcon from '@lucide/svelte/icons/coins';
  import FootprintsIcon from '@lucide/svelte/icons/footprints';
  import TrainFrontIcon from '@lucide/svelte/icons/train-front';
  import Trash2Icon from '@lucide/svelte/icons/trash-2';
  import XIcon from '@lucide/svelte/icons/x';
  import { fly, slide } from 'svelte/transition';
  import StationPicker from '$lib/components/StationPicker.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import { formatDuration, localizedName } from '$lib/format';
  import { i18n } from '$lib/i18n.svelte';
  import { app } from '$lib/state.svelte';

  const locale = $derived(i18n.locale);

  const route = $derived(app.route);
  const routeKey = $derived(route ? `${app.state.originId}->${app.state.destinationId}` : null);
  let expandedLeg = $state<string | null>(null);

  // Stations offered by the pickers always come from the focused network.
  const pickerNetwork = $derived(
    (app.state.focusedNetworkId
      ? app.networks.find((n) => n.meta.id === app.state.focusedNetworkId)
      : null) ??
      app.stationById(app.state.originId)?.network ??
      app.networks[0] ??
      null
  );

  $effect(() => {
    // Collapse expansions when a new route arrives.
    routeKey;
    expandedLeg = null;
  });

  function legStations(stationIds: readonly string[] | undefined): string[] {
    if (!stationIds) return [];
    const out: string[] = [];
    for (const id of stationIds) {
      if (id !== out[out.length - 1]) out.push(id);
    }
    return out;
  }
</script>

{#if app.state.routePanelOpen}
  <div
    class="fixed bottom-3 left-1/2 z-30 w-[calc(100%-1.5rem)] max-w-lg -translate-x-1/2 sm:bottom-5 sm:left-5 sm:translate-x-0"
    in:fly={{ y: 48, duration: 350 }}
    out:fly={{ y: 48, duration: 250 }}
  >
    <div
      class="pointer-events-none absolute -inset-1 rounded-2xl bg-background/40 opacity-60 blur-md"
    ></div>
    <div class="relative rounded-2xl border bg-popover/95 shadow-2xl backdrop-blur-xl">
      <!-- Header -->
      <div class="flex items-center justify-between gap-2 px-4 pt-3">
        <h2 class="flex items-center gap-2 text-sm font-bold">
          <span
            class="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground"
          >
            <TrainFrontIcon class="size-3.5" />
          </span>
          {i18n.t.route_title()}
        </h2>
        <div class="flex items-center gap-1">
          {#if app.state.originId || app.state.destinationId}
            <Button
              variant="ghost"
              size="sm"
              class="h-7 gap-1 text-xs text-muted-foreground"
              onclick={() => app.clearRoute()}
            >
              <Trash2Icon class="size-3.5" />
              {i18n.t.route_clear()}
            </Button>
          {/if}
          <Button
            variant="ghost"
            size="icon-sm"
            class="size-7"
            aria-label={i18n.t.common_close()}
            title={i18n.t.common_close()}
            onclick={() => app.closeRoutePanel()}
          >
            <XIcon class="size-4" />
          </Button>
        </div>
      </div>

      <!-- Pickers -->
      <div class="flex items-center gap-2 px-4 py-3">
        <div class="grid min-w-0 flex-1 gap-1.5">
          <StationPicker
            value={app.state.originId}
            network={pickerNetwork}
            onSelect={(id) => (id ? app.setOrigin(id) : null)}
            placeholder={i18n.t.route_pick_origin()}
          />
          <StationPicker
            value={app.state.destinationId}
            network={pickerNetwork}
            onSelect={(id) => (id ? app.setDestination(id) : null)}
            placeholder={i18n.t.route_pick_destination()}
          />
        </div>
        <Button
          variant="outline"
          size="icon"
          class="shrink-0 rounded-full"
          title={i18n.t.route_swap()}
          onclick={() => app.swapOriginDestination()}
        >
          <ArrowDownUpIcon class="size-4" />
        </Button>
      </div>

      <!-- Hints / result -->
      <div class="px-4 pb-4">
        {#if !app.state.originId && !app.state.destinationId}
          <p class="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {i18n.t.map_hint()}
          </p>
        {:else if app.state.originId && !app.state.destinationId}
          <p class="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {i18n.t.route_hint_origin()}
          </p>
        {:else if !app.state.originId && app.state.destinationId}
          <p class="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {i18n.t.route_hint_destination()}
          </p>
        {:else if app.routeLoading}
          <div class="flex flex-col gap-2 pt-1">
            <div class="flex gap-2">
              <Skeleton class="h-8 w-24 rounded-lg" />
              <Skeleton class="h-8 w-24 rounded-lg" />
              <Skeleton class="h-8 w-24 rounded-lg" />
            </div>
            <Skeleton class="h-20 w-full rounded-xl" />
          </div>
        {:else if app.routeError}
          <p class="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {i18n.t.route_error()}
          </p>
        {:else if !route}
          <p class="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {i18n.t.route_no_route()}
          </p>
        {:else}
          {#key routeKey}
            <div in:fly={{ y: 14, duration: 300 }}>
              <!-- Summary chips -->
              <div class="flex flex-wrap gap-1.5">
                <Badge variant="secondary" class="gap-1.5 px-2.5 py-1">
                  <ClockIcon class="size-3.5" />
                  {formatDuration(route.total_seconds, locale)}
                </Badge>
                <Badge variant="secondary" class="gap-1.5 px-2.5 py-1">
                  <FootprintsIcon class="size-3.5" />
                  {i18n.t.route_transfers()}
                  <span class="font-bold">{route.transfers}</span>
                </Badge>
                <Badge variant="secondary" class="gap-1.5 px-2.5 py-1">
                  <CoinsIcon class="size-3.5" />
                  {route.fare != null && route.currency
                    ? i18n.t.route_fare_value({ amount: route.fare, currency: route.currency })
                    : i18n.t.route_no_fare()}
                </Badge>
              </div>

              <Separator class="my-3" />

              <!-- Legs timeline -->
              <ol class="flex flex-col">
                {#each route.legs as leg, i (i + leg.from_station_id + leg.to_station_id)}
                  {@const from = app.stationById(leg.from_station_id)?.station}
                  {@const to = app.stationById(leg.to_station_id)?.station}
                  {@const line = leg.line_id ? app.lineById(leg.line_id) : null}
                  {@const stations = leg.kind === "ride" ? legStations(leg.station_ids) : []}
                  {@const legId = `${i}-${leg.kind}-${leg.from_station_id}`}
                  {#if leg.kind === "transfer"}
                    <li class="flex items-center gap-2 py-1.5 pl-3.5">
                      <FootprintsIcon class="size-3.5 shrink-0 text-muted-foreground" />
                      <span class="text-xs text-muted-foreground">
                        {i18n.t.route_transfer_walk({
                          minutes: Math.max(1, Math.round(leg.seconds / 60)),
                        })}
                      </span>
                    </li>
                  {:else}
                    <li class="flex gap-2.5">
                      <!-- Vertical indicator: single centered dot when collapsed,
                        two dots joined by the line when expanded -->
                      <div
                        class="flex w-2.5 shrink-0 flex-col items-center {expandedLeg === legId &&
                        stations.length > 2
                          ? ''
                          : 'justify-center'}"
                      >
                        {#if expandedLeg === legId && stations.length > 2}
                          <span
                            class="z-10 size-2.5 rounded-full border-2 border-white"
                            style="background: {line?.color ?? '#64748b'}; box-shadow: 0 0 0 1.5px {line?.color ?? '#64748b'}"
                          ></span>
                          <span
                            class="w-0.75 flex-1 rounded-full"
                            style="background: {line?.color ?? '#64748b'}"
                          ></span>
                          <span
                            class="z-10 size-2.5 rounded-full border-2 border-white"
                            style="background: {line?.color ?? '#64748b'}; box-shadow: 0 0 0 1.5px {line?.color ?? '#64748b'}"
                          ></span>
                        {:else}
                          <span
                            class="z-10 size-2.5 rounded-full border-2 border-white"
                            style="background: {line?.color ?? '#64748b'}; box-shadow: 0 0 0 1.5px {line?.color ?? '#64748b'}"
                          ></span>
                        {/if}
                      </div>
                      <div class="min-w-0 flex-1 py-0.5">
                        <!-- biome-ignore lint/a11y/useSemanticElements: nested <button> inside; cannot use <button> here -->
                        <div
                          class="group flex w-full cursor-pointer items-baseline gap-1.5 text-left"
                          role="button"
                          tabindex="0"
                          onclick={() => (expandedLeg = expandedLeg === legId ? null : legId)}
                          onkeydown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              expandedLeg = expandedLeg === legId ? null : legId;
                            }
                          }}
                        >
                          <span class="min-w-0 flex-1 truncate text-xs">
                            <span class="font-semibold">
                              {#if line}
                                <button
                                  type="button"
                                  class="cursor-pointer hover:underline"
                                  onclick={(e) => {
                                    e.stopPropagation();
                                    app.selectLine(line.id);
                                  }}
                                >
                                  {i18n.t.route_ride({
                                    line: localizedName(line.names, line.name, locale),
                                  })}
                                </button>
                              {:else}
                                {i18n.t.route_ride({ line: "—" })}
                              {/if}
                            </span>
                            <span class="text-muted-foreground">
                              <button
                                type="button"
                                class="cursor-pointer hover:underline"
                                onclick={(e) => {
                                  e.stopPropagation();
                                  app.selectStation(leg.from_station_id);
                                }}
                              >
                                {from
                                  ? localizedName(from.names, from.name, locale)
                                  : leg.from_station_id}
                              </button>
                              <ArrowRightIcon class="inline size-3" />
                              <button
                                type="button"
                                class="cursor-pointer hover:underline"
                                onclick={(e) => {
                                  e.stopPropagation();
                                  app.selectStation(leg.to_station_id);
                                }}
                              >
                                {to ? localizedName(to.names, to.name, locale) : leg.to_station_id}
                              </button>
                            </span>
                          </span>
                          <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {formatDuration(leg.seconds, locale)}
                          </span>
                          <ChevronDownIcon
                            class="size-3.5 shrink-0 text-muted-foreground transition-transform {expandedLeg ===
                            legId
                              ? 'rotate-180'
                              : ''}"
                          />
                        </div>
                        {#if expandedLeg === legId && stations.length > 2}
                          <ol
                            class="mt-1.5 flex flex-col gap-1 border-l-2 pl-3 ml-0.5"
                            style="border-color: {line?.color ?? '#64748b'}66"
                            transition:slide={{ duration: 220 }}
                          >
                            {#each stations as stationId, j (stationId + j)}
                              {@const st = app.stationById(stationId)?.station}
                              <li
                                class="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                              >
                                <span
                                  class="size-1.5 shrink-0 rounded-full"
                                  style="background: {line?.color ?? '#64748b'}"
                                ></span>
                                <button
                                  type="button"
                                  class="cursor-pointer truncate hover:text-foreground hover:underline"
                                  onclick={() => app.selectStation(stationId)}
                                >
                                  {st ? localizedName(st.names, st.name, locale) : stationId}
                                </button>
                                {#if j === 0 || j === stations.length - 1}
                                  <span class="font-medium text-foreground"
                                    >· {j === 0 ? "A" : "B"}</span
                                  >
                                {/if}
                              </li>
                            {/each}
                          </ol>
                        {/if}
                      </div>
                    </li>
                  {/if}
                {/each}
              </ol>
            </div>
          {/key}
        {/if}
      </div>
    </div>
  </div>
{/if}
