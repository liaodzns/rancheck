/**
 * Perceptual hashing.
 *
 * argus declared this field and never filled it: `TokenMeta.imagePhash` exists
 * in its shared events, and `enrich.ts` sets it to `null` with the comment
 * `// computed at step 9`. Step 9 never happened. This is that step.
 *
 * It matters more here than it did there, because image reuse is what catches
 * the clone that renames completely — the case both text indexes are blind to
 * by construction. On Axiom's Pulse it matters more still: the markup exposes
 * no metadata URI anywhere, so argus's cheapest true positive (two launches
 * pointing at the same metadata) never fires from this surface. The image is
 * the only remaining way to notice that two differently-named coins are the
 * same thing.
 *
 * ---------------------------------------------------------------------------
 * The CORS trap, which the spec warns costs an afternoon.
 *
 * The image is already decoded in the page, and it is tempting to hash it
 * there. You cannot. `ctx.drawImage()` with a cross-origin `<img>` that carries
 * no `crossorigin` attribute taints the canvas, and `getImageData` then throws
 * a SecurityError. Nothing in the content script can undo that — the taint is
 * decided when the image was fetched, long before we see it.
 *
 * So hashing happens in the service worker: `fetch()` the URL under
 * `host_permissions`, `createImageBitmap(blob)`, draw into an `OffscreenCanvas`.
 * A worker is not subject to the page's canvas taint rules, and the fetch
 * usually hits the browser cache the page has already warmed.
 * ---------------------------------------------------------------------------
 *
 * The file is split so the expensive half is testable and measurable without a
 * browser: everything from a grayscale buffer onwards is pure arithmetic, and
 * only `fetchAndHash` touches the network or a canvas.
 */
import type { PhashThresholds } from "../shared/config.js";

/** Why a hash was not produced. Never conflated with "no match". */
export type PhashFailure =
  /** Solid or near-uniform image. Permanent — do not retry. */
  | "degenerate"
  /** Network, decode, or a host we hold no permission for. Retryable. */
  | "unavailable";

export interface PhashResult {
  hash: string | null;
  failure: PhashFailure | null;
  /** Grayscale variance, kept for tuning the degenerate floor against real data. */
  variance: number;
}

// --- Pure arithmetic --------------------------------------------------------

/**
 * Cosine table for a 1D DCT-II of length N.
 *
 * Built once per size and cached. This is a mathematical constant, not corpus
 * state, so it is safe to hold across service-worker messages — the MV3 rule is
 * about data that can go stale, and cos(π(2n+1)k/2N) cannot.
 */
const cosTables = new Map<number, Float64Array>();

function cosTable(n: number): Float64Array {
  const cached = cosTables.get(n);
  if (cached !== undefined) return cached;

  const table = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      table[k * n + i] = Math.cos((Math.PI * (2 * i + 1) * k) / (2 * n));
    }
  }
  cosTables.set(n, table);
  return table;
}

/**
 * Convert RGBA bytes to a grayscale plane.
 *
 * Rec. 601 luma. A plain channel average would weight a colour-swap clone as a
 * different image when a human would call it the same one, which is the exact
 * judgement this hash is supposed to imitate.
 */
export function toGrayscale(rgba: Uint8ClampedArray | Uint8Array, size: number): Float64Array {
  const gray = new Float64Array(size * size);
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    gray[i] =
      0.299 * (rgba[p] as number) +
      0.587 * (rgba[p + 1] as number) +
      0.114 * (rgba[p + 2] as number);
  }
  return gray;
}

/** Population variance of a grayscale plane. The degenerate-image test. */
export function varianceOf(gray: Float64Array): number {
  let sum = 0;
  for (const value of gray) sum += value;
  const mean = sum / gray.length;

  let acc = 0;
  for (const value of gray) {
    const delta = value - mean;
    acc += delta * delta;
  }
  return acc / gray.length;
}

/**
 * Separable 2D DCT-II, orthonormal.
 *
 * Rows then columns, which is O(2·N³) rather than the O(N⁴) of the direct form
 * — for N=32 that is 65k multiplications instead of a million. The difference
 * decides whether this is affordable on a feed doing 31 launches a minute.
 */
