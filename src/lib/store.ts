/**
 * The app's single storage layer. Reads are synchronous from memory, and writes go straight through to an adapter.
 * Everything saved goes through here, so syncing with a server later means adding an adapter, not touching pages.
 */
export interface StorageAdapter {
  loadAll(): Promise<Record<string, string>>;
  put(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryAdapter implements StorageAdapter {
  data: Record<string, string> = {};
  async loadAll() {
    return { ...this.data };
  }
  async put(key: string, value: string) {
    this.data[key] = value;
  }
  async remove(key: string) {
    delete this.data[key];
  }
}

const DB_NAME = 'gridtheory';
const DB_STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;

  async loadAll() {
    this.db = await openDb();
    const store = this.db.transaction(DB_STORE).objectStore(DB_STORE);
    return new Promise<Record<string, string>>((resolve, reject) => {
      const out: Record<string, string> = {};
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (row) {
          out[String(row.key)] = String(row.value);
          row.continue();
        } else {
          resolve(out);
        }
      };
      cursor.onerror = () => reject(cursor.error);
    });
  }

  private write(apply: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        reject(new Error('Storage is not open.'));
        return;
      }
      const transaction = this.db.transaction(DB_STORE, 'readwrite');
      apply(transaction.objectStore(DB_STORE));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  put(key: string, value: string) {
    return this.write((store) => store.put(value, key));
  }

  remove(key: string) {
    return this.write((store) => store.delete(key));
  }
}

const LOCAL_PREFIX = 'gts.';

/** Fallback for browsers with IndexedDB disabled. Holds much less, but keeps the app usable. */
export class LocalStorageAdapter implements StorageAdapter {
  async loadAll() {
    const out: Record<string, string> = {};
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(LOCAL_PREFIX)) out[key.slice(LOCAL_PREFIX.length)] = localStorage.getItem(key)!;
    }
    return out;
  }
  async put(key: string, value: string) {
    localStorage.setItem(LOCAL_PREFIX + key, value);
  }
  async remove(key: string) {
    localStorage.removeItem(LOCAL_PREFIX + key);
  }
}

export const SCHEMA_VERSION = 3;

export interface LegacyData {
  [key: string]: string;
}

/**
 * Upgrades saved data to the current schema. Each step runs once, in order. Old backups go through this too,
 * so that a backup from any version can still be restored.
 */
export function migrate(data: Record<string, string>): Record<string, string> {
  const out = { ...data };
  let version = Number(out.schema ?? 0);

  // 0 to 1: Phase 1 and 2 used "gt."-prefixed keys, with every game in one list.
  if (version < 1) {
    const games = out['gt.games'];
    for (const [key, value] of Object.entries(out)) {
      if (key.startsWith('gt.') && key !== 'gt.games') out[key.slice(3)] = value;
      if (key.startsWith('gt.')) delete out[key];
    }
    if (games) {
      try {
        for (const game of JSON.parse(games) as { id: string }[]) out[`game:${game.id}`] = JSON.stringify(game);
      } catch {
        // A damaged list cannot be recovered, and shouldn't block the rest of the upgrade.
      }
    }
    version = 1;
  }

  // 1 to 2: games record a precise source, and training games are no longer labelled as bot games.
  if (version < 2) {
    for (const [key, value] of Object.entries(out)) {
      if (!key.startsWith('game:')) continue;
      try {
        const game = JSON.parse(value) as { pgn: string; source: string };
        if (game.source === 'bot' && game.pgn.includes('GridTheory training')) game.source = 'training';
        out[key] = JSON.stringify(game);
      } catch {
        delete out[key];
      }
    }
    version = 2;
  }

  // 2 to 3: the Claude coach is gone, so nothing should keep holding the API key it used.
  if (version < 3) {
    delete out.settings;
    version = 3;
  }

  out.schema = String(version);
  return out;
}

