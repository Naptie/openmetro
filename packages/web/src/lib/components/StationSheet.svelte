<script lang="ts">
  import CircleArrowDownIcon from '@lucide/svelte/icons/circle-arrow-down';
  import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
  import FlagIcon from '@lucide/svelte/icons/flag';
  import FootprintsIcon from '@lucide/svelte/icons/footprints';
  import MapPinIcon from '@lucide/svelte/icons/map-pin';
  import MoveRightIcon from '@lucide/svelte/icons/move-right';
  import XIcon from '@lucide/svelte/icons/x';
  import type { ApiStationDetail as StationDetail } from 'openmetro-client';
  import { fly } from 'svelte/transition';
  import { client, get } from '$lib/client';
  import { Badge } from '$lib/components/ui/badge/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { Skeleton } from '$lib/components/ui/skeleton/index.js';
  import { formatDuration, localizedName } from '$lib/format';
  import { createSheetSizer } from '$lib/hooks/use-sheet-resize.svelte';
  import { i18n } from '$lib/i18n.svelte';
  import { app } from '$lib/state.svelte';

  const t = $derived(i18n.t);
  const locale = $derived(i18n.locale);
  const sizer = createSheetSizer('station');

  const selection = $derived(app.selectedStation);
  const station = $derived(selection?.station ?? null);
  const network = $derived(selection?.network ?? null);

  let detail = $state<StationDetail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state(false);

  $effect(() => {
    const stationId = station?.id;
    const networkId = network?.meta.id;
    detail = null;
    detailError = false;
    if (!stationId || !networkId) return;
    let cancelled = false;
    detailLoading = true;
    get(client.api.networks({ id: networkId }).stations({ stationId }).get())
      .then((d) => {
        if (!cancelled) detail = d;
      })
      .catch(() => {
        if (!cancelled) detailError = true;
      })
      .finally(() => {
        if (!cancelled) detailLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  const lineBadges = $derived.by(() => {
    if (!station?.lines || !network) return [];
    return station.lines
      .map((lineId) => network.lines.find((l) => l.id === lineId))
      .filter((l) => l !== undefined);
  });

  const lineName = (lineId: string | undefined) => {
    if (!lineId || !network) return null;
    const line = network.lines.find((l) => l.id === lineId);
    return line ? { line, name: localizedName(line.names, line.name, locale) } : null;
  };

  // Transfer edges are directional (walking from one platform to another), so
  // each row is rendered as an explicit "from line → to line" hop.
  const transferRows = $derived.by(() => {
    if (!detail || !network) return [];
    return detail.transfers
      .map((transfer) => ({
        id: transfer.id,
        from: lineName(transfer.from_line_id),
        to: lineName(transfer.to_line_id),
        seconds: transfer.walk_time_seconds ?? 0
      }))
      .sort(
        (a, b) =>
          (a.from?.name ?? '').localeCompare(b.from?.name ?? '') ||
          (a.to?.name ?? '').localeCompare(b.to?.name ?? '') ||
          a.seconds - b.seconds
      );
  });

  const statusByTimetable = $derived(
    detail
      ? new Map(detail.status.map((s) => [s.timetable_id, s]))
      : new Map<string, StationDetail['status'][number]>()
  );

  // Timetable rows grouped per line, destination label derived from stop data.
  // Loop lines have no destination stop: their timetables label the directions
  // via `direction_label` (e.g. "积水潭", or Guangzhou's "龙潭(内环-全程)").
  // The station-name part is localized; common ring qualifiers are translated.
  const timetableRows = $derived.by(() => {
    if (!detail || !network) return [];
    const stopById = new Map(network.stops.map((s) => [s.id, s]));
    const stationById = new Map(network.stations.map((s) => [s.id, s]));
    const lineById = new Map(network.lines.map((l) => [l.id, l]));
    const stationByZhName = new Map(
      network.stations.map((s) => [s.names?.zh ?? s.name, s] as const)
    );

    const localizeDirection = (label: string | undefined) => {
      if (!label) return undefined;
      const parenIdx = label.indexOf('(');
      const main = parenIdx === -1 ? label : label.slice(0, parenIdx);
      const qualifier = parenIdx === -1 ? null : label.slice(parenIdx);
      const station = stationByZhName.get(main);
      const mainLocalized = station ? localizedName(station.names, main, locale) : main;
      const qualifierLocalized =
        qualifier && locale === 'en'
          ? qualifier
              .replace(/内环/g, ' inner ring')
              .replace(/外环/g, ' outer ring')
              .replace(/全程/g, ' full loop')
              .replace(/终点/g, ' terminus')
          : qualifier;
      return { main: mainLocalized, qualifier: qualifierLocalized };
    };

    return detail.timetables
      .map((tt) => {
        const destStop = tt.destination_stop_id ? stopById.get(tt.destination_stop_id) : undefined;
        const destStation = destStop ? stationById.get(destStop.station_id) : undefined;
        const status = statusByTimetable.get(tt.id);
        const line = lineById.get(tt.line_id);
        const destination = destStation
          ? localizedName(destStation.names, destStation.name, locale)
          : undefined;
        return {
          id: tt.id,
          line,
          isLoop: line?.loop ?? false,
          destination,
          direction: localizeDirection(tt.direction_label),
          first: tt.first_train[tt.first_train.length - 1] ?? tt.first_train[0],
          last: tt.last_train[tt.last_train.length - 1] ?? tt.last_train[0],
          inService: status?.is_in_service ?? false
        };
      })
      .filter((row) => row.line)
      .sort((a, b) =>
        (a.line!.id + (a.destination ?? a.direction?.main)).localeCompare(
          b.line!.id + (b.destination ?? b.direction?.main)
        )
      );
  });

  const isOrigin = $derived(station !== null && app.state.originId === station.id);
  const isDestination = $derived(station !== null && app.state.destinationId === station.id);
</script>

<Sheet.Root
  open={station !== null}
  onOpenChange={(open) => {
    if (!open) app.selectStation(null);
  }}
>
  <Sheet.Content
    side={sizer.isDesktop ? "right" : "bottom"}
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
      class="absolute inset-y-0 left-0 z-20 hidden w-1.5 cursor-col-resize touch-none hover:bg-primary/20 sm:block"
      onpointerdown={(e) => sizer.startWidthResize(e, -1)}
      role="separator"
      aria-orientation="vertical"
    ></div>

    <Sheet.Header class="border-b px-4 py-3">
      <div class="flex items-center gap-2">
        <Sheet.Title class="text-base">{t.station_title()}</Sheet.Title>
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
      <Sheet.Description class="sr-only">{t.station_lines()}</Sheet.Description>
    </Sheet.Header>

    <div class="panel-scroll flex-1 overflow-y-auto p-4">
      {#if station && network}
        <div in:fly={{ y: 16, duration: 300 }}>
          <!-- Header -->
          <div class="flex items-start gap-3">
            <span
              class="mt-1.5 grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
            >
              <MapPinIcon class="size-4.5" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-lg leading-tight font-bold tracking-tight">
                {localizedName(station.names, station.name, locale)}
              </h2>
              <p class="text-xs text-muted-foreground">
                {localizedName(station.names, station.name, locale === "zh" ? "en" : "zh")}
              </p>
            </div>
          </div>

          <div class="mt-3 flex flex-wrap gap-1.5">
            {#if station.is_interchange}
              <Badge variant="secondary">{t.station_interchange()}</Badge>
            {/if}
            {#each lineBadges as line (line.id)}
              <button
                type="button"
                class="inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-accent"
                style="border-color: {line.color ?? '#94a3b8'}66; color: {line.color ?? '#334155'}"
                onclick={() => app.selectLine(line.id)}
                title={t.line_metadata()}
              >
                <span
                  class="size-2 rounded-full"
                  style="background: {line.color ?? '#94a3b8'}"
                ></span>
                {localizedName(line.names, line.name, locale)}
              </button>
            {/each}
          </div>

          {#if station.location}
            <p class="mt-2 flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
              <FlagIcon class="size-3" />
              {station.location.lat.toFixed(5)}, {station.location.lon.toFixed(5)}
              <span class="font-sans uppercase">({station.location.crs})</span>
            </p>
          {/if}

          <Separator class="my-4" />

          <!-- OD actions -->
          <div class="grid grid-cols-2 gap-2">
            <Button
              variant={isOrigin ? "default" : "outline"}
              class="gap-1.5 transition-all {isOrigin
                ? 'animate-in fade-in-0 zoom-in-95 bg-route-origin hover:bg-route-origin text-white'
                : ''}"
              onclick={() => app.setOrigin(station.id)}
            >
              <CircleArrowUpIcon class="size-4" />
              {isOrigin ? t.station_is_origin() : t.station_set_origin()}
            </Button>
            <Button
              variant={isDestination ? "default" : "outline"}
              class="gap-1.5 transition-all {isDestination
                ? 'animate-in fade-in-0 zoom-in-95 bg-route-destination hover:bg-route-destination text-white'
                : ''}"
              onclick={() => app.setDestination(station.id)}
            >
              {#if isDestination}
                <FlagIcon class="size-4" />
              {:else}
                <CircleArrowDownIcon class="size-4" />
              {/if}
              {isDestination ? t.station_is_destination() : t.station_set_destination()}
            </Button>
          </div>

          <Separator class="my-4" />

          <!-- Timetables -->
          <h3 class="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t.station_timetable()}
          </h3>
          {#if detailLoading}
            <div class="flex flex-col gap-2">
              {#each Array(3) as _, i (i)}
                <Skeleton class="h-9 w-full rounded-lg" />
              {/each}
            </div>
          {:else if detailError}
            <p class="text-sm text-destructive">{t.station_detail_error()}</p>
          {:else if timetableRows.length === 0}
            <p class="text-sm text-muted-foreground">{t.common_loading()}</p>
          {:else}
            <div class="flex flex-col gap-1.5">
              {#each timetableRows as row (row.id)}
                <div class="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-xs">
                  <span
                    class="size-2.5 shrink-0 rounded-full"
                    style="background: {row.line?.color ?? '#94a3b8'}"
                  ></span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-medium">
                      <button
                        type="button"
                        class="cursor-pointer hover:underline"
                        onclick={() => app.selectLine(row.line!.id)}
                      >
                        {localizedName(row.line!.names, row.line!.name, locale)}
                      </button>
                      {#if row.isLoop && row.direction}
                        <span class="font-normal text-muted-foreground">
                          ·
                          {row.direction.main}{row.direction.qualifier}
                        </span>
                      {:else if row.destination}
                        <span class="font-normal text-muted-foreground">→ {row.destination}</span>
                      {/if}
                    </p>
                  </div>
                  <div class="shrink-0 text-right tabular-nums">
                    <p>
                      <span class="text-muted-foreground">{t.station_first_train()}</span>
                      {row.first}
                    </p>
                    <p>
                      <span class="text-muted-foreground">{t.station_last_train()}</span>
                      {row.last}
                    </p>
                  </div>
                  <span
                    class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium {row.inService
                      ? 'bg-emerald-500/15 text-emerald-700'
                      : 'bg-zinc-500/15 text-zinc-500'}"
                    title={row.inService ? t.station_in_service() : t.station_out_of_service()}
                  >
                    {row.inService ? t.station_in_service() : t.station_out_of_service()}
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          <!-- Transfers -->
          {#if transferRows.length > 0}
            <h3
              class="mt-4 mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase"
            >
              {t.station_transfers()}
            </h3>
            <div class="flex flex-col gap-1.5">
              {#each transferRows as transfer (transfer.id)}
                <div
                  class="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 text-xs"
                >
                  <FootprintsIcon class="size-3.5 shrink-0 text-muted-foreground" />
                  {#if transfer.from}
                    <span class="flex min-w-0 items-center gap-1">
                      <span
                        class="size-2 shrink-0 rounded-full"
                        style="background: {transfer.from.line.color ?? '#94a3b8'}"
                      ></span>
                      <button
                        type="button"
                        class="cursor-pointer truncate hover:underline"
                        onclick={() => app.selectLine(transfer.from!.line.id)}
                      >
                        {transfer.from.name}
                      </button>
                    </span>
                    <MoveRightIcon class="size-3.5 shrink-0 text-muted-foreground" />
                  {/if}
                  {#if transfer.to}
                    <span class="flex min-w-0 items-center gap-1">
                      <span
                        class="size-2 shrink-0 rounded-full"
                        style="background: {transfer.to.line.color ?? '#94a3b8'}"
                      ></span>
                      <button
                        type="button"
                        class="cursor-pointer truncate hover:underline"
                        onclick={() => app.selectLine(transfer.to!.line.id)}
                      >
                        {transfer.to.name}
                      </button>
                    </span>
                  {/if}
                  <span class="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {formatDuration(transfer.seconds, locale)}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
