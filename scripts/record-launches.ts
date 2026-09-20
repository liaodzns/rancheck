/**
 * Record launches from PumpPortal's free feed, for seeding the corpus.
 *
 * A port of argus `packages/ingest/src/streams/launches.ts` and the parts of
 * `reconnect.ts` it depends on, reduced to what a recorder needs: no Redis, no
 * pino, no event bus, no zod. It opens a socket, writes newline-delimited JSON,
 * and does not stop.
 *
 * ---------------------------------------------------------------------------
 * The silence watchdog is the whole reason this is a port rather than twenty
 * lines of WebSocket.
 *
 * argus's header puts it exactly right, and it is worth repeating because the
 * failure is silent by construction: **a stream that stops delivering looks
 * exactly like a quiet market.** At roughly 31 launches a minute, silence does
 * not mean nobody launched — it means the socket died. A recorder without this
 * sits open and healthy-looking for six hours and writes nothing, and you find
 * out when you go to import a file that is twelve rows long.
 *
 * So silence is a fault: the watchdog tears the connection down and the
 * reconnect loop builds a new one. A socket that is open but mute is worse than
 * one that is closed, because only the closed one reconnects.
 * ---------------------------------------------------------------------------
 *
 *   npm run record -- --out seed.ndjson [--minutes 120]
 *
 * Output is newline-delimited JSON, appended as it arrives. A run that is
 * killed — and a run measured in days will be — leaves a complete, importable
 * file behind rather than a truncated array that parses as nothing.
 */
import { appendFileSync, existsSync, statSync } from "node:fs";
import WebSocket from "ws";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

/** Base58, the Solana alphabet: no 0, O, I or l. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface Options {
  out: string;
  minutes: number | null;
  silenceMs: number;
  wsUrl: string;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const minutes = get("--minutes");
  return {
    out: get("--out") ?? "seed.ndjson",
    minutes: minutes === undefined ? null : Number(minutes),
    // A minute of nothing, when the feed does ~31 a minute. Generous enough not
    // to fire on a lull, short enough that a dead socket is noticed promptly.
    silenceMs: Number(get("--silence-ms") ?? 60_000),
    wsUrl: get("--url") ?? PUMPPORTAL_WS,
  };
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters even for a single client: without it a provider blip lines
 * every reconnect attempt up on the same tick, and the retry storm keeps the
 * connection from recovering.
 */
function backoffDelay(attempt: number, min = 500, max = 30_000): number {
  const ceiling = Math.min(max, min * 2 ** Math.min(attempt, 16));
  return Math.floor(min + Math.random() * (ceiling - min));
}

/**
 * Fires when nothing has arrived for `timeoutMs`.
 *
 * Kicked on every inbound frame, including keepalives and subscription
 * acknowledgements — anything that proves the socket is still carrying bytes.
 */
class SilenceWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly timeoutMs: number,
    private readonly onSilent: () => void,
  ) {}

  kick(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(this.onSilent, this.timeoutMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

const stats = {
  launches: 0,
  duplicates: 0,
  malformed: 0,
  reconnects: 0,
  silences: 0,
  startedAt: Date.now(),
};

/**
 * Mints already written, bounded.
 *
 * A reconnect replays nothing, but the feed does occasionally repeat a frame,
 * and the same mint twice in a recording would inflate that coin's sighting
 * count on import for no reason. Bounded because a multi-day run would
 * otherwise grow this set without limit — and a duplicate arriving 20,000
 * launches later is not the case this is defending against.
 */
const seen = new Set<string>();
const order: string[] = [];
const SEEN_CAP = 20_000;

function remember(mint: string): boolean {
  if (seen.has(mint)) return false;
  seen.add(mint);
  order.push(mint);
  if (order.length > SEEN_CAP) {
    for (const old of order.splice(0, SEEN_CAP / 2)) seen.delete(old);
  }
  return true;
}

function connect(options: Options, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(options.wsUrl);
    let settled = false;

    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      ws.removeAllListeners();
      ws.terminate();
      if (error === undefined) resolve();
      else reject(error);
    };

    const watchdog = new SilenceWatchdog(options.silenceMs, () => {
      stats.silences += 1;
      finish(new Error(`no frames for ${options.silenceMs}ms; the feed is dead, not quiet`));
    });

    signal.addEventListener("abort", () => finish(), { once: true });

    ws.on("open", () => {
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      watchdog.kick();
      console.log(`subscribed to ${options.wsUrl}`);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      // Kicked before parsing: any frame at all proves the socket is alive,
      // including ones this recorder has no use for.
      watchdog.kick();

      let frame: unknown;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        stats.malformed += 1;
        return;
      }

      const message = frame as Record<string, unknown>;

      // Subscription acknowledgements and plan-gating notices arrive on the
      // same socket as the data.
      if (typeof message["message"] === "string") {
        console.log(`feed says: ${message["message"]}`);
        return;
      }

      if (message["txType"] !== "create") return;

      const mint = typeof message["mint"] === "string" ? message["mint"] : "";
      if (!BASE58.test(mint)) {
        stats.malformed += 1;
        return;
      }
      if (!remember(mint)) {
        stats.duplicates += 1;
        return;
      }

      // Only the fields matching needs. The feed carries a creator, a signature
      // and a bonding curve as well; none of them are read by anything in this
      // project, and a recording is smaller and clearer without them.
      //
      // `observedAt` is wall clock and says so. This feed has no chain
      // timestamp, and inventing one would put a fabricated time into a corpus
      // that later displays it as when the coin launched.
      const row = {
        mint,
        name: typeof message["name"] === "string" ? message["name"] : "",
        symbol: typeof message["symbol"] === "string" ? message["symbol"] : "",
        uri: typeof message["uri"] === "string" ? message["uri"] : "",
        observedAt: Date.now(),
      };

      appendFileSync(options.out, `${JSON.stringify(row)}\n`);
      stats.launches += 1;
    });

    ws.on("error", (error) => finish(error));
    ws.on("close", () => finish());
  });
}

function report(options: Options): void {
  const minutes = (Date.now() - stats.startedAt) / 60_000;
  const rate = minutes > 0 ? stats.launches / minutes : 0;
  const size = existsSync(options.out) ? statSync(options.out).size : 0;

  console.log(
    `${stats.launches} launches in ${minutes.toFixed(1)} min ` +
      `(${rate.toFixed(1)}/min) · ${(size / 1024 / 1024).toFixed(1)} MB · ` +
      `${stats.duplicates} dupes, ${stats.malformed} malformed, ` +
      `${stats.reconnects} reconnects, ${stats.silences} silences`,
  );

  // The feed's documented rate is ~31/min. Far below that, sustained, means
  // something is wrong that no error will tell you about.
  if (minutes > 5 && rate < 10) {
    console.warn(
      `WARNING: ${rate.toFixed(1)} launches/min is well below the expected ~31. ` +
        `The feed may be degraded or gated.`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const controller = new AbortController();

  console.log(`recording to ${options.out}`);
  if (options.minutes !== null) console.log(`stopping after ${options.minutes} minutes`);
  console.log("ctrl-c to stop; the file is complete and importable at any point\n");

  const stop = (): void => {
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  if (options.minutes !== null) {
    setTimeout(stop, options.minutes * 60_000).unref();
  }

  const ticker = setInterval(() => report(options), 60_000);
  ticker.unref();

  let attempt = 0;
  while (!controller.signal.aborted) {
    try {
      await connect(options, controller.signal);
      if (controller.signal.aborted) break;
      attempt += 1;
      stats.reconnects += 1;
      // A stream that closes cleanly on its own is still a stream that stopped.
      console.warn("feed closed; reconnecting");
    } catch (error) {
      if (controller.signal.aborted) break;
      attempt += 1;
      stats.reconnects += 1;
      console.warn(`feed dropped: ${String(error)}`);
    }

    const delay = backoffDelay(attempt);
    console.warn(`  retry ${attempt} in ${delay}ms`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  clearInterval(ticker);
  console.log("\nstopped.");
  report(options);
  console.log(`\nimport ${options.out} from the extension's options page.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
