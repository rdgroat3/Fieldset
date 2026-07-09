// Photo quality check: blur (Laplacian variance) + exposure (mean luminance).
// Runs entirely on-device in pure JS. We downscale to ~240px first so the
// JPEG decode + convolution completes in well under a second on any phone.

import * as ImageManipulator from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import { Buffer } from 'buffer';
import { QUALITY } from '../theme';

export async function checkPhotoQuality(uri, { nameplate = false } = {}) {
  try {
    const small = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: 240 } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );

    const raw = jpeg.decode(Buffer.from(small.base64, 'base64'), { useTArray: true });
    const { width: w, height: h, data } = raw;

    // Grayscale
    const g = new Float32Array(w * h);
    let lumaSum = 0;
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const v = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      g[i] = v;
      lumaSum += v;
    }
    const meanLuma = lumaSum / (w * h);

    // Laplacian variance (4-neighbor kernel), skipping 1px border
    let sum = 0, sumSq = 0;
    const n = (w - 2) * (h - 2);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = -4 * g[i] + g[i - 1] + g[i + 1] + g[i - w] + g[i + w];
        sum += lap;
        sumSq += lap * lap;
      }
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;

    const blurMin = nameplate ? QUALITY.BLUR_MIN_NAMEPLATE : QUALITY.BLUR_MIN;
    return {
      ok: variance >= blurMin && meanLuma >= QUALITY.LUMA_MIN,
      blurry: variance < blurMin,
      dark: meanLuma < QUALITY.LUMA_MIN,
      variance: Math.round(variance),
      meanLuma: Math.round(meanLuma),
    };
  } catch (e) {
    // Never block a save because the checker failed — degrade gracefully.
    return { ok: true, blurry: false, dark: false, variance: -1, meanLuma: -1, error: String(e) };
  }
}
