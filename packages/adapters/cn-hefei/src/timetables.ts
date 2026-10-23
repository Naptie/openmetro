/**
 * Timetables for cn-hefei: the operator's official first/last-train table and
 * the per-station harvest that completes it.
 *
 * ## The official table
 *
 * 《合肥轨道1、2、3、4、5、6、7、8号线首末班车时间及行车间隔》 is published on
 * the Hefei government disclosure platform (see `./gov.ts`). Its body is one
 * plain HTML table with **three service-day bands**:
 *
 * | band | days |
 * |---|---|
 * | `mon_thu` | 周一至周四工作日 |
 * | `fri` | 周五工作日 |
 * | `weekend` | 双休日 |
 *
 * Each cell reads `首：<stations>：<time> 末：<stations>：<times>` and the
 * 注释 column defines the two service directions
 * ("上行：九联圩站开往张洼站方向；下行：张洼站开往九联圩方向；").
 *
 * The `首` list names the **first-train origin stations** — the stations the
 * very first train of the day departs from (all at 06:00). The `末` list names
 * the **last-train terminals**. Intermediate stations are **not** published, so
 * the official table alone cannot fill a per-station timetable.
 *
 * ## The per-station harvest
 *
 * The Baidu planner reports the boarding station's own first/last departure,
 * and it agrees with the official table **exactly** at every published
 * terminal (7/7 verified 2026-10-23 — see `./baidu.ts`). It therefore fills
 * the intermediate stations the operator does not publish.
 *
 * The planner answers for the day it is queried, so a harvested value belongs
 * to one band only. The harvest records which band it observed, and the
 * canonical record keeps the official band structure wherever the operator
 * published one.
 */
import { type BaiduRailLeg, fetchBaiduOriginLeg } from './baidu.js';
import type { HefeiLineConfig } from './lines.js';

/** The operator's two service directions, as labelled 上行 / 下行. */
export type OperatorDirection = 'operatorUp' | 'operatorDown';

/** The three service-day bands the operator publishes. */
export type ServiceBand = 'mon_thu' | 'fri' | 'weekend';

/** A time per service-day band. */
export interface BandTimes {
  mon_thu: string;
  fri: string;
  weekend: string;
}

/** The official table for one line. */
export interface OfficialLineTimetable {
  /** Official line number (`'1'` … `'8'`). */
  lineNumber: string;
  /** First-train origins: station → direction → times. */
  first: Map<string, Map<OperatorDirection, BandTimes>>;
  /** Last trains: station → direction → times. */
  last: Map<string, Map<OperatorDirection, BandTimes>>;
  /** Published minimum headway per band, as printed (e.g. `高峰:4分钟 平峰:6分钟`). */
  headway: Partial<Record<ServiceBand, string>>;
  /** The station the operator's 上行 service heads to (raw operator spelling). */
  upToward: string;
  /** The station the operator's 下行 service heads to (raw operator spelling). */
  downToward: string;
  /** The raw 注释 column. */
  notes: string;
}

/** Which band of the operator's split a given date falls into. */
export function serviceBandFor(date: Date): ServiceBand {
  const dow = date.getDay(); // 0 = Sunday
  if (dow >= 1 && dow <= 4) return 'mon_thu';
  if (dow === 5) return 'fri';
  return 'weekend';
}

/**
 * Expand the three official bands onto the canonical 7-element weekday array
 * (index 0 = Monday … 6 = Sunday).
 */
export function bandTimesToWeekArray(times: BandTimes): string[] {
  return [
    times.mon_thu,
    times.mon_thu,
    times.mon_thu,
    times.mon_thu,
    times.fri,
    times.weekend,
    times.weekend
  ];
}

