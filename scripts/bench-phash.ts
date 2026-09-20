/**
 * How much CPU a perceptual hash costs.
 *
 * The spec calls phase 4 the one most likely to cost performance and says to
 * measure before and after. This measures the half that is ours: the arithmetic
 * from a decoded 32x32 buffer to 16 hex characters. Fetch and decode dominate
 * wall-clock time in the browser, but those are the browser's to optimise and
 * mostly hit cache; the DCT is the part we could get wrong.
 *
 * Run: npm run bench:phash
 */
import { performance } from "node:perf_hooks";
import { dct2d, hashPixels, toGrayscale } from "../src/worker/phash.js";
import { THRESHOLDS } from "../src/shared/config.js";

const PH = THRESHOLDS.phash;
const SIZE = PH.sampleSize;
const ITERATIONS = Number(process.argv[2] ?? 2000);

/** A structured image, like real token art rather than static. */
const sample = (seed: number): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inside = Math.hypot(x - SIZE / 2, y - SIZE / 2) < SIZE / 3;
      const v = inside ? 230 - ((x * seed) % 40) : 25 + ((y * seed) % 30);
      const p = (y * SIZE + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return data;
};

const images = Array.from({ length: 64 }, (_, i) => sample(i + 1));
const grays = images.map((img) => toGrayscale(img, SIZE));

// Warm up, so the first measured iterations are not paying for JIT.
for (let i = 0; i < 300; i++) hashPixels(images[i % images.length]!, SIZE, PH);

const time = (label: string, fn: (i: number) => unknown): number => {
  const started = performance.now();
  for (let i = 0; i < ITERATIONS; i++) fn(i);
  const per = (performance.now() - started) / ITERATIONS;
  console.log(
    `  ${label.padEnd(24)} ${per.toFixed(4)} ms/image   ` +
      `${Math.round(1000 / per).toLocaleString()} images/sec`,
  );
  return per;
};

console.log(`\nphash cost, ${ITERATIONS.toLocaleString()} iterations at ${SIZE}x${SIZE}:\n`);
time("grayscale only", (i) => toGrayscale(images[i % images.length]!, SIZE));
time("DCT only", (i) => dct2d(grays[i % grays.length]!, SIZE));
const full = time("full hash", (i) => hashPixels(images[i % images.length]!, SIZE, PH));

console.log(
  `\n  40 visible rows:  ${(full * 40).toFixed(1)} ms of CPU total` +
    ` (spread across ${PH.maxConcurrent} concurrent fetches)`,
);
// ms of CPU per second of wall clock, as a share of one core. Dividing by 1000
// converts ms/s to a fraction; multiplying by 100 makes it a percentage. An
// earlier version of this line did the second step and not the first, and
// reported a cost a thousand times too high — which, had it stood, would have
// argued for optimising something that costs nothing.
const msPerSecond = (full * 31) / 60;
console.log(
  `  31 launches/min:  ${((msPerSecond / 1000) * 100).toFixed(4)}% of one core, sustained\n`,
);
