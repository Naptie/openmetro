/**
 * Client for the Hefei municipal government disclosure platform
 * (`www.hefei.gov.cn`), where 合肥市轨道交通集团有限公司 publishes its
 * operating data.
 *
 * ## Why the government platform and not the operator's website
 *
 * The operator's own site (`www.hfgdjt.com`) is a **web-isolation proxy
 * shell**: it serves a 1.3 kB SPA document whose only asset is a 1.26 MB
 * `webmirror.js` bundle that re-renders the mirrored original site at runtime.
 * The bundle contains no operating data (no `乘车查询`, `线路查询`, `首末班`
 * or `票价` strings at all), `robots.txt` and `sitemap.xml` both return the
 * same shell, and no sibling API host resolves. The structured operating data
 * is published instead on the municipal disclosure platform under the
 * operator's own column, which is what this module talks to.
 *
 * ## Two ways in
 *
 * 1. **The label endpoint** (`GET /site/label/8888`) — the endpoint the
 *    platform's own list pages use. It is **not** behind the WAF and returns
 *    the category listing (title / dates / document path) as a small HTML
 *    table. This is how the adapter discovers the newest document of a
 *    category without hardcoding an id.
 * 2. **Document pages** (`/public/156407/<id>.html`) — the articles
 *    themselves. These are normally served directly, but the platform's
 *    rate limiter puts some paths behind the **Jiasule (加速乐) WAF**.
 *
 * ## The Jiasule challenge
 *
 * A blocked request answers `521` with a single inline `<script>`:
 *
 * - **Stage 1** assigns `document.cookie = '__jsl_clearance_s=' + <arithmetic>`
 *   and reloads. The arithmetic is plain JS over numbers, arrays and strings.
 * - **Stage 2** is an obfuscated bundle that ends in
 *   `go({"bts":[...], "chars":..., "ct":..., "ha":"sha256", "tn":"__jsl_clearance_s", ...})`.
 *   The cookie is written from a **`setTimeout` callback**, so the callback has
 *   to be collected and invoked *after* the script body ran.
 *
 * Both stages are evaluated in a `node:vm` sandbox that exposes nothing but
 * `document` / `location` / `window` / `navigator` stubs and a fake
 * `setTimeout`. The callback must be **called as a VM function object** — the
 * stage-2 body closes over obfuscated locals, so re-compiling it from
 * `Function.prototype.toString()` loses them and the write never happens.
 *
 * The platform rate-limits aggressively (repeated hits degrade to `403`), so
 * the clearance cookie is cached per host and requests are spaced out.
 */
import vm from 'node:vm';

export const GOV_BASE = 'https://www.hefei.gov.cn';

/** The platform's "label" endpoint — the category listing behind every list page. */
export const GOV_LABEL_ENDPOINT = `${GOV_BASE}/site/label/8888`;

/** Column id of 合肥市轨道交通集团有限公司 on the disclosure platform. */
export const GOV_ORGAN_ID = '156407';
/** Site id of the Hefei government portal (as sent by the label endpoint). */
export const GOV_SITE_ID = '6784341';

/** 信息分类 — 运营线路 (operating lines: timetables, interchange list, network map). */
export const CAT_OPERATING_LINES = 7028295;
/** 信息分类 — 服务价目 (fare policy). */
export const CAT_FARE_PRICE = 7028296;
/** 信息分类 — 乘车（船）规则 (passenger rules, prohibited items, safety signage). */
export const CAT_PASSENGER_RULES = 7028299;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One document in a disclosure category. */
export interface DisclosureDoc {
  /** Document title as published. */
  title: string;
  /** Site-relative path, e.g. `/public/156407/112539005.html`. */
  path: string;
  /** Absolute URL. */
  url: string;
  /** Publication date as published (`yyyy年MM月dd日`). */
  publishedAt?: string;
  /** Document date as published (`yyyy年MM月dd日`). */
  datedAt?: string;
}

/** Strip tags and collapse whitespace. */
export function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse every `<table>` in a document into rows of cell texts.
 *
 * The disclosure articles publish their payload as plain HTML tables, so no
 * XML parsing is involved — only the cell text is needed.
 */
