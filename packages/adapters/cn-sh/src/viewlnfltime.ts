import { officialFetchHeaders, proxyUrl } from '@openmetro/core';

const BASE = 'https://m.shmetro.com/workspace/shmetrotest/view_lnfltime.aspx';

export interface FlTimeRow {
  stationName: string;
  directionLabel: string; // e.g. "往富锦路"
  firstTime: string;
  lastTime: string; // data-normal (weekday-common last train)
  adjust?: string; // URL-encoded data-adjust JSON (weekday/datetime extensions)
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(proxyUrl(url), { headers: officialFetchHeaders() });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/** Parse the station table from the per-line timetable HTML. */
export function parseFlTimeTable(html: string): FlTimeRow[] {
  const rows = html.split('<tr');
  const out: FlTimeRow[] = [];
  let curStation: string | null = null;
  for (const r of rows) {
    const stname = /class="stname">([^<]+)<\/td>/.exec(r);
    if (stname) curStation = stname[1];
    const dirn = /class="stdirt">.*?<span[^>]*>([^<]+)<\/span>/.exec(r);
    const sttime = /class="sttime"><div>([0-9:]+)\/<span[^>]*data-normal="([0-9:]+)"([^>]*)>/.exec(
      r
    );
    if (curStation && dirn && sttime) {
      const adjustMatch = /data-adjust="([^"]*)"/.exec(sttime[3]);
      out.push({
        stationName: curStation,
        directionLabel: dirn[1].trim(),
        firstTime: sttime[1],
        lastTime: sttime[2],
        adjust: adjustMatch ? adjustMatch[1] : undefined
      });
    }
  }
  return out;
}

/**
 * Extract the human-readable branch note from a line's timetable page, e.g.
 * "11号线嘉定北站~迪士尼站为主线段，花桥站~嘉定新城站为支线段。". Returns
 * undefined for lines without a branch.
 */
export function parseBranchNote(html: string): string | undefined {
  const m = />([^<]*支线段[^<]*)</.exec(html);
  return m ? m[1].trim() : undefined;
}

/**
 * Official display name for the selected line from the timetable page header
 * (e.g. "1号线", "浦江线", "市域机场线"). The `func=lines` map endpoint only
 * returns line numbers and colors — names live here instead.
 */
export function parseLineName(html: string): string | undefined {
  const header = /class="shvsilnname">\s*<span class="stxt">([^<]+)<\/span>/.exec(html);
  if (header?.[1]) return header[1].trim();
  const option = /<option selected="selected" value="[^"]*">([^<]+)<\/option>/.exec(html);
  return option?.[1]?.trim();
}

/** A line's parsed first/last table, official name, and branch note. */
export interface LineFlTime {
  rows: FlTimeRow[];
  name?: string;
  note?: string;
}

/** Fetch and parse the per-line first/last timetable pages. */
export async function fetchAllLines(
  lineNos: string[],
  opts: { delayMs?: number } = {}
): Promise<Map<string, LineFlTime>> {
  const delayMs = opts.delayMs ?? 150;
  const out = new Map<string, LineFlTime>();
  for (const ln of lineNos) {
    try {
      const html = await fetchText(`${BASE}?ln=${encodeURIComponent(ln)}`);
      out.set(ln, {
        rows: parseFlTimeTable(html),
        name: parseLineName(html),
        note: parseBranchNote(html)
      });
    } catch {
      // skip failed line
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}
