/**
 * Official-source fetch for cn-tianjin.
 *
 * Two structured sources, no scraping and no OCR:
 * - The public AMap subway dataset (GCJ-02 native): station names/order,
 *   coordinates, schematic pixels, romanisations and line colours.
 * - The operator's official "运营时刻表" H5 app
 *   (`static-app.trtpazyz.com/tj-app-h5/train-time/`, linked from
 *   tjgdjt.com/channels/20.html): its JS chunk embeds every service
 *   alignment with **per-station first/last-train times in both
 *   directions** as static data — the same app the TJ Metro App uses.
 *
 * The H5 app additionally exposes a per-station minute-level timetable API
 * (`app-tj.trtpazyz.com/tj-metro-api/open-api/ipis/queryLineRunTime`,
 * RSA-signed MD5) — the signature is replicated in `signTjApiPayload`,
 * but the service is currently disabled server-side
 * (`resultCode 0001` "正在调试中"); kept as a probe for future enablement.
 */
import { spawn } from 'node:child_process';
import { constants, createHash, createPublicKey, publicEncrypt } from 'node:crypto';
import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const AMAP_SUBWAY = 'https://webapi.amap.com/subway/data/1200_drw_tianjin.json';
const AMAP_REFERER = 'https://www.tjgdjt.com/';

/** The official H5 "运营时刻表" app (tjgdjt.com → 运营时刻表). */
const H5_APP = 'https://static-app.trtpazyz.com/tj-app-h5/train-time/index.html';

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
// Official H5 train-time app: embedded per-alignment first/last-train data
// ---------------------------------------------------------------------------

/** One station entry of the H5 app's embedded direction list. */
export interface H5DirectionStation {
  stationId: string;
  name: string;
  /** First-train time at this station toward `dstName` (`H:MM`/`HH:MM`). */
  startTime?: string;
  /** Last-train time at this station toward `dstName`. */
  endTime?: string;
}

export interface H5Direction {
  id: number;
  /** Destination the H5 app displays for this direction. */
  dstName: string;
  /** `1` = the reverse-order (down) direction, `2` = forward order. */
  up_down_type: number;
  direction: H5DirectionStation[];
}

export interface H5LineEntry {
  /** H5 line id; a split line (4号线) shares one id across two entries. */
  id: string | number;
  /** Service alignment label, e.g. `4号线南段`, `9号线区间`, `Z4线`. */
  lineName: string;
  /** Alignment colour, e.g. `#E75650`. */
  color: string;
  directions: H5Direction[];
}

/**
 * RSA-signed-MD5 request signature for the TJ Metro app gateway
 * (`app-tj.trtpazyz.com/tj-metro-api`): the app signs
 * `MD5(JSON.stringify(payload)).toUpperCase()` with its embedded RSA public
 * key and sends it as the `signature` header.
 */
