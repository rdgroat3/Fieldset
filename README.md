# MEP Survey Pro — v1.0 (React Native / Expo)

One codebase → iPhone + Android. Zero servers. Everything runs on-device.

**The pitch:** Point your phone at the building like you always do. Walk out
with your photo log, equipment inventory, and panel sheets already done.

---


---

## Install & run

**Expo SDK 56 / React Native 0.85.** This project uses native modules
(OCR, speech recognition) that cannot run in Expo Go — you build a
development client once, then develop against it exactly like Expo Go.

```
npm install
npx expo install --fix
npm install -g eas-cli
eas login
eas build --profile development --platform android
```

Install the resulting APK on your phone, then:

```
npx expo start --dev-client
```

Scan the QR code. Hot reload works as normal. Rebuild only when you add
another native module.

### AR sizer is NOT in this build
The AR pipe/duct sizer needs `@reactvision/react-viro`, a heavy native AR
module that has repeatedly conflicted with current React Native versions.
It is intentionally excluded. Its screen shows an explanatory message; every
other feature — including the footcandle meter and CCT estimator — works.

To try enabling it later:
```
npm install @reactvision/react-viro
```
then add `"@reactvision/react-viro"` to `plugins` in app.json and rebuild.
Expect version conflicts; pin to whatever release matches your RN version.

## What's in v1

| Feature | Status |
|---|---|
| Tagged camera (sticky level/space/system, thumb-tap +1 increment) | ✅ |
| Watermark burned onto every photo (BLDG / LVL / SPACE / SYS / timestamp) | ✅ |
| Blur + exposure check the instant you shoot (stricter for nameplates) | ✅ |
| Torch toggle for dark mechanical rooms | ✅ |
| Deficiency flag (⚠ burns onto photo + gets its own report section) | ✅ |
| Nameplate mode with structured data fields (make/model/serial/capacity/year) | ✅ |
| Video walkthrough mode, tagged and filed with the project | ✅ |
| Photos saved to a per-project album in your camera roll (Google Photos/iCloud sync untouched) | ✅ |
| Gallery grouped by level/space with quality + flag badges | ✅ |
| **Export: Photo Log PDF** (grouped, numbered, captioned, deficiency table) | ✅ |
| **Export: Equipment Inventory CSV** (opens in Excel) | ✅ |
| **Export: Panel Profile Sheet PDF** (schedule + breaker columns) | ✅ |
| Close-out sweep (removes project photos from camera roll, surgically) | ✅ |
| Firm branding — name burned into watermarks, logo on PDF report headers | ✅ |
| Walkthrough flag-moments — tap ⚑ while recording to bookmark timestamps | ✅ |
| Automatic nameplate OCR + brand decode (Carrier/Trane/York/Daikin/Lennox/Square D/Eaton/Siemens) | ✅ dev build |
| Voice captions (tap mic, speak your observation) | ✅ dev build |
| 🧪 AR Pipe & Duct Sizer (experimental, disclaimed, estimates only) | ✅ dev build |
| 🧪 Footcandle Meter (Android live sensor / iOS camera estimate) | ✅ Expo Go |
| 🧪 Color Temperature (CCT) estimator | ✅ Expo Go |
| Watermark burned into video frames | 🔜 Phase 3 (needs native video processing) |

---

## 1. One-time setup (~15 min)

1. Install **Node.js** (LTS) from nodejs.org
2. In a terminal, unzip this project and run:
   ```bash
   cd mep-survey-pro
   npx expo install
   ```
   (`npx expo install` resolves every package to the exact version matching
   the Expo SDK — do not use plain `npm install` for the expo-* packages.)
3. Install the **Expo Go** app on your phone (App Store / Play Store).

## 2. Run it on your phone (~2 min)

```bash
npx expo start
```

Scan the QR code with your phone (iPhone: Camera app; Android: Expo Go app).
The app loads live. Edit code → it hot-reloads instantly.

> Camera, photo library, video, blur check, and all three exports work in
> Expo Go. This is your field-testing loop: take it on a real survey.

## 3. Build real installable apps (when ready)

```bash
npm install -g eas-cli
eas login              # free Expo account
eas build --platform ios      # needs Apple Developer account ($99/yr)
eas build --platform android  # needs Google Play account ($25 once)
```

EAS compiles in the cloud — no Mac required for iOS builds.

---

## Tuning after your first field test

Open `src/theme.js` → `QUALITY`:

- `BLUR_MIN` (default 110) — raise if blurry shots pass, lower if good shots fail
- `BLUR_MIN_NAMEPLATE` (default 260) — the stricter nameplate bar
- `LUMA_MIN` (default 38) — the "too dark" threshold

