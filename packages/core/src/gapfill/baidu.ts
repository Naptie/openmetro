/**
 * Baidu Direction Lite transit planner client for the adapter-agnostic
 * `gapfill` layer.
 *
 * Identical to the official Web service
 * (`https://api.map.baidu.com/directionlite/v1/transit`): city operators that
 * reverse-proxy it (e.g. cqmetro `/baidu-map-api/`) return the same body.
 * Configure base + AK via env so the implementation stays out of adapters.
 */

export const BAIDU_SOURCE_ID = 'baidu-transit';

export interface BaiduGapfillConfig {
  /** Web service AK. Required — never hardcode. */
  ak: string;
  /** Absolute URL of the transit endpoint. */
  baseUrl: string;
  /** Optional browser-side sn (unused unless the key requires it). */
  sn?: string;
  /** Max queries/sec (client-side throttle). */
  qps: number;
  /** Optional hard cap on planner calls (testing / CI budget). */
  maxQueries?: number;
}

export interface BaiduLatLng {
  lat: number;
  lng: number;
}

export interface BaiduTransitStep {
  distance?: number;
  duration?: number;
  type?: number;
  instruction?: string;
  path?: string;
  vehicle?: {
    name?: string;
    /** 0 bus, 1 subway, … */
    type?: number;
    direct_text?: string;
    start_name?: string;
    end_name?: string;
    start_time?: string;
    end_time?: string;
    stop_num?: number;
    line_color?: string;
    stop_info?: { stop_name?: string; stop_loction?: BaiduLatLng }[];
  };
}

export interface BaiduTransitRoute {
  distance?: number;
  duration?: number;
  price?: number;
  steps?: BaiduTransitStep[][];
}

export interface BaiduTransitResponse {
  status?: number;
  message?: string;
  result?: {
    origin?: BaiduLatLng;
    destination?: BaiduLatLng;
    routes?: BaiduTransitRoute[];
  };
}

export function loadBaiduGapfillConfig(
  env: Record<string, string | undefined> = process.env
): BaiduGapfillConfig | { error: string } {
  const ak = env.OPENMETRO_BAIDU_AK?.trim();
  if (!ak) {
    return { error: 'OPENMETRO_BAIDU_AK is not set — gapfill is disabled' };
  }
  const baseUrl =
    env.OPENMETRO_BAIDU_BASE?.trim() ||
    'https://api.map.baidu.com/directionlite/v1/transit';
  const qps = Math.max(0.2, Number(env.OPENMETRO_BAIDU_QPS ?? '2') || 2);
  const maxRaw = env.OPENMETRO_BAIDU_MAX_QUERIES?.trim();
  const maxQueries = maxRaw ? Math.max(1, Number(maxRaw) || 0) : undefined;
  return {
    ak,
    baseUrl,
    sn: env.OPENMETRO_BAIDU_SN?.trim() || undefined,
    qps,
    maxQueries
  };
}

/** GCJ-02 → BD-09 (Baidu). Station coords in canonical data are GCJ-02. */
export function gcj02ToBd09(lat: number, lng: number): BaiduLatLng {
  const xPi = (Math.PI * 3000.0) / 180.0;
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * xPi);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * xPi);
  return {
    lng: z * Math.cos(theta) + 0.0065,
    lat: z * Math.sin(theta) + 0.006
  };
}

function encodeLatLng(p: BaiduLatLng): string {
  return `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
}

export class BaiduPlannerClient {
  #cfg: BaiduGapfillConfig;
  #minIntervalMs: number;
  #nextAt = 0;
  #queries = 0;

  constructor(cfg: BaiduGapfillConfig) {
    this.#cfg = cfg;
    this.#minIntervalMs = Math.ceil(1000 / cfg.qps);
  }

  get queries(): number {
    return this.#queries;
  }

  get exhausted(): boolean {
    return this.#cfg.maxQueries != null && this.#queries >= this.#cfg.maxQueries;
  }

  async #throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.#nextAt - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.#nextAt = Date.now() + this.#minIntervalMs;
  }

  /**
   * One transit plan between two GCJ-02 points. Returns `undefined` on
   * planner "no route" / budget exhaustion; throws on transport errors after
   * retries so a flaky sync cannot silently drop harvested values.
   */
  async transit(
    originGcj: BaiduLatLng,
    destGcj: BaiduLatLng,
    retries = 3
  ): Promise<BaiduTransitResponse | undefined> {
    if (this.exhausted) return undefined;
    const o = gcj02ToBd09(originGcj.lat, originGcj.lng);
    const d = gcj02ToBd09(destGcj.lat, destGcj.lng);
    const params = new URLSearchParams({
      origin: encodeLatLng(o),
      destination: encodeLatLng(d),
      ak: this.#cfg.ak
    });
    if (this.#cfg.sn) params.set('sn', this.#cfg.sn);
    const url = `${this.#cfg.baseUrl}?${params.toString()}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      await this.#throttle();
      this.#queries++;
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*'
          },
          signal: AbortSignal.timeout(30_000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as BaiduTransitResponse;
        // status 0 = ok; 2/4/… = no route / param — not transport failures.
        if (typeof body.status === 'number' && body.status !== 0) return body;
        return body;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw new Error(
      `baidu transit ${encodeLatLng(o)}->${encodeLatLng(d)}: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`
    );
  }
}

/**
 * Flatten route steps and keep a pure metro+walk itinerary.
 * Baidu may nest each step as its own one-element group, so always flatten
 * the whole route first. Rides must be subway (`vehicle.type === 1` or a
 * 地铁/轨道 name) — bus legs type=3 with vehicle.type=0 are rejected.
 */
export function pureMetroSteps(steps: BaiduTransitStep[][] | undefined): BaiduTransitStep[] {
  if (!steps?.length) return [];
  const flat = steps.flat().filter(Boolean);
  if (flat.length === 0) return [];
  const isMetroRide = (s: BaiduTransitStep): boolean => {
    if (s.type !== 3) return false;
    const v = s.vehicle ?? {};
    if (v.type === 1) return true;
    const n = v.name ?? '';
    return n.includes('地铁') || n.includes('轨道');
  };
  let sawRide = false;
  for (const s of flat) {
    const t = s.type ?? -1;
    if (t === 5) continue; // walk
    if (isMetroRide(s)) {
      sawRide = true;
      continue;
    }
    return []; // bus / ferry / …
  }
  return sawRide ? flat : [];
}

/** Polyline length in meters from a Baidu `path` string (`lng,lat;…`). */
export function pathMeters(path: string | undefined): number | undefined {
  if (!path) return undefined;
  const pts: [number, number][] = [];
  for (const part of path.split(';')) {
    const [lngS, latS] = part.split(',');
    const lng = Number(lngS);
    const lat = Number(latS);
    if (Number.isFinite(lng) && Number.isFinite(lat)) pts.push([lng, lat]);
  }
  if (pts.length < 2) return undefined;
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    const dLat = toRad(y2 - y1);
    const dLng = toRad(x2 - x1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(y1)) * Math.cos(toRad(y2)) * Math.sin(dLng / 2) ** 2;
    sum += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return sum;
}
