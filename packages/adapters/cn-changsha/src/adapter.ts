import {
  type AdapterManifest,
  repoRootForDataDir,
  type SyncCtx,
  type SyncLayer
} from '@openmetro/core';
import { runChangshaNormalize } from './run.js';

export const adapter: AdapterManifest = {
  networkId: 'cn-changsha',
  displayName: { zh: '长沙', en: 'Changsha' },
  layers: {
    // Official Creator CMS feed (findAllDtLineData / findDtStationData /
    // getDtStationInfoById): lines, per-line stop order, official per-line
    // station codes, interchange flags, station exits, bus connections and the
    // per-station per-direction first/last trains. AMap Subway 4301 supplies
    // coordinates, English names, line colours and the schematic pixel grid.
    topology: { supported: true, estimatedMinutes: 5 },
    // First/last trains come from the CMS `times` field (161/161 line-stops,
    // three destinations on Line 3, weekday + weekend variants on the maglev).
    // No planner harvest is needed for the timetable layer.
    timetables: { supported: true, estimatedMinutes: 5 },
    // The operator publishes the fare policy as text (票务规则 第四条): the
    // mileage ladder is applied to the network's shortest riding path, whose
    // segment kilometres are harvested from the Baidu planner.
    fares: { supported: true, estimatedMinutes: 20 },
    enrichment: { supported: true, estimatedMinutes: 5 },
    // Adapter-agnostic core gapfill (Baidu segment times / transfer walks).
    gapfill: { supported: true, estimatedMinutes: 15 }
  },
  async sync(layers: SyncLayer[], ctx: SyncCtx): Promise<void> {
    if (layers.length === 0) return;
    const root = repoRootForDataDir(ctx.dataDir, 'cn-changsha');
    const wantTopology = layers.some(
      (l) => l === 'topology' || l === 'timetables' || l === 'enrichment'
    );
    const wantFares = layers.includes('fares');

    if (wantTopology) {
      await runChangshaNormalize({
        root,
        skipGeocode: false,
        skipFares: !wantFares
      });
    } else if (wantFares) {
      // Fares-only: recompute the ladder on the segment distances already on
      // disk. No planner harvest, no canonical rewrite.
      const { computeAndWriteFares } = await import('./fares.js');
      await computeAndWriteFares(ctx.dataDir);
    }
  }
};

export default adapter;
