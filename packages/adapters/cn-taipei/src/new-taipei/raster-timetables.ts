import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { type Canvas, createCanvas } from '@napi-rs/canvas';
import { adapterCacheDir, fetchFeed } from '@openmetro/core';
import { createWorker, PSM } from 'tesseract.js';
import type { DepartureWindow } from './normalize.js';
import {
  type CellReader,
  type LabelReader,
  readFareTriangle,
  readRuntimeMatrix,
  readStationTimetable
} from './raster-tables.js';

function clusters(values: number[], gap = 4): number[][] {
  const groups: number[][] = [];
  for (const n of values) {
    const group = groups.at(-1);
    if (group && n - group.at(-1)! <= gap) group.push(n);
    else groups.push([n]);
  }
  return groups;
}
const centers = (values: number[]) =>
  clusters(values).map((g) => Math.round(g.reduce((a, b) => a + b, 0) / g.length));

/**
 * Automatic digit OCR of the operator's two-column timetable grids. Grid lines
 * locate cells; 06..00 hour labels and confidence/format checks reject changed
 * or ambiguous layouts. No station-specific times, pixel boxes or file hashes
 * are maintained. SHA256 is only a cache key, so changed PDFs are re-read.
 */
export async function createTimetableOcr() {
  const cache = join(adapterCacheDir('cn-new-taipei'), 'ocr');
  const model = process.env.OPENMETRO_OCR_MODEL_DIR ?? cache;
  await mkdir(cache, { recursive: true });
  await mkdir(model, { recursive: true });
  const languages = ['eng', 'chi_tra'].map((lang) => join(model, `${lang}.traineddata.gz`));
  const modelBytes: Uint8Array[] = [];
  for (const [i, language] of languages.entries()) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(language);
      gunzipSync(bytes);
    } catch {
      bytes = await fetchFeed(
        `https://tessdata.projectnaptha.com/4.0.0/${['eng', 'chi_tra'][i]}.traineddata.gz`
      );
      gunzipSync(bytes);
      const temporary = `${language}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, language);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    modelBytes.push(bytes);
  }
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let chinese: Awaited<ReturnType<typeof createWorker>> | undefined;
  const modelHash = createHash('sha256')
    .update(Buffer.concat(modelBytes))
    .digest('hex')
    .slice(0, 12);
  let queue = Promise.resolve();

  // Read semantic labels without telling OCR which station or time to expect.
  // The source must independently identify exactly one allowed label.
  const readLabel: LabelReader = async (canvas, [left, top, right, bottom], labels, kind) => {
    let whiteInk = false;
    if (kind.endsWith('code')) {
      const data = canvas.getContext('2d').getImageData(left, top, right - left, bottom - top).data;
      {
        let light = 0,
          dark = 0;
        for (let p = 0; p < data.length; p += 4) {
          if (Math.min(data[p]!, data[p + 1]!, data[p + 2]!) > 210) light++;
          if (Math.max(data[p]!, data[p + 1]!, data[p + 2]!) < 170) dark++;
        }
        // A dark background can occupy most pixels; choose its contrasting ink.
        whiteInk = dark > data.length / 8 ? true : light > data.length / 8 ? false : light > dark;
      }
      const inkRows: number[] = [];
      for (let y = 0; y < bottom - top; y++) {
        let count = 0;
        for (let x = 0; x < right - left; x++) {
          const p = (y * (right - left) + x) * 4;
          const ink = whiteInk
            ? Math.min(data[p]!, data[p + 1]!, data[p + 2]!) > 210
            : Math.max(data[p]!, data[p + 1]!, data[p + 2]!) < 170;
          if (ink) count++;
        }
        if (count >= 2) inkRows.push(y);
      }
      const bands = clusters(inkRows, 2).filter((g) => g.length >= 3);
      const band = kind === 'white-code' ? bands[0] : bands.at(-1);
      if (!band) throw new Error('Official station code label is empty');
      const originalTop = top;
      top = Math.max(top, originalTop + band[0]! - 2);
      bottom = Math.min(bottom, originalTop + band.at(-1)! + 3);
    }
    const scale = kind.endsWith('code')
      ? Math.max(1, Math.min(3, Math.floor(90 / (bottom - top))))
      : 3;
    const crop = createCanvas((right - left + 24) * scale, (bottom - top + 24) * scale),
      ctx = crop.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, crop.width, crop.height);
    ctx.drawImage(
      canvas,
      left,
      top,
      right - left,
      bottom - top,
      12 * scale,
      12 * scale,
      (right - left) * scale,
      (bottom - top) * scale
    );
    const variants = [crop];
    if (kind.endsWith('code')) {
      if (whiteInk) {
        const inverted = createCanvas(crop.width, crop.height),
          invertedContext = inverted.getContext('2d');
        invertedContext.drawImage(crop, 0, 0);
        const pixels = ctx.getImageData(
          12 * scale,
          12 * scale,
          (right - left) * scale,
          (bottom - top) * scale
        );
        for (let i = 0; i < pixels.data.length; i += 4) {
          const value =
            255 -
            Math.max(
              0,
              Math.min(
                255,
                ((Math.min(pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!) - 100) *
                  255) /
                  155
              )
            );
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
        }
        invertedContext.putImageData(pixels, 12 * scale, 12 * scale);
        variants.push(inverted);
        if (scale > 1) {
          const smaller = createCanvas(
            Math.round((inverted.width * (scale - 1)) / scale),
            Math.round((inverted.height * (scale - 1)) / scale)
          );
          smaller.getContext('2d').drawImage(inverted, 0, 0, smaller.width, smaller.height);
          variants.push(smaller);
        }
      }
      const binary = createCanvas(crop.width, crop.height),
        binaryContext = binary.getContext('2d');
      binaryContext.drawImage(crop, 0, 0);
      const pixels = ctx.getImageData(
        12 * scale,
        12 * scale,
        (right - left) * scale,
        (bottom - top) * scale
      );
      for (let i = 0; i < pixels.data.length; i += 4) {
        const ink = whiteInk
          ? Math.min(pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!) > 210
          : Math.max(pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!) < 170;
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = ink ? 0 : 255;
      }
      binaryContext.putImageData(pixels, 12 * scale, 12 * scale);
      variants.push(binary);
    }
    const engines =
      kind === 'name'
        ? [
            worker!,
            (chinese ??= await createWorker('chi_tra', 1, {
              langPath: model,
              cacheMethod: 'none',
              gzip: true
            }))
          ]
        : [worker!];
    const fold = (text: string) =>
      text
        .toLowerCase()
        .replaceAll('臺', '台')
        .replace(/[^a-z0-9\p{Script=Han}]/gu, '');
    const readings: { text: string; confidence: number; key?: string }[] = [];
    const aliases = Object.fromEntries(
      Object.entries(labels).map(([key, value]) => [
        key,
        typeof value === 'string' ? [value] : value
      ])
    );
    for (const engine of engines)
      for (const variant of variants)
        for (const mode of [PSM.SINGLE_BLOCK, PSM.SINGLE_LINE, PSM.SPARSE_TEXT]) {
          await engine.setParameters({
            tessedit_char_whitelist: '',
            tessedit_pageseg_mode: mode,
            user_defined_dpi: '300'
          });
          const { data } = await engine.recognize(
            variant.toBuffer('image/png'),
            {},
            { blocks: true }
          );
          let keys: string[];
          if (kind.endsWith('code')) {
            keys = [...data.text.toUpperCase().matchAll(/\b(LB|V|K|Y)\s*([0-9OI]{2})\b/g)].map(
              (m) => `${m[1]}${m[2]!.replaceAll('O', '0').replaceAll('I', '1')}`
            );
            keys = [...new Set(keys)];
          } else {
            const hits = Object.entries(aliases).flatMap(([key, values]) =>
              values
                .filter((value) => fold(data.text).includes(fold(value)))
                .map((value) => ({ key, value: fold(value) }))
            );
            // Combined headings must not be mistaken for one of their components
            // (for example Weekdays/Holidays is not a weekday-only column).
            keys = [
              ...new Set(
                hits
                  .filter(
                    (hit) =>
                      !hits.some(
                        (other) =>
                          other.value.length > hit.value.length && other.value.includes(hit.value)
                      )
                  )
                  .map((hit) => hit.key)
              )
            ];
          }
          const key = keys.length === 1 ? keys[0] : undefined;
          let confidence = data.confidence;
          if (key && aliases[key]) {
            const words = (data.blocks ?? []).flatMap((b) =>
              b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words.flatMap((w) => w.symbols)))
            );
            let offset = 0;
            const spans = words.map((word) => {
              const start = offset;
              offset += fold(word.text).length;
              return { start, end: offset, confidence: word.confidence };
            });
            let normalized = words.map((word) => fold(word.text)).join('');
            if (kind.endsWith('code'))
              normalized = normalized.replace(
                /(lb|v|k|y)([0-9oi]{2})/g,
                (_m, prefix: string, digits: string) =>
                  prefix + digits.replaceAll('o', '0').replaceAll('i', '1')
              );
            const alias = aliases[key]!.find((value) => normalized.includes(fold(value)));
            const start = alias ? normalized.indexOf(fold(alias)) : -1,
              end = start + (alias ? fold(alias).length : 0);
            const relevant = spans.filter((span) => span.end > start && span.start < end);
            if (start >= 0 && relevant.length)
              confidence = Math.min(...relevant.map((span) => span.confidence));
          }
          readings.push({ text: data.text.trim(), confidence, key });
        }
    const accepted = readings.filter((r) => r.key && r.confidence >= 60);
    const keys = new Set(accepted.map((r) => r.key));
    if (
      keys.size === 1 &&
      labels[accepted[0]!.key!] &&
      (accepted.length >= 2 || accepted.some((r) => r.confidence >= 85))
    )
      return accepted[0]!.key!;
    const consensus = readings.filter((r) => r.key && r.confidence >= 50);
    if (
      kind.endsWith('code') &&
      consensus.length >= 3 &&
      labels[consensus[0]!.key!] &&
      new Set(consensus.map((r) => r.key)).size === 1
    )
      return consensus[0]!.key!;
    await writeFile(
      join(cache, `uncertain-label-${kind}-${left}-${top}.png`),
      crop.toBuffer('image/png')
    );
    throw new Error(
      `Unconfirmed official ${kind} identity at ${left},${top}: ${JSON.stringify(readings)}`
    );
  };

  const readCell: CellReader = async (canvas, [left, top, right, bottom], kind) => {
    // Excessive resampling changes the small timetable font's 7 into a 1.
    // Keep time cells at 2x; the smaller matrix digits need 3x.
    const scale = kind === 'time' ? 2 : 3;
    const crop = createCanvas((right - left + 24) * scale, (bottom - top + 24) * scale),
      ctx = crop.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, crop.width, crop.height);
    ctx.drawImage(
      canvas,
      left,
      top,
      right - left,
      bottom - top,
      12 * scale,
      12 * scale,
      (right - left) * scale,
      (bottom - top) * scale
    );
    const candidates: { text: string; confidence: number }[] = [];
    for (const mode of [PSM.SINGLE_LINE, PSM.RAW_LINE, PSM.SINGLE_BLOCK]) {
      await worker!.setParameters({
        tessedit_char_whitelist: kind === 'time' ? '0123456789:' : '0123456789',
        tessedit_pageseg_mode: mode
      });
      const result = await worker!.recognize(crop.toBuffer('image/png'));
      let text = result.data.text.replace(/\s+/g, '');
      if (kind === 'time') {
        const m = /^(\d{2}):?(\d{2})$/.exec(text);
        if (!m || Number(m[1]) > 26 || Number(m[2]) > 59) continue;
        text = `${m[1]}:${m[2]}`;
      } else if (!/^\d{1,3}$/.test(text)) continue;
      if (kind === 'fare' && (Number(text) < 5 || Number(text) > 300 || Number(text) % 5 !== 0))
        continue;
      candidates.push({ text, confidence: result.data.confidence });
    }
    const votes = new Map<string, number>();
    for (const c of candidates)
      if (c.confidence >= 60) votes.set(c.text, (votes.get(c.text) ?? 0) + 1);
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    if (ranked[0] && ranked[0][1] >= 2 && (ranked[1]?.[1] ?? 0) < ranked[0][1]) return ranked[0][0];
    if (
      kind !== 'time' &&
      candidates.length >= 2 &&
      new Set(candidates.map((c) => c.text)).size === 1 &&
      Math.max(...candidates.map((c) => c.confidence)) >= 85
    )
      return candidates[0]!.text;
    const strong = candidates.filter((c) => c.confidence >= 90);
    if (strong.length && new Set(strong.map((c) => c.text)).size === 1) return strong[0]!.text;
    if (
      kind === 'fare' &&
      candidates.length &&
      new Set(candidates.map((c) => c.text)).size === 1 &&
      Math.max(...candidates.map((c) => c.confidence)) >= 80
    )
      return candidates[0]!.text;
    await writeFile(
      join(cache, `uncertain-table-${kind}-${left}-${top}.png`),
      crop.toBuffer('image/png')
    );
    throw new Error(
      `Ambiguous official ${kind} cell ${left},${top}: ${JSON.stringify(candidates)}`
    );
  };
  function table<T>(
    kind: string,
    bytes: Uint8Array,
    context: unknown,
    work: (digest: string) => Promise<T>
  ): Promise<T> {
    const result = queue.then(async () => {
      const digest = createHash('sha256').update(bytes).digest('hex'),
        path = join(cache, `result-v1-${modelHash}-${kind}-${digest}.json`);
      try {
        const saved = JSON.parse(await readFile(path, 'utf8'));
        if (
          !process.env.OPENMETRO_OCR_REFRESH &&
          JSON.stringify(saved.context) === JSON.stringify(context)
        )
          return saved.value as T;
      } catch {}
      worker ??= await createWorker('eng', 1, {
        langPath: model,
        cacheMethod: 'none',
        gzip: true
      });
      const value = await work(digest);
      await writeFile(path, JSON.stringify({ context, value }));
      return value;
    });
    queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async function recognize(
    bytes: Uint8Array,
    destinations: string[],
    stationCode: string,
    digest: string
  ): Promise<DepartureWindow[]> {
    const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdf.GlobalWorkerOptions.workerSrc = import.meta.resolve(
      'pdfjs-dist/legacy/build/pdf.worker.mjs'
    );
    const task = pdf.getDocument({
      data: new Uint8Array(bytes),
      disableFontFace: true,
      useSystemFonts: false
    });
    let canvas: Canvas;
    try {
      const document = await task.promise;
      if (document.numPages !== 1) throw new Error('Timetable PDF must contain one station page');
      const page = await document.getPage(1);
      const viewport = page.getViewport({ scale: 1240 / page.getViewport({ scale: 1 }).width });
      canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({
        canvas: canvas as never,
        canvasContext: canvas.getContext('2d') as never,
        viewport
      }).promise;
    } finally {
      await task.destroy();
    }
    const w = canvas.width,
      h = canvas.height,
      context = canvas.getContext('2d');
    if (!/^Y\d{2}$/.test(stationCode))
      throw new Error('Expected official PDF station identity is required');
    // The code sits inside the circular station badge, above the timetable.
    // Exclude its enclosing ring, which otherwise joins the three glyphs.
    await readLabel(
      canvas,
      [Math.round(w * 0.06), Math.round(h * 0.045), Math.round(w * 0.145), Math.round(h * 0.075)],
      { [stationCode]: stationCode },
      'code'
    );
    const pixels = context.getImageData(0, 0, w, h).data;
    const dark = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return pixels[i]! < 150 && pixels[i + 1]! < 150 && pixels[i + 2]! < 150;
    };
    const counts = Array<number>(w).fill(0);
    for (let x = 0; x < w; x++)
      for (let y = Math.floor(h * 0.17); y < h * 0.93; y++) if (dark(x, y)) counts[x]!++;
    const max = Math.max(...counts);
    const vertical = centers(counts.flatMap((n, x) => (n > max * 0.62 ? [x] : [])));
    const sides = [vertical.filter((x) => x < w / 2), vertical.filter((x) => x > w / 2)];
    if (sides.some((s) => s.length !== 3)) throw new Error('Unrecognized timetable column grid');

    async function number(
      left: number,
      right: number,
      y: number,
      height: number,
      edge: 'first' | 'last'
    ) {
      const ink: number[] = [];
      for (let x = left; x < right; x++) {
        let n = 0;
        for (let yy = y; yy < y + height; yy++) if (dark(x, yy)) n++;
        if (n >= 2) ink.push(x);
      }
      const tokens = clusters(ink, 8),
        token = edge === 'first' ? tokens[0] : tokens.at(-1);
      if (!token) throw new Error('Empty timetable numeric cell');
      const l = token[0]! - 2,
        r = token.at(-1)! + 3;
      const crop = createCanvas((r - l + 16) * 4, (height + 16) * 4),
        ctx = crop.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, crop.width, crop.height);
      ctx.drawImage(canvas, l, y, r - l, height, 32, 32, (r - l) * 4, height * 4);
      const accepted = new Set<number>();
      const readings: { text: string; confidence: number }[] = [];
      for (const mode of [PSM.SINGLE_LINE, PSM.RAW_LINE, PSM.SINGLE_WORD]) {
        await worker!.setParameters({
          tessedit_pageseg_mode: mode,
          tessedit_char_whitelist: '0123456789'
        });
        const result = await worker!.recognize(crop.toBuffer('image/png'));
        const text = result.data.text.trim();
        readings.push({ text, confidence: result.data.confidence });
        if (/^\d{2}$/.test(text) && Number(text) <= 59 && result.data.confidence >= 80)
          accepted.add(Number(text));
      }
      // Small glyphs can have lower confidence despite identical readings in
      // all segmentation modes. Require unanimous valid two-digit agreement.
      const consensus = readings.filter(
        (r) => /^\d{2}$/.test(r.text) && Number(r.text) <= 59 && r.confidence >= 60
      );
      if (
        accepted.size === 0 &&
        consensus.length === 3 &&
        consensus.reduce((sum, r) => sum + r.confidence, 0) / 3 >= 65 &&
        new Set(consensus.map((r) => r.text)).size === 1
      )
        accepted.add(Number(consensus[0]!.text));
      if (accepted.size !== 1) {
        await writeFile(
          join(cache, `uncertain-${digest}-${l}-${y}.png`),
          crop.toBuffer('image/png')
        );
        throw new Error(`Ambiguous timetable digit OCR at ${l},${y}: ${JSON.stringify(readings)}`);
      }
      return [...accepted][0]!;
    }
    const columns: { destination: string; day: string; first: string; last: string }[][] = [];
    const destinationLabels = {
      Y20: ['新北產業園區', 'New Taipei Industrial Park'],
      Y07: ['大坪林', 'Dapinglin']
    };
    for (const side of sides) {
      const [left, hourEnd, right] = side as [number, number, number];
      const horizontal: number[] = [];
      for (let y = Math.floor(h * 0.17); y < h * 0.94; y++) {
        let n = 0;
        for (let x = left + 5; x < right - 5; x++) if (dark(x, y)) n++;
        if (n > (right - left - 10) * 0.8) horizontal.push(y);
      }
      const lines = centers(horizontal),
        bodies: [number, number][] = [];
      for (let i = 1; i < lines.length; i++)
        if (lines[i]! - lines[i - 1]! > h * 0.15) bodies.push([lines[i - 1]!, lines[i]!]);
      if (bodies.length !== destinations.length)
        throw new Error('Timetable direction count does not match operator topology');
      const windows: { destination: string; day: string; first: string; last: string }[] = [];
      for (const [top, bottom] of bodies) {
        const index = lines.indexOf(top),
          dayTop = lines[index - 2]!,
          dayBottom = lines[index - 1]!;
        if (dayTop == null || dayBottom == null)
          throw new Error('Official timetable day headings missing');
        const day = await readLabel(
          canvas,
          [left + 4, dayTop + 3, right - 4, dayBottom - 3],
          {
            weekday: 'Weekdays',
            holiday: 'Saturday, Sunday & Holidays',
            combined: 'Weekdays/Holidays'
          },
          'text'
        );
        if (day === 'combined')
          throw new Error('Unsupported combined official timetable day heading');
        const previousBottom = bodies.find(([, b]) => b < top)?.[1] ?? Math.round(h * 0.115);
        const destination = await readLabel(
          canvas,
          [0, previousBottom + 3, w, dayTop - 3],
          destinationLabels,
          'name'
        );
        if (!destinations.includes(destination))
          throw new Error(`Unexpected official timetable destination ${destination}`);
        const rh = (bottom - top) / 19;
        const row = (n: number) => {
          // The final row's glyphs sit higher than a uniform inset predicts.
          // Preserve the full glyph: clipping a 6's top hook can confidently
          // turn 26 into 20 in every OCR segmentation mode.
          const y = Math.round(top + n * rh + (n === 0 ? rh * 0.08 : 0));
          return {
            y,
            height:
              n === 0 ? Math.round(rh * 0.84) : Math.min(Math.round(rh * 0.95), bottom - y - 3)
          };
        };
        const first = row(0),
          last = row(18);
        const fh = await number(left + 4, hourEnd - 4, first.y, first.height, 'first');
        const lh = await number(left + 4, hourEnd - 4, last.y, last.height, 'first');
        if (fh !== 6 || lh !== 0)
          throw new Error('Timetable hour layout changed; expected a 06..00 service-day grid');
        const fm = await number(hourEnd + 5, right - 5, first.y, first.height, 'first');
        const lm = await number(hourEnd + 5, right - 5, last.y, last.height, 'last');
        windows.push({
          destination,
          day,
          first: `06:${String(fm).padStart(2, '0')}`,
          last: `24:${String(lm).padStart(2, '0')}`
        });
      }
      columns.push(windows);
    }
    const windows = destinations.map((destination) => {
      const matches = columns.flat().filter((w) => w.destination === destination);
      const weekday = matches.filter((w) => w.day === 'weekday'),
        holiday = matches.filter((w) => w.day === 'holiday');
      if (weekday.length !== 1 || holiday.length !== 1)
        throw new Error(`Incomplete official day coverage for ${stationCode}->${destination}`);
      return {
        destination,
        first: [
          ...Array<string>(5).fill(weekday[0]!.first),
          ...Array<string>(2).fill(holiday[0]!.first)
        ],
        last: [
          ...Array<string>(5).fill(weekday[0]!.last),
          ...Array<string>(2).fill(holiday[0]!.last)
        ]
      };
    });
    return windows;
  }
  return {
    readStationTable(bytes: Uint8Array, codes: string[], names: Record<string, string | string[]>) {
      return table('stations', bytes, [codes, names], () =>
        readStationTimetable(bytes, codes, names, readCell, readLabel)
      );
    },
    readRuntimeTable(bytes: Uint8Array, codes: string[], edges: [string, string][]) {
      return table('runtime', bytes, [codes, edges], () =>
        readRuntimeMatrix(bytes, codes, edges, readCell, readLabel)
      );
    },
    readFareTable(bytes: Uint8Array, codes: string[]) {
      return table('fares', bytes, codes, () =>
        readFareTriangle(bytes, codes, readCell, readLabel)
      );
    },
    read(bytes: Uint8Array, destinations: string[], stationCode: string) {
      return table('pdf', bytes, [destinations, stationCode], (digest) =>
        recognize(bytes, destinations, stationCode, digest)
      );
    },
    async close() {
      await queue;
      await worker?.terminate();
      await chinese?.terminate();
    }
  };
}