/** The band a harvested value belongs to, as its weekday indices. */
export function bandWeekIndices(band: ServiceBand): number[] {
  if (band === 'mon_thu') return [0, 1, 2, 3];
  if (band === 'fri') return [4];
  return [5, 6];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Official table parsing
// ---------------------------------------------------------------------------

/**
 * Split `<station><direction>` off the end of a table cell.
 *
 * The operator writes the station with a trailing `站` (`九联圩站`) and the
 * direction with none (`上行` / `下行` / `上下行`).
 */
function splitDirection(
  item: string
): { station: string; direction: OperatorDirection | 'both' } | null {
  if (item.endsWith('上下行')) return { station: item.slice(0, -3), direction: 'both' };
  if (item.endsWith('上行')) return { station: item.slice(0, -2), direction: 'operatorUp' };
  if (item.endsWith('下行')) return { station: item.slice(0, -2), direction: 'operatorDown' };
  return null;
}

/**
 * Split `<station><direction>：<time>` into its parts.
 *
 * The table mixes half-width (`23:35`) and full-width (`22：30`) colons, uses
 * the full-width colon as the separator, and once omits it altogether
 * (`合肥南站上下行23:35`), so the time is matched by shape rather than by
 * splitting on a colon. The separator is optional.
 */
const TIME_ITEM = /^(.*?)[：:]?\s*(\d{1,2})\s*[：:]\s*(\d{2})\s*$/;

/** One `、`-separated item of a 首/末 list. */
interface ListItem {
  /** The `<station><direction>` head. */
  head: string;
  /** The time, when the item carries its own. */
  time: string | null;
}

/**
 * Split a 首/末 list into items.
 *
 * The operator writes the list either with a time per item
 * (`九联圩站上行：22:20、张洼站下行：22:40`) or with **one trailing time for
 * the whole preceding run** (`南岗站上行、撮镇站下行：22:30`, and
 * `烧脉岗站上行、综保区站下行：22:00、合肥南站上下行23:35`). The trailing time
 * therefore applies to every item before it that carries none.
 */
function splitListItems(part: string): ListItem[] {
  return part
    .split('、')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item) => {
      const m = TIME_ITEM.exec(item);
      if (!m) return { head: item, time: null };
      return { head: m[1]!.trim(), time: `${m[2]!.padStart(2, '0')}:${m[3]}` };
    });
}

/**
 * Pair every station/direction head with its time, resolving the shared
 * trailing time.
 */
function pairHeadsWithTimes(items: ListItem[]): { head: string; time: string }[] {
  const out: { head: string; time: string }[] = [];
  let pending: string[] = [];
  for (const item of items) {
    if (item.time) {
      for (const head of [...pending, item.head]) out.push({ head, time: item.time });
      pending = [];
    } else {
      pending.push(item.head);
    }
  }
  return out;
}

/** Parse a 末 list into per-station times. */
function parseLastItems(part: string): Map<string, Map<OperatorDirection, string>> {
  const out = new Map<string, Map<OperatorDirection, string>>();
  for (const { head, time } of pairHeadsWithTimes(splitListItems(part))) {
    const dir = splitDirection(head);
    if (!dir) continue;
    const byDir = out.get(dir.station) ?? new Map<OperatorDirection, string>();
    if (dir.direction === 'both') {
      byDir.set('operatorUp', time);
      byDir.set('operatorDown', time);
    } else {
      byDir.set(dir.direction, time);
    }
    out.set(dir.station, byDir);
  }
  return out;
}

/**
 * Parse a 首 list — every station shares one first-train time.
 */
function parseFirstItems(part: string): { stations: string[]; time: string } {
  const paired = pairHeadsWithTimes(splitListItems(part));
  if (paired.length === 0) return { stations: [], time: '' };
  return {
    stations: paired.map((p) => p.head),
    time: paired[paired.length - 1]!.time
  };
}

/**
 * Parse the operator's 《首末班车时间及行车间隔》 table.
 *
 * `tables` is the list of tables found in the article (see `parseTables`).
 * The timetable table is the one whose header starts with 线路.
 */