export class Store {
  private cache = new Map<string, string>();
  private adapter: StorageAdapter = new MemoryAdapter();
  private parsed = new Map<string, unknown>();
  /** Set when a write failed, so that the app can warn instead of silently losing data. */
  lastError: string | null = null;
  private errorListeners = new Set<(message: string) => void>();
  private channel: BroadcastChannel | null = null;

  onError(listener: (message: string) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  private fail(error: unknown) {
    this.lastError = error instanceof Error ? error.message : String(error);
    for (const listener of this.errorListeners) listener(this.lastError);
  }

  /**
   * Keeps other open tabs up to date. Without this, each tab holds its own copy in
   * memory, and whichever wrote last would quietly undo the other's progress.
   */
  connectTabs() {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel('gridtheory-store');
    this.channel.onmessage = (event: MessageEvent<{ key: string; value: string | null }>) => {
      const { key, value } = event.data;
      this.parsed.delete(key);
      if (value === null) this.cache.delete(key);
      else this.cache.set(key, value);
    };
  }

  /** Loads everything into memory, and folds in any data left by older versions of the app. */
  async hydrate(adapter: StorageAdapter, legacy: Record<string, string> = {}) {
    this.adapter = adapter;
    const stored = await adapter.loadAll();
    const merged = { ...legacy, ...stored };
    const migrated = migrate(merged);
    this.cache = new Map(Object.entries(migrated));
    this.parsed.clear();
    for (const [key, value] of Object.entries(migrated)) {
      if (stored[key] !== value) await adapter.put(key, value);
    }
    for (const key of Object.keys(stored)) {
      if (!(key in migrated)) await adapter.remove(key);
    }
  }

  get<T>(key: string, fallback: T): T {
    if (this.parsed.has(key)) return this.parsed.get(key) as T;
    const raw = this.cache.get(key);
    if (raw === undefined) return fallback;
    try {
      const value = JSON.parse(raw) as T;
      this.parsed.set(key, value);
      return value;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown) {
    const raw = JSON.stringify(value);
    this.cache.set(key, raw);
    this.parsed.set(key, value);
    this.channel?.postMessage({ key, value: raw });
    this.adapter.put(key, raw).catch((error: unknown) => this.fail(error));
  }

  remove(key: string) {
    this.cache.delete(key);
    this.parsed.delete(key);
    this.channel?.postMessage({ key, value: null });
    this.adapter.remove(key).catch((error: unknown) => this.fail(error));
  }

  keys(prefix = ''): string[] {
    return [...this.cache.keys()].filter((key) => key.startsWith(prefix));
  }

  /** All values under a prefix, for records stored one per key. */
  list<T>(prefix: string): T[] {
    return this.keys(prefix).map((key) => this.get<T | null>(key, null)).filter((value): value is T => value !== null);
  }

  exportAll(): Record<string, string> {
    return Object.fromEntries(this.cache);
  }

  /** Replaces matching keys with a backup's contents, upgrading the backup first. */
  async importAll(data: Record<string, string>) {
    const migrated = migrate(data);
    for (const [key, value] of Object.entries(migrated)) {
      this.cache.set(key, value);
      this.parsed.delete(key);
      await this.adapter.put(key, value);
    }
  }
}

export const store = new Store();

/** Connects the real browser storage. Call once before the app renders. */
export async function openStore() {
  const legacy: Record<string, string> = {};
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('gt.')) legacy[key] = localStorage.getItem(key)!;
    }
  } catch {
    // Storage may be blocked; there is simply nothing to carry over.
  }
  try {
    await store.hydrate(new IndexedDbAdapter(), legacy);
  } catch {
    await store.hydrate(new LocalStorageAdapter(), legacy);
  }
  // The old keys can go once their contents are safely in the new store.
  try {
    for (const key of Object.keys(legacy)) localStorage.removeItem(key);
  } catch {
    // Nothing further to do.
  }
  store.connectTabs();
  void navigator.storage?.persist?.();
}
