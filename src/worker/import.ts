/**
 * Seeding the corpus from a recording.
 *
 * ---------------------------------------------------------------------------
 * What this fixes, and — more importantly — what it does not.
 *
 * A self-accumulated corpus is useless on day one and thin for a week. This
 * turns weeks into hours by loading launches recorded off PumpPortal's free
 * feed, which is the same data the extension would eventually collect itself.
 *
 * But the launch feed carries a mint, a name, a ticker and a metadata URI. It
 * carries **no market cap and no migration**, so every imported coin arrives
 * with `ran: false` and stays that way unless you later watch it run yourself.
 *
 * The consequence is worth stating plainly, because the badge will show it: a
 * seed grows the **denominator** and not the numerator. A ticker that read
 * `3 / 12` before an import will read `3 / 47` after, and nothing got worse —
 * you simply now know about 35 deployments you had never seen. The count of
 * runs is still, and remains, a floor bounded by what your own screen caught.
 * ---------------------------------------------------------------------------
 *
 * This is also the one place in the project where genuinely untrusted data
 * arrives: a file the user picked, from a recorder that may be any version or
 * none. So validation happens here, at the edge, rather than by making every
 * consumer downstream carry a runtime schema — which is exactly the trade the
 * type contract describes when it explains why zod is not a dependency.
 */
import type { PairObservation, Timestamp } from "../shared/types.js";
import { THRESHOLDS, type Thresholds } from "../shared/config.js";
import { normaliseText } from "./index-store.js";
import { mergeSighting } from "./ran.js";
import { withCoinsWrite } from "./corpus.js";

/** One launch, as a recording supplies it. */
export interface ImportedLaunch {
  mint: string;
  name: string;
  symbol: string;
  /** Off-chain metadata URI. Two launches sharing one are byte-identical. */
  uri: string;
  /** When the recorder heard about it. Absent in older recordings. */
  observedAt?: number | undefined;
}

export type RejectReason =
  | "not-an-object"
  | "bad-mint"
  | "duplicate-in-file";

export interface ValidationReport {
  accepted: number;
  rejected: number;
  reasons: Record<RejectReason, number>;
}

export interface ParsedImport {
  launches: ImportedLaunch[];
  report: ValidationReport;
}

/** Base58, the Solana alphabet: no 0, O, I or l. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Read a recording, in either shape it might arrive in.
 *
 * A JSON array is what `fixtures/launches-2026-09-17.json` is and what a small
 * export produces. Newline-delimited JSON is what the recorder writes, because
 * a process that may run for days must be able to append without holding the
 * whole recording in memory, and must leave a usable file behind if it is
 * killed mid-run.
 *
 * Accepting both means the importer does not care which produced the file.
 */
export function parseLaunchFile(text: string): ParsedImport {
  const trimmed = text.trim();
  if (trimmed.length === 0) return emptyImport();

  if (trimmed.startsWith("[")) {
    try {
      return validateLaunches(JSON.parse(trimmed));
    } catch {
      return emptyImport();
    }
  }

  const rows: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.length === 0) continue;
    try {
      rows.push(JSON.parse(candidate));
    } catch {
      // A truncated final line is the normal way a killed recorder ends. One
      // unparseable row is not a reason to discard the other 300,000.
      rows.push(null);
    }
  }
  return validateLaunches(rows);
}

const emptyImport = (): ParsedImport => ({
  launches: [],
  report: { accepted: 0, rejected: 0, reasons: blankReasons() },
});

const blankReasons = (): Record<RejectReason, number> => ({
  "not-an-object": 0,
  "bad-mint": 0,
  "duplicate-in-file": 0,
});

/**
 * Validate untrusted rows into launches.
 *
 * Permissive about everything except the mint, which is the primary key and the
 * one field that cannot be wrong. A blank name is a real launch — eight of the
 * 123 in the recorded fixture have one — and the matcher's `minLength` guard
 * already handles them, so rejecting them here would throw away real data to
 * solve a problem that is already solved.
 *
 * Duplicates within one file are dropped rather than merged. A recording can
 * repeat a frame after a reconnect, and importing the same mint twice would
 * inflate its sighting count on nothing.
 */
