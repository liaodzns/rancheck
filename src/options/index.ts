/**
 * The options page: corpus status, and importing a recording.
 *
 * The only UI the extension has beyond the badge, and it exists because a file
 * has to be chosen by a person. A content script cannot open a file picker for
 * a local file, and the service worker has no DOM at all.
 */
import type { Request, Response } from "../shared/messages.js";
import { mergeReports, parseLaunchFile, type ValidationReport } from "../worker/import.js";

/**
 * Launches per message to the worker.
 *
 * Two limits meet here. `chrome.runtime.sendMessage` serialises the whole
 * payload, so a 300,000-row file in one message is tens of megabytes of JSON
 * crossing a process boundary. And the worker writes each batch in a single
 * IndexedDB transaction, which holds the store for its duration — long enough
 * and an eviction mid-transaction loses the lot.
 *
 * Two thousand is a few hundred kilobytes and a transaction measured in tens of
 * milliseconds.
 */
const BATCH = 2_000;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const log = (line: string): void => {
  const el = $("log");
  el.textContent = `${el.textContent ?? ""}${line}\n`;
  el.scrollTop = el.scrollHeight;
};

async function ask(request: Request): Promise<Response | null> {
  try {
    return (await chrome.runtime.sendMessage(request)) as Response;
  } catch {
    return null;
  }
}

function formatAge(ms: number): string {
  const hours = ms / 3_600_000;
  if (ms === 0) return "not yet";
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Show corpus size and whether badges are live yet.
 *
 * The readiness line matters more than it looks. A user who sees "new corpus"
 * on every badge needs to know whether that is the age gate holding numbers
 * back or the extension failing to store anything, and those need opposite
 * responses. Coin count and corpus age together answer it.
 */
async function refreshStatus(): Promise<void> {
  const response = await ask({ type: "meta" });
  if (response === null || response.type !== "meta") {
    $("coins").textContent = "—";
    $("ready-note").textContent = "The extension is not responding. Is it enabled?";
    return;
  }

  const { meta, ageMs } = response;
  $("coins").textContent = meta.coinCount.toLocaleString();
  $("age").textContent = formatAge(ageMs);

  const ready = response.badgesReady;
  const readyEl = $("ready");
  readyEl.textContent = ready ? "live" : "waiting";
  readyEl.className = `value ${ready ? "good" : "warn"}`;

  $("ready-note").textContent = ready
    ? "Counts are being shown on the feed."
    : `Badges stay muted until the corpus is ${formatAge(response.minAgeMs)} old. ` +
      `Until then a 0 would read as "never been run" when it means "we started watching recently".`;
}

function describeRejections(report: ValidationReport): string {
  if (report.rejected === 0) return "";
  const parts = Object.entries(report.reasons)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason.replace(/-/g, " ")}`);
  return ` (${report.rejected} skipped: ${parts.join(", ")})`;
}

async function importFile(file: File): Promise<void> {
  const progress = $<HTMLProgressElement>("progress");
  $("log").textContent = "";
  log(`reading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`);

  const parsed = parseLaunchFile(await file.text());
  if (parsed.launches.length === 0) {
    log(`nothing importable found${describeRejections(parsed.report)}.`);
    log("Expected newline-delimited JSON, or a JSON array, of launch records.");
    return;
  }

  log(`${parsed.launches.length.toLocaleString()} launches${describeRejections(parsed.report)}`);

  progress.hidden = false;
  progress.max = parsed.launches.length;
  progress.value = 0;

  const reports: ValidationReport[] = [parsed.report];
  const started = Date.now();
  let added = 0;
  let written = 0;

  for (let offset = 0; offset < parsed.launches.length; offset += BATCH) {
    const batch = parsed.launches.slice(offset, offset + BATCH);
    const response = await ask({ type: "import", launches: batch });

    if (response === null || response.type !== "imported") {
      log(`failed at row ${offset.toLocaleString()}. Nothing after this point was imported.`);
      // Deliberately not a throw: everything before this point is genuinely in
      // the corpus, and saying so is more useful than implying it all failed.
      break;
    }

    added += response.added;
    written += response.written;
    progress.value = offset + batch.length;
  }

  const seconds = (Date.now() - started) / 1000;
  log(
    `imported ${written.toLocaleString()} launches in ${seconds.toFixed(1)}s — ` +
      `${added.toLocaleString()} new, ${(written - added).toLocaleString()} already known`,
  );
  log("Imported coins count toward the total, never toward the ran count.");

  void mergeReports(reports);
  progress.hidden = true;
  await refreshStatus();
}

$<HTMLInputElement>("file").addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file !== undefined) void importFile(file);
});

void refreshStatus();
