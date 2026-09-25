/**
 * Generate the data-quality summary:
 * - `data/quality.svg` — same dashboard next to QUALITY.md (data branch)
 * - `data/QUALITY.md` — full per-network markdown detail
 *
 * Does not touch README.md (no generated markers / timestamps there).
 * Recomputes each `network.json.quality` from on-disk canonical records
 * (including fares.json) before rendering, so the summary cannot drift from
 * the published data.
 *
 *   bun run scripts/write-quality-report.ts
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { computeNetworkQuality } from '../packages/core/src/data/quality.js';

interface LayerQuality {
  precision: string;
  coverage: number;
  status: string;
  counts: Record<string, number>;
}

interface NetworkQuality {
  topology: LayerQuality;
  coordinates: LayerQuality;
  names: LayerQuality;
  segment_times: LayerQuality;
  segment_distances: LayerQuality;
  transfer_times: LayerQuality;
  timetables: LayerQuality;
  schematic: LayerQuality;
  fares?: LayerQuality;
}

interface NetworkDoc {
  id: string;
  name: string;
  names?: { en?: string };
  quality?: NetworkQuality;
}

const LAYERS = [
  ['topology', 'Topology'],
  ['coordinates', 'Coordinates'],
  ['names', 'Names'],
  ['segment_times', 'Segment times'],
  ['segment_distances', 'Segment distances'],
  ['transfer_times', 'Transfer times'],
  ['timetables', 'Timetables'],
  ['schematic', 'Schematic'],
  ['fares', 'Fares']
] as const;

const STATUS = {
  complete: { fill: '#10b981', soft: '#064e3b', label: 'Complete' },
  partial: { fill: '#f59e0b', soft: '#451a03', label: 'Partial' },
  derived: { fill: '#f97316', soft: '#431407', label: 'Derived' },
  unavailable: { fill: '#ef4444', soft: '#450a0a', label: 'Unavailable' }
} as const;

function statusColor(status: string | undefined): string {
  if (status && status in STATUS) return STATUS[status as keyof typeof STATUS].fill;
  return '#64748b';
}

function statusLabel(status: string | undefined): string {
  if (status && status in STATUS) return STATUS[status as keyof typeof STATUS].label;
  return '—';
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadRecords(dir: string, name: string): Promise<unknown[]> {
  try {
    const doc = JSON.parse(await readFile(join(dir, name), 'utf-8')) as { records?: unknown[] };
    return doc.records ?? [];
  } catch {
    return [];
  }
}

/** Recompute `network.json.quality` from on-disk canonical records + fares. */
async function refreshNetworkQuality(dir: string): Promise<void> {
  const netPath = join(dir, 'network.json');
  let net: Record<string, unknown>;
  try {
    net = JSON.parse(await readFile(netPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }
  let fares: unknown;
  try {
    fares = JSON.parse(await readFile(join(dir, 'fares.json'), 'utf-8'));
  } catch {
    fares = undefined;
  }
  const quality = computeNetworkQuality({
    lines: (await loadRecords(dir, 'lines.json')) as { id: string }[],
    stations: (await loadRecords(dir, 'stations.json')) as never,
    stops: (await loadRecords(dir, 'stops.json')) as never,
    segments: (await loadRecords(dir, 'segments.json')) as never,
    transfers: (await loadRecords(dir, 'transfers.json')) as never,
    timetables: (await loadRecords(dir, 'timetables.json')) as never,
    fares: fares as never
  });
  await writeFile(netPath, `${JSON.stringify({ ...net, quality }, null, 2)}\n`, 'utf-8');
}

async function listNetworkIds(root: string): Promise<string[]> {
  const dataDir = join(root, 'data');
  return (await readdir(dataDir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function loadNetworks(root: string): Promise<NetworkDoc[]> {
  const dataDir = join(root, 'data');
  const entries = await listNetworkIds(root);
  const networks: NetworkDoc[] = [];
  for (const id of entries) {
    try {
      networks.push(
        JSON.parse(await readFile(join(dataDir, id, 'network.json'), 'utf-8')) as NetworkDoc
      );
    } catch {
      // skip dirs without network.json
    }
  }
  return networks;
}

/**
 * Self-contained SVG dashboard. No external fonts/CDN — GitHub raw/README
 * rendering stays reliable; system UI stack covers CJK on typical clients.
 *
 * Layout: **fixed three columns**. Network cards wrap into rows so the canvas
 * width stays constant as cities are added; only height grows (ceil(n/3)).
 */
function buildQualitySvg(networks: NetworkDoc[], generatedAt: string): string {
  const pad = 28;
  const gap = 18;
  const COLS = 3;
  const cardW = 340;
  const headerH = 88;
  const rowH = 28;
  const rows = LAYERS.length;
  const cardH = 56 + rows * rowH + 36;
  const gridRows = Math.max(1, Math.ceil(networks.length / COLS));
  const width = pad * 2 + cardW * COLS + gap * (COLS - 1);
  const height = headerH + gridRows * (cardH + gap) - gap + 48;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Open Metro data quality">`
  );
  parts.push(`<rect width="${width}" height="${height}" rx="16" fill="#0b1220"/>`);
  // subtle top accent
  parts.push(`<rect width="${width}" height="4" fill="url(#accent)"/>`);
  parts.push(`
<defs>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#38bdf8"/>
    <stop offset="50%" stop-color="#818cf8"/>
    <stop offset="100%" stop-color="#34d399"/>
  </linearGradient>
  <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#38bdf8"/>
    <stop offset="100%" stop-color="#34d399"/>
  </linearGradient>
</defs>`);

  parts.push(
    `<text x="${pad}" y="36" fill="#e2e8f0" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, Microsoft YaHei, sans-serif" font-size="18" font-weight="600">Open Metro · Data quality</text>`
  );
  parts.push(
    `<text x="${pad}" y="56" fill="#64748b" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, Microsoft YaHei, sans-serif" font-size="12">Per-layer precision &amp; coverage overview · ${escapeXml(generatedAt.slice(0, 10))} · ${networks.length} network(s)</text>`
  );

  // legend chips — compact, right-aligned on the title row
  // let lx = width - pad;
  // const legendItems = ['complete', 'partial', 'derived', 'unavailable'] as const;
  // for (const key of [...legendItems].reverse()) {
  //   const st = STATUS[key];
  //   const label = st.label;
  //   const w = 14 + label.length * 5.8 + 14;
  //   lx -= w;
  //   parts.push(
  //     `<rect x="${lx}" y="24" width="${w}" height="20" rx="10" fill="${st.soft}" stroke="${st.fill}" stroke-opacity="0.35"/>`
  //   );
  //   parts.push(`<circle cx="${lx + 12}" cy="34" r="3.5" fill="${st.fill}"/>`);
  //   parts.push(
  //     `<text x="${lx + 22}" y="38" fill="#cbd5e1" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11">${label}</text>`
  //   );
  //   lx -= 6;
  // }

  networks.forEach((n, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = pad + col * (cardW + gap);
    const y = headerH + row * (cardH + gap);
    parts.push(
      `<rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="14" fill="#111827" stroke="#1f2937"/>`
    );

    const title = n.names?.en ? `${n.name} · ${n.names.en}` : n.name;
    parts.push(
      `<text x="${x + 18}" y="${y + 30}" fill="#f8fafc" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, Microsoft YaHei, sans-serif" font-size="15" font-weight="600">${escapeXml(title)}</text>`
    );
    parts.push(
      `<text x="${x + 18}" y="${y + 48}" fill="#64748b" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11">${escapeXml(n.id)}</text>`
    );

    LAYERS.forEach(([key, label], rowIdx) => {
      const q = n.quality?.[key as keyof NetworkQuality] as LayerQuality | undefined;
      const ry = y + 64 + rowIdx * rowH;
      const color = statusColor(q?.status);
      const pct = q ? Math.round(q.coverage * 100) : 0;
      const barW = 72;
      const barX = x + cardW - 18 - barW;

      parts.push(
        `<text x="${x + 18}" y="${ry + 14}" fill="#94a3b8" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, PingFang SC, Microsoft YaHei, sans-serif" font-size="12">${label}</text>`
      );

      // status: coloured dot + label only (no pill chrome)
      const statusText = statusLabel(q?.status);
      const statusX = x + 150;
      parts.push(`<circle cx="${statusX + 3}" cy="${ry + 11}" r="3" fill="${color}"/>`);
      parts.push(
        `<text x="${statusX + 10}" y="${ry + 14}" fill="#e2e8f0" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10">${statusText}</text>`
      );

      // coverage track
      parts.push(
        `<rect x="${barX}" y="${ry + 6}" width="${barW}" height="10" rx="5" fill="#1f2937"/>`
      );
      if (pct > 0) {
        parts.push(
          `<rect x="${barX}" y="${ry + 6}" width="${(barW * pct) / 100}" height="10" rx="5" fill="${color}"/>`
        );
      }
      parts.push(
        `<text x="${barX + barW}" y="${ry + 4}" text-anchor="end" fill="#64748b" font-family="ui-sans-serif, system-ui, sans-serif" font-size="9">${pct}%</text>`
      );
    });
  });

  parts.push('</svg>');
  return parts.join('\n');
}

function statusEmoji(status: string | undefined): string {
  switch (status) {
    case 'complete':
      return '✅';
    case 'partial':
      return '🟡';
    case 'derived':
      return '🟠';
    case 'unavailable':
      return '❌';
    default:
      return '—';
  }
}

function detailSections(networks: NetworkDoc[]): string[] {
  const lines: string[] = [];
  for (const n of networks) {
    lines.push(`## ${n.name}${n.names?.en ? ` / ${n.names.en}` : ''} (\`${n.id}\`)`);
    lines.push('');
    if (!n.quality) {
      lines.push('_No quality block in `network.json`._');
      lines.push('');
      continue;
    }
    lines.push('| Layer | Status | Precision | Coverage | Counts |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const [key, label] of LAYERS) {
      const q = n.quality[key as keyof NetworkQuality] as LayerQuality | undefined;
      if (!q) {
        lines.push(`| ${label} | — | — | — | — |`);
        continue;
      }
      const counts = Object.entries(q.counts)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      lines.push(
        `| ${label} | ${statusEmoji(q.status)} ${statusLabel(q.status)} | ${q.precision} | ${Math.round(q.coverage * 100)}% | ${counts || '—'} |`
      );
    }
    lines.push('');
  }
  return lines;
}

export async function writeQualityReport(root: string): Promise<string[]> {
  for (const id of await listNetworkIds(root)) {
    await refreshNetworkQuality(join(root, 'data', id));
  }
  const networks = await loadNetworks(root);
  const generatedAt = new Date().toISOString();
  const svgBody = `${buildQualitySvg(networks, generatedAt)}\n`;

  const dataSvgPath = join(root, 'data', 'quality.svg');
  await writeFile(dataSvgPath, svgBody, 'utf-8');

  const full: string[] = [
    '# Data quality',
    '',
    '![Data quality](./quality.svg)',
    '',
    'Generated from each network’s canonical records and fares matrix after data sync. ' +
      'Do not edit by hand — re-run `bun run data:sync` (or `scripts/write-quality-report.ts`).',
    '',
    `_Updated ${generatedAt}_`,
    '',
    ...detailSections(networks),
    '### Legend',
    '',
    '| Status | Meaning |',
    '| --- | --- |',
    '| ✅ complete | Full coverage, official values |',
    '| 🟡 partial | Some entities still use network defaults |',
    '| 🟠 derived | Full coverage but only derived values |',
    '| ❌ unavailable | No source values |',
    ''
  ];

  const qualityPath = join(root, 'data', 'QUALITY.md');
  await writeFile(qualityPath, `${full.join('\n')}\n`, 'utf-8');

  return [dataSvgPath, qualityPath];
}

const isDirect = process.argv[1]?.includes('write-quality-report');
if (isDirect) {
  const root = process.env.OPENMETRO_ROOT || process.cwd();
  writeQualityReport(root)
    .then((paths) => {
      for (const p of paths) console.log(`wrote ${p}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
