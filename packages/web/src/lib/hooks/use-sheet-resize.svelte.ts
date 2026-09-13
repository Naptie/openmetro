import { browser } from '$app/environment';

/** Reactive media query (SSR-safe: resolves to false off-browser). */
export function useMediaQuery(query: string) {
  const mql = browser ? window.matchMedia(query) : null;
  let matches = $state(mql?.matches ?? false);

  if (mql) {
    mql.addEventListener('change', (e) => {
      matches = e.matches;
    });
  }

  return {
    get value() {
      return matches;
    }
  };
}

export interface SheetSizer {
  /** Inline style for the sheet content ("", width or height). */
  readonly style: string;
  readonly isDesktop: boolean;
  startWidthResize(e: MouseEvent, dir: 1 | -1): void;
  startHeightResize(e: MouseEvent, dir: 1 | -1): void;
}

/**
 * Drag-to-resize for sheets: width (desktop, side=left/right sheets) and
 * height (mobile, bottom drawer). Width persists to localStorage; height
 * defaults to 68% of the viewport so the map stays visible above the drawer.
 */
export function createSheetSizer(key: string): SheetSizer {
  const isDesktop = useMediaQuery('(min-width: 640px)');
  const storageKey = `openmetro.sheet.${key}.width`;
  let width = $state<number | null>(null);
  let height = $state<number | null>(null);

  if (browser) {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= 320) width = saved;
  }

  function begin(
    axis: 'x' | 'y',
    e: MouseEvent,
    dir: 1 | -1,
    getStartSize: () => number,
    clamp: (v: number) => number,
    commit: (v: number) => void
  ): void {
    e.preventDefault();
    e.stopPropagation();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = getStartSize();
    const move = (ev: MouseEvent) => {
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      const delta = axis === 'x' ? pos - startPos : startPos - pos;
      commit(clamp(startSize + dir * delta));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    // Listen to both pointer and mouse events: touch drags fire pointer
    // events, mouse drags fire either (or both — commits are idempotent).
    window.addEventListener('pointermove', move);
    window.addEventListener('mousemove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('mouseup', up);
  }

  const clampWidth = (v: number) =>
    Math.round(Math.min(Math.max(v, 320), Math.min(760, window.innerWidth - 60)));
  const clampHeight = (v: number) =>
    Math.round(Math.min(Math.max(v, 260), window.innerHeight - 96));

  return {
    get isDesktop() {
      return isDesktop.value;
    },
    get style(): string {
      if (isDesktop.value) {
        return width != null ? `width:${width}px;max-width:none;` : '';
      }
      return `height:${height ?? Math.round(window.innerHeight * 0.68)}px;`;
    },
    startWidthResize(e: MouseEvent, dir: 1 | -1): void {
      const content = (e.currentTarget as HTMLElement).closest('[data-slot="sheet-content"]');
      begin(
        'x',
        e,
        dir,
        () => content?.getBoundingClientRect().width ?? 448,
        clampWidth,
        (v) => {
          width = v;
          localStorage.setItem(storageKey, String(v));
        }
      );
    },
    startHeightResize(e: MouseEvent, dir: 1 | -1): void {
      const content = (e.currentTarget as HTMLElement).closest('[data-slot="sheet-content"]');
      begin(
        'y',
        e,
        dir,
        () => content?.getBoundingClientRect().height ?? 480,
        clampHeight,
        (v) => {
          height = v;
        }
      );
    }
  };
}
