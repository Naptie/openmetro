import { type Canvas, createCanvas, loadImage } from '@napi-rs/canvas';
import type { DepartureWindow } from './normalize.js';

export type CellReader = (
  canvas: Canvas,
  box: [number, number, number, number],
  kind: 'time' | 'number' | 'fare'
) => Promise<string>;
export type LabelReader = (
  canvas: Canvas,
  box: [number, number, number, number],
  labels: Record<string, string | string[]>,
  kind: 'code' | 'white-code' | 'name' | 'text'
) => Promise<string>;
const clusters = (a: number[]) => {
  const out: number[][] = [];
  for (const x of a) {
    const g = out.at(-1);
    if (g && x - g.at(-1)! < 5) g.push(x);
    else out.push([x]);
  }
  return out.map((g) => Math.round(g.reduce((x, y) => x + y, 0) / g.length));
};
async function image(bytes: Uint8Array) {
  const img = await loadImage(Buffer.from(bytes));
  const s = 1600 / img.width,
    c = createCanvas(1600, Math.round(img.height * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function pixels(c: Canvas, colored = false) {
  const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  return (x: number, y: number) => {
    const i = (y * c.width + x) * 4;
    const r = p[i]!,
      g = p[i + 1]!,
      b = p[i + 2]!;
    return (colored || Math.max(r, g, b) - Math.min(r, g, b) < 30) && Math.max(r, g, b) < 210;
  };
}
function vertical(c: Canvas, expected: number, top = 0, bottom = c.height) {
  const dark = pixels(c),
    counts = Array<number>(c.width).fill(0);
  for (let x = 0; x < c.width; x++) for (let y = top; y < bottom; y++) if (dark(x, y)) counts[x]!++;
  const max = Math.max(...counts),
    lines = clusters(counts.flatMap((n, x) => (n > max * 0.62 ? [x] : [])));
  if (lines.length < expected && lines.length > 2) {
    const gaps = lines.slice(1).map((x, i) => x - lines[i]!),
      step = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    for (let i = 1; i < lines.length && lines.length < expected; i++) {
      if (Math.abs(lines[i]! - lines[i - 1]! - 2 * step) < 4) {
        lines.splice(i, 0, Math.round((lines[i]! + lines[i - 1]!) / 2));
        i++;
      }
    }
  }
  if (lines.length < expected) {
    const gaps = lines.slice(1).map((x, i) => x - lines[i]!),
      step = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    if (gaps.every((g) => Math.abs(g - step) < 3)) {
      while (lines.length < expected && lines[0]! - step >= -3)
        lines.unshift(Math.max(0, lines[0]! - step));
      while (lines.length < expected && lines.at(-1)! + step <= c.width + 3)
        lines.push(Math.min(c.width - 1, lines.at(-1)! + step));
    }
  }
  if (lines.length !== expected)
    throw new Error(
      `Official raster grid columns changed: expected ${expected}, found ${lines.length}: ${lines.join(',')}`
    );
  return lines;
}
function horizontal(c: Canvas, left: number, right: number, colored = false) {
  const dark = pixels(c, colored),
    lines: number[] = [];
  for (let y = 0; y < c.height; y++) {
    let n = 0;
    for (let x = left + 3; x < right - 3; x++) if (dark(x, y)) n++;
    if (n > (right - left - 6) * 0.8) lines.push(y);
  }
  return clusters(lines);
}
const cell = (
  xs: number[],
  ys: number[],
  col: number,
  row: number
): [number, number, number, number] => [
  xs[col]! + 5,
  ys[row]! + 4,
  xs[col + 1]! - 5,
  ys[row + 1]! - 4
];
const serviceLast = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return `${String(h! < 3 ? h! + 24 : h!).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

export async function readStationTimetable(
  bytes: Uint8Array,
  codes: string[],
  names: Record<string, string | string[]>,
  read: CellReader,
  label: LabelReader
) {
  const c = await image(bytes),
    xs = vertical(c, 7),
    all = horizontal(c, xs[2]!, xs.at(-1)!);
  const count = codes.length * 2 - 2,
    ys = all.slice(-(count + 1));
  if (ys.length !== count + 1)
    throw new Error('Official Sanying timetable rows do not cover the station topology');
  const headers = all.slice(0, all.length - count);
  if (headers.length < 3) throw new Error('Official Sanying timetable column headings missing');
  const header = (col: number, row: number) => cell(xs, headers, col, row);
  for (const [col, value] of [
    [0, 'Stations'],
    [1, 'Destination'],
    [2, 'First Train'],
    [4, 'Last Transfer to the Bannan Line'],
    [5, 'Last Train']
  ] as const) {
    const box = header(col, 0);
    if (col === 2) box[2] = xs[4]! - 5;
    await label(c, box, { [value]: value }, 'text');
  }
  for (const [col, expected] of [
    [2, 'weekday'],
    [3, 'holiday'],
    [4, 'combined'],
    [5, 'combined']
  ] as const) {
    const actual = await label(
      c,
      header(col, 1),
      { weekday: 'Weekdays', holiday: 'Holidays', combined: 'Weekdays/Holidays' },
      'text'
    );
    if (actual !== expected)
      throw new Error(`Official Sanying day heading changed in column ${col}: ${actual}`);
  }
  const rows: { code: string; windows: DepartureWindow[] }[] = [];
  const stationLines = horizontal(c, xs[0]!, xs[1]!).filter((y) => y >= ys[0]! - 3);
  if (stationLines.length !== codes.length + 1)
    throw new Error('Official station label rows changed');
  for (let i = 0; i < codes.length; i++) {
    const code = await label(c, cell(xs, stationLines, 0, i), names, 'name');
    if (!codes.includes(code) || rows.some((r) => r.code === code))
      throw new Error(`Duplicate or unknown Sanying station ${code}`);
    const windows: DepartureWindow[] = [];
    const firstRow = ys.findIndex((y) => Math.abs(y - stationLines[i]!) < 4);
    const endRow = ys.findIndex((y) => Math.abs(y - stationLines[i + 1]!) < 4);
    if (firstRow < 0 || endRow <= firstRow)
      throw new Error(`Unrecognized Sanying station span ${code}`);
    for (let row = firstRow; row < endRow; row++) {
      const destination = await label(c, cell(xs, ys, 1, row), names, 'name');
      const weekday = await read(c, cell(xs, ys, 2, row), 'time'),
        holiday = await read(c, cell(xs, ys, 3, row), 'time');
      const last = serviceLast(await read(c, cell(xs, ys, 5, row), 'time'));
      // This is a distinct published connection cutoff, not the station's last train.
      const transfer =
        destination === codes[0] ? await read(c, cell(xs, ys, 4, row), 'time') : undefined;
      windows.push({
        destination,
        first: [...Array<string>(5).fill(weekday), ...Array<string>(2).fill(holiday)],
        last: Array<string>(7).fill(last),
        last_transfer_to_bannan: transfer
      });
    }
    const expected = [codes[0]!, codes.at(-1)!].filter((d) => d !== code);
    if (
      windows.length !== expected.length ||
      expected.some((d) => !windows.some((w) => w.destination === d))
    )
      throw new Error(`Incomplete Sanying station directions ${code}`);
    rows.push({ code, windows });
  }
  return codes.map((code) => rows.find((row) => row.code === code)!);
}

export async function readRuntimeMatrix(
  bytes: Uint8Array,
  codes: string[],
  edges: [string, string][],
  read: CellReader,
  label: LabelReader
) {
  const c = await image(bytes),
    xs = vertical(c, codes.length + 2),
    ys = horizontal(c, xs[0]!, xs.at(-1)!);
  if (ys.length < codes.length + 2) {
    const gaps = ys.slice(1).map((y, i) => y - ys[i]!),
      step = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    if (gaps.every((g) => Math.abs(g - step) < 4)) {
      if (ys[0]! - step >= -3) ys.unshift(Math.max(0, ys[0]! - step));
      if (ys.length < codes.length + 2 && ys.at(-1)! + step <= c.height + 3)
        ys.push(Math.min(c.height - 1, ys.at(-1)! + step));
    }
  }
  if (ys.length !== codes.length + 2)
    throw new Error(`Official runtime matrix row count changed: ${ys.length}`);
  const labels = Object.fromEntries(codes.map((code) => [code, code]));
  const rowCodes: string[] = [],
    colCodes: string[] = [];
  for (let i = 1; i <= codes.length; i++) {
    for (const [box, order] of [
      [cell(xs, ys, 0, i), rowCodes],
      [cell(xs, ys, i, 0), colCodes]
    ] as const) {
      // Runtime station codes are the bottom line of each bilingual header.
      const lower: [number, number, number, number] = [
        box[0],
        Math.round(box[1] + (box[3] - box[1]) * 0.5),
        box[2],
        box[3]
      ];
      order.push(await label(c, lower, labels, 'code'));
    }
  }
  if ([rowCodes, colCodes].some((order) => new Set(order).size !== codes.length))
    throw new Error('Official runtime headers contain duplicate or missing stations');
  const pairs: { from: string; to: string; seconds: number }[] = [];
  for (const [from, to] of edges) {
    const i = rowCodes.indexOf(from) + 1,
      j = colCodes.indexOf(to) + 1;
    if (i < 1 || j < 1) throw new Error(`Runtime edge not in source headers ${from}->${to}`);
    const a = Number(await read(c, cell(xs, ys, j, i), 'number')),
      b = Number(
        await read(c, cell(xs, ys, colCodes.indexOf(from) + 1, rowCodes.indexOf(to) + 1), 'number')
      );
    if (a !== b || a <= 0 || a > 120)
      throw new Error(`Conflicting official runtime matrix values ${from}->${to}: ${a}/${b}`);
    pairs.push({ from, to, seconds: a * 60 });
  }
  return pairs;
}

export async function readFareTriangle(
  bytes: Uint8Array,
  codes: string[],
  read: CellReader,
  label: LabelReader
) {
  const c = await image(bytes),
    ys = horizontal(c, Math.round(c.width * 0.02), c.width - 3, true);
  const bottom = ys.at(-1),
    previous = ys.at(-2);
  if (bottom == null || previous == null) throw new Error('Fare table border missing');
  const height = bottom - previous,
    xs = vertical(c, codes.length + 1, previous + 5, bottom - 5);
  const top = bottom - height * codes.length;
  if (top < 0 || height < 15) throw new Error('Official triangular fare grid geometry is invalid');
  const rows = Array.from({ length: codes.length + 1 }, (_, i) => Math.round(top + i * height));
  const order: string[] = [],
    labels = Object.fromEntries(codes.map((code) => [code, code]));
  for (let i = 0; i < codes.length; i++) {
    const box = cell(xs, rows, i, i);
    order.push(
      await label(
        c,
        [box[0], box[1], box[2], Math.round(box[1] + (box[3] - box[1]) * 0.48)],
        labels,
        'white-code'
      )
    );
  }
  if (new Set(order).size !== codes.length)
    throw new Error('Official fare headers contain duplicate or missing stations');
  const pairs: { from: string; to: string; price: number }[] = [];
  for (let i = 1; i < codes.length; i++)
    for (let j = 0; j < i; j++) {
      const price = Number(await read(c, cell(xs, rows, j, i), 'fare'));
      if (price < 5 || price > 300 || price % 5 !== 0)
        throw new Error(`Invalid official fare ${price}`);
      pairs.push({ from: order[j]!, to: order[i]!, price });
    }
  return pairs;
}
