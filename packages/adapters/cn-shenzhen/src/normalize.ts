import {
  asciiSlug,
  coerceStationStatus,
  deriveLineEnglishName,
  foldStationName,
  hasValidTimes,
  hexToCss,
  type LineEncoded,
  type LineMode,
  type NetworkEncoded,
  type PatternEncoded,
  parsePixel,
  parseSlCoord,
  placeholderCity,
  readableSlug,
  resolveLineShortName,
  type SegmentEncoded,
  type StationEncoded,
  type StopEncoded,
  stationIdFor,
  type TimetableEncoded,
  type TransferEncoded
} from '@openmetro/core';
import {
  parseEnTimetableHtml,
  type ShenzhenSources,
  type ShListLine,
  type ShMapLine,
  type ShMapStation
} from './fetch.js';

const NETWORK_ID = 'cn-shenzhen';

export interface ShenzhenCanonical {
  network: NetworkEncoded;
  lines: LineEncoded[];
  stations: StationEncoded[];
  stops: StopEncoded[];
  patterns: PatternEncoded[];
  segments: SegmentEncoded[];
  transfers: TransferEncoded[];
  timetables: TimetableEncoded[];
  /** Official 4-digit codes keyed by station id (planner/fare keys). */
  fareCodesByStationId: Map<string, string>;
  /** Official GCJ-02 locations keyed by station id. */
  officialLocations: Map<string, { lon: number; lat: number; crs: 'gcj02' }>;
  /** Chinese station name → EN name from the map feed. */
  enByZh: Map<string, string>;
  /** stop source_id (station code) → station id. */
  stationIdByCode: Map<string, string>;
}

/** Prefer a human short badge; collapse Shenzhen Line 6 branch variants. */
function officialShortName(ln: string, kn: string): string {
  const raw = ln.trim();
  if (raw === '6支' || raw === '66' || /6号线支线/.test(kn)) return '6支';
  if (raw) {
    return resolveLineShortName(kn, /^\d+$/.test(raw) ? raw : undefined) || raw;
  }
  return resolveLineShortName(kn) || kn;
}

function lineIdFromShort(short: string): string {
  if (short === '6支') return `${NETWORK_ID}-line-6z`;
  return `${NETWORK_ID}-line-${readableSlug(short) || asciiSlug(short)}`;
}

function lineEnglishName(ln: string, kn: string): string {
  if (ln === '6支' || ln === '66' || /6号线支线/.test(kn)) return 'Line 6 Branch';
  const m = /地铁(\d+)号线/.exec(kn);
  if (m) return `Line ${m[1]}`;
  const n = /(\d+)/.exec(ln);
  if (n) return `Line ${n[1]}`;
  return deriveLineEnglishName(kn) || kn;
}

function lineAlias(kn: string): string | undefined {
  const m = /\(([^)]+)\)/.exec(kn);
  return m?.[1]?.trim() || undefined;
}

function lineMode(_ln: string): LineMode {
  // Same-network metro fare policy covers airport/express branches.
  return 'metro';
}

/** Official map `sl` reused by many stations is a placeholder, not a real coord. */
function collectPlaceholderSl(mapLines: ShMapLine[]): Set<string> {
  const counts = new Map<string, number>();
  const names = new Map<string, Set<string>>();
  for (const line of mapLines) {
    for (const st of line.st ?? []) {
      const sl = st.sl?.trim();
      const n = st.n?.trim();
      if (!sl || !n) continue;
      counts.set(sl, (counts.get(sl) ?? 0) + 1);
      const set = names.get(sl) ?? new Set<string>();
      set.add(n);
      names.set(sl, set);
    }
  }
  const bad = new Set<string>();
  for (const [sl, count] of counts) {
    const distinct = names.get(sl)?.size ?? 0;
    // Same physical interchange can legitimately appear on several lines, but a
    // shared `sl` across many *different* station names is a feed placeholder.
    if (distinct >= 3 || count >= 5) bad.add(sl);
  }
  return bad;
}

