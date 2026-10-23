/**
 * Official-source fetch for cn-qingdao.
 *
 * Three structured sources, no scraping and no OCR:
 * - The public AMap subway dataset (GCJ-02 native): station names/order,
 *   coordinates, schematic pixels, romanisations and line colours.
 * - The operator website's query backend (`www.qd-metro.com/data/execute.php`,
 *   the same endpoint the homepage fare/station widgets POST to):
 *   `act=siteSearch` returns each line's ordered stations with the operator's
 *   own station ids and interchange flags; `act=pjSearch` quotes the fare for
 *   one OD pair by exact display name.
 * - The published OD fare matrix (`青岛地铁票价信息表.xlsx`, linked from the
 *   official 信息公开 page) — the full 195×195 network matrix in one file.
 *   Downloaded fresh on every run and parsed in memory; a machine-local copy
 *   under the OS temp dir is kept only as an offline fallback, so nothing
 *   about this file is ever part of the repository.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { adapterOsCacheDir, officialFetchHeaders, proxyUrl } from '@openmetro/core';

const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/3702_drw_qingdao.json';
const AMAP_REFERER = 'https://www.qd-metro.com/';

const QD_SITE = 'https://www.qd-metro.com';
/** `informationInfo.php?id=636` links this workbook as the official fare table. */
export const FARE_XLSX_URL = `${QD_SITE}/uploadfile/file/20241217/1734432687501297.xlsx`;
const FARE_XLSX_CACHE = 'official-fare-table.xlsx';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curlBuffer(url: string, referer: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '-sS',
      '-L',
      '--max-time',
      '120',
      '-A',
      officialFetchHeaders()['User-Agent'] as string,
      '-H',
      'Accept: */*',
      '-H',
      'Accept-Encoding: identity',
      '-H',
      `Referer: ${referer}`,
      url
    ];
    const child = spawn('curl', args, { windowsHide: true });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => errChunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(chunks));
      else
        reject(
          new Error(`curl exited ${code}: ${Buffer.concat(errChunks).toString('utf-8').trim()}`)
        );
    });
  });
}

