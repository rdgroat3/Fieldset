# expo-camera patch — ultra-wide (0.5x) zoom on Android

## Why
Stock expo-camera cannot reach a phone's ultra-wide lens on Android. Two reasons,
both in its own code — not the hardware:

1. `ExpoCameraView.setCameraZoom()` computes
   `max(1f, min(maxZoomRatio, zoom * maxZoomRatio))`.
   The `max(1f, ...)` is a hard 1.0x floor.
2. `zoom` is a normalised 0..1 fraction of a maximum that is never reported to
   JS, so exact factors (2x, 5x) can't be requested either — only guessed.

On phones whose logical back camera bundles an ultra-wide (Pixel, most modern
Androids), CameraX reports `minZoomRatio ~0.5` and switches to that lens by
itself when asked for a sub-1x ratio. expo-camera already calls
`setZoomRatio()` — it just clamps the value first.

## What the patch adds
- `zoomRatio` prop: absolute factor (0.5 / 1 / 2 / 5), clamped to the device's
  real `minZoomRatio..maxZoomRatio`. Safe on phones with no ultra-wide —
  min is 1.0 there, so 0.5 clamps to 1.0.
- `getZoomRange()` / `getZoomRangeAsync()`: reports true min/max, so the UI
  offers only factors this device can hit.
- Re-applies the ratio on `CameraState.Type.OPEN` (props can land before the
  session binds).

The existing `zoom` prop is untouched — this is additive.

## Mechanics
`patch-package` runs via the `postinstall` script, so it re-applies on every
`npm install`, including on EAS Build.

**This is a NATIVE change: it needs a full `eas build`, not `eas update`.**

Pinned to expo-camera **56.0.8**. On upgrade, patch-package fails loudly rather
than silently dropping the fix — re-generate with:
`npx patch-package expo-camera`
