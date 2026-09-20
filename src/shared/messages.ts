/**
 * The content script / service worker contract.
 *
 * One file, because both sides import it and a disagreement about a message
 * shape is the kind of bug that only appears once the extension is loaded.
 */
import type { CorpusMeta, PairObservation } from "./types.js";
import type { LookupResult } from "../worker/lookup.js";

export type Request =
  | { type: "observe"; observations: PairObservation[] }
  | { type: "lookup"; subjects: LookupSubject[] }
  | { type: "meta" };

export interface LookupSubject {
  mint: string;
  name: string | null;
  symbol: string | null;
}

export type Response =
  | { type: "observed"; recorded: number }
  | { type: "looked-up"; results: LookupResult[] }
  | { type: "meta"; meta: CorpusMeta; ageMs: number }
  | { type: "error"; message: string };
