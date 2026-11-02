import { useState, type FormEvent, type ReactNode } from 'react';
import type { Access } from '../backend/access';
import { passwordProblem, PASSWORD_MIN } from '../backend/access';
import { signOut } from '../backend/account';
import { linkError, linkType, supabase } from '../backend/client';
import { PrivacyContent } from './PrivacyPage';

type Mode = 'signin' | 'redeem' | 'forgot' | 'privacy';

const backToApp = () => window.location.replace(window.location.pathname);

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="gate" id="main">
      <div className="gate-card">
        <div className="brand gate-brand">
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span className="brand-name">GridTheory</span>
        </div>
        {children}
      </div>
    </main>
  );
}

function SetPassword() {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, repeat);
    setError(problem);
    if (problem) return;
    setBusy(true);
    const { error: failed } = await supabase!.auth.updateUser({ password });
    setBusy(false);
    if (failed) setError('That password could not be saved. Try a different one.');
    else backToApp();
  }

  return (
    <Shell>
      <h1>{linkType === 'invite' ? 'Welcome. Choose a password' : 'Choose a new password'}</h1>
      <form onSubmit={(event) => void submit(event)} className="gate-form">
        <label htmlFor="new-password">Password</label>
        <input id="new-password" type="password" autoComplete="new-password" required minLength={PASSWORD_MIN} value={password} onChange={(event) => setPassword(event.target.value)} />
        <label htmlFor="repeat-password">Type it again</label>
        <input id="repeat-password" type="password" autoComplete="new-password" required value={repeat} onChange={(event) => setRepeat(event.target.value)} />
        <p className="small muted">At least {PASSWORD_MIN} characters. A short phrase is easier to remember and harder to guess.</p>
        {error && <p className="error small" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
      </form>
    </Shell>
  );
}

export function AuthGate({ access }: { access: Access }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(linkError ? 'That link has expired or was already used. Sign in, or ask for a new one below.' : null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (access.state === 'setPassword') return <SetPassword />;

  if (access.state === 'offline') {
    return (
      <Shell>
        <h1>You're offline</h1>
        <p>Your access couldn't be checked. Reconnect to the internet, then try again.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Try again</button>
      </Shell>
    );
  }

  if (access.state === 'removed') {
    return (
      <Shell>
        <h1>No access</h1>
        <p><strong>{access.email}</strong> doesn't have access to GridTheory at the moment. If you think that's a mistake, contact the person who invited you.</p>
        <button type="button" className="btn" onClick={() => void signOut(true)}>Sign out</button>
      </Shell>
    );
  }

  const go = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failed } = await supabase!.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (failed) setError(failed.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : "That email and password don't match.");
    else backToApp();
  }

  async function redeem(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failed } = await supabase!.functions.invoke('redeem-invite', { body: { code, email: email.trim() } });
    setBusy(false);
    if (!failed) {
      setCode('');
      setNotice(`Your code is accepted. Check ${email.trim()} for an email with a link to finish setting up, including your spam folder.`);
      return;
    }
    const status = (failed as { context?: { status?: number } }).context?.status;
    setError(status === 429 ? 'Too many attempts. Try again in an hour.' : status === 400 ? "That code can't be used with that email. Check you've typed both correctly, or ask for a new code." : "Something went wrong and your code wasn't used. Try again shortly.");
  }

  async function forgot(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    await supabase!.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}${window.location.pathname}` });
    setBusy(false);
    // The same message whether or not the account exists, so this can't be used to find out who has one.
    setNotice(`If ${email.trim()} has an account, a reset link is on its way.`);
  }

  if (mode === 'privacy') {
    return (
      <Shell>
        <button type="button" className="link-button" onClick={() => go('signin')}>Back to sign in</button>
        <PrivacyContent />
      </Shell>
    );
  }

  const emailField = (
    <>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
    </>
  );

  return (
    <Shell>
      <p className="muted gate-tag">GridTheory is invite-only.</p>
      {mode === 'signin' && (
        <form onSubmit={(event) => void signIn(event)} className="gate-form">
          <h1>Sign in</h1>
          {emailField}
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          {error && <p className="error small" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <button type="button" className="link-button" onClick={() => go('forgot')}>Forgot your password?</button>
          <button type="button" className="link-button" onClick={() => go('redeem')}>I have an access code</button>
        </form>
      )}
      {mode === 'redeem' && (
        <form onSubmit={(event) => void redeem(event)} className="gate-form">
          <h1>Use your access code</h1>
          <label htmlFor="code">Access code</label>
          <input id="code" autoComplete="off" spellCheck={false} required maxLength={64} placeholder="GT-XXXX-XXXX-XXXX-XXXX" value={code} onChange={(event) => setCode(event.target.value)} />
          {emailField}
          <p className="small muted">A code works once, and creates your account. By continuing, you accept the <button type="button" className="link-button inline" onClick={() => go('privacy')}>privacy policy</button>.</p>
          {error && <p className="error small" role="alert">{error}</p>}
          {notice && <p className="feedback feedback-good small" role="status">{notice}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
          <button type="button" className="link-button" onClick={() => go('signin')}>Back to sign in</button>
        </form>
      )}
      {mode === 'forgot' && (
        <form onSubmit={(event) => void forgot(event)} className="gate-form">
          <h1>Reset your password</h1>
          {emailField}
          {notice && <p className="feedback feedback-good small" role="status">{notice}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
          <button type="button" className="link-button" onClick={() => go('signin')}>Back to sign in</button>
        </form>
      )}
      <button type="button" className="link-button gate-foot" onClick={() => go('privacy')}>Privacy policy</button>
    </Shell>
  );
}
