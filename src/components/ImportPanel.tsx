import { Download, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { ImportError, SITE_NAMES, importGames, type Site } from '../import/sources';
import { loadGames, loadProfile, saveGame, saveProfile } from '../lib/storage';
import { cancelBatch, runBatch, useBatch } from '../review/batch';

const COUNTS = [20, 50, 100, 300];
const DEPTHS = [
  { depth: 10, label: 'Quick' },
  { depth: 14, label: 'Standard' },
];

/** Pulls games from Chess.com or Lichess, and analyses any unreviewed ones in the background. */
export function ImportPanel({ onChange }: { onChange: () => void }) {
  const profile = loadProfile();
  const [site, setSite] = useState<Site>(profile.lichess && !profile.chesscom ? 'lichess' : 'chesscom');
  const [names, setNames] = useState({ lichess: profile.lichess ?? '', chesscom: profile.chesscom ?? '' });
  const [count, setCount] = useState(50);
  const [depth, setDepth] = useState(10);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const batch = useBatch();
  const unreviewed = loadGames().filter((game) => !game.review);

  async function run() {
    const username = names[site].trim();
    setBusy(true);
    setMessage(null);
    try {
      const existing = new Set(loadGames().flatMap((game) => (game.externalId ? [game.externalId] : [])));
      const result = await importGames(site, username, count, existing);
      for (const game of result.added) saveGame(game);
      saveProfile({ [site]: username });
      const parts = [`Added ${result.added.length} ${result.added.length === 1 ? 'game' : 'games'} from ${SITE_NAMES[site]}.`];
      if (result.skipped) parts.push(`${result.skipped} already here.`);
      if (result.unreadable) parts.push(`${result.unreadable} couldn't be read.`);
      setMessage({ text: parts.join(' '), error: false });
      onChange();
    } catch (error) {
      setMessage({ text: error instanceof ImportError ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="import-card" aria-labelledby="import-heading">
      <h2 id="import-heading">Import your games</h2>
      <p className="small muted">Uses each site's public game archive, so no password or login is needed. Only the username you enter is sent.</p>
      <div className="import-row">
        <div className="segmented" role="group" aria-label="Site">
          {(Object.keys(SITE_NAMES) as Site[]).map((option) => (
            <button key={option} type="button" aria-pressed={site === option} onClick={() => setSite(option)}>{SITE_NAMES[option]}</button>
          ))}
        </div>
        <div className="import-name">
          <label htmlFor="import-username" className="sr-only">{SITE_NAMES[site]} username</label>
          <input
            id="import-username"
            value={names[site]}
            placeholder={`${SITE_NAMES[site]} username`}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setNames({ ...names, [site]: event.target.value })}
          />
        </div>
        <label className="import-count">
          <span className="sr-only">How many games</span>
          <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
            {COUNTS.map((option) => <option key={option} value={option}>Last {option}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={busy || !names[site].trim()}>
          <Download size={16} aria-hidden="true" />{busy ? 'Importing…' : 'Import'}
        </button>
      </div>
      {message && <p className={message.error ? 'error small' : 'small'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}

      {(unreviewed.length > 0 || batch.running) && (
        <div className="batch">
          {batch.running ? (
            <>
              <div className="batch-top">
                <span className="small"><strong>Analysing {batch.done} of {batch.total}</strong>{batch.current ? ` · ${batch.current}` : ''}</span>
                <button type="button" className="btn btn-quiet" onClick={cancelBatch}><Pause size={16} aria-hidden="true" />Stop</button>
              </div>
              <div className="progress" role="progressbar" aria-label="Batch analysis" aria-valuenow={batch.done} aria-valuemin={0} aria-valuemax={batch.total}>
                <div style={{ width: `${(batch.done / Math.max(1, batch.total)) * 100}%` }} />
              </div>
              <p className="small muted">You can keep using the app while this runs. It stops if you close the tab.</p>
            </>
          ) : (
            <div className="batch-top">
              <span className="small"><strong>{unreviewed.length} {unreviewed.length === 1 ? 'game' : 'games'} not yet analysed.</strong> Analysis creates your drills and fills in your skill map.</span>
              <div className="batch-actions">
                <div className="segmented" role="group" aria-label="Analysis depth">
                  {DEPTHS.map((option) => (
                    <button key={option.depth} type="button" aria-pressed={depth === option.depth} onClick={() => setDepth(option.depth)}>{option.label}</button>
                  ))}
                </div>
                <button type="button" className="btn" onClick={() => void runBatch(unreviewed.map((game) => game.id), depth).then(onChange)}>
                  <Play size={16} aria-hidden="true" />Analyse all
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
