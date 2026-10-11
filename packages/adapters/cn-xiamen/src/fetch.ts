/**
 * Official-source fetch for cn-xiamen.
 *
 * Two structured sources, no scraping:
 * - Xiamen Metro official CMS (`www.xmgdjt.com.cn/api/transit/*`, the REST
 *   backend of the operator website): line metadata, per-line ordered
 *   stations with the operator's own station ids, per-station first/last
 *   trains (lines 1–3) and the OD fare inquiry (numeric-id stations only).
 * - The public AMap subway dataset (GCJ-02 native): topology base — station
 *   names/order, coordinates and schematic pixels. The CMS station list has
 *   no geographic coordinates, so AMap carries every location.
 *
 * The CMS also lists three BRT lines (`lineType: 2`, 集美线/同安线/前埔线);
 * they are a bus rapid-transit mode and are deliberately not fetched.
 */
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';
import { XIAMEN_LINES } from './lines.js';

const XM_CMS = 'https://www.xmgdjt.com.cn';
const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3502_drw_xiamen.json';
const AMAP_REFERER = 'https://www.xmgdjt.com.cn/';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string, referer: string, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(proxyUrl(url), {
        headers: officialFetchHeaders({ Referer: referer }),
        signal: AbortSignal.timeout(60_000)
      });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      const delay = 500 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** CMS envelope: most list endpoints differ only in which field carries the rows. */
interface CmsEnvelope<T> {
  state?: string;
  success?: boolean;
  error?: string | null;
  info?: string | null;
  list?: T[] | null;
  data?: { total?: number; list?: T[] | null } | null;
}

function cmsRows<T>(env: CmsEnvelope<T>, what: string): T[] {
  if (env.success === false) throw new Error(`CMS ${what} failed: ${env.error ?? env.info}`);
  const rows = env.data?.list ?? env.list;
  if (!Array.isArray(rows)) throw new Error(`CMS ${what}: no list in response`);
  return rows;
}

export interface CmsLine {
  id: string;
  lineName: string;
  lineCode: string;
  /** 1 = metro, 2 = BRT. */
  lineType: number;
  status: number;
  lineColor?: string | null;
  description?: string | null;
  firstTime?: string | null;
  lastTime?: string | null;
}

export interface CmsLineStation {
  lineId: string;
  /** Operator station id — numeric for lines 1–3, UUID for most 4/6 stations. */
  stationId: string;
  stationOrder: number;
  stationName: string;
  isTerminal: number;
  isTransfer: number;
  transferInfo?: string | null;
  mapX: number;
  mapY: number;
}

export interface CmsTimetableRow {
  lineId: string;
  lineName: string;
  stationId: string;
  stationName: string;
  direction: number;
  /** `HH:MM:SS`. */
  firstTime: string;
  lastTime: string;
  status: number;
  destinationStationId?: string | null;
  /** Rows without a destination are duplicated line-level records — skip them. */
  destinationStationName?: string | null;
}

export interface AmapStation {
  n?: string;
  en?: string;
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  sid?: string;
  multilang?: { n?: Record<string, string> };
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  /** Line colour hex (no `#`). */
  cl?: string;
  li?: string;
  st?: AmapStation[];
  multilang?: { ln?: Record<string, string> };
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

export interface XiamenSources {
  amapSubway: AmapSubwayDoc;
  cmsLines: Map<string, CmsLine>;
  /** CMS line id → stations in the operator's order. */
  cmsLineStations: Map<string, CmsLineStation[]>;
  /** CMS station id → first/last rows (lines 1–3 only; other lines have none). */
  cmsTimetables: Map<string, CmsTimetableRow[]>;
}

export async function fetchXiamenSources(): Promise<XiamenSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch AMap subway 3502_drw_xiamen.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
  const lineCount = amapSubway.l?.length ?? 0;
  if (lineCount < 5) {
    throw new Error(`AMap subway doc for Xiamen has ${lineCount} lines, expected >= 5`);
  }
  console.log(
    `    ${lineCount} lines, ${amapSubway.l?.reduce((n, l) => n + (l.st?.length ?? 0), 0)} station entries`
  );

  console.log('  fetch official CMS lines');
  const linesEnv = await getJson<CmsEnvelope<CmsLine>>(
    `${XM_CMS}/api/transit/lines?pageNum=1&pageSize=50`,
    `${XM_CMS}/`
  );
  const cmsLines = new Map(
    cmsRows(linesEnv, 'lines')
      .filter((l) => l.lineType === 1 && l.status === 1)
      .map((l) => [l.id, l] as const)
  );
  for (const cfg of XIAMEN_LINES) {
    const line = cmsLines.get(cfg.cmsLineId);
    if (!line) throw new Error(`CMS is missing operating line ${cfg.cmsLineId} (${cfg.name})`);
    console.log(
      `    ${line.lineName}: color=${line.lineColor} span=${line.firstTime}-${line.lastTime}`
    );
  }

  const cmsLineStations = new Map<string, CmsLineStation[]>();
  const cmsTimetables = new Map<string, CmsTimetableRow[]>();
  const stationIds = new Set<string>();
  for (const cfg of XIAMEN_LINES) {
    const env = await getJson<CmsEnvelope<CmsLineStation>>(
      `${XM_CMS}/api/transit/line-station/line/${cfg.cmsLineId}`,
      `${XM_CMS}/`
    );
    const stations = cmsRows(env, `line-station ${cfg.cmsLineId}`);
    cmsLineStations.set(cfg.cmsLineId, stations);
    for (const s of stations) stationIds.add(s.stationId);
    console.log(`    ${cfg.name}: ${stations.length} CMS stations`);
    await sleep(150);
  }

  console.log(`  fetch CMS first/last trains for ${stationIds.size} stations`);
  let withRows = 0;
  let i = 0;
  for (const stationId of [...stationIds].sort()) {
    const env = await getJson<CmsEnvelope<CmsTimetableRow>>(
      `${XM_CMS}/api/transit/timetable/list?stationId=${encodeURIComponent(stationId)}`,
      `${XM_CMS}/`
    );
    const rows = cmsRows(env, `timetable ${stationId}`);
    if (rows.length > 0) withRows++;
    cmsTimetables.set(stationId, rows);
    if (++i % 20 === 0) console.log(`    ${i}/${stationIds.size}`);
    await sleep(120);
  }
  console.log(`    ${withRows}/${stationIds.size} stations carry CMS timetable rows`);

  return { amapSubway, cmsLines, cmsLineStations, cmsTimetables };
}
