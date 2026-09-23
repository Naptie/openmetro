import { haversineKm } from '../geocode/consistency.js';
import type { SegmentEncoded, StationEncoded } from '../schema/index.js';

/**
 * Straight-line distance + affine time-model fallbacks for segment metrics.
 *
 * Operators rarely publish both inter-station distance and run time. When
 * coordinates are already resolved, the great-circle distance is a stable
 * lower bound; trustworthy segment times calibrate a run-time slope and a
 * per-hop overhead, first for the same line and then for the network.
 *
 * Never overwrite a published `distance_km` or a `source` / `planner` /
 * `last_train` travel time.
 */

/** Great-circle distance in km; tagged `extras.distance_source = "haversine"`. */
export function fillStraightLineDistances(
  segments: SegmentEncoded[],
  stations: Pick<StationEncoded, 'id' | 'location'>[],
  opts: { minKm?: number; maxKm?: number } = {}
): SegmentEncoded[] {
  const minKm = opts.minKm ?? 0.02;
  const maxKm = opts.maxKm ?? 40;
  const loc = new Map<string, { lon: number; lat: number }>();
  for (const s of stations) {
    if (s.location) loc.set(s.id, { lon: s.location.lon, lat: s.location.lat });
  }
  return segments.map((seg) => {
    if (seg.distance_km != null && seg.distance_km > 0) return seg;
    const a = loc.get(seg.from_station_id);
    const b = loc.get(seg.to_station_id);
    if (!a || !b) return seg;
    const km = haversineKm(a, b);
    if (!(km >= minKm) || km > maxKm) return seg;
    return {
      ...seg,
      distance_km: Math.round(km * 1000) / 1000,
      extras: { ...(seg.extras ?? {}), distance_source: 'haversine' }
    };
  });
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface TimeSample {
  distanceKm: number;
  seconds: number;
  speedKmh: number;
}

interface AffineTimeModel {
  secondsPerKm: number;
  fixedSeconds: number;
}

function fitAffine(samples: TimeSample[]): AffineTimeModel | undefined {
  if (samples.length < 2) return undefined;
  const meanDistance = samples.reduce((sum, sample) => sum + sample.distanceKm, 0) / samples.length;
  const meanSeconds = samples.reduce((sum, sample) => sum + sample.seconds, 0) / samples.length;
  let covariance = 0;
  let distanceVariance = 0;
  for (const sample of samples) {
    const distanceDelta = sample.distanceKm - meanDistance;
    covariance += distanceDelta * (sample.seconds - meanSeconds);
    distanceVariance += distanceDelta * distanceDelta;
  }
  if (!(distanceVariance > 1e-9)) return undefined;

  const secondsPerKm = covariance / distanceVariance;
  const fixedSeconds = meanSeconds - secondsPerKm * meanDistance;
  if (
    !Number.isFinite(secondsPerKm) ||
    !Number.isFinite(fixedSeconds) ||
    secondsPerKm <= 0 ||
    fixedSeconds < -1
  ) {
    return undefined;
  }
  return { secondsPerKm, fixedSeconds: Math.max(0, fixedSeconds) };
}

function isTrustworthyTime(source: string | undefined): boolean {
  return source === 'source' || source === 'planner' || source === 'last_train';
}

/**
 * Estimate missing inter-station times with `t = a * distance_km + b`, fitting
 * trustworthy samples from the same line before falling back to the network.
 * The function name is retained for API compatibility; undersampled or
 * degenerate fits still fall back to the former median-speed model.
 * Gaps with no distance stay untouched for `fillMissingSegmentTimes`.
 */
export function estimateTimesFromDistanceSpeed(
  segments: SegmentEncoded[],
  opts: { minSeconds?: number; maxSeconds?: number; minSamplesPerLine?: number } = {}
): SegmentEncoded[] {
  const minSeconds = opts.minSeconds ?? 30;
  const maxSeconds = opts.maxSeconds ?? 2400;
  const minSamplesPerLine = opts.minSamplesPerLine ?? 3;

  const byLine = new Map<string, TimeSample[]>();
  const all: TimeSample[] = [];
  for (const s of segments) {
    const t = s.travel_time_seconds;
    const d = s.distance_km;
    if (t == null || t <= 0 || d == null || d <= 0) continue;
    if (!isTrustworthyTime(s.travel_time_source)) continue;
    const kmh = d / (t / 3600);
    // Reject absurd implied speeds (bad coords / unit mix-ups).
    if (!(kmh >= 2 && kmh <= 120)) continue;
    const sample = { distanceKm: d, seconds: t, speedKmh: kmh };
    all.push(sample);
    const list = byLine.get(s.line_id) ?? [];
    list.push(sample);
    byLine.set(s.line_id, list);
  }
  const netKmh = median(all.map((sample) => sample.speedKmh));
  const networkModel = all.length >= minSamplesPerLine ? fitAffine(all) : undefined;
  const lineModels = new Map<string, AffineTimeModel>();
  for (const [lineId, samples] of byLine) {
    if (samples.length < minSamplesPerLine) continue;
    const model = fitAffine(samples);
    if (model) lineModels.set(lineId, model);
  }

  const canUpgrade = (s: SegmentEncoded): boolean => {
    if (s.travel_time_seconds != null && s.travel_time_seconds > 0) {
      // Upgrade legacy proportional estimates, but keep estimates from this model.
      return (
        s.travel_time_source === 'estimated' && s.extras?.time_estimate !== 'distance_time_affine'
      );
    }
    return true;
  };

  return segments.map((s) => {
    if (!canUpgrade(s)) return s;
    const d = s.distance_km;
    if (d == null || d <= 0) return s;
    const lineSamples = byLine.get(s.line_id) ?? [];
    const model = lineModels.get(s.line_id) ?? networkModel;
    const fallbackKmh =
      lineSamples.length >= minSamplesPerLine
        ? median(lineSamples.map((sample) => sample.speedKmh))
        : netKmh;
    if (!model && !(fallbackKmh > 0)) return s;
    let seconds = model ? model.secondsPerKm * d + model.fixedSeconds : (d / fallbackKmh) * 3600;
    if (!Number.isFinite(seconds) || seconds <= 0) return s;
    seconds = Math.min(maxSeconds, Math.max(minSeconds, Math.round(seconds)));
    const apparentSpeedKmh = d / (seconds / 3600);
    return {
      ...s,
      travel_time_seconds: seconds,
      travel_time_source: 'estimated' as const,
      travel_time_derived_from: [
        'distance_haversine',
        model ? 'affine_time_model' : `speed_${Math.round(fallbackKmh)}_kmh`
      ],
      extras: {
        ...(s.extras ?? {}),
        time_estimate: model ? 'distance_time_affine' : 'distance_speed',
        speed_kmh: Math.round(apparentSpeedKmh * 10) / 10,
        ...(model
          ? {
              a_s_per_km: Math.round(model.secondsPerKm * 10) / 10,
              b_s: Math.round(model.fixedSeconds * 10) / 10
            }
          : {})
      }
    };
  });
}