function mapLineGeometry(line: ShMapLine): { x: number; y: number }[] {
  const raw = line.c;
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const out: { x: number; y: number }[] = [];
  for (const item of arr) {
    const parts = String(item).trim().split(/\s+/);
    if (parts.length < 2) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

/** Normalize an English timetable station label for matching. */
function normEn(s: string): string {
  return s
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/\bstation\b/g, '')
    .replace(/\broad\b/g, 'rd')
    .replace(/\beast\b/g, 'e')
    .replace(/\bwest\b/g, 'w')
    .replace(/\bnorth\b/g, 'n')
    .replace(/\bsouth\b/g, 's')
    .replace(/\bbonded area\b/g, '')
    .replace(/\bcheck ?point\b/g, 'checkpoint')
    .replace(/[^a-z0-9]+/g, '');
}

/** Official English timetable labels that differ from map-feed `en`. */
const EN_SYNONYMS: Record<string, string> = {
  futianbondedarea: 'fubao',
  youghu: 'yonghu',
  shenzhenuniversity: 'shenda',
  windowoftheworld: 'shijiezhichuang',
  conventionexhibitioncenter: 'huizhanzhongxin',
  shoppingpark: 'gouwugongyuan',
  sciencemuseum: 'kexueguan',
  oct: 'huaqiaocheng',
  huaqiangroad: 'huaqianglu',
  airporteast: 'jichangdong',
  airportnorth: 'jichangbei',
  childrenspalace: 'shaoniangong',
  longchengsquare: 'longchengguangchang',
  honglingnorth: 'honglingbei',
  taian: 'taian',
  xakou: 'xakou',
  hongshuwansouth: 'hongshuwannan',
  bitou: 'bitou',
  nanshan: 'nanshan',
  qianhaiwan: 'qianhaiwan',
  baoan: 'baoan',
  bihaiwan: 'bihaiwan',
  fuyong: 'fuyong',
  qiaotou: 'qiaotou',
  tangwei: 'tangwei',
  maanhill: 'maanshan',
  shajing: 'shajing',
  houting: 'houting',
  songgang: 'songgang',
  xililake: 'xilihu',
  chaguang: 'chaguang',
  zhuguang: 'zhuguang',
  longjing: 'longjing',
  taoyuancun: 'taoyuancun',
  shenyun: 'shenyun',
  antuohill: 'antuoshan',
  nonglin: 'nonglin',
  chegongmiao: 'chegongmiao',
  shangsha: 'shangsha',
  shawei: 'shawei',
  huanggangcun: 'huanggangcun',
  fumin: 'fumin',
  huanggangcheckpoint: 'huanggangkouan',
  fulin: 'fulin',
  chiwei: 'chiwei',
  huaqiangsouth: 'huaqiangnan',
  huaqiangnorth: 'huaqiangbei',
  huangmugang: 'huangmugang',
  bagualing: 'bagualing',
  sungang: 'sungang',
  honghu: 'honghu',
  tianbei: 'tianbei'
};

function matchStationOnLine(
  enLabel: string,
  stations: { id: string; names: { zh: string; en?: string } }[]
): string | undefined {
  const key = normEn(enLabel);
  if (!key || key === 'firsttrain' || key === 'lasttrain') return undefined;
  const syn = EN_SYNONYMS[key];
  for (const st of stations) {
    const en = normEn(st.names.en || '');
    if (key && en === key) return st.id;
    if (syn && en === syn) return st.id;
    if (key && syn && (en === key || en === syn)) return st.id;
  }
  for (const st of stations) {
    const en = normEn(st.names.en || '');
    if (key && en && en.length >= 4 && key.length >= 4 && (en.includes(key) || key.includes(en))) {
      return st.id;
    }
    if (syn && en && en.length >= 4 && (en.includes(syn) || syn.includes(en))) return st.id;
  }
  return undefined;
}

export function normalize(input: ShenzhenSources): ShenzhenCanonical {
  const mapLines = input.mapDoc.l ?? [];
  const placeholderSl = collectPlaceholderSl(mapLines);
  const listByNo = new Map<string, ShListLine>();
  for (const line of input.listLines) {
    listByNo.set(String(line.line), line);
  }

  type Phys = {
    id: string;
    zh: string;
    en: string;
    pinyin: string;
    codes: Set<string>;
    status: StationEncoded['status'];
    location?: { lon: number; lat: number };
    schematic?: { x: number; y: number };
    mapSids: string[];
    facilities: Set<string>;
  };
  /** Keyed by folded Chinese name so 宝安客运 / 宝安客运站 collapse. */
  const physByName = new Map<string, Phys>();

  const ensurePhys = (
    zhRaw: string,
    mapSt?: ShMapStation,
    listSt?: {
      stationName?: string;
      stationCode: string;
      stationQP?: string;
      facilitiesList?: { facilitiesName: string }[];
    }
  ): Phys => {
    const zh = zhRaw.trim();
    const key = foldStationName(zh);
    let phys = physByName.get(key);
    const sl = mapSt?.sl?.trim();
    const loc = sl && !placeholderSl.has(sl) ? parseSlCoord(sl) : undefined;
    const pinyin = listSt?.stationQP || mapSt?.sp?.replace(/\s+/g, '') || phys?.pinyin || '';
    if (!phys) {
      const en = mapSt?.en?.trim() || zh;
      phys = {
        id: `${NETWORK_ID}-${stationIdFor(/^[A-Za-z]/.test(en) ? en : undefined, key, pinyin)}`,
        // Prefer the longer official display label (list often keeps 站).
        zh:
          [zh, listSt?.stationName]
            .filter(Boolean)
            .sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0] || zh,
        en,
        pinyin,
        codes: new Set(),
        status: 'operating',
        location: loc,
        schematic: parsePixel(mapSt?.p),
        mapSids: [],
        facilities: new Set()
      };
      physByName.set(key, phys);
    } else {
      if (!phys.en || phys.en === phys.zh) {
        const en = mapSt?.en?.trim();
        if (en) phys.en = en;
      }
      if (!phys.pinyin && pinyin) {
        phys.pinyin = pinyin;
        // Upgrade id from a hex slug to pinyin once we learn it.
        if (/^[0-9a-f]{6,}$/.test(phys.id.replace(`${NETWORK_ID}-`, ''))) {
          phys.id = `${NETWORK_ID}-${stationIdFor(undefined, key, pinyin)}`;
        }
      }
      if (loc && !phys.location) phys.location = loc;
      const sch = parsePixel(mapSt?.p);
      if (sch && !phys.schematic) phys.schematic = sch;
    }
    const code = mapSt?.poiid?.trim() || listSt?.stationCode?.trim();
    if (code) phys.codes.add(code);
    if (mapSt?.sid) phys.mapSids.push(mapSt.sid);
    for (const f of listSt?.facilitiesList ?? []) phys.facilities.add(f.facilitiesName);
    return phys;
  };

  // Seed physical stations from the official list JS (codes + facilities).
  for (const line of input.listLines) {
    for (const st of line.stationList ?? []) {
      ensurePhys(st.stationName, undefined, st);
    }
  }

  type LineBuild = {
    line: LineEncoded;
    short: string;
    sourceLn: string;
    kn: string;
    color?: string;
    stationsOrdered: Phys[];
    codesOrdered: string[];
  };

  const builds: LineBuild[] = [];

  for (const raw of mapLines) {
    const ln = String(raw.ln ?? '').trim();
    const kn = String(raw.kn ?? '').trim() || `地铁${ln}号线`;
    const short = officialShortName(ln, kn);
    const lineId = lineIdFromShort(short);
    // Collapse duplicate source rows for the same short badge (e.g. 6支/66).
    if (builds.some((b) => b.short === short || b.line.id === lineId)) {
      const existing = builds.find((b) => b.short === short || b.line.id === lineId);
      if (existing && existing.stationsOrdered.length < 2) {
        // replace placeholder with richer map row below via re-push
        builds.splice(builds.indexOf(existing), 1);
      } else {
        continue;
      }
    }
    const nameEn = lineEnglishName(ln, kn);
    const alias = lineAlias(kn);
    const geometry = mapLineGeometry(raw);
    const list = listByNo.get(ln) ?? listByNo.get(short);

    const line: LineEncoded = {
      id: lineId,
      name: kn.startsWith('地铁')
        ? kn
            .replace(/^地铁/, '')
            .replace(/\(.*\)$/, '')
            .trim() || kn
        : kn,
      names: { zh: kn.replace(/^地铁/, '').trim() || kn, en: nameEn },
      aliases: alias ? [alias] : [],
      color: hexToCss(raw.cl),
      short_name: short,
      mode: lineMode(ln),
      status: 'operating',
      loop: false,
      source_ids: [{ source: 'szmc-shentie-json', id: ln || short }],
      geometry:
        geometry.length >= 2
          ? {
              crs: 'schematic',
              points: geometry.map((p) => ({ x: p.x, y: p.y, crs: 'schematic' as const }))
            }
          : undefined,
      extras: {
        official_name: kn,
        source_line_no: ln,
        names_source: 'source'
      }
    };

    const stationsOrdered: Phys[] = [];
    const codesOrdered: string[] = [];
    const mapSts = raw.st ?? [];
    const listSts = list?.stationList ?? [];

    if (mapSts.length > 0) {
      for (let i = 0; i < mapSts.length; i++) {
        const mst = mapSts[i];
        const zh = (mst.n || '').trim();
        if (!zh) continue;
        const lst =
          foldStationName(listSts[i]?.stationName ?? '') === foldStationName(zh)
            ? listSts[i]
            : listSts.find((s) => foldStationName(s.stationName) === foldStationName(zh));
        const phys = ensurePhys(zh, mst, lst);
        stationsOrdered.push(phys);
        codesOrdered.push(mst.poiid || lst?.stationCode || '');
      }
    } else {
      for (const lst of listSts) {
        const phys = ensurePhys(lst.stationName, undefined, lst);
        stationsOrdered.push(phys);
        codesOrdered.push(lst.stationCode || '');
      }
    }

    if (stationsOrdered.length >= 2) {
      builds.push({
        line,
        short,
        sourceLn: ln,
        kn,
        color: hexToCss(raw.cl),
        stationsOrdered,
        codesOrdered
      });
    } else {
      // Keep short metadata lines even when the map feed omitted stations.
      builds.push({
        line,
        short,
        sourceLn: ln,
        kn,
        color: hexToCss(raw.cl),
        stationsOrdered: [],
        codesOrdered: []
      });
    }
  }

  // Also register list-only lines not present in shentie.json.
  for (const list of input.listLines) {
    const ln = String(list.line);
    const short = officialShortName(ln, list.lineName);
    if (builds.some((b) => b.short === short || b.sourceLn === ln)) continue;
    const lineId = lineIdFromShort(short);
    const stationsOrdered = (list.stationList ?? []).map((st) =>
      ensurePhys(st.stationName, undefined, st)
    );
    builds.push({
      line: {
        id: lineId,
        name: list.lineName,
        names: { zh: list.lineName, en: lineEnglishName(ln, list.lineName) },
        aliases: [],
        short_name: short,
        mode: lineMode(ln),
        status: 'operating',
        loop: false,
        source_ids: [{ source: 'szmc-station-list-js', id: ln }],
        extras: { source_line_no: ln, names_source: 'source' }
      },
      short,
      sourceLn: ln,
      kn: list.lineName,
      stationsOrdered,
      codesOrdered: (list.stationList ?? []).map((s) => s.stationCode || '')
    });
  }

  const lines = builds.map((b) => b.line).sort((a, b) => a.id.localeCompare(b.id));

  const stops: StopEncoded[] = [];
  const patterns: PatternEncoded[] = [];
  const segments: SegmentEncoded[] = [];
  const timetables: TimetableEncoded[] = [];
  const fareCodesByStationId = new Map<string, string>();
  const stationIdByCode = new Map<string, string>();
  const officialLocations = new Map<string, { lon: number; lat: number; crs: 'gcj02' }>();
  const enByZh = new Map<string, string>();
  const ttIds = new Set<string>();

  for (const phys of physByName.values()) {
    const preferred = [...phys.codes].sort()[0];
    if (preferred) {
      fareCodesByStationId.set(phys.id, preferred);
      for (const code of phys.codes) stationIdByCode.set(code, phys.id);
    }
    if (phys.location) officialLocations.set(phys.id, { ...phys.location, crs: 'gcj02' });
    enByZh.set(phys.zh, phys.en || phys.zh);
  }

  // Timetable HTML by line, matched onto stations after stops exist.
  const enTtByLineId = new Map<string, ReturnType<typeof parseEnTimetableHtml>>();

  for (const build of builds) {
    const { line, stationsOrdered, codesOrdered } = build;
    if (stationsOrdered.length < 2) continue;
    const short = build.short;
    const patternId = `${line.id}-pattern-main`;
    const patternStopIds: string[] = [];
    const patternStationIds: string[] = [];

    for (let i = 0; i < stationsOrdered.length; i++) {
      const phys = stationsOrdered[i];
      const code = codesOrdered[i] || [...phys.codes][0] || '';
      const stopId = `${phys.id}-${short === '6支' ? '6z' : readableSlug(short) || asciiSlug(short)}`;
      patternStopIds.push(stopId);
      patternStationIds.push(phys.id);
      stops.push({
        id: stopId,
        station_id: phys.id,
        line_id: line.id,
        sequence: i,
        is_terminal: i === 0 || i === stationsOrdered.length - 1,
        source_id: code || undefined,
        schematic: phys.schematic
          ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' }
          : undefined,
        extras: {
          line_short_name: short,
          station_code: code || undefined
        }
      });
      if (code) {
        stationIdByCode.set(code, phys.id);
        if (!fareCodesByStationId.has(phys.id)) fareCodesByStationId.set(phys.id, code);
      }
    }

    patterns.push({
      id: patternId,
      line_id: line.id,
      name: line.names.zh,
      names: { zh: line.names.zh, en: line.names.en },
      stop_ids: patternStopIds,
      origin_stop_id: patternStopIds[0],
      terminal_stop_id: patternStopIds[patternStopIds.length - 1],
      is_primary: true,
      source_ids: [{ source: 'szmc-shentie-json', id: build.sourceLn || short }],
      extras: { line_short_name: short }
    });

    for (let i = 0; i < patternStopIds.length - 1; i++) {
      const aStop = patternStopIds[i];
      const bStop = patternStopIds[i + 1];
      const a = patternStationIds[i];
      const b = patternStationIds[i + 1];
      segments.push({
        id: `${NETWORK_ID}-seg-${aStop}-${bStop}`,
        line_id: line.id,
        from_stop_id: aStop,
        to_stop_id: bStop,
        from_station_id: a,
        to_station_id: b,
        direction: 'both',
        source_id: 'szmc-shentie-json'
      });
    }

    const enHtml = input.enTimetables[build.sourceLn] ?? input.enTimetables[short];
    if (enHtml) {
      const parsed = parseEnTimetableHtml(enHtml);
      enTtByLineId.set(line.id, parsed);
      const lineStations = stationsOrdered.map((p) => ({
        id: p.id,
        names: { zh: p.zh, en: p.en }
      }));
      const stopByStationId = new Map(patternStationIds.map((sid, i) => [sid, patternStopIds[i]]));

      // Align unmatched EN labels by row order when counts are close.
      const byOrder = parsed.rows.length === stationsOrdered.length;

      for (let r = 0; r < parsed.rows.length; r++) {
        const row = parsed.rows[r];
        const stationId =
          matchStationOnLine(row.stationEn, lineStations) ??
          (byOrder ? stationsOrdered[r].id : undefined);
        if (!stationId) continue;
        const stopId = stopByStationId.get(stationId);
        if (!stopId) continue;
        const phys = physByName.get(
          foldStationName(stationsOrdered.find((s) => s.id === stationId)?.zh ?? '')
        );
        const dest0 = patternStopIds[0];
        const dest1 = patternStopIds[patternStopIds.length - 1];
        const pairs: { dest: string; first?: string; last?: string }[] = [
          { dest: dest0, first: row.dir0First, last: row.dir0Last },
          { dest: dest1, first: row.dir1First, last: row.dir1Last }
        ];
        for (const pair of pairs) {
          if (!pair.first && !pair.last) continue;
          if (pair.first === '--' || pair.last === '--') {
            if (!pair.first || pair.first === '--' || !pair.last || pair.last === '--') {
              // Terminal direction may legitimately have one side missing.
              if (!pair.first || pair.first === '--') continue;
            }
          }
          const id = `${NETWORK_ID}-${stationId}-${asciiSlug(short)}-to-${asciiSlug(
            pair.dest.replace(`${NETWORK_ID}-`, '')
          )}-en`;
          if (ttIds.has(id)) continue;
          ttIds.add(id);
          timetables.push({
            id,
            station_id: stationId,
            stop_id: stopId,
            line_id: line.id,
            station_code: [...(phys?.codes ?? [])].sort()[0],
            source_id: `szmc-en-timetable-${build.sourceLn || short}`,
            destination_stop_id: pair.dest,
            pattern_id: patternId,
            first_train: pair.first && pair.first !== '--' ? [pair.first] : [],
            last_train: pair.last && pair.last !== '--' ? [pair.last] : [],
            service: 'all_days',
            direction_type: 'linear',
            extras: {
              en_label: row.stationEn,
              directions: parsed.directions
            }
          });
        }
      }
    }
  }

  const stations: StationEncoded[] = [];
  const stopStationIds = new Set(stops.map((s) => s.station_id));
  for (const phys of physByName.values()) {
    if (!stopStationIds.has(phys.id)) continue;
    stations.push({
      id: phys.id,
      name: phys.zh,
      names: { zh: phys.zh, en: phys.en || phys.zh },
      location: phys.location
        ? { lon: phys.location.lon, lat: phys.location.lat, crs: 'gcj02' }
        : undefined,
      schematic: phys.schematic
        ? { x: phys.schematic.x, y: phys.schematic.y, crs: 'schematic' }
        : undefined,
      status: coerceStationStatus(phys.status),
      source_ids: phys.codes.size
        ? [...phys.codes].map((c) => ({ source: 'szmc-station-code', id: c }))
        : [{ source: 'szmc-station-list-js', id: phys.zh }],
      extras: {
        official_codes: [...phys.codes].sort(),
        pinyin: phys.pinyin || undefined,
        facilities: [...phys.facilities].sort(),
        location_source: phys.location ? 'official' : undefined
      }
    });
  }

  const transfers: TransferEncoded[] = [];

  return {
    network: {
      id: NETWORK_ID,
      name: '深圳地铁',
      names: { zh: '深圳地铁', en: 'Shenzhen Metro' },
      city: placeholderCity('CN-4403'),
      country_code: 'CN',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      coordinate_system: 'gcj02',
      default_units: { distance: 'km', time: 'seconds', speed: 'km/h' },
      routing: {
        weight: 'time',
        // Official planner samples report ~360s same-station interchange.
        default_transfer_seconds: 360,
        max_transfer_seconds: 900
      },
      notes:
        '深圳地铁票价实行里程分段计价，同网同价：首4公里2元；4–12公里每4公里加1元；12–24公里每6公里加1元；超过24公里每8公里加1元。'
    },
    lines,
    stations,
    stops,
    patterns,
    segments,
    transfers,
    timetables: timetables.filter(hasValidTimes),
    fareCodesByStationId,
    officialLocations,
    enByZh,
    stationIdByCode
  };
}
