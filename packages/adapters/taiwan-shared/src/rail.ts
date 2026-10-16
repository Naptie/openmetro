import { fetchRailResource, type OsmFeed, type RailResourceSource } from '@openmetro/core';

/** Operator identity is filtered by the caller before station-name matching. */
export async function fetchRailOsm(cacheDir: string) {
  const query =
    '[out:json][timeout:35];(node["railway"="station"](21.8,120,25.4,122.1);node["railway"="halt"](21.8,120,25.4,122.1););out body;';
  const endpoints = process.env.OVERPASS_URL?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  let result: { resource: Awaited<ReturnType<typeof fetchRailResource>>; osm: OsmFeed } | undefined;
  let failure: unknown;
  const parse = (bytes: Uint8Array): OsmFeed => {
    const osm = JSON.parse(new TextDecoder().decode(bytes)) as OsmFeed;
    if (!osm.elements?.length || osm.remark || !osm.osm3s?.timestamp_osm_base)
      throw new Error('Incomplete rail station enrichment');
    return osm;
  };
  for (const endpoint of endpoints) {
    try {
      const resource = await fetchRailResource(
        endpoint,
        cacheDir,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: query }).toString()
        },
        parse
      );
      const osm = parse(resource.bytes);
      result = { resource, osm };
      break;
    } catch (error) {
      failure = error;
      if (
        (error as { permanent?: boolean; status?: number }).permanent ||
        (error as { status?: number }).status === 429
      )
        throw error;
    }
  }
  if (!result) throw failure ?? new Error('No Overpass endpoint configured');
  const { resource, osm } = result;
  const source: RailResourceSource = {
    ...resource.source,
    name: 'OpenStreetMap rail stations',
    license: 'odbl',
    license_url: 'https://www.openstreetmap.org/copyright',
    attribution: '© OpenStreetMap contributors',
    version: osm.osm3s!.timestamp_osm_base!,
    osm_base: osm.osm3s!.timestamp_osm_base!
  };
  return { osm, source };
}

export function railServiceDate(date = new Date()): string {
  const override = process.env.OPENMETRO_SERVICE_DATE;
  const value =
    override ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error(`Invalid rail service date ${value}`);
  return value;
}
