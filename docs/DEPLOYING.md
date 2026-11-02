# Deploying GridTheory

GridTheory is a static site, so any static host works. It needs HTTPS for install and offline support.

Do the items under "Before you go public" in [SECURITY_AUDIT.md](SECURITY_AUDIT.md) first.

## Build

Use Node 22.15 or newer, and a full install. The chess engine is copied from a dev dependency, so `--omit=dev` won't work, and the build check will fail if you try it.

```bash
npm ci
```

Set your public source code link for the build. On a host, add `VITE_SOURCE_URL` to its environment variables. Then build:

```bash
npm run build
```

Deploy the `dist` folder. The build fails if the engine is missing, or if it finds source maps or anything that looks like a key.

**Never put a secret in a `VITE_` variable.** Anything with that prefix ends up in the public JavaScript.

## Hosts

| Host | Setup | Security headers |
| --- | --- | --- |
| **Cloudflare Pages** | Build command `npm run build`, output `dist` | Automatic, from `dist/_headers` |
| **Netlify** | Same | Automatic, from `dist/_headers` |
| **Vercel** | Automatic, from `vercel.json` | Automatic, from `vercel.json` |
| **GitHub Pages** | Works, but can't set headers | **Not recommended.** The page's meta tag gives most of the policy, but it can't block framing or set the other headers |
| **Your own server** | Serve `dist` | Copy the values from `security-headers.ts` |

If you change `security-headers.ts`, update `vercel.json` to match. A test fails if they differ.

## After deploying

1. Open the live site and check the browser console for policy violations.
2. Run the address through [securityheaders.com](https://securityheaders.com). It should show the headers from `security-headers.ts`.
3. Play a move against a Stockfish bot, to confirm the WebAssembly engine loads.
4. Import a game from each site, and open a puzzle.
5. Check Settings shows a working source code link.
6. Repeat in Firefox and Safari, which haven't been tested yet.
7. Load the installed version, go offline, and reload.

## Keeping it safe

- Turn on two-factor authentication for your host, your domain registrar and GitHub. With no server, those accounts are the most likely way in.
- Keep the repository's `main` branch protected, and turn on Dependabot alerts.
- Run `npm audit --omit=dev` before each release.
- Once HTTPS has worked well for a few weeks, you can add `includeSubDomains; preload` to the HSTS header. It's left out for now, because it's hard to undo.
- If the policy blocks a new feature you add, widen it for that one address only. Avoid `unsafe-inline` and `unsafe-eval`, which would remove most of its protection.