export function parseOfficialTimetable(tables: string[][][]): OfficialLineTimetable[] {
  const table = tables.find((t) => t[0]?.[0] === '线路' && t.length > 2);
  if (!table)
    throw new Error('hefei: official timetable table not found in the disclosure article');

  const lines: OfficialLineTimetable[] = [];
  for (const row of table) {
    const lineCell = row[0]?.trim() ?? '';
    const m = /^(\d+)号线$/.exec(lineCell);
    if (!m) continue;
    const lineNumber = m[1]!;

    const bands: ServiceBand[] = ['mon_thu', 'fri', 'weekend'];
    const first = new Map<string, Map<OperatorDirection, BandTimes>>();
    const last = new Map<string, Map<OperatorDirection, BandTimes>>();
    const headway: Partial<Record<ServiceBand, string>> = {};

    for (const [i, band] of bands.entries()) {
      const timesCell = row[1 + i * 2] ?? '';
      const headwayCell = row[2 + i * 2] ?? '';
      if (headwayCell.trim()) headway[band] = headwayCell.trim();

      const split = /首[：:]([\s\S]*?)\s*末[：:]([\s\S]*)$/.exec(timesCell);
      if (!split) continue;
      const firstPart = split[1]!.trim();
      const lastPart = split[2]!.trim();

      const { stations: firstStations, time: firstTime } = parseFirstItems(firstPart);
      if (firstTime) {
        for (const rawStation of firstStations) {
          const dir = splitDirection(rawStation);
          if (!dir) continue;
          const byDir = first.get(dir.station) ?? new Map<OperatorDirection, BandTimes>();
          const current = byDir.get(dir.direction === 'both' ? 'operatorUp' : dir.direction);
          const merged: BandTimes = current
            ? { ...current, [band]: firstTime }
            : ({ mon_thu: '', fri: '', weekend: '', [band]: firstTime } as BandTimes);
          if (dir.direction === 'both') {
            byDir.set('operatorUp', merged);
            byDir.set('operatorDown', merged);
          } else {
            byDir.set(dir.direction, merged);
          }
          first.set(dir.station, byDir);
        }
      }

      for (const [station, byDir] of parseLastItems(lastPart)) {
        const target = last.get(station) ?? new Map<OperatorDirection, BandTimes>();
        for (const [dir, time] of byDir) {
          const current = target.get(dir);
          target.set(
            dir,
            current
              ? { ...current, [band]: time }
              : ({ mon_thu: '', fri: '', weekend: '', [band]: time } as BandTimes)
          );
        }
        last.set(station, target);
      }
    }

    // Direction definitions from the 注释 column.
    const notes = row[7] ?? '';
    const upMatch = /上行[：:]\s*(.+?)站开往(.+?)方向/.exec(notes);
    const downMatch = /下行[：:]\s*(.+?)站开往(.+?)方向/.exec(notes);

    lines.push({
      lineNumber,
      first,
      last,
      headway,
      upToward: upMatch?.[2]?.trim() ?? '',
      downToward: downMatch?.[2]?.trim() ?? '',
      notes: notes.trim()
    });
  }

  if (lines.length === 0) throw new Error('hefei: official timetable table has no line rows');
  return lines;
}

// ---------------------------------------------------------------------------
// Per-station harvest
// ---------------------------------------------------------------------------

/** A station reference for the planner, in the canonical GCJ-02 datum. */
export interface HefeiStationRef {
  /** Canonical station name (as in `stations.json`). */
  name: string;
  lon: number;
  lat: number;
}

/** The harvested service window at one station, per direction. */
export interface HarvestedStationTimes {
  stationName: string;
  /** Toward the **last** stop of the line's canonical order. */
  downFirst?: string | null;
  downLast?: string | null;
  downDirection?: string | null;
  /** The exit the planner boards through, e.g. `E口`. */
  downExit?: string | null;
  /** Toward the **first** stop of the line's canonical order. */
  upFirst?: string | null;
  upLast?: string | null;
  upDirection?: string | null;
  upExit?: string | null;
}

