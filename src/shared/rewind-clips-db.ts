// IndexedDB-backed persistence for Rewind / Share Last Minute clips.
//
// Phase 3 uses this module to stash the WebM blob produced by the rolling
// buffer offscreen flow, plus enough metadata to render a clip card in the
// viewer. The viewer reads back the blob via getRewindClip() and can either
// play it locally or trigger an optional upload to the DevRecorder API.
//
// Phase 5 adds an `events` field (console/network/navigation/interaction
// captured alongside the video) and a `deviceInfo` snapshot. Both are
// optional on the record so v1 clips remain readable without migration.
//
// The store is a single-version object store keyed by `id` with an index on
// `capturedAt` (used to iterate newest-first for both listing and purging).
//
// All functions are promise-wrapped IDBRequest calls; we don't depend on any
// external idb library. The module is consumed from both the service worker
// (writes on SHARE_LAST_MINUTE) and the viewer (reads + delete + upload mark),
// so all paths run in plain-DOM contexts where indexedDB is available.

import type { TimelineEvent } from './types';

const DB_NAME = 'devrecorder-rewind';
// v1 -> v2: added optional `events`, `deviceInfo`, and `eventCount` fields on
// the clip record. No destructive migration needed — `onupgradeneeded` just
// ensures the store + index exist; existing records simply lack the new
// fields and consumers handle them as undefined.
const DB_VERSION = 2;
const STORE_NAME = 'clips';
const INDEX_CAPTURED_AT = 'capturedAt';

// Snapshot of browser / device context captured at clip-finalize time so the
// viewer (and any subsequent upload) carries the same device-info payload
// that a primary recording would. Mirrors what `captureDeviceInfo()` writes
// for primary recordings; fields are optional so older clips and partial
// captures still render.
export interface DeviceInfoSnapshot {
  userAgent?: string;
  language?: string;
  languages?: readonly string[];
  platform?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number | null;
  onLine?: boolean;
  connectionType?: string | null;
  connectionDownlink?: number | null;
  screenWidth?: number;
  screenHeight?: number;
  devicePixelRatio?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  colorScheme?: string;
  timezone?: string;
  timezoneOffset?: number;
  cpuArchName?: string | null;
  cpuModelName?: string | null;
  cpuNumProcessors?: number | null;
  memoryCapacityBytes?: number | null;
  memoryAvailableBytes?: number | null;
}

export interface RewindClipMetadata {
  id: string;
  capturedAt: number;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  host: string;
  sourceTabUrl: string;
  sourceTabTitle: string;
  // Phase 5 — length of the events array. Stored on the metadata projection
  // so list views can show it without loading the full events array.
  eventCount?: number;
  uploaded: {
    recordingId: string;
    shareUrl: string;
    uploadedAt: number;
  } | null;
}

export interface RewindClip extends RewindClipMetadata {
  blob: Blob;
  // Phase 5 — events captured during the rewind buffer window, with
  // relativeTime rebased to the clip start. recordingId is left blank
  // locally and filled in by the upload path before shipping.
  events?: TimelineEvent[];
  deviceInfo?: DeviceInfoSnapshot;
}

// Internal record shape stored in IDB — same as RewindClip but kept private so
// callers go through the typed helpers below.
interface RewindClipRecord extends RewindClipMetadata {
  blob: Blob;
  events?: TimelineEvent[];
  deviceInfo?: DeviceInfoSnapshot;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex(INDEX_CAPTURED_AT, 'capturedAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('rewind-clips-open-failed'));
  });
}

// Run `op` in a transaction and resolve with whatever it produces. The wrapper
// owns the transaction lifecycle so callers don't have to.
function runTransaction<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  return openDb().then((database) =>
    new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result: T;
      Promise.resolve(op(store))
        .then((value) => {
          result = value;
        })
        .catch((err) => {
          try {
            transaction.abort();
          } catch {
            // already aborted
          }
          reject(err);
        });
      transaction.oncomplete = () => {
        database.close();
        resolve(result);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error('rewind-clips-transaction-failed'));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error || new Error('rewind-clips-transaction-aborted'));
      };
    }),
  );
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('rewind-clips-request-failed'));
  });
}

export type RewindClipSaveInput = Omit<
  RewindClipMetadata,
  'id' | 'capturedAt' | 'sizeBytes' | 'uploaded' | 'eventCount'
