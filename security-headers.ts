// The app's security policy, in one place. The build and the preview server use it, and a test keeps vercel.json in step.
// A browser enforces every policy it's given, so the two work together: the header, in a public file, allows any Supabase
// project, and the meta tag, built from VITE_SUPABASE_URL, narrows that to exactly this site's project.

const IMPORT_SERVICES = 'https://lichess.org https://api.chess.com';

const cspCommon = (backend: string) => [
  "default-src 'none'",
  // The chess engine is WebAssembly, which needs this one permission. No inline scripts and no eval are allowed.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  // The only outside services the app may talk to: game import, and this site's backend.
  `connect-src 'self' ${IMPORT_SERVICES}${backend ? ` ${backend}` : ''}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/** For a <meta> tag, which is the fallback if a host doesn't send headers. Browsers ignore frame-ancestors there. */
export const cspMeta = (supabaseUrl?: string) => cspCommon(supabaseUrl ? new URL(supabaseUrl).origin : '').join('; ');

export const CSP_HEADER = [...cspCommon('https://*.supabase.co'), "frame-ancestors 'none'", 'upgrade-insecure-requests'].join('; ');

/** Sent on every response. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP_HEADER,
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Files that must always be revalidated, or users could get stuck on an old version of the app. */
export const NO_CACHE_PATHS = ['/', '/index.html', '/sw.js', '/registerSW.js', '/manifest.webmanifest'];

/** The `_headers` file format used by Netlify and Cloudflare Pages. */
export function headersFile(): string {
  const lines = ['/*'];
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) lines.push(`  ${name}: ${value}`);
  lines.push('', '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', '');
  for (const path of NO_CACHE_PATHS) lines.push(path, '  Cache-Control: no-cache', '');
  return lines.join('\n');
}
