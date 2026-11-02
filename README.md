# GridTheory

A local-first chess training app. The chess runs in your browser, and invite-only accounts sync your progress between devices.

- **Play**: 12 bots from about 100 to 3000+, with optional chess clocks, live grades on every move, and a coach that can warn you before a bad move.
- **Train**: endless random opening, middlegame and endgame scenarios, with every move graded as you play it and an optional timer.
- **Learn**: a 64-lesson course from the rules to grandmaster ideas, with checkpoints and classic games.
- **Review**: paste a game or import from Chess.com and Lichess for move grades, explanations and study recommendations.
- **My mistakes**: errors from your analysed games become drills, repeated on a spaced schedule until you have them.
- **Puzzles**: 4,800 rated puzzles from Lichess with an adaptive rating, theme filters and a timed Rush mode.
- **Progress and Today**: a skill map from all your results, trend charts, and a daily plan aimed at your weakest area.

It can be installed as an app and works offline, apart from game import.

## Run it

Requires Node 22.15 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5173. With no backend configured, it runs with no accounts, and everything is stored in this browser. To add accounts and access codes, see [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

## Tests

```bash
npm test
```

Fast tests cover notation parsing, motif detection, grading, course legality and scenario rules. They also attack the real database rules on a real Postgres, as anonymous visitors, normal members and forged admins.

```bash
npm run verify:course
```

The slow suite runs real Stockfish: every course exercise is checked against the engine, the bots play matches
against each other to check the ladder order, and sample scenarios are generated in each phase.

## How the pieces fit

| Area | Files |
| --- | --- |
| Rules and clock logic with no UI, reusable on a server | `src/core/` |
| Storage layer, data migrations and backups | `src/lib/store.ts`, `src/lib/storage.ts` |
| Accounts, sync and access decisions | `src/backend/` |
| Database rules and the access-code function | `supabase/` |
| Chess.com and Lichess import | `src/import/sources.ts` |
| Drills, puzzles, skill map and daily plan | `src/training/` |
| Engine wrapper and bots | `src/engine/` |
| Move grading, motifs, coach personas | `src/coach/` |
| Course content | `src/course/content.ts` |
| Scenario generators | `src/training/scenarios.ts` |
| Game analysis and recommendations | `src/review/analyze.ts` |

Move grades and accuracy use Lichess's published win-chance formulas.

## Bot ratings

Ratings come from a 440-game tournament between the bots at the app's exact settings (`npm run calibrate`, about 35 minutes),
fitted by maximum likelihood and anchored so that the four mid-level Stockfish settings average their nominal Elo. Results are in
`calibration/results.json`. Stockfish's own Elo scale is calibrated against engine rating lists, not people, so these are
estimates of human strength. Expect an error of 100 points or more, and more than that at the extremes. Thinking is limited by time,
so the top bots will play a bit weaker on a slower computer than the one used for the measurement.

## Deploying and security

See [docs/DEPLOYING.md](docs/DEPLOYING.md), [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) and [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).

## Going online later

Accounts and sync already exist. For multiplayer, `src/core` has no UI dependencies, so a server can run the same rules to check
moves and clocks. Every game records a player id. Before multiple users, licensing should be reviewed.

To rebuild the puzzle set: `node scripts/build-puzzles.mjs <lichess_db_puzzle.csv.zst>`. A partial download works.
To rebuild the opening names: `node scripts/build-openings.mjs <folder with a.tsv to e.tsv from lichess-org/chess-openings>`.

## Licence

GPL-3.0-or-later, because the app bundles Stockfish (GPLv3). The lessons are original writing. They follow the teaching
order of the classic books listed under each level, and don't reproduce their text. Historic games are included as move lists.
