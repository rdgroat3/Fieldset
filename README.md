# Fieldset — UI Update Setup Guide

Step-by-step to get the three new screens (Landing, Space Type Picker, Camera) from this bundle into your app and onto a device. Commands are PowerShell, for your Windows + EAS setup.

**Time:** ~15 min of setup, then one EAS cloud build (~10–20 min unattended).

> This update adds **native** modules, so it ships via a full `eas build` — not an OTA `eas update`. Plan a rebuild window before your next site visit.

> **Status:** Steps 1–6 are already done in this repo — the screens, deps, babel
> plugin, app-root wrappers, fonts and routes are all in place. They're kept
> here as a record of what the integration involved. Steps 7–9 (dev-client
> smoke test, field build, OTA loop) are the parts still worth referring to.

> **Repo location:** this project lives at `C:\Apps\fieldset`. An older copy
> under `OneDrive\Richie-Holly Messaround\Fieldset\` is abandoned — don't edit
> or push from it.

---

## Step 1 — Copy the source into your project

From this bundle, copy the `src/` folder into your project root, merging with what's there:

```
mep-ui-update/src/  ->  C:\Apps\fieldset\src\
```

That adds:
- `src/theme/tokens.js`
- `src/components/Surface.js`, `Icons.js`, `HoldShutter.js`
- `src/screens/LandingScreen.js`, `SpaceTypeScreen.js`, `CameraScreen.js`

If you already have a `src/theme` or `src/components`, keep both — none of these filenames should collide. Nothing existing is overwritten.

---

## Step 2 — Install the native dependencies

```powershell
cd C:\Apps\fieldset

npx expo install expo-linear-gradient expo-blur react-native-svg `
  react-native-gesture-handler react-native-reanimated `
  react-native-safe-area-context `
  @expo-google-fonts/manrope @expo-google-fonts/jetbrains-mono expo-font
```

Use `npx expo install` (not `npm install`) so the versions match Expo SDK 56.

**Check:** all packages appear under `dependencies` in `package.json` (not `optionalDevModules` — that field is ignored and native modules there silently vanish from the build).

---

## Step 3 — Add the reanimated babel plugin

Open `babel.config.js` and make the reanimated plugin the **last** entry:

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-reanimated/plugin'], // must be last
  };
};
```

If you skip this, the shutter's gesture code won't compile.

---

## Step 4 — Wrap the app root

In your top-level `App.js` (or `index.js` entry component), wrap everything in `GestureHandlerRootView` and `SafeAreaProvider`:

```jsx
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* your existing navigator goes here */}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
```

Without `GestureHandlerRootView`, the hold-to-select shutter won't respond to touch.

---

## Step 5 — Load the fonts

The screens expect Manrope and JetBrains Mono. Load them at startup and hold the first render until they're ready:

```jsx
import { useFonts,
  Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold,
  Manrope_700Bold, Manrope_800ExtraBold } from '@expo-google-fonts/manrope';
import {
  JetBrainsMono_400Regular, JetBrainsMono_500Medium,
  JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';

// inside App():
const [fontsLoaded] = useFonts({
  Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold,
  Manrope_700Bold, Manrope_800ExtraBold,
  JetBrainsMono_400Regular, JetBrainsMono_500Medium, JetBrainsMono_700Bold,
});
if (!fontsLoaded) return null; // or your splash
```

**Check:** text renders in Manrope, not the system font. If it looks like default Android sans, fonts didn't load — the family names in `tokens.js` must match the ones above exactly.

---

## Step 6 — Wire the navigation routes

Register the screens and point the buttons at them. Add these targets to your navigator:

| Route name | Screen file |
|---|---|
| `SpaceType` | `SpaceTypeScreen.js` |
| `Camera` | `CameraScreen.js` |
| `Landing` (if not already) | `LandingScreen.js` |

The screens call these on tap — make sure each exists:

| From | Calls | Goes to |
|---|---|---|
| Landing -> Start Walkthrough | `navigate('SpaceType')` | picker |
| SpaceType -> Continue (preset) | `navigate('Camera', { spaceType })` | camera |
| SpaceType -> Continue (Create New) | `navigate('CreateSpaceType')` | **screen not built yet — see Step 9** |
| Camera -> Finish | `navigate('Review')` | your review screen |
| Camera -> thumbnail | `navigate('Gallery')` | shot gallery |
| Landing -> Decoder / Experimental / Surveys / Deliverables / Settings | same names | your existing routes |

Routes you haven't built yet won't crash until tapped — safe to defer, but note the gaps.

---

## Step 7 — Smoke-test with the dev client

```powershell
npx expo start --dev-client
```

Walk the flow on your connected device: Landing -> Start Walkthrough -> pick a space -> Continue -> Camera. On the camera screen, **press and hold the shutter for ~1 second** — the radial menu (Electrical Panels / Video / Flag) should rise and the progress ring should fill. Drag onto an option and release to select; a plain press takes a photo.

**Check:** while the shutter is held, the Floor/Room/Finish toolbar dims and stops responding. If it doesn't dim, re-check Steps 3–4.

> The dev client needs Metro running on the PC. It's fine for this smoke test but is **not** a valid field test — that's Step 8.

---

## Step 8 — Build the standalone field APK

Native modules were added, so this is a full build (an OTA update can't carry it):

```powershell
eas build -p android --profile preview
```

When it finishes, download the APK from the EAS build page and install it on the device. Then **test it offline**: turn off Wi-Fi and cellular, force-close the app, reopen, and run a full walkthrough. Nothing should block on a network call.

---

## Step 9 — (After field testing) the OTA update loop

For JS-only changes from here on — no new native package, no `app.json` plugin/permission change:

```powershell
eas update --branch preview
```

On the device, force-close and reopen **twice** to pull and apply the update.

Any *native* change sends you back to Step 8.

---

## Still open (decide before wider release)

1. **Create New routing** — Step 6 routes it to `CreateSpaceType`, which isn't built. Decide: custom-type entry step, or straight to camera?
2. **Deselect** — re-tapping a selected space card does **not** clear it (current behavior). Add a clear affordance only if you want one.
3. **AR copy** — "AR pipe sizing" is still on the Experimental card by your request; restore full AR before anyone else sees it.
4. **Config token** — move the Cloudflare Worker token in `src/config.js` to an env var before the repo goes public.

---

## If something's off

- **Fonts look default** -> Step 5, family names must match `tokens.js`.
- **Shutter doesn't react** -> Step 4 (`GestureHandlerRootView`) then Step 3 (babel plugin).
- **Build fails on a plugin reference** -> a plugin listed in `app.json` must have its package actually in `dependencies`.
- **`git add` MAX_PATH error on Windows** -> `git config --global core.longpaths true` and confirm `.gitignore` excludes `node_modules/`.
