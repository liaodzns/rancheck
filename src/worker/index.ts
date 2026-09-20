/**
 * The service worker: message router, and nothing else.
 *
 * Every handler starts from IndexedDB. There is no module-level cache of corpus
 * data here and there must never be one — MV3 evicts this worker after roughly
 * 30 seconds idle, and a count computed from a half-populated cache that
 * survived an eviction is still a number with nothing about it to say it is
 * wrong.
 *
 * The one thing that persists between messages is the database handle, which
 * `corpus.ts` reopens transparently when it has gone.
 */
import type { Request, Response } from "../shared/messages.js";
import {
  IndexedDbCorpus,
  pendingImageWork,
  recordObservations,
  recordPhashes,
  runRetention,
} from "./corpus.js";
import { fetchAndHash, mapWithConcurrency } from "./phash.js";
import { lookup } from "./lookup.js";
import { corpusAge } from "./lookup.js";
import { THRESHOLDS } from "../shared/config.js";

const corpus = new IndexedDbCorpus(THRESHOLDS);

async function handle(request: Request): Promise<Response> {
  switch (request.type) {
    case "observe": {
      const written = await recordObservations(request.observations);
      // Not awaited. Hashing is network-bound and best-effort; making the
      // content script wait on it would stall the badge behind image downloads
      // for a number the badge can already produce without them.
      void hashPending(written.map((coin) => coin.mint));
      return { type: "observed", recorded: written.length };
    }

    case "lookup": {
      // Sequential rather than Promise.all: forty concurrent IndexedDB
      // transactions on a feed that is already writing contend with each other
      // and with the observe path, and the wall-clock win is not worth the
      // jank it puts on Axiom's own rendering.
      const results = [];
      for (const subject of request.subjects) {
        results.push(await lookup(subject, corpus));
      }
      return { type: "looked-up", results };
    }

    case "meta": {
      const meta = await corpus.meta();
      return { type: "meta", meta, ageMs: corpusAge(meta, Date.now()) };
    }
  }
}

/**
 * Whether a hashing sweep is already running.
 *
 * Not corpus state — it is a lock, and losing it to a worker eviction is
 * harmless: the worst case is one sweep running twice, which wastes a few
 * cached fetches and writes the same verdicts again. The alternative, no lock
 * at all, would start a fresh sweep on every 250ms pass and pile them up.
 */
let hashing = false;

/**
 * Hash the images of whatever was just observed.
 *
 * Deliberately bounded to the mints from this pass. The alternative — sweeping
 * the whole corpus for unhashed coins — would, on a six-figure corpus, spend
 * the worker's life re-fetching images for coins nobody is looking at, and
 * would be doing it on every feed tick.
 */
async function hashPending(mints: readonly string[]): Promise<void> {
  if (hashing) return;
  hashing = true;
  try {
    const work = await pendingImageWork(mints);
    if (work.length === 0) return;

    const started = Date.now();
    const results = await mapWithConcurrency(
      work,
      THRESHOLDS.phash.maxConcurrent,
      async (item) => {
        const result = await fetchAndHash(item.imageUrl, THRESHOLDS.phash);
        return {
          mint: item.mint,
          phash: result.hash,
          // A failure is recorded, not discarded. An unrecorded failure is
          // indistinguishable from never having tried, and the queue would
          // offer the same dead image again on every pass forever.
          state: (result.hash !== null ? "ok" : result.failure) as
            | "ok"
            | "degenerate"
            | "unavailable",
        };
      },
    );

    await recordPhashes(results);

    const ok = results.filter((r) => r.state === "ok").length;
    const flat = results.filter((r) => r.state === "degenerate").length;
    console.log(
      `[rancheck worker] hashed ${ok}/${results.length} images in ${Date.now() - started}ms` +
        (flat > 0 ? ` (${flat} rejected as too flat)` : ""),
    );
  } catch (error) {
    console.error("[rancheck worker] hashing failed", error);
  } finally {
    hashing = false;
  }
}

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  handle(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      // A failed lookup must not leave the content script waiting forever on a
      // promise that never settles, so failures are answered, not dropped.
      console.error("[rancheck worker]", error);
      sendResponse({ type: "error", message: String(error) } satisfies Response);
    });
  // Keeps the message channel open for the async response above.
  return true;
});

/**
 * Retention, on the alarm rather than on a timer.
 *
 * `setInterval` in an MV3 worker does not survive eviction, so a timer would
 * fire only while the worker happened to be alive — which is to say, almost
 * never, and unpredictably. An alarm wakes the worker on purpose.
 */
chrome.alarms?.create("rancheck:retention", { periodInMinutes: 60 * 12 });

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== "rancheck:retention") return;
  runRetention()
    .then((removed) => {
      if (removed > 0) console.log(`[rancheck worker] retention dropped ${removed} coins`);
    })
    .catch((error: unknown) => console.error("[rancheck worker] retention failed", error));
});
