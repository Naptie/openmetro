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
  instructions?: string;
  path?: string;
  start_location?: { lng?: number; lat?: number };
  end_location?: { lng?: number; lat?: number };
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
    env.OPENMETRO_BAIDU_BASE?.trim() || 'https://api.map.baidu.com/direction/v2/transit';
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

/** GCJ-02 → BD-09. Single source of truth lives in `geocode/coords.ts`. */
export { gcj02ToBd09 } from '../geocode/coords.js';

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
   * One transit plan between two GCJ-02 points.
   *
   * Direction v2 accepts `coord_type=gcj02` / `ret_coordtype=gcj02`, so
   * canonical GCJ-02 is sent as-is (no BD-09 detour). `tactics_incity=5`
   * prefers metro ("地铁优先") — the strongest public filter; there is no
   * hard "metro only" switch (3 = avoid metro).
   */
  async transit(
    originGcj: BaiduLatLng,
    destGcj: BaiduLatLng,
    retries = 3
  ): Promise<BaiduTransitResponse | undefined> {
    if (this.exhausted) return undefined;
    const o = { lat: originGcj.lat, lng: originGcj.lng };
    const d = { lat: destGcj.lat, lng: destGcj.lng };
    const params = new URLSearchParams({
      origin: encodeLatLng(o),
      destination: encodeLatLng(d),
      coord_type: 'gcj02',
      ret_coordtype: 'gcj02',
      // 5 = 地铁优先 (prefer metro). 3 = 不坐地铁.
      tactics_incity: '5',
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
        normalizeV2Response(body);
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
 * Direction v2 step shape differs from DirectionLite:
 *   - no top-level `type`; mode lives in `vehicle_info.type` (5 walk, 3 transit)
 *   - transit legs carry `vehicle_info.detail` (type 1 = 地铁/轻轨)
 * Map them onto the Lite `BaiduTransitStep` fields the harvest helpers use.
 */
function normalizeV2Response(body: BaiduTransitResponse): void {
  for (const route of body.result?.routes ?? []) {
    const groups = route.steps ?? [];
    const flat: BaiduTransitStep[] = [];
    for (const g of groups) {
      if (Array.isArray(g)) flat.push(...(g as BaiduTransitStep[]));
      else if (g) flat.push(g as BaiduTransitStep);
    }
    for (const s of flat) {
      const vi = (s as { vehicle_info?: Record<string, unknown> }).vehicle_info;
      if (!vi) continue;
      if (s.type == null && typeof vi.type === 'number') {
        (s as { type?: number }).type = vi.type;
      }
      if (!s.vehicle) {
        const detail = (vi.detail ?? {}) as Record<string, unknown>;
        s.vehicle = {
          type: (vi.type as number) ?? undefined,
          name: (vi.name as string) ?? (detail.name as string) ?? undefined,
          start_name: (detail.start_name as string) ?? undefined,
          end_name: (detail.end_name as string) ?? undefined,
          start_time: (detail.start_time as string) ?? undefined,
          end_time: (detail.end_time as string) ?? undefined,
          stop_num: (detail.stop_num as number) ?? undefined
        };
        const busType = detail.type;
        if (typeof busType === 'number') {
          s.vehicle.type = busType;
        }
      }
    }
    route.steps = [flat];
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
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(y1)) * Math.cos(toRad(y2)) * Math.sin(dLng / 2) ** 2;
    sum += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return sum;
}
