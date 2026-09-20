/**
 * The corpus. IndexedDB, and the only thing that knows how storage is shaped.
 *
 * ---------------------------------------------------------------------------
 * The MV3 constraint, which dictates everything below.
 *
 * A service worker is killed after roughly 30 seconds idle and restarted on the
 * next message. **No corpus state may live in a module variable.** Anything
 * cached across messages is either gone after an eviction, or — worse — stale
 * in a way that looks fine: a count computed from a half-populated cache is
 * still a number, and nothing about it says it is wrong.
 *
 * So every lookup starts from IndexedDB. The one thing held across calls is the
 * open database connection, which is not state but a handle: if it is gone, it
 * is reopened, and reopening is idempotent. `withDb` treats a dead connection
 * as the normal case rather than an error.
 * ---------------------------------------------------------------------------
 *
 * Bounds. Roughly 200 bytes per coin plus its index entries, against ~45k
 * launches a day with a feed open. 100k coins is comfortable; the retention job
 * keeps it there by dropping coins that never ran. A coin that ran is the whole
 * point of the corpus and is never evicted, whatever its age.
 */
import type {
  CorpusMeta,
  PairObservation,
  StoredCoin,
  Timestamp,
} from "../shared/types.js";
import { THRESHOLDS, type Thresholds } from "../shared/config.js";
import { mergeCandidates, normaliseText, phashBands } from "./index-store.js";
import { mergeSighting } from "./ran.js";

export const DB_NAME = "rancheck";
export const SCHEMA_VERSION = 1;

const COINS = "coins";
const META = "meta";
const META_KEY = "corpus";

/**
 * Read access to prior deployments.
 *
 * Every read goes through this, with `IndexedDbCorpus` as the only
 * implementation. The seam is deliberate and named in the spec: a future source
 * backed by a local companion process, or by a public index consulted on
 * demand, then costs one file rather than a refactor through the worker.
 *
 * It is read-only on purpose. Writes are local by nature — they are what *this*
 * browser saw — and an external source has nothing to write to.
 */
export interface CorpusSource {
  /** Plausible prior deployments of a subject, already narrowed. */
  candidatesFor(subject: CandidateSubject): Promise<CandidateResult>;
  getMany(mints: readonly string[]): Promise<StoredCoin[]>;
  meta(): Promise<CorpusMeta>;
}

export interface CandidateSubject {
  mint: string;
  name: string | null;
  symbol: string | null;
  phash?: string | null;
}

export interface CandidateResult {
  coins: StoredCoin[];
  /** True when the cap was hit, which means a very large cluster. */
  capped: boolean;
}

type Db = IDBDatabase;

let connection: Db | null = null;

/**
 * Run `fn` against an open database.
 *
 * Reopens transparently when the worker has been evicted and the handle is
 * dead. `InvalidStateError` from a closed connection is an expected outcome of
 * normal MV3 lifecycle, not a fault, so it is retried once rather than
 * surfaced.
 */
async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  if (connection === null) connection = await openDb();
  try {
    return await fn(connection);
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      connection = await openDb();
      return await fn(connection);
    }
    throw error;
  }
}

/** For tests, and for a schema bump that needs a clean handle. */
export function closeCorpus(): void {
  connection?.close();
  connection = null;
}

function openDb(): Promise<Db> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(COINS)) {
        const coins = db.createObjectStore(COINS, { keyPath: "mint" });

        // The ~98% path. Two separate indexes rather than one compound, because
        // a launch matches on *either* field alone — requiring both to agree
        // would have missed the recorded wave outright.
        coins.createIndex("normName", "normName", { unique: false });
        coins.createIndex("normSymbol", "normSymbol", { unique: false });

        // multiEntry: one entry per array element, maintained by the engine.
        // This is what replaces the spec's `{ key, mints[] }` rows and removes
        // the read-modify-write on every insert.
        coins.createIndex("trigrams", "trigrams", { unique: false, multiEntry: true });
        coins.createIndex("phashBands", "phashBands", { unique: false, multiEntry: true });

        // Retention scans by last sighting and skips anything that ran.
        coins.createIndex("lastSeen", "lastSeen", { unique: false });
      }

      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another tab opening a newer schema must not be blocked by this handle.
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("rancheck: corpus upgrade blocked by another tab"));
  });
}

const promisify = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/**
 * What is physically stored.
 *
 * `phashBands` is a derived column existing only so IndexedDB can index it;
 * nothing reads it back. Keeping it out of `StoredCoin` keeps the derived thing
 * out of the domain type, where someone would eventually try to trust it.
 */
type CoinRecord = StoredCoin & { phashBands: string[] };

const toRecord = (coin: StoredCoin): CoinRecord => ({ ...coin, phashBands: phashBands(coin.phash) });

const fromRecord = (record: CoinRecord | undefined): StoredCoin | null => {
  if (record === undefined) return null;
  const { phashBands: _ignored, ...coin } = record;
  return coin;
};

/**
 * Record a pass's worth of sightings.
 *
 * One transaction for the batch. A pass produces up to forty rows and forty
 * transactions would serialise against the feed's own writes; one is atomic and
 * an order of magnitude cheaper.
 *
 * Returns the merged coins, so a caller that has just written can answer from
 * what it wrote rather than reading back.
 */