export function dct2d(input: Float64Array, size: number): Float64Array {
  const table = cosTable(size);
  const scale0 = Math.sqrt(1 / size);
  const scaleK = Math.sqrt(2 / size);

  const rows = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let k = 0; k < size; k++) {
      let sum = 0;
      for (let x = 0; x < size; x++) {
        sum += (input[y * size + x] as number) * (table[k * size + x] as number);
      }
      rows[y * size + k] = sum * (k === 0 ? scale0 : scaleK);
    }
  }

  const out = new Float64Array(size * size);
  for (let x = 0; x < size; x++) {
    for (let k = 0; k < size; k++) {
      let sum = 0;
      for (let y = 0; y < size; y++) {
        sum += (rows[y * size + x] as number) * (table[k * size + y] as number);
      }
      out[k * size + x] = sum * (k === 0 ? scale0 : scaleK);
    }
  }

  return out;
}

/**
 * Hash a grayscale plane, or refuse it.
 *
 * The low-frequency top-left 8×8 of the DCT is what survives rescaling,
 * recompression and mild edits, which is what makes this a *perceptual* hash
 * rather than a checksum.
 *
 * The DC term is excluded from the median. It is total brightness and is an
 * order of magnitude larger than everything else, so including it would drag
 * the median up and flatten most of the remaining bits to zero.
 *
 * **The variance floor is load-bearing, not defensive** — though not quite for
 * the reason the spec gives, and the difference is worth recording.
 *
 * The spec says a flat image "produces a hash that matches other flat images".
 * Measured here, what actually happens is worse. A solid image's DCT is
 * entirely DC: every other coefficient is floating-point residue on the order
 * of 1e-12. The median of those is ~0, so all 64 bits come from comparing
 * numerical noise against numerical noise. Two solid grays measured **16 bits
 * apart** — not a collision but an arbitrary value, sensitive to rounding and
 * therefore to the engine it ran on. An unpredictable hash is harder to reason
 * about than a predictable collision, and either way it is not information.
 *
 * So the floor stands, as the image-domain twin of the `minLength` guard: both
 * refuse to compare inputs that cannot carry a comparison.
 *
 * **Known limitation: variance is not structure.** A busy but featureless
 * image — visual static — has *high* variance and sails past this floor, while
 * carrying almost no low-frequency content, which is the only thing a DCT hash
 * reads. Two different noise images were measured 2 bits apart, well inside the
 * match bar. The floor catches blank images; it does not catch featureless
 * ones, and nothing here does. If false positives show up in practice, this is
 * the first place to look, ahead of tightening `maxHamming`.
 */
export function hashGrayscale(
  gray: Float64Array,
  size: number,
  thresholds: PhashThresholds,
): PhashResult {
  const variance = varianceOf(gray);
  if (variance < thresholds.minVariance) {
    return { hash: null, failure: "degenerate", variance };
  }

  const dct = dct2d(gray, size);
  const n = thresholds.dctSize;

  const coefficients = new Float64Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      coefficients[y * n + x] = dct[y * size + x] as number;
    }
  }

  const forMedian = [...coefficients.slice(1)].sort((a, b) => a - b);
  const mid = forMedian.length >> 1;
  const median =
    forMedian.length % 2 === 0
      ? ((forMedian[mid - 1] as number) + (forMedian[mid] as number)) / 2
      : (forMedian[mid] as number);

  let hash = "";
  for (let byte = 0; byte < coefficients.length / 8; byte++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) {
      if ((coefficients[byte * 8 + bit] as number) > median) value |= 1 << (7 - bit);
    }
    hash += value.toString(16).padStart(2, "0");
  }

  return { hash, failure: null, variance };
}

/** Bits set, per byte value. Faster than counting bit by bit, and clearer. */
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + (POPCOUNT[i >> 1] as number);

/**
 * Hamming distance between two hex hashes, or null if either is unusable.
 *
 * Null means "cannot compare", which callers must not read as "far apart" —
 * the spec is explicit that a failed hash is never a statement about matching.
 */
