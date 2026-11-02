// The rules for using an access code, kept apart from the server so that they can be tested without one.

export interface RedeemDeps {
  /** False once this address, or everyone together, has tried too often. */
  allowAttempt(ip: string): Promise<boolean>;
  /** Uses up the code if it's valid for this email. Null if it isn't. */
  claim(code: string, email: string): Promise<string | null>;
  release(invite: string): Promise<void>;
  /** Creates the account and emails its set-up link. Null if that email can't have one, such as one already in use. */
  createAccount(email: string): Promise<string | null>;
  removeAccount(user: string): Promise<void>;
  complete(invite: string, user: string): Promise<void>;
}

export interface RedeemResult {
  status: number;
  body: { ok: boolean; error?: 'invalid' | 'rate_limited' | 'failed' };
}

const CODE = /^GT[A-HJ-NP-Z2-9]{16}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Every failure about the code or email looks the same, so this can't be used to test codes or discover who has an account.
const INVALID: RedeemResult = { status: 400, body: { ok: false, error: 'invalid' } };

export async function redeem(input: unknown, ip: string, deps: RedeemDeps): Promise<RedeemResult> {
  if (!(await deps.allowAttempt(ip))) return { status: 429, body: { ok: false, error: 'rate_limited' } };

  const { code, email } = (typeof input === 'object' && input !== null ? input : {}) as { code?: unknown; email?: unknown };
  if (typeof code !== 'string' || typeof email !== 'string' || code.length > 64) return INVALID;
  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const cleanEmail = email.trim().toLowerCase();
  if (!CODE.test(cleanCode) || cleanEmail.length > 254 || !EMAIL.test(cleanEmail)) return INVALID;

  const invite = await deps.claim(cleanCode, cleanEmail);
  if (!invite) return INVALID;

  let user: string | null = null;
  try {
    user = await deps.createAccount(cleanEmail);
    if (!user) {
      await deps.release(invite);
      return INVALID;
    }
    await deps.complete(invite, user);
    return { status: 200, body: { ok: true } };
  } catch {
    // Never leave an account with no membership, or a person's code wasted.
    if (user) await deps.removeAccount(user).catch(() => undefined);
    await deps.release(invite).catch(() => undefined);
    return { status: 500, body: { ok: false, error: 'failed' } };
  }
}

/** Only the site itself may call this from a browser. */
export function corsHeaders(origin: string | null, siteUrl: string): Record<string, string> {
  const allowed = new URL(siteUrl).origin;
  return {
    Vary: 'Origin',
    ...(origin === allowed
      ? {
          'Access-Control-Allow-Origin': allowed,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        }
      : {}),
  };
}