export async function recordObservations(
  observations: readonly PairObservation[],
  thresholds: Thresholds = THRESHOLDS,
  now: Timestamp = Date.now(),
): Promise<StoredCoin[]> {
  if (observations.length === 0) return [];

  return withDb(async (db) => {
    const tx = db.transaction([COINS, META], "readwrite");
    const coins = tx.objectStore(COINS);
    const meta = tx.objectStore(META);

    const existingMeta = (await promisify(meta.get(META_KEY))) as CorpusMeta | undefined;
    const written: StoredCoin[] = [];

    for (const observation of observations) {
      const prior = fromRecord(
        (await promisify(coins.get(observation.mint))) as CoinRecord | undefined,
      );
      const normalised = normaliseText(observation.name, observation.symbol, thresholds.corpus);
      const merged = mergeSighting(prior, observation, normalised, thresholds.ran);
      coins.put(toRecord(merged));
      written.push(merged);
    }

    const added = written.filter((coin) => coin.sightings === 1).length;
    meta.put(
      {
        // Set once and never moved. The honest-zero depends on this being the
        // moment watching started, not the moment of the most recent write.
        startedAt: existingMeta?.startedAt ?? now,
        schemaVersion: SCHEMA_VERSION,
        coinCount: (existingMeta?.coinCount ?? 0) + added,
      } satisfies CorpusMeta,
      META_KEY,
    );

    await done(tx);
    return written;
  });
}

/**
 * The corpus backed by this browser's IndexedDB.
 *
 * The only `CorpusSource` that exists, and the only one that can be written to.
 */
export class IndexedDbCorpus implements CorpusSource {
  constructor(private readonly thresholds: Thresholds = THRESHOLDS) {}

  /**
   * Plausible prior deployments of a subject.
   *
   * Unions the three index lookups, dedupes, drops the subject itself, caps,
   * then fetches the survivors. Scoring happens in `matchCorpus` — this decides
   * only who is worth scoring.
   */
  async candidatesFor(subject: CandidateSubject): Promise<CandidateResult> {
    const normalised = normaliseText(subject.name, subject.symbol, this.thresholds.corpus);
    const bands = phashBands(subject.phash ?? null);

    return withDb(async (db) => {
      const tx = db.transaction(COINS, "readonly");
      const coins = tx.objectStore(COINS);

      const buckets: string[][] = [];

      // Exact normalised keys first, so that when the cap truncates, what
      // survives is the ~98% path rather than whatever a trigram dragged in.
      // A short or empty key is skipped: `""` would match every coin whose name
      // failed to normalise, which is the blank-name failure via the index.
      for (const key of [normalised.normName, normalised.normSymbol]) {
        if (key.length < this.thresholds.narrative.minLength) continue;
        // Cross-field too: a clone may carry the parent's name in its ticker.
        buckets.push(await keysOfIndex(coins, "normName", key));
        buckets.push(await keysOfIndex(coins, "normSymbol", key));
      }

      for (const band of bands) {
        buckets.push(await keysOfIndex(coins, "phashBands", band));
      }

      for (const trigram of normalised.trigrams) {
        buckets.push(await keysOfIndex(coins, "trigrams", trigram));
      }

      const { mints, capped } = mergeCandidates(buckets, {
        excludeMint: subject.mint,
        max: this.thresholds.candidates.maxPerRow,
      });

      const found: StoredCoin[] = [];
      for (const mint of mints) {
        const coin = fromRecord((await promisify(coins.get(mint))) as CoinRecord | undefined);
        if (coin !== null) found.push(coin);
      }

      return { coins: found, capped };
    });
  }

  async getMany(mints: readonly string[]): Promise<StoredCoin[]> {
    if (mints.length === 0) return [];
    return withDb(async (db) => {
      const coins = db.transaction(COINS, "readonly").objectStore(COINS);
      const out: StoredCoin[] = [];
      for (const mint of mints) {
        const coin = fromRecord((await promisify(coins.get(mint))) as CoinRecord | undefined);
        if (coin !== null) out.push(coin);
      }
      return out;
    });
  }

  async meta(): Promise<CorpusMeta> {
    return withDb(async (db) => {
      const store = db.transaction(META, "readonly").objectStore(META);
      const stored = (await promisify(store.get(META_KEY))) as CorpusMeta | undefined;
      return (
        stored ?? {
          // A corpus that has never been written has not started watching. The
          // caller reads this as "age zero", which suppresses badges — which is
          // exactly right on a fresh install.
          startedAt: 0,
          schemaVersion: SCHEMA_VERSION,
          coinCount: 0,
        }
      );
    });
  }
}

/** Primary keys from an index bucket, without fetching the records. */
async function keysOfIndex(
  store: IDBObjectStore,
  indexName: string,
  key: string,
): Promise<string[]> {
  return (await promisify(store.index(indexName).getAllKeys(key))) as string[];
}

/**
 * Drop coins that never ran and have not been seen for a while.
 *
 * A coin that ran is never evicted regardless of age — it is the entire point
 * of keeping a corpus, and it is also the rarest thing in it.
 *
 * Returns how many were removed, so the caller can log it. Silent deletion of
 * the user's data is not acceptable even when it is correct.
 */
export async function runRetention(
  thresholds: Thresholds = THRESHOLDS,
  now: Timestamp = Date.now(),
): Promise<number> {
  const cutoff = now - thresholds.corpus.retentionMs;

  return withDb(async (db) => {
    const tx = db.transaction([COINS, META], "readwrite");
    const coins = tx.objectStore(COINS);
    const stale = await promisify(
      coins.index("lastSeen").getAll(IDBKeyRange.upperBound(cutoff, true)),
    );

    let removed = 0;
    for (const record of stale as CoinRecord[]) {
      if (record.ran) continue;
      coins.delete(record.mint);
      removed += 1;
    }

    if (removed > 0) {
      const meta = tx.objectStore(META);
      const existing = (await promisify(meta.get(META_KEY))) as CorpusMeta | undefined;
      if (existing !== undefined) {
        meta.put({ ...existing, coinCount: Math.max(0, existing.coinCount - removed) }, META_KEY);
      }
    }

    await done(tx);
    return removed;
  });
}