async function fetchBuffer(targetUrl: string, referer: string): Promise<Buffer> {
  const url = proxyUrl(targetUrl);
  try {
    return await curlBuffer(url, referer);
  } catch (curlErr) {
    const res = await fetch(url, {
      headers: { ...officialFetchHeaders(), Referer: referer },
      signal: AbortSignal.timeout(90_000)
    }).catch((fetchErr) => {
      throw new Error(`curl failed (${curlErr}); fetch failed (${fetchErr})`);
    });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} (after curl failure: ${curlErr})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

async function getText(url: string, referer: string, retries = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return (await fetchBuffer(url, referer)).toString('utf-8');
    } catch (err) {
      lastErr = err;
      const delay = 500 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function getJson<T>(url: string, referer: string, retries = 3): Promise<T> {
  return JSON.parse(await getText(url, referer, retries)) as T;
}

// ---------------------------------------------------------------------------
// AMap subway dataset
// ---------------------------------------------------------------------------

export interface AmapStation {
  n?: string;
  en?: string;
  sp?: string;
  /** `lon,lat` in GCJ-02. */
  sl?: string;
  /** Schematic pixel pair `x y`. */
  p?: string;
  poiid?: string;
  si?: string;
  sid?: string;
  t?: string | number;
  r?: string;
  multilang?: { n?: Record<string, string> };
}

export interface AmapLine {
  ln?: string;
  kn?: string;
  /** Line colour hex (no `#`). */
  cl?: string;
  /** `1` when the line is a loop. */
  lo?: string | number;
  li?: string;
  st?: AmapStation[];
  multilang?: { ln?: Record<string, string> };
}

export interface AmapSubwayDoc {
  s?: string;
  i?: string;
  l?: AmapLine[];
}

// ---------------------------------------------------------------------------
// Official website query backend (qd-metro.com/data/execute.php)
// ---------------------------------------------------------------------------

/** One `siteSearch` row: operator per-line station, in site order. */
export interface SiteStation {
  /** Operator id, unique across the whole site station DB. */
  id: string;
  title: string;
  /** `1` marks an interchange station. */
  state?: string | null;
  /** Station name without qualifiers. */
  value: string;
  /** Qualifier suffix, e.g. `(轮渡)` — the fare planner needs value+text. */
  text?: string;
}

export interface SiteSearchResult {
  /** site line parameter → stations in the operator's order. */
  byLine: Map<number, SiteStation[]>;
}

export async function fetchSiteStations(siteLines: readonly number[]): Promise<SiteSearchResult> {
  const byLine = new Map<number, SiteStation[]>();
  for (const line of siteLines) {
    const rows = await postForm<SiteStation[]>(
      { act: 'siteSearch', line: String(line) },
      `${QD_SITE}/operate.php`
    );
    if (!Array.isArray(rows)) {
      throw new Error(`siteSearch line ${line}: non-array response`);
    }
    byLine.set(line, rows);
    console.log(`    siteSearch line ${line}: ${rows.length} stations`);
    await sleep(150);
  }
  return { byLine };
}

/** Quote the official fare for one OD pair (`act=pjSearch`). */
export async function fetchSiteFare(from: string, to: string): Promise<number | null> {
  const body = await postForm<string>({ act: 'pjSearch', sfz: from, zdz: to }, `${QD_SITE}/`);
  // `"3|票价"` — leading integer is the fare in yuan, `0` means "no quote".
  const m = /^(\d+)\|/.exec(String(body));
  if (!m) return null;
  const fare = Number(m[1]);
  return Number.isFinite(fare) && fare > 0 ? fare : null;
}

async function postForm<T>(form: Record<string, string>, referer: string): Promise<T> {
  const res = await fetch(proxyUrl(`${QD_SITE}/data/execute.php`), {
    method: 'POST',
    headers: {
      ...officialFetchHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: QD_SITE,
      Referer: referer
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(60_000)
  });
  if (!res.ok) throw new Error(`POST execute.php ${form.act} -> ${res.status}`);
  const text = await res.text();
  if (!text) throw new Error(`POST execute.php ${form.act}: empty response`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Official fare workbook (xlsx) — minimal reader, no third-party dependency
// ---------------------------------------------------------------------------

/** Column letters → 0-based index (`A`=0, `AA`=26 …). */
export function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return n - 1;
}

/** 0-based column index → spreadsheet letters (`A`, `B`, … `GO`). */
export function colLetters(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Read one entry out of a stored/deflated zip buffer (the xlsx subset). */
export function zipEntry(buf: Buffer, name: string): Buffer | null {
  let off = 0;
  while (off < buf.length - 30) {
    if (buf.readUInt32LE(off) !== 0x04034b50) {
      off++;
      continue;
    }
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const entryName = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    if (entryName === name) {
      const comp = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return comp;
      if (method === 8) return inflateRawSync(comp);
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }
    off = dataStart + compSize;
  }
  return null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface SheetCell {
  v: string;
}

/**
 * Parse a worksheet into a sparse cell grid keyed by `A1`-style refs.
 * Handles shared strings and inline strings — enough for the operator's
 * published fare workbook.
 */
export function parseSheet(xml: string, shared: string[]): Map<string, SheetCell> {
  const cells = new Map<string, SheetCell>();
  for (const m of xml.matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g)) {
    const attrs = m[1] ?? m[2] ?? '';
    const inner = m[3] ?? '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /\bt="([a-z]+)"/.exec(attrs)?.[1];
    let value = '';
    if (type === 's') {
      const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
      value = shared[idx] ?? '';
    } else if (type === 'inlineStr') {
      value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('');
    } else {
      value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
    }
    value = decodeXmlEntities(value).trim();
    if (value) cells.set(ref, { v: value });
  }
  return cells;
}

export function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXmlEntities([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''))
  );
}

export interface FareWorkbookRow {
  /** Line block label (`1号线` … `西海岸快线`). */
  line: string;
  /** Col-B station display name (`四川路(轮渡)` form). */
  station: string;
  /** Fare cells aligned to the shared header index (null when absent). */
  fares: (number | null)[];
}

export interface FareWorkbook {
  /** Display names in sheet column order (195 columns). */
  header: string[];
  rows: FareWorkbookRow[];
}

/**
 * Parse the official fare workbook: one sheet — a title row, a shared
 * 195-column header row of station display names, then per-line blocks of
 * station rows (col A = line name, col B = station name, col C.. = fares).
 */
export function parseFareWorkbook(buf: Buffer): FareWorkbook {
  const sheetXml = zipEntry(buf, 'xl/worksheets/sheet1.xml')?.toString('utf-8');
  const sharedXml = zipEntry(buf, 'xl/sharedStrings.xml')?.toString('utf-8');
  if (!sheetXml || !sharedXml) {
    throw new Error('fare workbook: missing sheet1.xml or sharedStrings.xml');
  }
  const shared = parseSharedStrings(sharedXml);
  const cells = parseSheet(sheetXml, shared);

  const maxCol = [...cells.keys()].reduce((n, ref) => Math.max(n, colIndex(ref) + 1), 0);
  const rowKeys = [
    ...new Set([...cells.keys()].map((ref) => Number(ref.replace(/\D+/g, ''))))
  ].sort((a, b) => a - b);
  const get = (row: number, col: number): string | undefined =>
    cells.get(`${colLetters(col)}${row}`)?.v;

  const LINES = ['1号线', '2号线', '3号线', '4号线', '6号线', '8号线', '蓝谷快线', '西海岸快线'];
  let header: string[] = [];
  const rows: FareWorkbookRow[] = [];
  let currentLine: string | null = null;

  for (const row of rowKeys) {
    const a = get(row, 0);
    const b = get(row, 1);
    const c = get(row, 2);
    // Only a labelled line cell (col A) switches the current block; the
    // label repeats on the block's first row only.
    if (a && LINES.includes(a)) currentLine = a;
    if (b && c != null && rowCellsCount(cells, row) > 50) {
      // Matrix station row: fares live in columns C.. aligned with the header.
      const fares: (number | null)[] = [];
      for (let col = 2; col < maxCol; col++) {
        const raw = get(row, col);
        const num = raw == null || raw === '' ? null : Number(raw);
        fares.push(num != null && Number.isFinite(num) ? num : null);
      }
      if (!currentLine) throw new Error(`fare workbook: station row ${row} before any line block`);
      rows.push({ line: currentLine, station: b, fares });
      continue;
    }
    // Header row: no col A/B, 100+ populated name cells from col C.
    if (!a && !b && c && rowCellsCount(cells, row) > 100) {
      header = [];
      for (let col = 2; col < maxCol; col++) header.push(get(row, col) ?? '');
      while (header.length && !header[header.length - 1]) header.pop();
    }
  }

  if (header.length < 150) {
    throw new Error(`fare workbook: header has ${header.length} columns, expected >= 150`);
  }
  if (rows.length < 150) {
    throw new Error(`fare workbook: ${rows.length} station rows, expected >= 150`);
  }
  for (const r of rows) {
    if (r.fares.length !== header.length) {
      throw new Error(
        `fare workbook row ${r.line}/${r.station}: ${r.fares.length} cells vs ${header.length} header columns`
      );
    }
  }
  return { header, rows };
}

function rowCellsCount(cells: Map<string, SheetCell>, row: number): number {
  let n = 0;
  for (const ref of cells.keys()) {
    if (Number(ref.replace(/\D+/g, '')) === row) n++;
  }
  return n;
}

/**
 * Download the operator's published fare workbook into memory.
 *
 * Pure acquisition: the bytes never touch the repository. The sync pipeline
 * and the test both call this, so the workbook is fetched fresh on every run
 * — the same treatment every other official JSON payload gets. Nothing about
 * this file is ever committed.
 *
 * The zip magic check matters: a reverse proxy that cannot reach the
 * operator often answers 200 with an HTML error page, and that must be
 * reported as an unreachable source rather than as a broken workbook.
 */
export async function downloadFareWorkbookBytes(): Promise<Buffer> {
  const buf = await fetchBuffer(FARE_XLSX_URL, `${QD_SITE}/`);
  if (buf.length < 4 || buf.subarray(0, 4).toString('hex') !== '504b0304') {
    const preview = buf.subarray(0, 80).toString('utf-8').replace(/\s+/g, ' ').trim();
    throw new Error(
      `fare workbook: expected a zip archive, got ${buf.length} bytes` +
        (preview ? ` ("${preview}")` : '') +
        ' — the proxy may have answered with an error page'
    );
  }
  return buf;
}

/**
 * Download and parse the official fare workbook.
 *
 * The bytes are fetched fresh on every sync (one 141 KB request) and parsed
 * in memory. A machine-local copy under the OS temp dir is kept purely as an
 * offline fallback: when the operator site is unreachable, the previous copy
 * lets the sync finish, and `matrixFromWorkbook` still fails loudly if that
 * copy is stale relative to the freshly synced topology.
 */
export async function fetchFareWorkbook(): Promise<FareWorkbook> {
  const cacheDir = adapterOsCacheDir('cn-qingdao');
  const cachePath = join(cacheDir, FARE_XLSX_CACHE);
  let fromLocalCopy = false;
  const buf = await downloadFareWorkbookBytes().catch(async (err: unknown) => {
    fromLocalCopy = true;
    console.log(`  fare workbook download failed (${err}) — falling back to the local copy`);
    try {
      return await readFile(cachePath);
    } catch {
      throw new Error(`fare workbook unavailable (${err}) and no local copy at ${cachePath}`);
    }
  });
  // Caching is an optimisation, never a requirement: failing to persist the
  // copy must not fail the sync.
  await mkdir(cacheDir, { recursive: true })
    .then(() => writeFile(cachePath, buf))
    .catch((err: unknown) => console.log(`  fare workbook cache write failed (${err})`));
  console.log(fromLocalCopy ? '  fare workbook ready (local copy)' : '  fare workbook downloaded');
  return parseFareWorkbook(buf);
}

// ---------------------------------------------------------------------------

export interface QingdaoSources {
  amapSubway: AmapSubwayDoc;
  siteStations: SiteSearchResult;
  fareWorkbook: FareWorkbook;
}

export async function fetchQingdaoSources(): Promise<QingdaoSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch AMap subway 3702_drw_qingdao.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
  const lineCount = amapSubway.l?.length ?? 0;
  if (lineCount < 8) {
    throw new Error(`AMap subway doc for Qingdao has ${lineCount} lines, expected >= 8`);
  }
  console.log(
    `    ${lineCount} lines, ${amapSubway.l?.reduce((n, l) => n + (l.st?.length ?? 0), 0)} station entries`
  );

  console.log('  fetch official siteSearch station lists');
  const siteStations = await fetchSiteStations([1, 2, 3, 4, 6, 8, 11, 13]);

  const fareWorkbook = await fetchFareWorkbook();
  console.log(
    `    fare workbook: ${fareWorkbook.header.length} header cols, ${fareWorkbook.rows.length} station rows`
  );

  return { amapSubway, siteStations, fareWorkbook };
}