> &
  Partial<Pick<RewindClipMetadata, 'capturedAt'>> & {
    events?: TimelineEvent[];
    deviceInfo?: DeviceInfoSnapshot;
  };

// Persist a new clip. Assigns id + capturedAt (defaults to Date.now) + sizeBytes
// from the blob; `uploaded` always starts null. Optional `events` and
// `deviceInfo` ride along (Phase 5). Returns the new id.
export async function saveRewindClip(
  blob: Blob,
  metadata: RewindClipSaveInput,
): Promise<string> {
  const id = crypto.randomUUID();
  const record: RewindClipRecord = {
    id,
    capturedAt: metadata.capturedAt ?? Date.now(),
    durationMs: metadata.durationMs,
    sizeBytes: blob.size,
    mimeType: metadata.mimeType,
    host: metadata.host,
    sourceTabUrl: metadata.sourceTabUrl,
    sourceTabTitle: metadata.sourceTabTitle,
    eventCount: metadata.events ? metadata.events.length : 0,
    uploaded: null,
    blob,
    events: metadata.events,
    deviceInfo: metadata.deviceInfo,
  };
  await runTransaction('readwrite', (store) => promisifyRequest(store.put(record)));
  return id;
}

// Iterate newest-first via the capturedAt index, stripping blob / events /
// deviceInfo so callers don't accidentally load every blob into memory.
export async function listRewindClipsMetadata(): Promise<RewindClipMetadata[]> {
  return runTransaction('readonly', async (store) => {
    const index = store.index(INDEX_CAPTURED_AT);
    return new Promise<RewindClipMetadata[]>((resolve, reject) => {
      const results: RewindClipMetadata[] = [];
      const cursorRequest = index.openCursor(null, 'prev');
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve(results);
          return;
        }
        const value = cursor.value as RewindClipRecord;
        const {
          blob: _omitBlob,
          events: _omitEvents,
          deviceInfo: _omitDeviceInfo,
          ...metadata
        } = value;
        void _omitBlob;
        void _omitEvents;
        void _omitDeviceInfo;
        results.push(metadata);
        cursor.continue();
      };
      cursorRequest.onerror = () =>
        reject(cursorRequest.error || new Error('rewind-clips-cursor-failed'));
    });
  });
}

export async function getRewindClip(id: string): Promise<RewindClip | null> {
  const record = await runTransaction('readonly', (store) =>
    promisifyRequest(store.get(id) as IDBRequest<RewindClipRecord | undefined>),
  );
  if (!record) return null;
  return record;
}

export async function deleteRewindClip(id: string): Promise<void> {
  await runTransaction('readwrite', (store) => promisifyRequest(store.delete(id)));
}

export async function markClipUploaded(
  id: string,
  info: { recordingId: string; shareUrl: string },
): Promise<void> {
  await runTransaction('readwrite', async (store) => {
    const existing = await promisifyRequest(
      store.get(id) as IDBRequest<RewindClipRecord | undefined>,
    );
    if (!existing) throw new Error('rewind-clip-not-found');
    const updated: RewindClipRecord = {
      ...existing,
      uploaded: {
        recordingId: info.recordingId,
        shareUrl: info.shareUrl,
        uploadedAt: Date.now(),
      },
    };
    await promisifyRequest(store.put(updated));
  });
}

// Keep the newest `maxClips` records, delete the rest. Returns the number of
// removed clips so callers can log/telemeter.
export async function purgeOldClips(maxClips: number): Promise<number> {
  if (maxClips < 0) maxClips = 0;
  return runTransaction('readwrite', async (store) => {
    const index = store.index(INDEX_CAPTURED_AT);
    return new Promise<number>((resolve, reject) => {
      let seen = 0;
      let removed = 0;
      const cursorRequest = index.openCursor(null, 'prev');
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve(removed);
          return;
        }
        seen++;
        if (seen > maxClips) {
          const deleteRequest = cursor.delete();
          deleteRequest.onsuccess = () => {
            removed++;
            cursor.continue();
          };
          deleteRequest.onerror = () =>
            reject(deleteRequest.error || new Error('rewind-clips-purge-delete-failed'));
        } else {
          cursor.continue();
        }
      };
      cursorRequest.onerror = () =>
        reject(cursorRequest.error || new Error('rewind-clips-purge-cursor-failed'));
    });
  });
}
