// Works out which screen someone should see. This is only for drawing the app. It grants nothing: the database
// checks every read, write and admin action for itself, whatever this file says.

export type Access =
  | { state: 'local' }
  | { state: 'signedOut' }
  | { state: 'setPassword' }
  | { state: 'offline' }
  | { state: 'removed'; email: string }
  | { state: 'ready'; userId: string; email: string; admin: boolean; twoFactor: boolean; offline: boolean };

export interface CachedAccount {
  userId: string;
  email: string;
  checkedAt: number;
}

/** How long a device can stay offline before it has to check in. */
export const OFFLINE_DAYS = 30;

export interface AccessFacts {
  enabled: boolean;
  /** From the link in an invite or password-reset email. */
  linkType: string | null;
  session: { userId: string; email: string } | null;
  /** What the server said, or null if it couldn't be reached. */
  server: { member: boolean; admin: boolean; twoFactor: boolean } | null;
  cached: CachedAccount | null;
  online: boolean;
  now: number;
}

export function decideAccess(facts: AccessFacts): Access {
  const { enabled, linkType, session, server, cached, online, now } = facts;
  if (!enabled) return { state: 'local' };
  const cachedIsFresh = cached !== null && now - cached.checkedAt < OFFLINE_DAYS * 86_400_000;

  if (!session) {
    // An expired login can't be renewed offline. Someone recently confirmed as a member keeps their offline app.
    if (!online && cachedIsFresh) return { state: 'ready', userId: cached.userId, email: cached.email, admin: false, twoFactor: false, offline: true };
    return { state: 'signedOut' };
  }
  if (linkType === 'invite' || linkType === 'recovery') return { state: 'setPassword' };
  if (server) {
    if (!server.member) return { state: 'removed', email: session.email };
    return { state: 'ready', userId: session.userId, email: session.email, admin: server.admin, twoFactor: server.twoFactor, offline: false };
  }
  // Admin is never assumed offline, and neither is membership for someone this device hasn't confirmed lately.
  if (cachedIsFresh && cached.userId === session.userId) return { state: 'ready', userId: session.userId, email: session.email, admin: false, twoFactor: false, offline: true };
  return { state: 'offline' };
}

export const PASSWORD_MIN = 10;

export function passwordProblem(password: string, repeat: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password !== repeat) return "Those passwords don't match.";
  return null;
}
