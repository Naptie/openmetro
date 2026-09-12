// The demo is a client-only SPA: it fetches the API at runtime and uses
// MapLibre (which requires `window`), so prerender the shell and disable SSR.
export const prerender = true;
export const ssr = false;
