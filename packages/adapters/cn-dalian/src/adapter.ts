import {
  type AdapterManifest,
  loadBaiduAk,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { computeAndWriteFares } from './fares.js';
import { runDalianNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-dalian',
  displayName: { zh: '大连', en: 'Dalian' },
  layers: {
    // AMap topology (2102_drw_dalian) — the only structured source. The former
    // operator site www.dlmetro.com no longer resolves and the successor
    // portal www.dltransgrp.com carries no metro data.
    topology: { supported: true, estimatedMinutes: 5 },
    // First/last trains via Baidu Direction Lite (OPENMETRO_BAIDU_AK). Live
    // query, no cache — the operator publishes timetables only as APP/WeChat
    // images. Measured 202/202 station-direction slots on the 7 alignments.
    timetables: { supported: true, estimatedMinutes: 12 },
    // Official distance ladder computed from the shortest rail distance per OD
    // (transfers free); depends on the segment distances harvested below.
    fares: { supported: true, estimatedMinutes: 3 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-dalian');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      // Segment distances must be harvested before the fare ladder is computed:
      // straight-line distances understate the long suburban alignments by up
      // to 3 yuan on the published anchors.
      await runDalianNormalize({ root, skipFares: !wantFares });
    } else if (wantFares) {
      // Fares-only: recompute the ladder on the segment distances already on
      // disk. Needs OPENMETRO_BAIDU_AK only if distances are missing.
      const ak = loadBaiduAk();
      if (!ak) throw new Error('OPENMETRO_BAIDU_AK is required for segment distances');
      await computeAndWriteFares(ctx.dataDir);
    }
  }
};

export default adapter;
