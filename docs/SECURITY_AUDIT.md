# GridTheory security audit

**Date:** 31 October 2026
**Scope:** all application code, dependencies, build output, git history, and the deployment configuration
**Result:** no critical vulnerabilities and no secrets found. Twelve issues were fixed. **Four things need your decision before a public launch.**

**Update, 2 November 2026:** the optional Claude coach was removed after this audit, along with its API key storage and network access. This report has been updated to match, and the fixes that only concerned it are noted as such.

This was a thorough review by an AI engineer, with active testing against the running app. It isn't a professional penetration test or legal advice.

## Before you go public

| # | What | Why | Who |
| --- | --- | --- | --- |
| 1 | **Publish the source code and set `VITE_SOURCE_URL`** | The app includes Stockfish (GPLv3), so anyone you serve it to must be able to get the source. The build warns until this is set. This means your own code has to be GPL and public too. | You |
| 2 | **Choose the email on your commits before pushing** | Your commits include your personal email address, which becomes public with the repository. A GitHub no-reply address avoids that, but changing existing commits means rewriting history, so it's best done before the first push. | You |
| 3 | **Confirm the piece artwork's licence** | The pieces come from `react-chessboard` (MIT), but they look like the Cburnett set, and I couldn't confirm their origin. Cburnett is available under GPL, so it would be compatible, but check before relying on it. | You |
| 4 | **Check third-party terms for your use** | Game import from Chess.com and Lichess is subject to those services' terms, especially if the app ever becomes commercial. | You |

Also worth doing: read through the lesson text. Stockfish verifies the moves in the exercises, but not the written explanations or historical claims.

## How the app is exposed

GridTheory is a static site with no server, database, accounts or cookies. That rules out many common attacks, such as SQL injection, session theft, CSRF and server compromise. What remains:

| Asset | Where it lives | Main threat |
| --- | --- | --- |
| Games and progress | Browser storage | Loss or corruption, malformed input |
| The site itself | Your host | Supply chain, account takeover at the host or registrar |

## Issues found and fixed

| Severity | Issue | Fix |
| --- | --- | --- |
| **High** | **No Content Security Policy or security headers.** Any script injection could have read saved data and sent it anywhere. Nothing stopped the site being framed either. | Strict policy with no inline scripts or `eval`, network access limited to two named services, and framing blocked. Tested in a real browser. |
| **High** | **No licence file or source link**, though the app distributes GPLv3 software. | Added `LICENSE`, third-party notices, font licences, a source link in Settings, and a build warning. |
| **Medium** | **Pasted text could freeze the page** for over 45 seconds. Regexes in the PGN parser became catastrophically slow on long runs of blank lines or digits (ReDoS). | Rewrote parsing to work line by line, and added limits of 5 MB, 500 games and 1,500 half-moves. Worst case is now about 150 ms. |
| **Medium** | **Crafted positions broke the engine.** Odd FENs passed validation, then Stockfish rejected them and answered for the *previous* position, silently giving wrong analysis, and the old worker leaked. | Stricter position check, confirmed by fuzzing against Stockfish. Failed workers are now replaced with settings restored, and a watchdog catches hangs. |
| **Medium** | **Backups were restored unchecked**, so a malicious or damaged file could write anything into storage. | Only known keys are accepted, and every game and drill is validated. Backups from newer versions are refused. |
| **Medium** | **Two open tabs overwrote each other's progress**, with the last write winning. | Tabs now keep each other in sync. |
| **Medium** | **Storage failures were silent**, so a full browser could lose data without warning. | A visible warning now tells the user to save a backup. |
| **Medium** | **A deployment could ship with no chess engine** if installed without dev dependencies, because the copy step skipped silently. | A post-build check now fails the build. It also scans for secrets and source maps, and was tested with a planted key. |
| **Medium** | **Wrong caching could trap users on an old version.** | `_headers` and `vercel.json` set the correct cache rules. |
| **Low** | **Chess.com import fetched whatever addresses a response listed.** | Addresses are checked against a strict pattern first, and requests send no cookies or referrer. |
| **Low** | **Raw PGN went into Claude prompts**, so an opponent could hide instructions in a name or comment. The model had no tools or access to the key, so the worst case was misleading advice. | Fixed at the time, and no longer relevant now that the feature is gone. |
| **Low** | Smaller items: a bad date could abort an import, a URL like `#/constructor` showed internals in the page title, a failed puzzle download couldn't retry, `.env` wasn't in `.gitignore`, and there was an unused font dependency. | All fixed. |

## Tested and found sound

| Area | Result |
| --- | --- |
| **Script injection (XSS)** | Payloads in PGN names, events, comments and URLs all rendered as plain text and never ran. The code has no raw HTML or `eval`, and a test now enforces that. |
| **The policy blocks attacks** | `eval`, `new Function`, injected inline scripts, inline event handlers, external scripts, and data sent by `fetch` or image were all blocked in a real browser. |
| **The policy doesn't break features** | Stockfish, the bot worker, puzzles, fonts and both imports all ran with no violations. |
| **Secrets** | None in the build, and none in any commit. The app no longer stores an API key, and upgrading deletes any key saved by an earlier version. |
| **Unexpected network traffic** | Browsing every page contacts only the app's own server. There are no third-party scripts, fonts or analytics, and no cookies. |
| **Dependencies** | No known vulnerabilities in anything that ships. All 455 packages come from the npm registry with integrity hashes, and none of the shipped ones run install scripts. |
| **Prototype pollution** | `__proto__` and `constructor` in URLs, PGN tags and backups had no effect. |
| **Offline cache** | The service worker only caches the app's own files, never API responses or data. |