export function hammingDistance(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  if (a.length !== b.length || !/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return null;

  let distance = 0;
  for (let i = 0; i < a.length; i += 2) {
    const left = Number.parseInt(a.slice(i, i + 2), 16);
    const right = Number.parseInt(b.slice(i, i + 2), 16);
    distance += POPCOUNT[left ^ right] as number;
  }
  return distance;
}

/**
 * Whether two images are the same picture, as far as this can tell.
 *
 * Approximate by construction, and that is acceptable: this produces a count,
 * not a proof. A false positive costs one wrong row in a popover; refusing to
 * answer at all costs the entire reason the phase exists.
 */
export function imagesMatch(
  a: string | null,
  b: string | null,
  thresholds: PhashThresholds,
): boolean {
  const distance = hammingDistance(a, b);
  return distance !== null && distance <= thresholds.maxHamming;
}

/** Hash decoded RGBA pixels. The seam the tests and the benchmark use. */
export function hashPixels(
  rgba: Uint8ClampedArray | Uint8Array,
  size: number,
  thresholds: PhashThresholds,
): PhashResult {
  return hashGrayscale(toGrayscale(rgba, size), size, thresholds);
}

// --- Network and canvas -----------------------------------------------------

/** The bits of the platform this needs, named so a test can supply its own. */
export interface DecodeEnvironment {
  fetch: typeof fetch;
  createImageBitmap: typeof createImageBitmap;
  createCanvas: (size: number) => OffscreenCanvas;
}

const defaultEnvironment = (): DecodeEnvironment => ({
  fetch: globalThis.fetch.bind(globalThis),
  createImageBitmap: globalThis.createImageBitmap,
  createCanvas: (size) => new OffscreenCanvas(size, size),
});

/**
 * Fetch an image and hash it.
 *
 * Every failure becomes `unavailable` rather than an exception. A coin whose
 * image could not be fetched is a coin we know nothing about the picture of,
 * which is not the same as a coin whose picture differs — and an exception here
 * would take down the whole hashing queue for one dead CDN link.
 *
 * The size cap and the timeout exist because this runs against URLs the page
 * supplied. Neither is a security boundary — the host allowlist in the manifest
 * is that — but an 80MB PNG would evict the worker mid-decode and a hung
 * request would occupy one of only four slots indefinitely.
 */
export async function fetchAndHash(
  url: string,
  thresholds: PhashThresholds,
  environment: DecodeEnvironment = defaultEnvironment(),
): Promise<PhashResult> {
  const unavailable: PhashResult = { hash: null, failure: "unavailable", variance: 0 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), thresholds.fetchTimeoutMs);

  try {
    const response = await environment.fetch(url, {
      signal: controller.signal,
      // The page has almost certainly just fetched this, so the browser cache
      // should answer and no second request reaches the CDN.
      cache: "force-cache",
      credentials: "omit",
    });
    if (!response.ok) return unavailable;

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > thresholds.maxBytes) return unavailable;

    const blob = await response.blob();
    if (blob.size > thresholds.maxBytes) return unavailable;

    const bitmap = await environment.createImageBitmap(blob);
    try {
      const size = thresholds.sampleSize;
      const canvas = environment.createCanvas(size);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return unavailable;

      // Downscaling to 32×32 is the resize the algorithm calls for, and letting
      // the browser do it with smoothing on is deliberate: nearest-neighbour
      // would alias fine detail into the low frequencies the hash reads.
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "medium";
      context.drawImage(bitmap, 0, 0, size, size);

      const pixels = context.getImageData(0, 0, size, size).data;
      return hashPixels(pixels, size, thresholds);
    } finally {
      bitmap.close();
    }
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run `work` over `items`, at most `limit` at a time.
 *
 * The cap is the whole point. Forty visible rows would otherwise open forty
 * simultaneous image fetches, competing with Axiom's own requests for
 * connections on a page that is already streaming a feed — and an extension
 * that makes the feed slow does not get used, however good its numbers are.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index] as T);
    }
  });

  await Promise.all(workers);
  return results;
}