Space templates per building profile: `BUILDING_PROFILES` in the same file.

## Phase 3 backlog

- Payments (RevenueCat), Word/.docx export
- Project sync for teams, floor plan photo-pinning
- True voice-triggered flags (saying "flag" during recording) — deferred
  because speech recognition can't run while the mic feeds video capture
  on most devices; the on-screen ⚑ button is the reliable version
- AI-assisted nameplate parsing for unmapped brands (on-connectivity)


---

## Phase 2 features: the development build (one-time, ~30 min)

OCR, voice captions, and the AR sizer use native modules Expo Go doesn't
include. Build your own dev client once and they all light up:

```bash
npm install -g eas-cli
eas login                                   # free account
eas build --profile development --platform ios      # or android
```

Install the build EAS gives you on your phone, then run `npx expo start`
as usual — same QR code workflow, same hot reload, now with all features.
Everything else (camera, tagging, exports) still works in plain Expo Go
if you skip this.

### AR sizer notes (EXPERIMENTAL)
- Workflow: aim reticle at pipe → LOCK DISTANCE → drag the two amber
  guides to bracket the pipe edges → read nominal size → SAVE.
- Duct mode: save width, then bracket and save height.
- Insulation offset chips subtract 2× thickness before the nominal lookup.
- Saved measurements appear in the Photo Log PDF under a clearly
  disclaimed "AR ESTIMATES" table.
- `H_FOV_DEG` in `src/screens/ARPipeSizerScreen.js` (default 60°) is the
  calibration constant. Field-calibrate: measure a known pipe, adjust
  until the readout matches. Accuracy is best on LiDAR iPhones; expect
  degradation on non-LiDAR devices in dim/low-texture rooms.

### Footcandle meter notes (EXPERIMENTAL)
- Android reads the hardware ambient light sensor live (works in Expo Go).
- iOS has no public light sensor; readings are estimated from camera
  exposure EXIF. Tune `LUX_K` in `src/utils/photometry.js` against a real
  meter for your device (one comparison reading is enough to calibrate).
- Take multiple samples and use the session average.

### CCT estimator notes (EXPERIMENTAL)
- Aim the target box at a WHITE surface (paper) lit by the fixture.
- Auto white balance partially cancels the color cast, so treat absolute
  values loosely — the tool is at its best comparing/matching fixtures
  ("is this wing 3500K or 4000K?"). Keep some non-white surroundings in
  frame to reduce AWB cancellation.

### Nameplate decode notes
Decode rules live in `src/data/nomenclature.js`, fully decoupled from app
code (spec §4.3). Serial-year rules are approximations of common formats
and are labeled "verify" in the UI — expand per-brand rules there as you
hit real equipment in the field.


---

## AI decode fallback (optional, ~10 min setup)

When the local dictionary can't fully decode a nameplate, the raw OCR text
is queued on-device and decoded by AI when connectivity returns. Results
merge into the record labeled "AI-decoded — verify" (hand-typed values are
never overwritten). Costs ~$0.001–0.003 per decode.

**One key total — yours, held server-side. Users never see or need keys.**

1. `npm install -g wrangler && wrangler login` (free Cloudflare account)
2. `cd server && wrangler deploy`
3. `wrangler secret put ANTHROPIC_API_KEY` (from console.anthropic.com — set a spend cap there too)
4. `wrangler secret put APP_TOKEN` (invent a long random string)
5. Paste the Worker URL + same APP_TOKEN into `src/config.js`

Leave `src/config.js` empty to disable the feature — everything else is
fully offline. Queue drains automatically when a survey screen opens with
connectivity; a blue banner shows the pending count.

## Architecture map

```
App.js                     navigation stack
src/theme.js               design tokens, profiles, quality thresholds
src/store/ProjectContext.js all data (AsyncStorage; zero servers)
src/utils/quality.js       Laplacian blur + exposure check (pure JS)
src/utils/media.js         app storage + per-project albums + sweep
src/utils/exports.js       PDF photo log, CSV inventory, panel sheet PDF
src/utils/native.js        lazy OCR + voice wrappers (dev-build features)
src/data/nomenclature.js   brand decode dictionary + pipe size tables
src/utils/aidecode.js      offline AI-decode queue (store-and-forward)
src/config.js              AI decode endpoint config (empty = disabled)
server/worker.js           Cloudflare Worker API-key proxy (deploy once)
src/screens/               Projects → ProjectHome → Capture → Review
                           Gallery · Panels · Export · ARPipeSizer (experimental)
```
