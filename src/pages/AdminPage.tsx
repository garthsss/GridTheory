import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { currentAccount } from '../backend/account';
import { supabase } from '../backend/client';

// This page is only a set of buttons. Every action below is checked again by the database, against the admins table and
// a two-factor login, so a person who forces this page open, or edits this code in their browser, gets nothing from it.

interface Invite {
  id: string;
  label: string;
  lockedEmail: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  claimedAt: string | null;
  claimedBy: string | null;
}

interface Member {
  userId: string;
  email: string;
  status: 'active' | 'removed';
  joinedAt: string;
  usedBytes: number;
  admin: boolean;
}

interface AuditEntry {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  target: string | null;
}

const when = (date: string) => new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const size = (bytes: number) => (bytes < 1_048_576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`);

function inviteStatus(invite: Invite) {
  if (invite.claimedAt) return invite.claimedBy ? `Used by ${invite.claimedBy}` : 'Used';
  if (invite.revokedAt) return 'Revoked';
  if (new Date(invite.expiresAt) < new Date()) return 'Expired';
  return `Unused, expires ${when(invite.expiresAt)}`;
}

function NotFound() {
  return (
    <div className="page narrow">
      <h1>Page not found</h1>
      <p><a href="#/">Go to the home page</a></p>
    </div>
  );
}

function TwoFactor() {
  const [enrolment, setEnrolment] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const auth = supabase!.auth.mfa;
      const { data, error: failed } = await auth.listFactors();
      if (failed) {
        setError(failed.message);
        return;
      }
      const verified = data.totp.find((factor) => factor.status === 'verified');
      if (verified) {
        setFactorId(verified.id);
        return;
      }
      // Clears any half-finished set-up, whose code was never confirmed.
      for (const factor of data.all) if (factor.status !== 'verified') await auth.unenroll({ factorId: factor.id });
      const started = await auth.enroll({ factorType: 'totp', friendlyName: 'GridTheory admin' });
      if (started.error) {
        setError(started.error.message);
        return;
      }
      setEnrolment({ id: started.data.id, qr: started.data.totp.qr_code, secret: started.data.totp.secret });
      setFactorId(started.data.id);
    })();
  }, []);

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failed } = await supabase!.auth.mfa.challengeAndVerify({ factorId: factorId!, code: code.trim() });
    setBusy(false);
    if (failed) setError("That code didn't work. Codes change every 30 seconds, so try the current one.");
    else window.location.reload();
  }

  return (
    <div className="page narrow">
      <h1>Admin sign-in</h1>
      <section className="settings-card">
        {enrolment ? (
          <>
            <h2>Set up two-factor login</h2>
            <p>Admin tools need a code from an authenticator app, so a stolen password alone can't reach them. Scan this with an app such as Google Authenticator, or type the key in.</p>
            <img className="qr" src={enrolment.qr} alt="QR code for your authenticator app" width={180} height={180} />
            <p className="small">Key: <code className="selectable">{enrolment.secret}</code></p>
          </>
        ) : (
          <p>Enter the code from your authenticator app.</p>
        )}
        {factorId && (
          <form onSubmit={(event) => void verify(event)}>
            <label htmlFor="totp">6-digit code</label>
            <input id="totp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" required maxLength={7} value={code} onChange={(event) => setCode(event.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
          </form>
        )}
        {error && <p className="error small" role="alert">{error}</p>}
      </section>
    </div>
  );
}

function Tools() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [lockEmail, setLockEmail] = useState('');
  const [days, setDays] = useState(14);
  const [created, setCreated] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [i, m, a] = await Promise.all([
      supabase!.rpc('admin_list_invites'),
      supabase!.rpc('admin_list_members'),
      supabase!.rpc('admin_list_audit', { p_limit: 50 }),
    ]);
    const failed = i.error ?? m.error ?? a.error;
    if (failed) {
      setError(failed.message);
      return;
    }
    setInvites(i.data as Invite[]);
    setMembers(m.data as Member[]);
    setAudit(a.data as AuditEntry[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(name: string, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setConfirming(null);
    const { data, error: failed } = await supabase!.rpc(name, args);
    setBusy(false);
    if (failed) {
      setError(failed.message);
      return null;
    }
    await load();
    return data as unknown;
  }

  async function createInvite(event: FormEvent) {
    event.preventDefault();
    setCopied(false);
    const result = await act('admin_create_invite', { p_label: label.trim(), p_email: lockEmail.trim() || null, p_days: days });
    if (result) {
      setCreated(result as { code: string; expiresAt: string });
      setLabel('');
      setLockEmail('');
    }
  }

  return (
    <div className="page narrow">
      <header className="page-head"><h1>Admin</h1></header>
      {error && <p className="error" role="alert">{error}</p>}

      <section className="settings-card">
        <h2>Create an access code</h2>
        <form onSubmit={(event) => void createInvite(event)}>
          <label htmlFor="invite-label">Who it's for (only you see this)</label>
          <input id="invite-label" maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} />
          <label htmlFor="invite-email">Lock to an email (optional)</label>
          <input id="invite-email" type="email" value={lockEmail} onChange={(event) => setLockEmail(event.target.value)} />
          <label htmlFor="invite-days">Expires in</label>
          <select id="invite-days" value={days} onChange={(event) => setDays(Number(event.target.value))}>
            {[1, 7, 14, 30, 90].map((value) => <option key={value} value={value}>{value} {value === 1 ? 'day' : 'days'}</option>)}
          </select>
          <button type="submit" className="btn btn-primary" disabled={busy}>Create code</button>
        </form>
        {created && (
          <div className="new-code" role="status">
            <p><strong>Copy this now. It can't be shown again.</strong></p>
            <p><code className="selectable code-big">{created.code}</code></p>
            <button
              type="button"
              className="btn"
              onClick={() => void navigator.clipboard.writeText(created.code).then(() => setCopied(true))}
            >
              {copied ? 'Copied' : 'Copy code'}
            </button>
            <p className="small muted">It works once and expires on {when(created.expiresAt)}. Send it privately, because anyone holding it can use it.</p>
          </div>
        )}
      </section>

      <section className="settings-card">
        <h2>Access codes</h2>
        {invites.length === 0 ? <p className="muted">None yet.</p> : (
          <ul className="admin-list">
            {invites.map((invite) => (
              <li key={invite.id}>
                <div>
                  <strong>{invite.label || 'No label'}</strong>{invite.lockedEmail && <span className="muted small"> (only {invite.lockedEmail})</span>}
                  <br /><span className="small muted">{inviteStatus(invite)}</span>
                </div>
                {!invite.claimedAt && !invite.revokedAt && (
                  <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void act('admin_revoke_invite', { p_invite: invite.id })}>Revoke</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-card">
        <h2>People</h2>
        <ul className="admin-list">
          {members.map((member) => (
            <li key={member.userId}>
              <div>
                <strong>{member.email}</strong>{member.admin && <span className="tag">Admin</span>}{member.status === 'removed' && <span className="tag">Removed</span>}
                <br /><span className="small muted">Joined {when(member.joinedAt)}, using {size(member.usedBytes)}</span>
              </div>
              {!member.admin && (member.status === 'removed' ? (
                <button type="button" className="btn" disabled={busy} onClick={() => void act('admin_set_member_status', { p_user: member.userId, p_status: 'active' })}>Restore</button>
              ) : confirming === member.userId ? (
                <span className="btn-row">
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act('admin_set_member_status', { p_user: member.userId, p_status: 'removed' })}>Yes, remove</button>
                  <button type="button" className="btn btn-quiet" onClick={() => setConfirming(null)}>Cancel</button>
                </span>
              ) : (
                <button type="button" className="btn btn-quiet" onClick={() => setConfirming(member.userId)}>Remove</button>
              ))}
            </li>
          ))}
        </ul>
        <p className="small muted">Removing someone cuts off their account and synced data straight away. You can restore them later. Admin rights can only be changed in the database.</p>
      </section>

      <section className="settings-card">
        <h2>Recent activity</h2>
        {audit.length === 0 ? <p className="muted">Nothing yet.</p> : (
          <ul className="admin-list small">
            {audit.map((entry) => <li key={entry.id}><span>{entry.action}</span><span className="muted">{new Date(entry.at).toLocaleString()}</span></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}

export function AdminPage() {
  const account = currentAccount();
  if (!account?.admin) return <NotFound />;
  return account.twoFactor ? <Tools /> : <TwoFactor />;
}
