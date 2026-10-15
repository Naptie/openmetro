import { expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

for (const id of ['cn-taichung', 'cn-kaohsiung'])
  test(`verify-data rejects a missing departure direction for ${id}`, async () => {
    const root = resolve(import.meta.dir, '../../..');
    const scratch = await mkdtemp(join(tmpdir(), 'openmetro-direction-test-'));
    try {
      const dir = join(scratch, id);
      await mkdir(dir);
      for (const name of await readdir(join(root, 'data', id)))
        await copyFile(join(root, 'data', id, name), join(dir, name));
      const path = join(dir, 'lines.json');
      const lines = JSON.parse(await readFile(path, 'utf8'));
      for (const line of lines.records)
        line.extras = { ...line.extras, timetable_coverage: 'all_stop_directions' };
      await writeFile(path, JSON.stringify(lines));
      const ttPath = join(dir, 'timetables.json');
      const tt = JSON.parse(await readFile(ttPath, 'utf8'));
      const counts = new Map<string, number>();
      for (const t of tt.records) counts.set(t.stop_id, (counts.get(t.stop_id) ?? 0) + 1);
      tt.records.splice(
        tt.records.findIndex((t: { stop_id: string }) => counts.get(t.stop_id) === 2),
        1
      );
      await writeFile(ttPath, JSON.stringify(tt));
      const p = Bun.spawn(
        [process.execPath, 'scripts/verify-data.ts', '--out', join(scratch, 'manifest.json')],
        {
          cwd: root,
          env: { ...process.env, OPENMETRO_DATA_ROOT: scratch },
          stdout: 'pipe',
          stderr: 'pipe'
        }
      );
      const stderr = await new Response(p.stderr).text();
      await new Response(p.stdout).text();
      expect(await p.exited).not.toBe(0);
      expect(stderr).toContain('Missing timetable direction');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
