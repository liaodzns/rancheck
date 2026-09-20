/**
 * The content script / service worker contract.
 *
 * One file, because both sides import it and a disagreement about a message
 * shape is the kind of bug that only appears once the extension is loaded.
 */
import type { CorpusMeta, PairObservation } from "./types.js";
import type { LookupResult } from "../worker/lookup.js";
import type { ImportedLaunch } from "../worker/import.js";

export type Request =
  | { type: "observe"; observations: PairObservation[] }
  | { type: "lookup"; subjects: LookupSubject[] }
  | { type: "meta" }
  /** One batch of a seed file. The options page chunks; the worker does not. */
  | { type: "import"; launches: ImportedLaunch[] };

export interface LookupSubject {
  mint: string;
  name: string | null;
  symbol: string | null;
}

export type Response =
  | { type: "observed"; recorded: number }
  | { type: "looked-up"; results: LookupResult[] }
  | {
      type: "meta";
      meta: CorpusMeta;
      ageMs: number;
      /**
       * Whether counts are being shown yet.
       *
       * Sent rather than recomputed by the caller, so the age gate has exactly
       * one definition. A second copy of that rule in the options page would
       * eventually disagree with the badge about whether the corpus is ready,
       * and the UI would be explaining a state the feed was not in.
       */
      badgesReady: boolean;
      minAgeMs: number;
    }
  | { type: "imported"; written: number; added: number }
  | { type: "error"; message: string };
