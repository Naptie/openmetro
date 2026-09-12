import { spawn } from "node:child_process";
import { officialFetchHeaders, proxyUrl } from "@openmetro/core";
import type { GzLineCard, GzServiceTime, GzStationDetail } from "./normalize.js";

const BASE = "https://apis.gzmtr.com";
const ACCESSKEY = "247919A174804353AE72BAB00981C6E8";
const TOKEN = "38c7e7b3ka1f3k44dak8707k806a1f8bf978";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function curlPostJson(url: string): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "-sS",
      "-L",
      "--max-time",
      "90",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${TOKEN}`,
      "-H",
      "Content-Type: application/json",
      "-H",
      "Accept: application/json",
      "-H",
      "Accept-Encoding: identity",
      url,
    ];
    const child = spawn("curl", args, { windowsHide: true });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const body = Buffer.concat(chunks).toString("utf-8");
      if (code !== 0) {
        reject(
          new Error(
            `curl exited ${code}: ${Buffer.concat(errChunks).toString("utf-8").trim()} body=${body.slice(0, 120)}`,
          ),
        );
        return;
      }
      try {
        resolvePromise(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function postJson(path: string, retries = 4): Promise<unknown> {
  const url = proxyUrl(`${BASE}${path}?auto_type=key&acccesskey=${ACCESSKEY}`);
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (process.env.OPENMETRO_REVERSE_PROXY) {
        // Proxy responses can carry broken content-encoding for Bun's fetch.
        return await curlPostJson(url);
      }
      const res = await fetch(url, {
        method: "POST",
        headers: officialFetchHeaders({
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      const delay = 400 * 2 ** attempt;
      console.log(`  retry ${attempt + 1}/${retries} in ${delay}ms: ${err}`);
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fetch service times (first/last train) for every station. */
export async function fetchServiceTimes(
  stationNames: string[],
  opts: { delayMs?: number; concurrency?: number } = {},
): Promise<Record<string, GzServiceTime[]>> {
  const delayMs = opts.delayMs ?? 250;
  const concurrency = opts.concurrency ?? 2;
  const result: Record<string, GzServiceTime[]> = {};
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= stationNames.length) return;
      const name = stationNames[i];
      try {
        const raw = (await postJson(`/app-map/serviceTime/list/${encodeURIComponent(name)}`)) as {
          businessObject?: GzServiceTime[];
        };
        result[name] = raw.businessObject ?? [];
      } catch {
        // skip failed station
      }
      await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return result;
}

interface LinestationCard {
  stations: { stationName: string; stationShowCode?: string }[];
}

export interface GuangzhouSources {
  linestation: { businessObject: GzLineCard[] };
  stationDetails: Record<string, GzStationDetail>;
  servicetimes: Record<string, GzServiceTime[]>;
}

/** Fetch Guangzhou topology + service times + station details live. */
export async function fetchGuangzhouSources(): Promise<GuangzhouSources> {
  console.log("  fetch linestation");
  const linestation = (await postJson("/app-map/metroweb/linestation")) as {
    businessObject: LinestationCard[];
  };

  const names = [
    ...new Set(linestation.businessObject.flatMap((c) => c.stations.map((s) => s.stationName))),
  ];

  console.log(`  fetch service times (${names.length} stations)`);
  const servicetimes = await fetchServiceTimes(names, { delayMs: 200, concurrency: 3 });

  console.log("  fetch station details");
  const stationDetails: Record<string, GzStationDetail> = {};
  for (const name of names) {
    try {
      const raw = (await postJson(
        `/app-map/station/getByNameOrCode/${encodeURIComponent(name)}`,
      )) as {
        businessObject?: GzStationDetail;
      };
      const detail = raw.businessObject ?? (raw as unknown as GzStationDetail);
      if (detail?.nameCN) stationDetails[detail.nameCN] = detail;
    } catch {
      // optional enrichment
    }
  }
  console.log(`  fetched ${Object.keys(stationDetails).length} station detail(s)`);

  return {
    linestation: linestation as unknown as { businessObject: GzLineCard[] },
    stationDetails,
    servicetimes,
  };
}