## Risks that remain

These come with the design, and I've left them in place on purpose:

| Risk | Why it stays | What limits it |
| --- | --- | --- |
| **Ratings and progress can be edited by the user.** | They're local and affect only that person. | **This must change for online play**, where the server has to be the authority. |
| **Data lives only in one browser.** | There's no server. | Backups, and a request for persistent storage. |
| **Low-severity `deepmerge` advisory** in `vite-plugin-pwa`. | Only used at build time, and never ships or handles untrusted input. | Update when a fix is released. |
| **Supply chain trust**, especially the `stockfish` package. | Any dependency could be compromised upstream. | The lockfile pins exact versions and hashes. Enable Dependabot once on GitHub. |

## Not covered

- **Browsers:** tested in Chromium only. Check Firefox and Safari before launch, especially WebAssembly under the policy.
- **Your host:** nothing has been deployed yet, so the headers need checking on the live site (see [DEPLOYING.md](DEPLOYING.md)).
- **Legal review:** licensing and terms are flagged here, but need your own judgement or a lawyer.

## Accounts and access codes (added 2 November 2026)

Everything above covers the static app. This section covers the Supabase backend added after it.

### How access is enforced

| Rule | How |
| --- | --- |
| **Admin rights can't be gained from the site** | They live in `public.admins`, which no client role can read or write. The only way in is `grant_admin`, which only the database owner can run. Nothing users can edit, such as `user_metadata`, is ever read |
| **Every admin action is checked by the database** | Each function starts with `require_admin()`, which needs a row in `admins`, an active membership and a two-factor login. Hiding the page is only a convenience |
| **Sign-ups are off** | Accounts are created only by the redeem function, after it uses up a valid code |
| **Codes can't be guessed or reused** | 80 random bits, stored only as hashes, claimed atomically, and rate-limited per address and overall |
| **Data is per person** | Row-level security on every table, and only `user_records` is open to clients, limited to the caller's own rows with an active membership |
| **Removal is immediate** | Row-level security checks membership on every query, so it doesn't wait for a login to expire |
| **Abuse is limited** | 50 MB and 20,000 records per account, 2 MB per record, and server-set timestamps |
| **The service role key stays on the server** | Only the redeem function has it, and the build fails if one reaches the app's code or a `VITE_` variable |
| **People sharing a browser are separated** | Each account has its own local database, deleted at sign-out |

### Tested

`tests/database.test.ts` runs the real SQL on a real Postgres, set up like Supabase with the same roles, default grants and a non-superuser owner. Each of these was tried against all six admin functions, and refused: an anonymous visitor, a person with no membership, a normal member, a member with two-factor login, a member forging admin in `user_metadata`, `app_metadata` and the login's role, a real admin without two-factor login, and a login with no user id. It also covers direct writes to private tables, reading or changing another person's records, reused, expired, revoked and email-locked codes, ten simultaneous claims of one code, the storage limit, and account deletion.

In a browser, against a stand-in server: a signed-out visitor forcing `#/admin` got the sign-in gate, and a normal member got "Page not found" and a refused API call. Sign-in, two-factor set-up, creating and revoking codes, removing a person, sign-out clearing local data, and the invite link leaving the address bar were also checked.

### Not tested yet

These need your real Supabase project, and the checklist in [SUPABASE_SETUP.md](SUPABASE_SETUP.md) covers them:

- The real sign-in service, email delivery, two-factor codes, the redeem function, and its rate limit behind Supabase's network
- The access rules on Supabase itself, rather than on a copy of its setup
- Syncing between two real devices
- Restoring a backup

### Risks that remain

| Risk | Why it stays | What limits it |
| --- | --- | --- |
| **The app's code and offline chess tools are public.** Someone can bypass the sign-in screen, or run the code themselves. | The code is public under the GPL, and it runs in the browser. | They get only the offline tools, with no account or anyone's data. |
| **Sign-in tokens are stored in the browser.** Malicious script in the page could read them. | This is how browser-only apps work. | The security policy blocks injected scripts and limits where data can be sent. Tokens expire within about an hour. |
| **The email in a pending invite can be chosen by anyone holding a code.** | A code is the proof of access. | Lock a code to an email in Admin when it matters. |
| **People can still edit their own ratings and progress.** | They're that person's own data, with no effect on anyone else. | **Must change for leaderboards or multiplayer**, where the server has to be the authority. |
| **The privacy policy is a plain-language draft.** | It hasn't had legal review. | Review it, especially if you invite under-18s or people in the EU or UK. |

## Before adding multiplayer

Multiplayer adds a new attack surface, and needs its own audit. At minimum:

- Server-side validation of every move and clock, reusing `src/core`
- Cheat detection, moderation, reporting and blocking
- A privacy policy, data deletion, and legal review (GDPR and minors, since chess attracts young players)
- Rate limiting and abuse protection

## How this stays fixed

`npm test` includes security tests covering hostile input, backups, import restrictions and banned code patterns. `tests/guard.engine.test.ts` fuzzes the position check against real Stockfish, and every production build runs `scripts/check-dist.mjs`.
