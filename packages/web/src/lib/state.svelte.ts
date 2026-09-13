import type {
  ApiLine as Line,
  ApiNetwork as NetworkMeta,
  ApiPattern as Pattern,
  ApiRoutePlan as RoutePlan,
  ApiStation as Station,
  ApiStop as Stop
} from 'openmetro-client';
import { client, get } from '$lib/client';

export interface NetworkData {
  meta: NetworkMeta;
  lines: Line[];
  stations: Station[];
  stops: Stop[];
  patterns: Pattern[];
}

interface AppState {
  networks: NetworkData[];
  loading: boolean;
  error: string | null;
  networksOpen: boolean;
  routePanelOpen: boolean;
  selectedLineId: string | null;
  selectedStationId: string | null;
  originId: string | null;
  destinationId: string | null;
  route: RoutePlan | null;
  routeLoading: boolean;
  routeError: string | null;
  /** Network the user last interacted with on the map (focus button, line or station click). */
  focusedNetworkId: string | null;
  /** Incremented only when the lines browser is opened via the navbar button. */
  networksExpandToken: number;
}

const state = $state<AppState>({
  networks: [],
  loading: true,
  error: null,
  networksOpen: false,
  routePanelOpen: false,
  selectedLineId: null,
  selectedStationId: null,
  originId: null,
  destinationId: null,
  route: null,
  routeLoading: false,
  routeError: null,
  focusedNetworkId: null,
  networksExpandToken: 0
});

/** Route key the current result was computed for, to dedupe fetches. */
let computedFor = $state<string | null>(null);

export const app = {
  get state(): AppState {
    return state;
  },
  get networks(): NetworkData[] {
    return state.networks;
  },
  get loading(): boolean {
    return state.loading;
  },
  get error(): string | null {
    return state.error;
  },
  get selectedLine(): NetworkData | null {
    return state.selectedLineId ? (this.findLine(state.selectedLineId)?.network ?? null) : null;
  },
  findLine(lineId: string | null): { line: Line; network: NetworkData } | null {
    if (!lineId) return null;
    for (const net of state.networks) {
      const line = net.lines.find((l) => l.id === lineId);
      if (line) return { line, network: net };
    }
    return null;
  },
  get selectedStation(): { station: Station; network: NetworkData } | null {
    if (!state.selectedStationId) return null;
    for (const net of state.networks) {
      const station = net.stations.find((s) => s.id === state.selectedStationId);
      if (station) return { station, network: net };
    }
    return null;
  },
  get origin(): Station | null {
    return state.originId ? (this.stationById(state.originId)?.station ?? null) : null;
  },
  get destination(): Station | null {
    return state.destinationId ? (this.stationById(state.destinationId)?.station ?? null) : null;
  },
  stationById(id: string | null | undefined): { station: Station; network: NetworkData } | null {
    if (!id) return null;
    for (const net of state.networks) {
      const station = net.stations.find((s) => s.id === id);
      if (station) return { station, network: net };
    }
    return null;
  },
  stationLocation(id: string | null | undefined): [number, number] | null {
    const hit = this.stationById(id);
    return hit?.station.location ? [hit.station.location.lon, hit.station.location.lat] : null;
  },
  lineById(lineId: string): Line | null {
    return this.findLine(lineId)?.line ?? null;
  },
  lineColor(lineId: string | null | undefined): string {
    return this.lineById(lineId ?? '')?.color ?? '#64748b';
  },
  get route() {
    return state.route;
  },
  get routeLoading() {
    return state.routeLoading;
  },
  get routeError() {
    return state.routeError;
  },

  async loadAll(): Promise<void> {
    state.loading = true;
    state.error = null;
    try {
      const { networks } = await get(client.api.networks.get());
      state.networks = await Promise.all(
        networks.map(async (meta) => {
          const [lines, stations, stops, patterns] = await Promise.all([
            get(client.api.networks({ id: meta.id }).lines.get()),
            get(client.api.networks({ id: meta.id }).stations.get()),
            get(client.api.networks({ id: meta.id }).stops.get()),
            get(client.api.networks({ id: meta.id }).patterns.get())
          ]);
          return {
            meta,
            lines,
            stations: [...new Map(stations.map((s) => [s.id, s])).values()],
            stops,
            patterns
          } satisfies NetworkData;
        })
      );
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.loading = false;
    }
  },

  selectLine(lineId: string | null): void {
    state.selectedLineId = lineId;
    state.selectedStationId = null;
    if (lineId) {
      const hit = this.findLine(lineId);
      if (hit) state.focusedNetworkId = hit.network.meta.id;
      state.networksOpen = true;
      state.routePanelOpen = false;
    }
  },

  selectStation(stationId: string | null): void {
    state.selectedStationId = stationId;
    if (stationId) {
      const hit = this.stationById(stationId);
      if (hit) state.focusedNetworkId = hit.network.meta.id;
      state.networksOpen = false;
    }
  },

  /**
   * Remember which network the user is looking at (map focus, line or station
   * click). Switching to a different network clears any picked route endpoints
   * — they belong to the previously focused network.
   */
  focusNetwork(networkId: string): void {
    if (state.focusedNetworkId && state.focusedNetworkId !== networkId) {
      state.originId = null;
      state.destinationId = null;
      state.route = null;
      state.routeError = null;
      computedFor = null;
    }
    state.focusedNetworkId = networkId;
  },

  openNetworks(): void {
    state.networksOpen = true;
    state.selectedLineId = null;
    state.networksExpandToken += 1;
  },

  toggleRoutePanel(): void {
    state.routePanelOpen = !state.routePanelOpen;
    if (state.routePanelOpen) {
      state.networksOpen = false;
      state.selectedStationId = null;
    }
  },

  closeRoutePanel(): void {
    state.routePanelOpen = false;
  },

  /** Open the route panel without clearing selections. */
  openRoutePanel(): void {
    state.routePanelOpen = true;
  },

  setOrigin(stationId: string | null): void {
    state.originId = state.originId === stationId ? null : stationId;
    state.routePanelOpen = true;
    state.networksOpen = false;
    state.selectedStationId = null;
  },

  setDestination(stationId: string | null): void {
    state.destinationId = state.destinationId === stationId ? null : stationId;
    state.routePanelOpen = true;
    state.networksOpen = false;
    state.selectedStationId = null;
  },

  swapOriginDestination(): void {
    [state.originId, state.destinationId] = [state.destinationId, state.originId];
  },

  clearRoute(): void {
    state.originId = null;
    state.destinationId = null;
    state.route = null;
    state.routeError = null;
    state.routePanelOpen = false;
    computedFor = null;
  },

  /** Plan a route as soon as both endpoints are known (no-op otherwise). */
  async recalcRoute(): Promise<void> {
    const { originId, destinationId } = state;
    if (!originId || !destinationId) return;
    const network = this.stationById(originId)?.network;
    if (!network) return;
    const key = `${network.meta.id}:${originId}->${destinationId}`;
    if (computedFor === key) return;
    computedFor = key;
    state.routeLoading = true;
    state.routeError = null;
    try {
      state.route = await get(
        client.api.networks({ id: network.meta.id }).route.get({
          query: { from: originId, to: destinationId, weight: 'time' }
        })
      );
    } catch (err) {
      state.route = null;
      state.routeError = err instanceof Error ? err.message : String(err);
    } finally {
      state.routeLoading = false;
    }
  }
};
