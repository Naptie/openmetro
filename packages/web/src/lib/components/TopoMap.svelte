<script lang="ts">
  import type {
    ApiLine as Line,
    ApiPattern as Pattern,
    ApiStation as Station,
    ApiStop as Stop
  } from 'openmetro-client';
  import { localizedName } from '$lib/format';
  import { i18n } from '$lib/i18n.svelte';

  let {
    line,
    patterns,
    stops,
    stations,
    selectedPatternId = null,
    onStationClick
  }: {
    line: Line;
    patterns: Pattern[];
    stops: Stop[];
    stations: Station[];
    /** Emphasize this pattern and dim the others (null = show all equally). */
    selectedPatternId?: string | null;
    onStationClick?: (stationId: string) => void;
  } = $props();

  const dim = (patternId: string | null | undefined) =>
    selectedPatternId && patternId && patternId !== selectedPatternId ? 0.3 : 1;

  const SPACING = 72;
  const BRANCH_H = 88;
  const DIAG = 56;
  const PAD = 56;
  const LABEL_GAP = 21;

  interface TopoNode {
    stationId: string;
    x: number;
    y: number;
    interchange: boolean;
    terminal: boolean;
    junction: boolean;
    labelBelow: boolean;
    delay: number;
    patternId: string;
  }

  interface TopoBranch {
    path: string;
    length: number;
    endX: number;
    pattern: Pattern;
  }

  const color = $derived(line.color ?? '#475569');
  const locale = $derived(i18n.locale);

  const stopToStation = $derived(new Map(stops.map((s) => [s.id, s.station_id])));
  const stationById = $derived(new Map(stations.map((s) => [s.id, s])));

  const layout = $derived.by(() => {
    if (patterns.length === 0) return null;

    const mainPattern =
      patterns.find((p) => p.is_primary) ??
      [...patterns].sort((a, b) => b.stop_ids.length - a.stop_ids.length)[0];

    const seq = (pattern: Pattern): string[] => {
      const out: string[] = [];
      for (const stopId of pattern.stop_ids) {
        const st = stopToStation.get(stopId);
        if (st && st !== out[out.length - 1]) out.push(st);
      }
      return out;
    };

    const mainSeq = seq(mainPattern);
    const isLoop = line.loop && mainSeq.length > 2 && mainSeq[0] === mainSeq[mainSeq.length - 1];
    if (isLoop) mainSeq.pop();

    const mainX = new Map<string, number>();
    mainSeq.forEach((stationId, i) => {
      mainX.set(stationId, PAD + i * SPACING);
    });

    const nodes: TopoNode[] = mainSeq.map((stationId, i) => ({
      stationId,
      x: PAD + i * SPACING,
      y: 0,
      interchange: stationById.get(stationId)?.is_interchange ?? false,
      terminal: i === 0 || i === mainSeq.length - 1,
      junction: false,
      labelBelow: true,
      delay: i * 22,
      patternId: mainPattern.id
    }));

    const branches: TopoBranch[] = [];
    const others = patterns.filter((p) => p.id !== mainPattern.id);

    for (const [branchIdx, pattern] of others.entries()) {
      const branchSeq = seq(pattern);
      const mainSet = new Set(mainSeq);

      // Junction: explicit junction stop, else the last station shared with the
      // main sequence (its position on the trunk is where the branch leaves).
      let junctionStation: string | null = pattern.junction_stop_id
        ? (stopToStation.get(pattern.junction_stop_id) ?? null)
        : null;
      if (!junctionStation || !mainSet.has(junctionStation)) {
        junctionStation = null;
        for (const st of branchSeq) {
          if (mainSet.has(st)) junctionStation = st;
        }
      }

      const branchOnly = branchSeq.filter((st) => !mainSet.has(st));
      const xj = junctionStation ? (mainX.get(junctionStation) ?? PAD) : PAD;
      // Alternate branches up / down so two branches never overlap.
      const side = branchIdx % 2 === 0 ? -1 : 1;
      const y = side * BRANCH_H;

      // Extend the branch towards the side its stations actually lie on:
      // if the unique stops precede the junction in the branch sequence,
      // they branch off to the left of the trunk.
      const junctionIdx = junctionStation ? branchSeq.indexOf(junctionStation) : -1;
      const goLeft = branchOnly.length > 0 && junctionIdx > 0 && branchSeq[0] !== junctionStation;
      const dir = goLeft ? -1 : 1;
      const kneeX = xj + DIAG * dir;
      const endX = kneeX + Math.max(branchOnly.length, 0.35) * SPACING * dir;
      const path = `M ${xj} 0 L ${kneeX} ${y} L ${endX} ${y}`;
      branches.push({
        path,
        length: DIAG * Math.SQRT2 + Math.max(branchOnly.length, 0.35) * SPACING,
        endX,
        pattern
      });

      branchOnly.forEach((stationId, i) => {
        nodes.push({
          stationId,
          x: kneeX + (i + 1) * SPACING * dir,
          y,
          interchange: stationById.get(stationId)?.is_interchange ?? false,
          terminal: goLeft ? i === 0 : i === branchOnly.length - 1,
          junction: false,
          labelBelow: side > 0,
          delay: mainSeq.length * 22 + branchIdx * 160 + i * 22,
          patternId: pattern.id
        });
      });

      if (junctionStation && !nodes.some((n) => n.stationId === junctionStation && n.junction)) {
        const jn = nodes.find((n) => n.stationId === junctionStation);
        if (jn) jn.junction = true;
      }
    }

    const maxX = Math.max(PAD + (mainSeq.length - 1) * SPACING, ...branches.map((b) => b.endX));
    const minX = Math.min(PAD, ...branches.map((b) => b.endX));

    return {
      nodes,
      branches,
      isLoop,
      mainPatternId: mainPattern.id,
      mainPath: `M ${PAD} 0 L ${PAD + Math.max(mainSeq.length - 1, 0.35) * SPACING} 0`,
      mainLength: Math.max(mainSeq.length - 1, 0.35) * SPACING,
      width: maxX + PAD - Math.min(0, minX - PAD),
      shift: -Math.min(0, minX - PAD),
      height: (BRANCH_H + LABEL_GAP + 14) * 2,
      midY: BRANCH_H + LABEL_GAP + 14
    };
  });

  const stationName = (stationId: string) => {
    const st = stationById.get(stationId);
    return st ? localizedName(st.names, st.name, locale) : stationId;
  };
