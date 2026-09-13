/**
 * Reverse-proxy helper for official metro APIs that reject non-CN egress.
 *
 * When `OPENMETRO_REVERSE_PROXY` is set (e.g. `https://revprx-....eo-edgefunctions.com`),
 * requests to `https://origin.example/path` are rewritten to
 * `{proxy}/?url={encodeURIComponent(origin+path)}`.
 * When unset, the original URL is returned unchanged.
 */
export function proxyUrl(target: string): string {
  const base = process.env.OPENMETRO_REVERSE_PROXY?.trim();
  if (!base) return target;
  const normalized = base.replace(/\/+$/, '');
  return `${normalized}/?url=${encodeURIComponent(target)}`;
}

/** Headers that help some official CDNs accept proxied requests. */
export function officialFetchHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: '*/*',
    ...extra
  };
  // Reverse proxies sometimes emit content-encoding headers Bun cannot decode.
  if (process.env.OPENMETRO_REVERSE_PROXY && !headers['Accept-Encoding']) {
    headers['Accept-Encoding'] = 'identity';
  }
  return headers;
}
