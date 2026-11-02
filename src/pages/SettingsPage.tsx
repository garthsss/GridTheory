import { Moon, Monitor, Sun } from 'lucide-react';
import { useState } from 'react';
import { InstallButton } from '../components/InstallButton';
import { BackupError, MAX_BACKUP_BYTES } from '../lib/backup';
import { BOARD_THEMES, savePrefs, usePrefs, type AnimationSpeed, type ThemeMode } from '../lib/prefs';
import { playSound } from '../lib/sound';
import { exportBackup, loadProfile, resetProgress, restoreBackup, saveProfile } from '../lib/storage';

const THEMES: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
];

export function SettingsPage() {
  const prefs = usePrefs();
  const [confirmReset, setConfirmReset] = useState(false);
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const [profile, setProfile] = useState(loadProfile);

  function updateProfile(patch: Partial<typeof profile>) {
    saveProfile(patch);
    setProfile(loadProfile());
  }

  function exportData() {
    const data = exportBackup();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    link.download = 'gridtheory-backup.json';
    link.click();
    URL.revokeObjectURL(link.href);
    setDataMessage('Backup downloaded.');
  }

  async function importData(file: File) {
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new BackupError('That file is too large to be a GridTheory backup.');
      const dropped = await restoreBackup(JSON.parse(await file.text()));
      setDataMessage(`Backup restored${dropped ? `, skipping ${dropped} unusable ${dropped === 1 ? 'entry' : 'entries'}` : ''}. Reloading…`);
      window.setTimeout(() => window.location.reload(), 600);
    } catch (error) {
      setDataMessage(error instanceof BackupError ? error.message : 'That file is not a GridTheory backup.');
    }
  }

  function resetData() {
    resetProgress();
    setConfirmReset(false);
    setDataMessage('Games, rating and progress cleared.');
  }

  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <section className="settings-card">
        <h2>Profile</h2>
        <label htmlFor="profile-name">Your name</label>
        <input id="profile-name" value={profile.name} maxLength={40} onChange={(event) => updateProfile({ name: event.target.value })} />
        <p className="small muted">Used on your games. Everything stays on this device for now.</p>
      </section>

      <section className="settings-card">
        <h2>Appearance</h2>
        <fieldset>
          <legend>Theme</legend>
          <div className="segmented">
            {THEMES.map((theme) => (
              <button key={theme.id} type="button" aria-pressed={prefs.theme === theme.id} onClick={() => savePrefs({ theme: theme.id })}>
                <theme.icon size={16} aria-hidden="true" />{theme.label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Board</legend>
          <div className="swatches">
            {BOARD_THEMES.map((theme) => (
              <button key={theme.id} type="button" className="swatch" aria-pressed={prefs.board === theme.id} onClick={() => savePrefs({ board: theme.id })}>
                <span className="swatch-squares" aria-hidden="true">
                  <span style={{ background: theme.light }} /><span style={{ background: theme.dark }} />
                  <span style={{ background: theme.dark }} /><span style={{ background: theme.light }} />
                </span>
                {theme.label}
              </button>
            ))}
          </div>
        </fieldset>
      </section>

      <section className="settings-card">
        <h2>Board and game</h2>
        <fieldset>
          <legend>Piece animation</legend>
          <div className="segmented">
            {([['off', 'Off'], ['fast', 'Fast'], ['normal', 'Normal']] as [AnimationSpeed, string][]).map(([speed, label]) => (
              <button key={speed} type="button" aria-pressed={prefs.animation === speed} onClick={() => savePrefs({ animation: speed })}>{label}</button>
            ))}
          </div>
          <p className="small muted">Your system's reduced-motion setting always turns animation off.</p>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={prefs.sound} onChange={(event) => { savePrefs({ sound: event.target.checked }); if (event.target.checked) playSound('move'); }} />
          Sound effects
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.coordinates} onChange={(event) => savePrefs({ coordinates: event.target.checked })} />
          Show board coordinates
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.legalDots} onChange={(event) => savePrefs({ legalDots: event.target.checked })} />
          Show legal moves
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.autoQueen} onChange={(event) => savePrefs({ autoQueen: event.target.checked })} />
          Always promote to a queen
        </label>
      </section>

      <section className="settings-card">
        <h2>Keyboard</h2>
        <dl className="keys">
          <div><dt><kbd>Tab</kbd></dt><dd>Move focus to the board or any control</dd></div>
          <div><dt><kbd>Arrows</kbd></dt><dd>On the board: move around the squares</dd></div>
          <div><dt><kbd>Enter</kbd></dt><dd>On the board: pick up a piece, then place it</dd></div>
          <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Off the board: step through the moves of a game</dd></div>
          <div><dt><kbd>F</kbd></dt><dd>Flip the board during a game</dd></div>
        </dl>
        <p className="small muted">You can also type moves such as Nf3 in the box beside the board. Right-click a square to mark it, or right-drag to draw an arrow.</p>
      </section>

      <section className="settings-card">
        <h2>Install the app</h2>
        <p className="small">Installing gives GridTheory its own window and icon. It works offline, except for game import.</p>
        <InstallButton />
      </section>

      <section className="settings-card">
        <h2>Your data</h2>
        <p className="small">Games, rating and progress live in this browser only. Save a backup to move them, or before clearing browser data.</p>
        <div className="btn-row">
          <button type="button" className="btn" onClick={exportData}>Download backup</button>
          <label className="btn">
            Restore backup
            <input type="file" accept=".json" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importData(file); }} />
          </label>
          {confirmReset ? (
            <>
              <button type="button" className="btn btn-danger" onClick={resetData}>Yes, clear everything</button>
              <button type="button" className="btn btn-quiet" onClick={() => setConfirmReset(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmReset(true)}>Clear my data</button>
          )}
        </div>
        {dataMessage && <p className="small" role="status">{dataMessage}</p>}
      </section>

      <section className="settings-card">
        <h2>Privacy</h2>
        <p className="small">
          GridTheory has no accounts, tracking or analytics, and sets no cookies. Your games and progress stay in this browser. Data only leaves it when you ask.
        </p>
        <ul className="small privacy-list">
          <li><strong>Importing games</strong> sends the username you enter to Lichess or Chess.com.</li>
        </ul>
        <p className="small">Each site handles that data under its own privacy policy.</p>
      </section>

      <section className="settings-card">
        <h2>About the ratings</h2>
        <p className="small">
          Bot ratings come from a tournament between the bots at the same settings the app uses, anchored to Stockfish's own Elo settings. Those are calibrated
          against engine rating lists, not human players, so expect some difference from a rating at a chess club or website. Your own rating here
          is measured only against these bots.
        </p>
        <p className="small">
          Chess engine: <a href="https://stockfishchess.org" target="_blank" rel="noreferrer">Stockfish</a> (GPLv3), via the stockfish.js
          WebAssembly port. Move logic: chess.js. Piece set from react-chessboard. Puzzles from the <a href="https://database.lichess.org/#puzzles" target="_blank" rel="noreferrer">Lichess puzzle database</a> (CC0). Opening names from the <a href="https://github.com/lichess-org/chess-openings" target="_blank" rel="noreferrer">Lichess opening database</a> (CC0). Accuracy and move-grade formulas follow Lichess's published method.
        </p>
        <p className="small">
          GridTheory is free software under the <a href="licenses/LICENSE.txt">GNU GPL version 3</a>.{' '}
          {import.meta.env.VITE_SOURCE_URL ? <a href={import.meta.env.VITE_SOURCE_URL} target="_blank" rel="noreferrer">Get the source code</a> : 'This build has no source code link configured.'}.{' '}
          <a href="licenses/THIRD_PARTY_NOTICES.md">Third-party notices</a>.
        </p>
      </section>
    </div>
  );
}