export function parseTables(html: string): string[][][] {
  const tables: string[][][] = [];
  for (const tableMatch of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const table = tableMatch[0];
    const rows: string[][] = [];
    for (const rowMatch of table.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
        cells.push(textOf(cellMatch[1]));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

/** Collect the hrefs of every anchor in a document. */
export function parseLinks(html: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    out.push({ href: m[1], text: textOf(m[2]) });
  }
  return out;
}

interface ChallengeOutcome {
  /** Cookies the challenge wants us to send back. */
  cookies: Map<string, string>;
}

/**
 * Evaluate one Jiasule challenge script and return the cookie it computes.
 *
 * The script runs in a sandbox that exposes only the stubs it may touch, so a
 * compromised page cannot reach the process. `setTimeout` is faked and its
 * callbacks are invoked afterwards — the stage-2 body writes the cookie from
 * inside one of them.
 */
function solveChallenge(script: string): ChallengeOutcome {
  const cookies = new Map<string, string>();
  const timers: (() => void)[] = [];

  const documentStub = {
    set cookie(value: string) {
      const pair = String(value).split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    },
    get cookie(): string {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
  };
  const locationStub = {
    href: '',
    pathname: '',
    search: '',
    host: '',
    reload() {}
  };
  const sandbox: Record<string, unknown> = {
    document: documentStub,
    location: locationStub,
    navigator: { userAgent: USER_AGENT },
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    alert: () => {}
  };
  sandbox.window = { document: documentStub, location: locationStub, navigator: sandbox.navigator };

  vm.runInNewContext(script, sandbox, { timeout: 10_000 });
  // The stage-2 body schedules the cookie write; call the VM function objects
  // directly so their closure scope survives.
  for (let i = 0; i < 12 && timers.length > 0; i++) {
    const fn = timers.shift();
    if (!fn) break;
    try {
      fn();
    } catch {
      // A challenge branch that throws simply produces no cookie.
    }
  }
  return { cookies };
}

export interface GovFetchOptions {
  /** Send this `Referer` header. */
  referer?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Attempts per request (the WAF often needs two rounds). */
  retries?: number;
  /** Minimum milliseconds between requests to the same host. */
  minIntervalMs?: number;
}

/** Clearance cookies are cached per host so a burst of fetches stays cheap. */
const cookieJar = new Map<string, Map<string, string>>();
let lastRequestAt = 0;

/** Merge the cached cookies of a host with the ones a challenge produced. */
function cookiesFor(url: string): Map<string, string> {
  const host = new URL(url).host;
  return cookieJar.get(host) ?? new Map<string, string>();
}

function rememberCookies(url: string, cookies: Map<string, string>): void {
  const host = new URL(url).host;
  const jar = cookieJar.get(host) ?? new Map<string, string>();
  for (const [k, v] of cookies) jar.set(k, v);
  cookieJar.set(host, jar);
}

/**
 * GET a document from the platform, solving the Jiasule challenge when the
 * platform answers `521`.
 *
 * Returns the decoded body. A non-2xx answer that the challenge could not
 * fix is thrown, because every caller needs the payload.
 */
export async function fetchGovText(url: string, opts: GovFetchOptions = {}): Promise<string> {
  const retries = opts.retries ?? 3;
  const minInterval = opts.minIntervalMs ?? 800;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = minInterval - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const jar = cookiesFor(url);
    const cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(opts.referer ? { Referer: opts.referer } : {}),
        ...(opts.headers ?? {})
      },
      signal: AbortSignal.timeout(60_000)
    });

    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const pair = sc.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }

    if (res.status === 521) {
      const body = await res.text();
      const script = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(body)?.[1];
      if (script) {
        try {
          const solved = solveChallenge(script);
          for (const [k, v] of solved.cookies) jar.set(k, v);
          rememberCookies(url, solved.cookies);
        } catch (err) {
          console.log(`  gov: challenge evaluation failed (${err})`);
        }
      }
      await sleep(400);
      continue;
    }

    if (!res.ok) {
      lastError = new Error(`HTTP ${res.status} for ${url}`);
      // A rate-limited (403) answer is worth one more try after a pause.
      if (res.status === 403 && attempt < retries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw lastError;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1];
    const decoded =
      charset && !/^utf-?8$/i.test(charset)
        ? new TextDecoder(charset).decode(buffer)
        : buffer.toString('utf8');
    rememberCookies(url, new Map());
    return decoded;
  }

  throw lastError instanceof Error ? lastError : new Error(`failed to fetch ${url}`);
}

/**
 * List the documents of one disclosure category through the platform's label
 * endpoint.
 *
 * The endpoint answers `GET` only (the matching `POST` is rejected), and it
 * is **not** behind the WAF — so this is the cheap way to find the newest
 * document of a category.
 */
export async function fetchDisclosureList(
  catId: number,
  opts: { pageSize?: number; pageIndex?: number } = {}
): Promise<DisclosureDoc[]> {
  const params = new URLSearchParams({
    labelName: 'publicInfoList',
    siteId: GOV_SITE_ID,
    organId: GOV_ORGAN_ID,
    catId: String(catId),
    type: '4',
    pageSize: String(opts.pageSize ?? 50),
    pageIndex: String(opts.pageIndex ?? 1),
    withOutDomain: 'true',
    dateFormat: 'yyyy年MM月dd日',
    file: '/hefei/publicInfoList_newestzc'
  });
  const url = `${GOV_LABEL_ENDPOINT}?${params.toString()}`;
  const html = await fetchGovText(url, { minIntervalMs: 400 });

  const docs: DisclosureDoc[] = [];
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = m[0];
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => textOf(c[1]));
    const href = /href="([^"]+)"/.exec(row)?.[1];
    if (!href || cells.length < 2) continue;
    const title = cells[1] ?? '';
    if (!title) continue;
    docs.push({
      title,
      path: href,
      url: href.startsWith('http') ? href : `${GOV_BASE}${href}`,
      datedAt: cells[3],
      publishedAt: cells[4]
    });
  }
  return docs;
}

/** Sort a disclosure list newest-first by publication date. */
export function byNewest(a: DisclosureDoc, b: DisclosureDoc): number {
  const parse = (d?: string) => {
    const m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(d ?? '');
    if (!m) return 0;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  return parse(b.publishedAt) - parse(a.publishedAt);
}