/** Extract the exit letter the planner boards through (`(E口)` → `E口`). */
export function exitOf(stationWithExit: string | undefined | null): string | undefined {
  const m = /[(（]([^)）]*)[)）]/.exec(String(stationWithExit ?? ''));
  const inner = m?.[1]?.trim();
  return inner ? inner : undefined;
}

/**
 * Destinations tried in order for one direction.
 *
 * The planner reports the boarding station's service window and the leg it
 * returns travels *towards the requested destination*, so the destination must
 * lie in the intended direction. Any destination in that direction yields the
 * same answer, which makes the destination a free parameter for working
 * around the planner's routing holes — every station in the direction is
 * tried, nearest first.
 */
export function destinationPool(
  refs: readonly HefeiStationRef[],
  originIndex: number,
  direction: 'down' | 'up'
): HefeiStationRef[] {
  const step = direction === 'down' ? 1 : -1;
  const pool: HefeiStationRef[] = [];
  for (let k = 1; originIndex + step * k >= 0 && originIndex + step * k < refs.length; k++) {
    const ref = refs[originIndex + step * k]!;
    if (!pool.some((p) => p.name === ref.name)) pool.push(ref);
  }
  return pool;
}

async function harvestDirection(
  ak: string,
  cfg: HefeiLineConfig,
  refs: readonly HefeiStationRef[],
  index: number,
  direction: 'down' | 'up',
  opts: { delayMs: number; retries: number }
): Promise<{ first: string | null; last: string | null; label: string | null; exit?: string }> {
  const origin = refs[index]!;
  const terminus = refs[direction === 'down' ? refs.length - 1 : 0]!;
  const opposite = refs[direction === 'down' ? 0 : refs.length - 1]!;
  const pool = destinationPool(refs, index, direction);

  for (const [i, dest] of pool.entries()) {
    if (dest.name === origin.name) continue;
    const attempts = i === 0 ? opts.retries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const leg: BaiduRailLeg | null = await fetchBaiduOriginLeg(
          ak,
          { name: origin.name, lon: origin.lon, lat: origin.lat },
          { lon: dest.lon, lat: dest.lat },
          cfg.officialId,
          {
            directionTerminus: terminus.name,
            oppositeTerminus: opposite.name,
            retries: 0
          }
        );
        if (leg?.firstTime || leg?.lastTime) {
          return {
            first: leg.firstTime ?? null,
            last: leg.lastTime ?? null,
            label: leg.direction || null,
            exit: exitOf(leg.onStation)
          };
        }
      } catch {
        // fall through to the next destination
      }
      await sleep(opts.delayMs);
    }
  }
  return { first: null, last: null, label: null };
}

/**
 * Harvest the first/last train at every station of one line, in both
 * directions.
 */
export async function harvestStationTimetables(
  ak: string,
  cfg: HefeiLineConfig,
  refs: readonly HefeiStationRef[],
  opts: { delayMs?: number; retries?: number } = {}
): Promise<HarvestedStationTimes[]> {
  const delayMs = opts.delayMs ?? 120;
  const retries = opts.retries ?? 1;
  const out: HarvestedStationTimes[] = [];

  for (let i = 0; i < refs.length; i++) {
    const row: HarvestedStationTimes = { stationName: refs[i]!.name };

    if (i < refs.length - 1) {
      const down = await harvestDirection(ak, cfg, refs, i, 'down', { delayMs, retries });
      row.downFirst = down.first;
      row.downLast = down.last;
      row.downDirection = down.label;
      row.downExit = down.exit;
    }
    if (i > 0) {
      const up = await harvestDirection(ak, cfg, refs, i, 'up', { delayMs, retries });
      row.upFirst = up.first;
      row.upLast = up.last;
      row.upDirection = up.label;
      row.upExit = up.exit;
    }

    out.push(row);
  }
  return out;
}
