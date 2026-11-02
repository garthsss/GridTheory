import type { StorageAdapter } from '../lib/store';
import { mergeRecord } from './merge';

export interface RemoteRow {
  key: string;
  value: string;
  deleted: boolean;
  updated_at: string;
}

export interface RemoteRecords {
  /** Records changed after a time, oldest first, one page at a time. */
  changesSince(since: string | null, offset: number, limit: number): Promise<RemoteRow[]>;
  upload(rows: { key: string; value: string; deleted: boolean }[]): Promise<void>;
}

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'denied' | 'full';

const META = '__sync.';
const CURSOR = `${META}cursor`;
const DIRTY = `${META}dirty.`;
/** Reads back slightly before the last change seen, since a slow write can get an earlier time than one already read. */
const OVERLAP_MS = 10_000;
const PAGE = 500;
const MAX_BATCH_BYTES = 1_000_000;
const MAX_BATCH_ROWS = 200;

/** The app's data version describes this browser's copy, so it's never shared. Keys the server wouldn't accept stay local. */
const syncable = (key: string) => key !== 'schema' && key.length <= 200 && /^[A-Za-z][A-Za-z0-9_:.-]*$/.test(key);

/** Keeps the local copy as the source of truth for the app, and remembers what still needs uploading, even across reloads. */
export class SyncedAdapter implements StorageAdapter {
  readonly dirty = new Set<string>();
  cursor: string | null = null;
  onChange: () => void = () => undefined;

  constructor(readonly local: StorageAdapter) {}

  async loadAll() {
    const all = await this.local.loadAll();
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(all)) {
      if (key === CURSOR) this.cursor = value;
      else if (key.startsWith(DIRTY)) this.dirty.add(key.slice(DIRTY.length));
      else out[key] = value;
    }
    return out;
  }

  private async mark(key: string) {
    if (!syncable(key)) return;
    if (!this.dirty.has(key)) {
      this.dirty.add(key);
      await this.local.put(DIRTY + key, '1');
    }
    this.onChange();
  }

  async put(key: string, value: string) {
    await this.local.put(key, value);
    await this.mark(key);
  }

  async remove(key: string) {
    await this.local.remove(key);
    await this.mark(key);
  }

  async clearDirty(key: string) {
    this.dirty.delete(key);
    await this.local.remove(DIRTY + key);
  }

  async saveCursor(cursor: string) {
    this.cursor = cursor;
    await this.local.put(CURSOR, cursor);
  }
}

interface LocalView {
  raw(key: string): string | undefined;
  applyRemote(key: string, value: string | null): void;
}

const failure = (error: unknown): SyncStatus => {
  const { code, status } = (error ?? {}) as { code?: string; status?: number };
  if (code === '42501' || status === 401 || status === 403) return 'denied';
  if (code === '54000') return 'full';
  return 'offline';
};

export class SyncEngine {
  status: SyncStatus = 'idle';
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private adapter: SyncedAdapter,
    private remote: RemoteRecords,
    private view: LocalView,
    private onStatus: (status: SyncStatus) => void = () => undefined,
  ) {}

  private set(status: SyncStatus) {
    this.status = status;
    this.onStatus(status);
  }

  /** Runs one full exchange. Calls made during a run are folded into one more, so nothing waits on a stale read. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.sync();
      }
    });
    return this.running;
  }

  private async run() {
    this.set('syncing');
    try {
      await this.pull();
      await this.push();
      this.set('idle');
    } catch (error) {
      this.set(failure(error));
    }
  }

  private async pull() {
    const since = this.adapter.cursor ? new Date(new Date(this.adapter.cursor).getTime() - OVERLAP_MS).toISOString() : null;
    let latest = this.adapter.cursor;
    for (let offset = 0; ; offset += PAGE) {
      const rows = await this.remote.changesSince(since, offset, PAGE);
      for (const row of rows) {
        await this.applyRow(row);
        if (!latest || row.updated_at > latest) latest = row.updated_at;
      }
      if (rows.length < PAGE) break;
    }
    if (latest && latest !== this.adapter.cursor) await this.adapter.saveCursor(latest);
  }

  private async applyRow(row: RemoteRow) {
    if (!syncable(row.key)) return;
    const local = this.view.raw(row.key);
    if (this.adapter.dirty.has(row.key)) {
      // Changed here too. A local deletion stands, and so does a local edit over a remote deletion: the upload settles it.
      if (local === undefined || row.deleted) return;
      const merged = mergeRecord(row.key, local, row.value);
      if (merged !== local) {
        await this.adapter.local.put(row.key, merged);
        this.view.applyRemote(row.key, merged);
      }
      return;
    }
    if (row.deleted) {
      if (local !== undefined) {
        await this.adapter.local.remove(row.key);
        this.view.applyRemote(row.key, null);
      }
    } else if (local !== row.value) {
      await this.adapter.local.put(row.key, row.value);
      this.view.applyRemote(row.key, row.value);
    }
  }

  private async push() {
    let batch: { key: string; value: string; deleted: boolean }[] = [];
    let bytes = 0;
    const send = async () => {
      if (batch.length === 0) return;
      const sent = batch;
      batch = [];
      bytes = 0;
      await this.remote.upload(sent);
      for (const row of sent) {
        // If it changed again during the upload, it stays dirty for the next run.
        const current = this.view.raw(row.key);
        if (row.deleted ? current === undefined : current === row.value) await this.adapter.clearDirty(row.key);
      }
    };
    for (const key of [...this.adapter.dirty]) {
      const value = this.view.raw(key);
      const row = { key, value: value ?? '', deleted: value === undefined };
      if (batch.length >= MAX_BATCH_ROWS || bytes + row.value.length > MAX_BATCH_BYTES) await send();
      batch.push(row);
      bytes += row.value.length;
    }
    await send();
  }
}
