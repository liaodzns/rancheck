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
import { IndexedDbCorpus, recordObservations, runRetention } from "./corpus.js";
import { lookup } from "./lookup.js";
import { corpusAge } from "./lookup.js";
import { THRESHOLDS } from "../shared/config.js";

const corpus = new IndexedDbCorpus(THRESHOLDS);

async function handle(request: Request): Promise<Response> {
  switch (request.type) {
    case "observe": {
      const written = await recordObservations(request.observations);
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
