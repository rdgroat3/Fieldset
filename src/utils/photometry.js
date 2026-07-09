// Photometry helpers for the experimental light tools.
// All conversions are ESTIMATES — phone sensors are not calibrated meters.

// --- Illuminance ---
export const luxToFc = (lux) => lux / 10.7639;

// iOS path: estimate scene lux from camera EXIF.
// Prefer Apple's BrightnessValue (BV): lux ≈ K · 2^BV. Fallback: compute
// EV100 from ISO/shutter/aperture. K is a calibration constant.
export const LUX_K = 2.5; // tune against a real meter; see README
export function exifToLux(exif = {}) {
  const bv = exif.BrightnessValue;
  if (typeof bv === 'number') return LUX_K * Math.pow(2, bv) * 10; // ×10: BV→cd/m²→lux approx for diffuse scene
  const iso = Array.isArray(exif.ISOSpeedRatings) ? exif.ISOSpeedRatings[0] : exif.ISOSpeedRatings;
  const t = exif.ExposureTime, N = exif.FNumber;
  if (!iso || !t || !N) return null;
  const ev100 = Math.log2((N * N) / t) - Math.log2(iso / 100);
  return LUX_K * Math.pow(2, ev100);
}

// IES-style reference targets (footcandles) for quick field comparison.
export const FC_TARGETS = [
  ['Parking / egress path', 5],
  ['Corridor / stairs', 10],
  ['Warehouse aisle', 15],
  ['Mechanical / electrical room', 30],
  ['Open office', 30],
  ['Private office / task', 50],
  ['Exam / detailed task', 75],
];

// --- Correlated Color Temperature (McCamy 1992) ---
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function rgbToCCT(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  // sRGB D65 -> XYZ
  const X = 0.4124 * R + 0.3576 * G + 0.1805 * B;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = 0.0193 * R + 0.1192 * G + 0.9505 * B;
  const sum = X + Y + Z;
  if (sum <= 0) return null;
  const x = X / sum, y = Y / sum;
  const n = (x - 0.332) / (0.1858 - y);
  const cct = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
  if (!isFinite(cct) || cct < 1000 || cct > 20000) return null;
  return Math.round(cct);
}

export const CCT_BINS = [2700, 3000, 3500, 4000, 4100, 5000, 6500];
export const nearestCCTBin = (k) =>
  CCT_BINS.reduce((best, b) => (Math.abs(b - k) < Math.abs(best - k) ? b : best), CCT_BINS[0]);

export function cctDescription(k) {
  if (k < 2900) return 'Warm white (residential/hospitality)';
  if (k < 3300) return 'Warm white (typical 3000K commercial)';
  if (k < 3800) return 'Neutral warm (3500K office)';
  if (k < 4600) return 'Cool white (4000–4100K office/industrial)';
  if (k < 5600) return 'Daylight-ish (5000K task/garage)';
  return 'Daylight (6500K)';
}
