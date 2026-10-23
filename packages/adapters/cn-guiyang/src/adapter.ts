import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { runGuiyangFaresOnly, runGuiyangNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-guiyang',
  displayName: { zh: '贵阳', en: 'Guiyang' },
  layers: {
    // Official station list from the operator's "线路，票价查询" page
    // (www.gyurt.com/subwayInquiry.html) + AMap Subway 5201 for GCJ-02
    // coordinates, English names, schematic pixels and line colours. Per-segment
    // ride times/distances and the interchange walk distances come from the
    // operator's own planner (cms.gyurt.com/external/interface/getSubwayLines).
    topology: { supported: true, estimatedMinutes: 5 },
    // Per-station, per-direction first/last trains from the same official
    // planner: the response of any journey that boards at a station carries
    // that station's first/last train for the direction travelled.
    timetables: { supported: true, estimatedMinutes: 5 },
    // OD fare matrix from the operator's own fare quotes (4 278 pairs, ~8 min).
    fares: { supported: true, estimatedMinutes: 10 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu planner: interchange walk times).
    gapfill: { supported: true, estimatedMinutes: 10 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-guiyang');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runGuiyangNormalize({
        root,
        skipTimetables: !layers.includes('timetables'),
        includeFares: wantFares
      });
      return;
    }

    if (wantFares) {
      // Fares-only sync: the station table is already on disk, so only the
      // operator's coordinate strings have to be re-read from the official
      // station list.
      await runGuiyangFaresOnly(ctx.dataDir);
    }
  }
};

export default adapter;
