// Runs after every production build, and fails it if the output isn't safe to deploy.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const problems = [];
const warnings = [];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const files = walk(root);
const has = (suffix) => files.some((file) => file.replaceAll('\\', '/').endsWith(suffix));

for (const required of ['engine/stockfish-19-lite-single.js', 'engine/stockfish-19-lite-single.wasm', 'engine/COPYING.txt', '_headers', 'sw.js', 'licenses/THIRD_PARTY_NOTICES.md']) {
  if (!has(required)) problems.push(`Missing ${required}. Install with dev dependencies (npm ci), because the engine is copied from one.`);
}

const FORBIDDEN_FILES = /\.(map|env|ts|tsx|pem|key)$|(^|[\\/])\.env/;
const SECRET = /sk-ant-[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;

/** Supabase's public key and its all-powerful service key look alike, so this reads what's inside any key it finds. */
const isServiceKey = (payload) => {
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).role === 'service_role';
  } catch {
    return false;
  }
};
for (const file of files) {
  if (FORBIDDEN_FILES.test(file)) problems.push(`Should not be deployed: ${file}`);
  if (/\.(js|html|css|json|webmanifest|txt|md)$/.test(file) && SECRET.test(readFileSync(file, 'utf8'))) {
    problems.push(`Looks like it contains a secret: ${file}`);
  }
  if (/\.(js|html|json)$/.test(file) && [...readFileSync(file, 'utf8').matchAll(JWT)].some((match) => isServiceKey(match[1]))) {
    problems.push(`Contains the Supabase service role key, which would give anyone full control of the database: ${file}`);
  }
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
if (!html.includes('Content-Security-Policy')) problems.push('index.html has no Content-Security-Policy.');
if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push('index.html has an inline script, which the Content-Security-Policy would block.');

if (!process.env.VITE_SOURCE_URL) {
  warnings.push('VITE_SOURCE_URL is not set. Stockfish is GPLv3, so a public deployment must link to this app\'s source code. Set it before going live.');
}

for (const name of Object.keys(process.env)) {
  if (name.startsWith('VITE_') && /SERVICE|SECRET|PASSWORD/i.test(name)) problems.push(`${name} would be published in the app's code. Remove it.`);
}

const supabaseUrl = process.env.VITE_SUPABASE_URL;
if (!supabaseUrl || !process.env.VITE_SUPABASE_ANON_KEY) {
  warnings.push("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set, so this build has no accounts and no access-code gate. Anyone with the link can use it.");
} else if (!html.includes(new URL(supabaseUrl).origin)) {
  problems.push('The security policy in index.html does not name this site\'s Supabase project.');
}

for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (problems.length) {
  for (const problem of problems) console.error(`BUILD CHECK FAILED: ${problem}`);
  process.exit(1);
}
console.log(`Build check passed: ${files.length} files, no secrets or source maps.`);
