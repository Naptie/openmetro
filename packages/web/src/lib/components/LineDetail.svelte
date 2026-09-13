<script lang="ts">
  import CrosshairIcon from '@lucide/svelte/icons/crosshair';
  import LoopIcon from '@lucide/svelte/icons/iteration-cw';
  import type { ApiLine as Line } from 'openmetro-client';
  import { fly } from 'svelte/transition';
  import TopoMap from '$lib/components/TopoMap.svelte';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import * as Tabs from '$lib/components/ui/tabs/index.js';
  import { lineModeKey, lineStatusKey, localizedName, networkName } from '$lib/format';
  import { i18n } from '$lib/i18n.svelte';
  import { app, type NetworkData } from '$lib/state.svelte';

  let { line, network }: { line: Line; network: NetworkData } = $props();

  const t = $derived(i18n.t);
  const locale = $derived(i18n.locale);
  const linePatterns = $derived(network.patterns.filter((p) => p.line_id === line.id));
  const mainPattern = $derived(linePatterns.find((p) => p.is_primary) ?? linePatterns[0]);

  // Which pattern's station list is shown; follows the main pattern by default
  // and resets whenever another line is opened. Empty string matches no tab
  // until the effect below syncs it (bind:value requires a defined value).
  let selectedPatternId = $state('');
  const selectedPattern = $derived(
    linePatterns.find((p) => p.id === selectedPatternId) ?? mainPattern
  );

  $effect(() => {
    // Reset the pattern selection when the line changes.
    line.id;
    selectedPatternId = mainPattern?.id ?? '';
  });

  // Stations of the selected pattern in sequence order (deduplicated).
  const patternStations = $derived.by(() => {
    const pattern = selectedPattern;
    if (!pattern) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const stopId of pattern.stop_ids) {
      const stop = network.stops.find((s) => s.id === stopId);
      if (!stop || seen.has(stop.station_id)) continue;
      seen.add(stop.station_id);
      out.push(stop.station_id);
    }
    return out;
  });

  const statusText = (status: string | undefined) =>
    lineStatusKey(status) === 'status_other'
      ? t.status_other({ status: status ?? '—' })
      : (t as unknown as Record<string, () => string>)[lineStatusKey(status)]();

  const modeText = (mode: string | undefined) =>
    lineModeKey(mode) === 'line_mode_other'
      ? t.line_mode_other({ mode: mode ?? '—' })
      : (t as unknown as Record<string, () => string>)[lineModeKey(mode)]();

  // Wide panels (resized by the user) get room to spell out which other lines
  // each interchange station connects to, instead of a bare "interchange" badge.
  let rootEl = $state<HTMLElement | null>(null);
  let panelWidth = $state(0);
  const wide = $derived(panelWidth >= 360);

  $effect(() => {
    const el = rootEl;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      panelWidth = entries[0].contentRect.width;
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  const otherLines = (stationId: string) => {
    const station = network.stations.find((s) => s.id === stationId);
    if (!station?.lines) return [];
    return station.lines
      .filter((id) => id !== line.id)
      .map((id) => network.lines.find((l) => l.id === id))
      .filter((l) => l !== undefined);
  };

  function focusNetwork(): void {
    app.focusNetwork(network.meta.id);
    const coords = network.stations
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

<div bind:this={rootEl} class="flex flex-col gap-5" in:fly={{ x: -24, duration: 250 }}>
  <!-- Line header -->
  <div class="flex items-start gap-3">
    <span
      class="mt-1 h-9 w-2.5 shrink-0 rounded-full"
      style="background: {line.color ?? '#64748b'}"
    ></span>
    <div class="min-w-0">
      <h2 class="text-lg leading-tight font-bold tracking-tight">
        {localizedName(line.names, line.name, locale)}
      </h2>
      <p class="text-xs text-muted-foreground">
        {localizedName(line.names, line.name, locale === "zh" ? "en" : "zh")}
      </p>
    </div>
  </div>

  <div class="flex flex-wrap gap-1.5">
    <Badge variant="secondary">{modeText(line.mode)}</Badge>
    <Badge
      variant={line.status === "operating" ? "outline" : "destructive"}
      class={line.status === "operating" ? "border-emerald-600/40 text-emerald-700" : ""}
    >
      {#if line.status === "operating"}
        <span class="mr-1 inline-block size-1.5 rounded-full bg-emerald-500"></span>
      {/if}
      {statusText(line.status)}
    </Badge>
    {#if line.loop}
      <Badge variant="secondary" class="gap-1">
        <LoopIcon class="size-3" />
        {t.line_loop()}
      </Badge>
    {/if}
  </div>

  <!-- Belonging network -->
  <div class="rounded-xl border bg-muted/40 p-3.5">
    <div class="flex items-center justify-between gap-2">
      <div class="min-w-0">
        <p class="text-[11px] tracking-wide text-muted-foreground uppercase">
          {t.network_network()}
        </p>
        <p class="truncate text-sm font-semibold">{networkName(network.meta, locale)}</p>
      </div>
      <Button variant="outline" size="sm" class="gap-1.5" onclick={focusNetwork}>
        <CrosshairIcon class="size-3.5" />
        <span class="hidden sm:inline">{t.network_focus()}</span>
      </Button>
    </div>
    <Separator class="my-2.5" />
    <dl class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
      <div class="flex justify-between gap-2">
        <dt class="text-muted-foreground">{t.network_city()}</dt>
        <dd class="font-medium">{network.meta.city.name[locale === "zh" ? "zh" : "en"]}</dd>
      </div>
      <div class="flex justify-between gap-2">
        <dt class="text-muted-foreground">{t.network_timezone()}</dt>
        <dd class="truncate font-medium">{network.meta.timezone}</dd>
      </div>
      <div class="flex justify-between gap-2">
        <dt class="text-muted-foreground">
          {t.network_lines_count({ count: network.lines.length })}
        </dt>
        <dd></dd>
      </div>
      <div class="flex justify-between gap-2">
        <dt class="text-muted-foreground">
          {t.network_stations_count({ count: network.stations.length })}
        </dt>
        <dd></dd>
      </div>
    </dl>
  </div>

  <!-- Topo map -->
  {#if mainPattern}
    <TopoMap
      {line}
      patterns={linePatterns}
      stops={network.stops}
      stations={network.stations}
      selectedPatternId={selectedPattern?.id ?? null}
      onStationClick={(id) => app.selectStation(id)}
    />
  {/if}

  <!-- Stations (per service pattern) -->
  <section class="flex flex-col gap-2">
    <h3 class="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
      {t.line_stations()}
    </h3>
    {#if linePatterns.length > 1 && mainPattern}
      <Tabs.Root bind:value={selectedPatternId}>
        <Tabs.List class="w-full">
          {#each linePatterns as pattern (pattern.id)}
            <Tabs.Trigger value={pattern.id} class="flex-1 gap-1.5 text-xs">
              <Badge
                variant={pattern.is_primary ? "default" : "outline"}
                class="px-1.5 py-0 text-[10px]"
              >
                {pattern.is_primary ? t.line_pattern_primary() : t.line_pattern_branch()}
              </Badge>
              <span class="min-w-0 truncate">
                {localizedName(pattern.names, pattern.name ?? line.name, locale)}
              </span>
            </Tabs.Trigger>
          {/each}
        </Tabs.List>
      </Tabs.Root>
    {/if}
    <p class="text-[11px] text-muted-foreground">
      {#if selectedPattern}
        {@const terminalStop = network.stops.find((s) => s.id === selectedPattern.terminal_stop_id)}
        {@const terminalStation = terminalStop
          ? network.stations.find((s) => s.id === terminalStop.station_id)
          : undefined}
        <Badge
          variant={selectedPattern.is_primary ? "default" : "outline"}
          class="mr-1 px-1.5 py-0 text-[10px]"
        >
          {selectedPattern.is_primary ? t.line_pattern_primary() : t.line_pattern_branch()}
        </Badge>
        {#if terminalStation}
          {t.line_pattern_terminal({
            name: localizedName(terminalStation.names, terminalStation.name, locale),
          })}
          ·
        {/if}
        {t.common_stops({ count: patternStations.length })}
      {/if}
    </p>
    <ol class="relative flex flex-col">
      <span
        class="absolute top-2 bottom-2 left-[6.5px] w-0.75 rounded-full"
        style="background: {line.color ?? '#64748b'}"
      ></span>
      {#each patternStations as stationId, i (stationId)}
        {@const station = network.stations.find((s) => s.id === stationId)}
        {#if station}
          <li>
            <div class="group relative flex w-full items-center gap-2.5 py-1">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                onclick={() => app.selectStation(stationId)}
              >
                <span
                  class="relative z-10 grid size-4 shrink-0 place-items-center rounded-full border-2 bg-background transition-transform group-hover:scale-125"
                  style="border-color: {line.color ?? '#64748b'}"
                >
                  {#if station.is_interchange}
                    <span class="size-1.5 rounded-full" style="background: {line.color}"></span>
                  {/if}
                </span>
                <span class="truncate text-sm group-hover:underline">
                  {localizedName(station.names, station.name, locale)}
                </span>
                {#if station.is_interchange && !wide}
                  <Badge variant="secondary" class="px-1.5 py-0 text-[10px]">
                    {t.station_interchange()}
                  </Badge>
                {/if}
              </button>
              {#if wide}
                <div class="flex shrink-0 items-center gap-1">
                  {#each otherLines(stationId) as otherLine (otherLine.id)}
                    <button
                      type="button"
                      class="inline-flex cursor-pointer items-center gap-1 rounded-full border px-1.5 py-0 text-[10px] leading-4 font-medium transition-colors hover:bg-accent"
                      style="border-color: {otherLine.color ?? '#94a3b8'}66; color: {otherLine.color ?? '#334155'}"
                      onclick={() => app.selectLine(otherLine.id)}
                      title={localizedName(otherLine.names, otherLine.name, locale)}
                    >
                      <span
                        class="size-1.5 rounded-full"
                        style="background: {otherLine.color ?? '#94a3b8'}"
                      ></span>
                      {localizedName(otherLine.names, otherLine.name, locale)}
                    </button>
                  {/each}
                </div>
              {/if}
              <span class="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
                {i + 1}
              </span>
            </div>
          </li>
        {/if}
      {/each}
    </ol>
  </section>
</div>