export function validateLaunches(raw: unknown): ParsedImport {
  const reasons = blankReasons();
  const launches: ImportedLaunch[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(raw)) return emptyImport();

  for (const row of raw) {
    if (row === null || typeof row !== "object") {
      reasons["not-an-object"] += 1;
      continue;
    }

    const record = row as Record<string, unknown>;
    const mint = typeof record["mint"] === "string" ? record["mint"].trim() : "";
    if (!BASE58.test(mint)) {
      reasons["bad-mint"] += 1;
      continue;
    }

    if (seen.has(mint)) {
      reasons["duplicate-in-file"] += 1;
      continue;
    }
    seen.add(mint);

    const observedAt = record["observedAt"];
    launches.push({
      mint,
      name: typeof record["name"] === "string" ? record["name"] : "",
      symbol: typeof record["symbol"] === "string" ? record["symbol"] : "",
      uri: typeof record["uri"] === "string" ? record["uri"] : "",
      observedAt:
        typeof observedAt === "number" && Number.isFinite(observedAt) && observedAt > 0
          ? observedAt
          : undefined,
    });
  }

  const rejected = Object.values(reasons).reduce((sum, n) => sum + n, 0);
  return { launches, report: { accepted: launches.length, rejected, reasons } };
}

export interface ImportResult {
  /** Coins written, new or merged. */
  written: number;
  /** Of those, ones the corpus had never seen. */
  added: number;
}

/**
 * Write a batch of launches into the corpus.
 *
 * One transaction per call, so the caller chooses the batch size. Three hundred
 * thousand rows in a single transaction would hold the store for minutes and
 * lose everything if the worker were evicted partway.
 *
 * **On timestamps.** `lastSeen` is set to the import moment, not to the launch
 * time, and that is deliberate rather than sloppy. `lastSeen` drives retention,
 * and it means "when did this coin last enter our hands" — importing a
 * two-month-old recording today *is* having it in hand today. Left as the
 * launch time, the first retention sweep would delete the entire seed for being
 * old, minutes after it was imported.
 *
 * `firstSeen` stays honest: the recorded launch time when the file carries one,
 * so the popover can say when the coin actually appeared rather than when you
 * happened to import it.
 */
export async function importLaunches(
  launches: readonly ImportedLaunch[],
  thresholds: Thresholds = THRESHOLDS,
  now: Timestamp = Date.now(),
): Promise<ImportResult> {
  if (launches.length === 0) return { written: 0, added: 0 };

  return withCoinsWrite(async (write) => {
    const existingMeta = await write.meta();
    let added = 0;

    for (const launch of launches) {
      const prior = await write.get(launch.mint);

      const observation: PairObservation = {
        mint: launch.mint,
        name: launch.name.length > 0 ? launch.name : null,
        symbol: launch.symbol.length > 0 ? launch.symbol : null,
        // The launch feed carries no image. Phase 4 hashes what the scraper
        // finds on screen; an imported coin simply has no picture to compare,
        // which is a gap in coverage and not a mismatch.
        imageUrl: null,
        // It does carry a metadata URI, which the Pulse markup does not expose
        // at all. Seeded coins therefore restore the identical-URI shortcut —
        // the cheapest true positive in the matcher — for comparisons between
        // two imported coins.
        metadataUri: launch.uri.length > 0 ? launch.uri : null,
        marketCapUsd: null,
        volumeUsd: null,
        ageSeconds: null,
        seenAt: now,
        source: "imported",
      };

      const normalised = normaliseText(observation.name, observation.symbol, thresholds.corpus);
      const merged = mergeSighting(prior, observation, normalised, thresholds.ran);

      // Restore the real launch time as the first sighting. `mergeSighting`
      // could not do this itself: an observation carries one timestamp, and for
      // an import the moment it entered the corpus and the moment the coin
      // launched are different facts.
      if (launch.observedAt !== undefined) {
        merged.firstSeen = Math.min(merged.firstSeen, launch.observedAt);
      }

      write.put(merged);
      if (prior === null) added += 1;
    }

    write.putMeta({
      startedAt: existingMeta?.startedAt ?? now,
      schemaVersion: existingMeta?.schemaVersion ?? 1,
      coinCount: (existingMeta?.coinCount ?? 0) + added,
    });

    return { written: launches.length, added };
  });
}

/** Sum several batch reports into one, for a whole-file total. */
export function mergeReports(reports: readonly ValidationReport[]): ValidationReport {
  const reasons = blankReasons();
  let accepted = 0;
  let rejected = 0;

  for (const report of reports) {
    accepted += report.accepted;
    rejected += report.rejected;
    for (const key of Object.keys(reasons) as RejectReason[]) {
      reasons[key] += report.reasons[key];
    }
  }

  return { accepted, rejected, reasons };
}

