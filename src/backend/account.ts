import { useEffect, useState } from 'react';
import { forgetAccountData, openAccountStore, store } from '../lib/store';
import { decideAccess, type Access, type CachedAccount } from './access';
import { backendEnabled, linkType, supabase } from './client';
import { SyncedAdapter, SyncEngine, type RemoteRecords, type SyncStatus } from './sync';

const CACHE_KEY = 'gts.account';
const FIRST_SYNC_WAIT_MS = 8000;
const PUSH_DELAY_MS = 3000;
const PERIODIC_MS = 5 * 60_000;

const readCache = (): CachedAccount | null => {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as CachedAccount | null;
  } catch {
    return null;
  }
};

let account: Extract<Access, { state: 'ready' }> | null = null;
export const currentAccount = () => account;

async function checkServer() {
  const { data, error } = await supabase!.rpc('my_access');
  if (error) return null;
  return data as { member: boolean; admin: boolean; twoFactor: boolean };
}

export async function loadAccess(): Promise<Access> {
  let session: { userId: string; email: string } | null = null;
  let server: Awaited<ReturnType<typeof checkServer>> = null;
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      session = { userId: data.session.user.id, email: data.session.user.email ?? '' };
      server = await checkServer();
    }
  }
  const access = decideAccess({ enabled: backendEnabled, linkType, session, server, cached: readCache(), online: navigator.onLine, now: Date.now() });
  if (access.state === 'ready') {
    account = access;
    if (!access.offline) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ userId: access.userId, email: access.email, checkedAt: Date.now() } satisfies CachedAccount));
      } catch {
        // Only offline use depends on this.
      }
    }
  }
  return access;
}

const remoteRecords = (userId: string): RemoteRecords => ({
  async changesSince(since, offset, limit) {
    let query = supabase!.from('user_records').select('key, value, deleted, updated_at').order('updated_at').order('key').range(offset, offset + limit - 1);
    if (since) query = query.gt('updated_at', since);
    const { data, error } = await query;
    if (error) throw error;
    return data;
  },
  async upload(rows) {
    const { error } = await supabase!.from('user_records').upsert(rows.map((row) => ({ ...row, user_id: userId })), { onConflict: 'user_id,key' });
    if (error) throw error;
  },
});

let engine: SyncEngine | null = null;
let adapter: SyncedAdapter | null = null;
let syncStatus: SyncStatus = 'idle';
const statusListeners = new Set<(status: SyncStatus) => void>();

export function useSyncStatus() {
  const [status, setStatus] = useState(syncStatus);
  useEffect(() => {
    statusListeners.add(setStatus);
    return () => {
      statusListeners.delete(setStatus);
    };
  }, []);
  return status;
}

export const unsyncedCount = () => adapter?.dirty.size ?? 0;
export const syncNow = () => engine?.sync() ?? Promise.resolve();

/** If an admin removes this person, or their login ends, the app closes the next time it checks. */
async function recheckAccess() {
  if (!account || account.offline) return;
  const server = await checkServer();
  if (server && !server.member) window.location.reload();
}

/** Opens this account's storage, brings in the latest from the server, and keeps the two in step from then on. */
export async function startAccount(userId: string) {
  await openAccountStore(userId, (local) => (adapter = new SyncedAdapter(local)));
  engine = new SyncEngine(adapter!, remoteRecords(userId), store, (status) => {
    syncStatus = status;
    for (const listener of statusListeners) listener(status);
  });

  // Waits briefly, so that a new device shows real progress, but never holds up someone with a bad connection.
  await Promise.race([engine.sync(), new Promise((resolve) => setTimeout(resolve, FIRST_SYNC_WAIT_MS))]);

  let timer: number | undefined;
  adapter!.onChange = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void engine?.sync(), PUSH_DELAY_MS);
  };
  const refresh = () => {
    void engine?.sync();
    void recheckAccess();
  };
  window.setInterval(refresh, PERIODIC_MS);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
    else void engine?.sync();
  });
}

/** Signs out and removes this account's data from the browser. Returns false, doing nothing, if unsaved changes would be lost. */
export async function signOut(force = false): Promise<boolean> {
  await syncNow();
  if (!force && unsyncedCount() > 0) return false;
  await leave();
  return true;
}

async function leave() {
  const id = account?.userId;
  await supabase?.auth.signOut({ scope: 'local' });
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // Nothing further to do.
  }
  if (id) forgetAccountData(id);
  window.location.replace(window.location.pathname);
}

export async function deleteAccount() {
  const { error } = await supabase!.rpc('delete_my_account');
  if (error) throw new Error(error.message);
  await leave();
}
