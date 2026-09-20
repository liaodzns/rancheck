/**
 * Perceptual hashing.
 *
 * Everything from a pixel buffer onwards is pure arithmetic, so it is tested
 * directly with synthetic images rather than through a browser. That split is
 * deliberate: the part that decides whether two coins are the same picture has
 * no dependency on a canvas, a network, or Chrome.
 */
import { describe, expect, it } from "vitest";
import {
  dct2d,
  fetchAndHash,
  hammingDistance,
  hashPixels,
  imagesMatch,
  mapWithConcurrency,
  toGrayscale,
  varianceOf,
  type DecodeEnvironment,
} from "../src/worker/phash.js";
import { THRESHOLDS } from "../src/shared/config.js";

const PH = THRESHOLDS.phash;
const SIZE = PH.sampleSize;

/** Build an RGBA buffer of `size`x`size` from a grayscale function. */
const image = (size: number, shade: (x: number, y: number) => number): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(255, Math.round(shade(x, y))));
      const p = (y * size + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return data;
};

/**
 * Deterministic pseudo-noise. Used only to demonstrate a limitation.
 *
 * It is a bad model for "a different picture", which an earlier draft of this
 * file learned the hard way: two noise images hash within 2 bits of each other,
 * because a DCT hash reads low frequencies and static has almost none.
 */
const noise = (seed: number) => (x: number, y: number) =>
  ((Math.sin((x * 12.9898 + y * 78.233 + seed) * 43758.5453) + 1) / 2) * 255;

/**
 * Structured fixtures, with hard edges and real low-frequency content — which
 * is what token art actually looks like.
 *
 * Smooth synthetic gradients are a trap here. Integer rounding of a gradient
 * produces staircase steps whose positions move under any brightness change, so
 * a gradient appears far less robust than it is: a first draft using one
 * measured 15 bits of drift from a contrast tweak that leaves a hard-edged
 * image at 0.
 */
const circle = (x: number, y: number): number =>
  Math.hypot(x - SIZE / 2, y - SIZE / 2) < SIZE / 3 ? 230 : 25;

const face = (x: number, y: number): number =>
  Math.hypot(x - SIZE / 2, y - SIZE / 2) < SIZE / 3
    ? Math.hypot(x - 12, y - 12) < 3 || Math.hypot(x - 20, y - 12) < 3
      ? 20
      : 235
    : 30;

