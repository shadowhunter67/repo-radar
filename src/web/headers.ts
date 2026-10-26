export const securityHeaders: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': '',
};
export function responseHeaders(api = false): Record<string, string> {
  return {
    ...securityHeaders,
    ...(api ? { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } : {}),
  };
}
