// Runs on Supabase's servers, the only place the service role key exists. Deno provides these imports and globals.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, redeem, type RedeemDeps } from './logic.ts';

const SITE_URL = Deno.env.get('SITE_URL')!;
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function hashAddress(ip: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw error;
  return data as T;
}

const deps: RedeemDeps = {
  allowAttempt: async (ip) => rpc<boolean>('allow_redeem_attempt', { p_ip_hash: await hashAddress(ip) }),
  claim: (code, email) => rpc<string | null>('claim_invite', { p_code: code, p_email: email }),
  release: (invite) => rpc<void>('release_invite', { p_invite: invite }),
  complete: (invite, user) => rpc<void>('complete_invite', { p_invite: invite, p_user: user }),
  createAccount: async (email) => {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: SITE_URL });
    if (error) {
      console.error('Could not create the account:', error.status, error.code);
      return null;
    }
    return data.user.id;
  },
  removeAccount: async (user) => {
    await admin.auth.admin.deleteUser(user);
  },
};

Deno.serve(async (request: Request) => {
  const headers = { ...corsHeaders(request.headers.get('origin'), SITE_URL), 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response('{}', { status: 405, headers });

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  try {
    const text = await request.text();
    if (text.length > 2000) return new Response('{"ok":false,"error":"invalid"}', { status: 400, headers });
    let input: unknown = null;
    try {
      input = JSON.parse(text);
    } catch {
      // Treated below as a bad request, the same as any other.
    }
    const result = await redeem(input, ip, deps);
    return new Response(JSON.stringify(result.body), { status: result.status, headers });
  } catch (error) {
    console.error('Redeem failed:', error instanceof Error ? error.name : 'unknown');
    return new Response('{"ok":false,"error":"failed"}', { status: 500, headers });
  }
});