const checkerboard = (x: number, y: number): number =>
  (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 20 : 235;

describe("toGrayscale", () => {
  it("weights channels by luma, not by a flat average", () => {
    // A colour-swap clone should read as the same picture to a human, and Rec.
    // 601 is the weighting that imitates that judgement.
    const gray = toGrayscale(new Uint8ClampedArray([0, 255, 0, 255]), 1);
    expect(gray[0]).toBeCloseTo(0.587 * 255, 5);
  });
});

describe("varianceOf", () => {
  it("is zero for a solid image", () => {
    expect(varianceOf(toGrayscale(image(SIZE, () => 128), SIZE))).toBe(0);
  });

  it("is large for real picture content", () => {
    expect(varianceOf(toGrayscale(image(SIZE, checkerboard), SIZE))).toBeGreaterThan(1000);
  });
});

describe("dct2d", () => {
  it("puts a flat image entirely in the DC term", () => {
    // The sanity check for the transform: constant input has no frequency
    // content, so every coefficient but the first must vanish.
    const out = dct2d(new Float64Array(SIZE * SIZE).fill(100), SIZE);
    expect(out[0]).toBeCloseTo(100 * SIZE, 6);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeCloseTo(0, 6);
  });

  it("is orthonormal, so it preserves energy", () => {
    // Parseval. If this holds the transform is right; a transposed or mis-scaled
    // DCT still produces plausible-looking hashes, so it is worth checking
    // against something that is not itself a hash.
    const input = new Float64Array(SIZE * SIZE);
    for (let i = 0; i < input.length; i++) input[i] = noise(1)(i % SIZE, Math.floor(i / SIZE));

    const energy = (a: Float64Array): number => a.reduce((sum, v) => sum + v * v, 0);
    expect(energy(dct2d(input, SIZE))).toBeCloseTo(energy(input), 3);
  });
});

describe("hashPixels", () => {
  it("produces 16 hex characters for a real picture", () => {
    const result = hashPixels(image(SIZE, checkerboard), SIZE, PH);
    expect(result.failure).toBeNull();
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", () => {
    expect(hashPixels(image(SIZE, circle), SIZE, PH).hash).toBe(
      hashPixels(image(SIZE, circle), SIZE, PH).hash,
    );
  });

  it("rejects a solid image as degenerate", () => {
    const result = hashPixels(image(SIZE, () => 0), SIZE, PH);
    expect(result.hash).toBeNull();
    expect(result.failure).toBe("degenerate");
  });

  it("rejects a near-uniform image too", () => {
    // The dangerous case is not a pure black square, which anyone would catch.
    // It is a nearly-flat one that still produces a confident-looking hash.
    expect(hashPixels(image(SIZE, (x) => 128 + x * 0.05), SIZE, PH).failure).toBe("degenerate");
  });

  it("would hash floating-point residue if the floor were removed", () => {
    // What a flat image's hash is actually made of, and the reason the floor
    // exists. The spec predicts flat images collide with each other; measured,
    // something worse happens. A solid image's DCT is entirely DC, so every
    // other coefficient is numerical residue near 1e-12, the median is ~0, and
    // all 64 bits come from comparing noise against noise.
    const flat = dct2d(toGrayscale(image(SIZE, () => 128), SIZE), SIZE);
    expect(Math.max(...[...flat.slice(1)].map(Math.abs))).toBeLessThan(1e-9);

    // The consequence: two solid images produce unrelated hashes rather than
    // equal ones. Not a collision but an arbitrary value, sensitive to rounding
    // and therefore to the engine. Unpredictable is harder to reason about than
    // predictable, and neither is information.
    const unguarded = { ...PH, minVariance: 0 };
    const black = hashPixels(image(SIZE, () => 10), SIZE, unguarded);
    const gray = hashPixels(image(SIZE, () => 200), SIZE, unguarded);
    expect(black.hash).not.toBeNull();
    expect(hammingDistance(black.hash, gray.hash)).toBeGreaterThan(0);
  });

  it("does not catch a busy but featureless image — a known limitation", () => {
    // Variance is not structure. Visual static has high variance and clears the
    // floor easily while carrying almost no low-frequency content, which is the
    // only thing a DCT hash reads. Two unrelated noise images land inside the
    // match bar.
    //
    // Recorded as a test rather than a comment so that if it ever stops being
    // true, someone finds out. If image false positives show up in the wild,
    // this is the first place to look — ahead of tightening maxHamming.
    const a = hashPixels(image(SIZE, noise(11)), SIZE, PH);
    const b = hashPixels(image(SIZE, noise(29)), SIZE, PH);
    expect(a.failure).toBeNull();
    expect(a.variance).toBeGreaterThan(PH.minVariance * 10);
    expect(hammingDistance(a.hash, b.hash)).toBeLessThanOrEqual(PH.maxHamming);
  });

  it("reports variance even when it accepts, so the floor can be tuned", () => {
    expect(hashPixels(image(SIZE, checkerboard), SIZE, PH).variance).toBeGreaterThan(0);
  });
});

describe("perceptual behaviour", () => {
  const base = (): string | null => hashPixels(image(SIZE, circle), SIZE, PH).hash;

  it("is unmoved by brightness and contrast", () => {
    // The property that makes this perceptual rather than a checksum: the same
    // picture, re-exported slightly differently, must still match. Measured at
    // zero bits of drift, not merely inside the bar.
    const shifted = hashPixels(image(SIZE, (x, y) => circle(x, y) * 0.9 + 20), SIZE, PH);
    expect(hammingDistance(base(), shifted.hash)).toBe(0);
  });

  it("is unmoved by mild compression noise", () => {
    const noisy = hashPixels(
      image(SIZE, (x, y) => circle(x, y) + ((x * 7 + y * 13) % 9) - 4),
      SIZE,
      PH,
    );
    expect(hammingDistance(base(), noisy.hash)).toBe(0);
  });

  it("is unmoved by a one-pixel shift", () => {
    // A re-upload is rarely pixel-aligned with the original.
    const shifted = hashPixels(image(SIZE, (x, y) => circle(x - 1, y)), SIZE, PH);
    expect(hammingDistance(base(), shifted.hash)).toBe(0);
  });

  it("separates genuinely different pictures", () => {
    // Same silhouette, different content — the hard case, not an easy one.
    const other = hashPixels(image(SIZE, face), SIZE, PH);
    expect(hammingDistance(base(), other.hash)).toBeGreaterThan(PH.maxHamming);
    expect(imagesMatch(base(), other.hash, PH)).toBe(false);
  });

  it("treats an inverted image as a different picture", () => {
    // Inversion flips every comparison against the median, so this lands near
    // the maximum. Worth pinning: a hash calling these the same would be
    // reading brightness rather than structure.
    const inverted = hashPixels(image(SIZE, (x, y) => 255 - circle(x, y)), SIZE, PH);
    expect(hammingDistance(base(), inverted.hash)).toBeGreaterThan(48);
  });

  it("separates a checkerboard from a circle", () => {
    const a = hashPixels(image(SIZE, checkerboard), SIZE, PH);
    expect(imagesMatch(a.hash, base(), PH)).toBe(false);
  });
});

describe("hammingDistance", () => {
  it("counts differing bits", () => {
    expect(hammingDistance("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingDistance("0000000000000001", "0000000000000000")).toBe(1);
    expect(hammingDistance("ffffffffffffffff", "0000000000000000")).toBe(64);
  });

  it("returns null rather than a distance when it cannot compare", () => {
    // Null must never be read as "far apart". A failed hash is not a statement
    // about whether two pictures match.
    expect(hammingDistance(null, "0000000000000000")).toBeNull();
    expect(hammingDistance("0000000000000000", null)).toBeNull();
    expect(hammingDistance("abc", "0000000000000000")).toBeNull();
    expect(hammingDistance("zzzzzzzzzzzzzzzz", "0000000000000000")).toBeNull();
  });
});

describe("imagesMatch", () => {
  it("accepts at the bar and rejects past it", () => {
    expect(imagesMatch("0000000000000000", "00000000000003ff", PH)).toBe(true); // 10 bits
    expect(imagesMatch("0000000000000000", "00000000000007ff", PH)).toBe(false); // 11 bits
  });

  it("never matches when either hash is missing", () => {
    expect(imagesMatch(null, "0000000000000000", PH)).toBe(false);
    expect(imagesMatch(null, null, PH)).toBe(false);
  });
});

describe("mapWithConcurrency", () => {
  it("never exceeds the limit", async () => {
    // Forty visible rows would otherwise open forty simultaneous fetches
    // against a page already streaming a feed.
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    const results = await mapWithConcurrency(items, 4, async (i) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return i * 2;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(results).toEqual(items.map((i) => i * 2));
  });

  it("preserves input order regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms / 10));
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("fetchAndHash", () => {
  const environment = (overrides: Partial<DecodeEnvironment>): DecodeEnvironment => ({
    fetch: (async () => new Response(null, { status: 404 })) as unknown as typeof fetch,
    createImageBitmap: (async () => ({ close() {} })) as unknown as typeof createImageBitmap,
    createCanvas: () => {
      throw new Error("not used");
    },
    ...overrides,
  });

  it("reports an unreachable image as unavailable, not as a mismatch", async () => {
    const result = await fetchAndHash("https://cdn.example/a.webp", PH, environment({}));
    expect(result.hash).toBeNull();
    expect(result.failure).toBe("unavailable");
  });

  it("does not throw when the network throws", async () => {
    // One dead CDN link must not take down the hashing queue.
    const result = await fetchAndHash(
      "https://cdn.example/a.webp",
      PH,
      environment({
        fetch: (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      }),
    );
    expect(result.failure).toBe("unavailable");
  });

  it("refuses an image larger than the cap", async () => {
    const huge = new Blob([new Uint8Array(PH.maxBytes + 1)]);
    const result = await fetchAndHash(
      "https://cdn.example/a.webp",
      PH,
      environment({
        fetch: (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch,
      }),
    );
    expect(result.failure).toBe("unavailable");
  });

  it("hashes a decoded image through the canvas path", async () => {
    const pixels = image(SIZE, checkerboard);
    const result = await fetchAndHash(
      "https://cdn.example/a.webp",
      PH,
      environment({
        fetch: (async () =>
          new Response(new Blob([new Uint8Array(10)]), { status: 200 })) as unknown as typeof fetch,
        createCanvas: () =>
          ({
            getContext: () => ({
              imageSmoothingEnabled: true,
              imageSmoothingQuality: "medium",
              drawImage: () => {},
              getImageData: () => ({ data: pixels }),
            }),
          }) as unknown as OffscreenCanvas,
      }),
    );
    expect(result.hash).toBe(hashPixels(pixels, SIZE, PH).hash);
  });
});