export function signTjApiPayload(payload: unknown): string {
  const keyB64 =
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQD2LhuMxy0HF3vZzyGJ9zBM5qoFvrxS' +
    '75YOtB9cjF0pENMO/zfZfWzBsyQisFdiDcQTa3uTTFgZXFirvUcXAKXAtzJ+bJLnutCB' +
    '8VnOTovvkajdcmwhgvHCnNIxdzhSllFf+jzoBbtLcwLGRD07LVwlSHo18GVkjswQWlu4' +
    'fH26ZQIDAQAB';
  const pem = `-----BEGIN PUBLIC KEY-----\n${keyB64.replace(/(.{64})/g, '$1\n')}\n-----END PUBLIC KEY-----`;
  const json = JSON.stringify(payload);
  const md5 = createHash('md5').update(json, 'utf-8').digest('hex').toUpperCase();
  const enc = publicEncrypt(
    { key: createPublicKey(pem), padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(md5, 'utf-8')
  );
  return enc.toString('base64');
}

export interface TjApiResponse {
  resultCode?: string;
  resultDesc?: string;
  resultData?: unknown;
}

/**
 * Query the official TJ Metro app gateway. Endpoint known live today:
 * `open-api/ipis/queryLineRunTime` (minute-level station timetables) —
 * currently returns `0001 操作失败` ("正在调试中"). Callers must treat
 * `resultCode !== '0000'` as "not available", never as a fetch failure.
 */
export async function tjApiQuery(endpoint: string, payload: unknown): Promise<TjApiResponse> {
  const base = 'https://app-tj.trtpazyz.com/tj-metro-api';
  const res = await fetch(`${base}/open-api/${endpoint.replace(/^\//, '')}`, {
    method: 'POST',
    headers: {
      appid: '426789409f3442d4a9bc10b0804039b1',
      signature: signTjApiPayload(payload),
      'Content-Type': 'application/json',
      Origin: 'https://static-app.trtpazyz.com',
      Referer: `${H5_APP}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`tj-api ${endpoint} -> ${res.status}`);
  return (await res.json()) as TjApiResponse;
}

/**
 * Extract the H5 app's embedded per-alignment static data.
 *
 * The data lives in a webpack route chunk (`chunk-2d228e45.<hash>.js`),
 * referenced by a content hash from the app shell, so the fetch resolves the
 * current chunk URL from `index.html` and evaluates the `[{id:"01",...}]`
 * array literal out of it.
 */
export async function fetchH5LineEntries(): Promise<H5LineEntry[]> {
  const shell = await getText(H5_APP, H5_APP, 2);
  // App-shell preload map: `train-time/js/chunk-2d228e45.<hash>.js`.
  const chunkRef = /(?:^|[^0-9a-z])(chunk-2d228e45)\.([0-9a-f]+)\.js/.exec(shell);
  if (!chunkRef) {
    throw new Error('train-time shell: data chunk reference not found');
  }
  const chunkUrl = `https://static-app.trtpazyz.com/tj-app-h5/train-time/train-time/js/${chunkRef[1]}.${chunkRef[2]}.js`;
  console.log(`  fetch H5 train-time data chunk ${chunkRef[1]}.${chunkRef[2]}`);
  const js = await getText(chunkUrl, H5_APP, 2);

  // The embedded literal is a `[ {id:.., lineName:.., directions:[..]} ]`
  // array with unquoted keys. Anchor on the first `[{id:` whose following
  // characters include `lineName`, then bracket-match from its start.
  let anchor = -1;
  for (let i = js.indexOf('[{id:'); i >= 0; i = js.indexOf('[{id:', i + 1)) {
    if (js.slice(i, i + 300).includes('lineName')) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) throw new Error('train-time chunk: embedded line array not found');
  let depth = 0;
  let end = -1;
  let inStr: string | null = null;
  for (let i = anchor; i < js.length; i++) {
    const ch = js[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0 && ch === ']') {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('train-time chunk: embedded line array unterminated');
  // The literal uses unquoted JS object keys (id:, lineName:, …). Quote the
  // keys and parse as JSON — no `eval`, and corruption fails loudly.
  const literal = js.slice(anchor, end);
  const asJson = literal.replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  let parsed: unknown;
  try {
    parsed = JSON.parse(asJson);
  } catch (err) {
    throw new Error(
      `train-time chunk: embedded literal is not JSON-like after key quoting (${err})`
    );
  }
  const entries = parsed as H5LineEntry[];
  if (!Array.isArray(entries) || entries.length < 15) {
    throw new Error(`train-time chunk: ${entries?.length ?? 0} line entries, expected >= 15`);
  }
  if (!entries.every((e) => typeof e.lineName === 'string' && Array.isArray(e.directions))) {
    throw new Error('train-time chunk: line entry missing lineName/directions');
  }
  const stations = new Set(
    entries.flatMap((e) => e.directions.flatMap((d) => d.direction.map((s) => s.name)))
  );
  console.log(`    ${entries.length} alignments, ${stations.size} distinct stations`);
  return entries;
}

// ---------------------------------------------------------------------------

export interface TianjinSources {
  amapSubway: AmapSubwayDoc;
  h5Lines: H5LineEntry[];
}

export async function fetchTianjinSources(): Promise<TianjinSources> {
  if (process.env.OPENMETRO_REVERSE_PROXY) {
    console.log(`  via reverse proxy: ${process.env.OPENMETRO_REVERSE_PROXY}`);
  }

  console.log('  fetch AMap subway 1200_drw_tianjin.json');
  const amapSubway = await getJson<AmapSubwayDoc>(AMAP_SUBWAY, AMAP_REFERER);
  const lineCount = amapSubway.l?.length ?? 0;
  if (lineCount < 14) {
    throw new Error(`AMap subway doc for Tianjin has ${lineCount} lines, expected >= 14`);
  }
  console.log(
    `    ${lineCount} lines, ${amapSubway.l?.reduce((n, l) => n + (l.st?.length ?? 0), 0)} station entries`
  );

  const h5Lines = await fetchH5LineEntries();

  return { amapSubway, h5Lines };
}