</script>

{#if layout}
  {#key line.id}
    <div class="topo-wrap w-full overflow-x-auto pb-1">
      <svg
        width={layout.width}
        height={layout.height}
        viewBox="0 0 {layout.width} {layout.height}"
        class="mx-auto block max-w-none"
        role="img"
        aria-label={localizedName(line.names, line.name, locale)}
      >
        <g transform="translate({layout.shift} {layout.midY})">
          <!-- loop closing arc -->
          {#if layout.isLoop}
            <path
              d="M {PAD} 0 C {PAD} -46 {layout.width - PAD} -46 {layout.width - PAD} 0"
              fill="none"
              stroke={color}
              stroke-width="2"
              stroke-dasharray="1 7"
              stroke-linecap="round"
              class="topo-line"
              style="--topo-length: {layout.mainLength + 120};"
            />
          {/if}

          <!-- trunk -->
          <path
            d={layout.mainPath}
            fill="none"
            stroke={color}
            stroke-width="5"
            stroke-linecap="round"
            class="topo-line"
            style="--topo-length: {layout.mainLength + 40}; opacity: {dim(layout.mainPatternId)}; transition: opacity 0.3s;"
          />

          <!-- branches -->
          {#each layout.branches as branch (branch.pattern.id)}
            <path
              d={branch.path}
              fill="none"
              stroke={color}
              stroke-width="5"
              stroke-linecap="round"
              class="topo-line"
              style="--topo-length: {branch.length + 40}; animation-delay: {layout.nodes.filter((n) => n.y === 0).length * 22}ms; opacity: {dim(branch.pattern.id)}; transition: opacity 0.3s;"
            />
          {/each}

          <!-- nodes -->
          {#each layout.nodes as node, i (node.stationId + "-" + node.x)}
            <g
              class="topo-node cursor-pointer"
              style="animation-delay: {node.delay}ms; opacity: {node.junction
              ? 1
              : dim(node.patternId)}; transition: opacity 0.3s;"
              role="button"
              tabindex="0"
              onclick={() => onStationClick?.(node.stationId)}
              onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") onStationClick?.(node.stationId);
            }}
            >
              <title>{stationName(node.stationId)}</title>
              {#if node.terminal}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="6.5"
                  fill={color}
                  stroke={color}
                  stroke-width="2"
                />
                <circle cx={node.x} cy={node.y} r="2.2" fill="#fff" />
              {:else if node.interchange}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="6.5"
                  fill="#fff"
                  stroke={color}
                  stroke-width="3.5"
                />
              {:else if node.junction}
                <circle cx={node.x} cy={node.y} r="6" fill="#fff" stroke={color} stroke-width="3" />
                <circle cx={node.x} cy={node.y} r="2" fill={color} />
              {:else}
                <circle
                  cx={node.x}
                  cy={node.y}
                  r="4.5"
                  fill="#fff"
                  stroke={color}
                  stroke-width="2.5"
                />
              {/if}
            </g>
            <text
              class="topo-label select-none {node.terminal || node.junction || node.interchange
              ? 'font-semibold'
              : ''}"
              x={node.x}
              y={node.labelBelow ? node.y + LABEL_GAP : node.y - LABEL_GAP + 4}
              text-anchor="middle"
              font-size="10.5"
              fill={node.terminal || node.junction || node.interchange
              ? "currentColor"
              : "var(--muted-foreground)"}
              style="animation-delay: {node.delay + 120}ms; opacity: {node.junction
              ? 1
              : dim(node.patternId)}; transition: opacity 0.3s;"
              paint-order="stroke"
              stroke="var(--background)"
              stroke-width="3"
            >
              {stationName(node.stationId)}
            </text>
          {/each}
        </g>
      </svg>
    </div>
  {/key}
{/if}

<style>
  .topo-wrap :global(svg) {
    color: var(--foreground);
  }
</style>
