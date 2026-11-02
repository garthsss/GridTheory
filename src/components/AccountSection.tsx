import { useState } from 'react';
import { passwordProblem, PASSWORD_MIN } from '../backend/access';
import { currentAccount, deleteAccount, signOut, syncNow, unsyncedCount, useSyncStatus } from '../backend/account';
import { supabase } from '../backend/client';

const STATUS_TEXT = {
  idle: 'All changes synced.',
  syncing: 'Syncing…',
  offline: "You're offline. Changes are saved here, and will sync when you reconnect.",
  denied: "Sync is blocked because your access has changed.",
  full: 'Your account has reached its storage limit.',
};

export function AccountSection() {
  const account = currentAccount();
  const status = useSyncStatus();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsynced, setUnsynced] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!account) return null;

  async function changePassword() {
    const problem = passwordProblem(password, repeat);
    setError(problem);
    setMessage(null);
    if (problem) return;
    const { error: failed } = await supabase!.auth.updateUser({ password });
    if (failed) {
      setError('That password could not be saved. Try a different one.');
      return;
    }
    setPassword('');
    setRepeat('');
    setMessage('Password changed.');
  }

  async function leave(force: boolean) {
    setBusy(true);
    if (!(await signOut(force))) setUnsynced(true);
    setBusy(false);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteAccount();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : 'Your account could not be deleted.');
      setBusy(false);
    }
  }

  return (
    <section className="settings-card">
      <h2>Account</h2>
      <p>Signed in as <strong>{account.email}</strong>.</p>
      <p className="small muted account-status" role="status">
        {STATUS_TEXT[status]}
        {(status === 'offline' || status === 'denied') && <button type="button" className="link-button inline" onClick={() => void syncNow()}>Try now</button>}
      </p>
      {account.offline ? (
        <p className="small muted">Some account options need a connection.</p>
      ) : (
        <>
          <label htmlFor="change-password">New password</label>
          <input id="change-password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} value={password} onChange={(event) => setPassword(event.target.value)} />
          <label htmlFor="change-password-repeat">Type it again</label>
          <input id="change-password-repeat" type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />
          <button type="button" className="btn" onClick={() => void changePassword()} disabled={!password}>Change password</button>
        </>
      )}
      {message && <p className="small" role="status">{message}</p>}
      {error && <p className="error small" role="alert">{error}</p>}

      <div className="btn-row">
        <button type="button" className="btn" disabled={busy} onClick={() => void leave(false)}>Sign out</button>
        {!account.admin && !account.offline && <button type="button" className="btn btn-quiet" onClick={() => setDeleting(true)}>Delete my account</button>}
      </div>
      {unsynced && (
        <div role="alert">
          <p className="error small">{unsyncedCount()} changes haven't synced, and signing out removes them from this browser. Reconnect first, or sign out anyway and lose them.</p>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void leave(true)}>Sign out and lose them</button>
        </div>
      )}
      {deleting && (
        <div role="alert">
          <p className="small"><strong>This permanently deletes your account, games and progress.</strong> It can't be undone, and you'd need a new access code to come back. Download a backup first if you want to keep anything. Type DELETE to confirm.</p>
          <input aria-label="Type DELETE to confirm" autoComplete="off" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
          <div className="btn-row">
            <button type="button" className="btn btn-danger" disabled={busy || confirmText !== 'DELETE'} onClick={() => void remove()}>Delete everything</button>
            <button type="button" className="btn btn-quiet" onClick={() => { setDeleting(false); setConfirmText(''); }}>Keep my account</button>
          </div>
        </div>
      )}
    </section>
  );
}
