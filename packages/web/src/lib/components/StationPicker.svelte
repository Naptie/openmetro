<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check';
  import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
  import MapPinIcon from '@lucide/svelte/icons/map-pin';
  import type { ApiStation as Station } from 'openmetro-client';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Command from '$lib/components/ui/command/index.js';
  import * as Popover from '$lib/components/ui/popover/index.js';
  import { isRoutableStation, localizedName } from '$lib/format';
  import { i18n } from '$lib/i18n.svelte';
  import type { NetworkData } from '$lib/state.svelte';
  import { cn } from '$lib/utils';

  let {
    value,
    network,
    onSelect,
    placeholder
  }: {
    value: string | null;
    /** Stations are offered from this network only. */
    network: NetworkData | null;
    onSelect: (stationId: string | null) => void;
    placeholder: string;
  } = $props();

  let open = $state(false);
  let search = $state('');

  const t = $derived(i18n.t);
  const locale = $derived(i18n.locale);
  const selected = $derived(network?.stations.find((s) => s.id === value) ?? null);
  const selectedColor = $derived.by(() => {
    const firstLineId = selected?.lines?.[0];
    if (!firstLineId) return '#94a3b8';
    return network?.lines.find((l) => l.id === firstLineId)?.color ?? '#94a3b8';
  });

  const stationLines = (station: Station) => {
    if (!network) return [];
    return (station.lines ?? [])
      .map((lineId) => network.lines.find((l) => l.id === lineId))
      .filter((l) => l !== undefined);
  };

  const matches = $derived.by(() => {
    if (!network) return [];
    const q = search.trim().toLowerCase();
    const out: Station[] = [];
    for (const station of network.stations) {
      if (!isRoutableStation(station.status)) continue;
      const zh = station.names?.zh ?? station.name;
      const en = station.names?.en ?? '';
      if (
        !q ||
        zh.toLowerCase().includes(q) ||
        en.toLowerCase().includes(q) ||
        station.id.includes(q)
      ) {
        out.push(station);
      }
    }
    return out.slice(0, 80);
  });
</script>

<Popover.Root bind:open>
  <Popover.Trigger>
    {#snippet child({ props })}
      <Button
        variant="outline"
        {...props}
        role="combobox"
        aria-expanded={open}
        class="w-full justify-between font-normal"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          {#if selected}
            <span class="size-2 shrink-0 rounded-full" style="background: {selectedColor}"></span>
            <span class="truncate">
              {localizedName(selected.names, selected.name, locale)}
            </span>
          {:else}
            <span class="text-muted-foreground">{placeholder}</span>
          {/if}
        </span>
        <ChevronsUpDownIcon class="size-4 shrink-0 opacity-50" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-(--bits-popover-anchor-width) p-0" align="start">
    <Command.Root>
      <Command.Input placeholder={t.search_placeholder()} bind:value={search} class="h-9" />
      <Command.List>
        <Command.Empty>{t.search_no_results()}</Command.Empty>
        {#each matches as station (station.id)}
          <Command.Item
            value={station.id}
            keywords={[station.names?.zh ?? station.name, station.names?.en ?? "", station.id]}
            onSelect={() => {
              onSelect(station.id);
              open = false;
            }}
            class="gap-2"
          >
            <MapPinIcon class="size-3.5 shrink-0 opacity-60" />
            <span class="min-w-0 truncate"
              >{localizedName(station.names, station.name, locale)}</span
            >
            <span class="ml-auto flex shrink-0 items-center gap-1">
              {#each stationLines(station).slice(0, 4) as line (line.id)}
                <span
                  class="rounded-full border px-1.5 py-0 text-[10px] leading-4 font-medium"
                  style="border-color: {line.color ?? '#94a3b8'}66; color: {line.color ?? '#334155'}"
                >
                  {localizedName(line.names, line.name, locale)}
                </span>
              {/each}
            </span>
            <CheckIcon class={cn("hidden", station.id === value && "block")} />
          </Command.Item>
        {/each}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
