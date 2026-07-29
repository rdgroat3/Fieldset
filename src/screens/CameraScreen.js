import React, { useRef, useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, Pressable, Image, Modal, FlatList, TextInput, Alert, Linking,
  useWindowDimensions, Platform,
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import ViewShot, { captureRef } from 'react-native-view-shot';
import Svg, { Rect } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import HoldShutter, { PHOTO_OPTIONS, VIDEO_OPTIONS } from '../components/HoldShutter';
import { MinusIcon, PlusIcon, LabelsToggleIcon, FlagIcon, TorchIcon } from '../components/Icons';
import { color, radius, font, gradient, angle } from '../theme/tokens';
import { useProjects } from '../store/ProjectContext';
import { persistToApp, saveToProjectAlbum, deleteAppFile, sweepAssets, getMediaLibraryPermissionStatus } from '../utils/media';
import { checkPhotoQuality } from '../utils/quality';

const pad2 = (n) => String(n).padStart(2, '0');

// Width in px of each edge bar drawn around the screen while flagging is on.
// This was referenced by the flag-frame render below but never defined,
// which threw a ReferenceError the instant the flag toggle was switched
// on — that was the "clicking the flag crashes the app" bug.
// Height of the Floor/Room toolbar row (matches the pill's minHeight) — used
// to position the recording timer below it instead of overlapping.
const TOOLBAR_ROW_H = 38;

const FLAG_BAR = 6;

// Stock expo-camera's `zoom` is a 0..1 fraction with no way to ask what the
// real maximum factor is. Assume a typical ~8x logical-camera max so presets
// map to something sane on unpatched builds. Module scope: updateZoom()
// references it, and a const declared later in the component body would sit in
// the temporal dead zone.
const ASSUMED_MAX_FACTOR = 8;

// Floor level presets, fixed to the surveyor's actual level set.
const COMMON_LEVELS = ['B1', '01', '02', '03', '04', 'RF', 'EXT'];

/**
 * Capture screen. Photos save directly to the project (no per-shot Review
 * detour) so a walkthrough stays fast:
 *   take -> burn watermark -> persist -> addPhoto, all inline.
 * A blurry shot still saves immediately, then a non-blocking popup offers
 * Retake, which deletes the just-saved photo and reopens the camera so the
 * next shot replaces it rather than piling up a duplicate.
 *
 * Caption is a sticky, optional field above the shutter that applies to the
 * next shot(s) - the only spot it fits without reintroducing a per-photo screen.
 *
 * Nameplate scanning lives in the standalone Decoder tool (Landing -> Decoder),
 * not here.
 */
export default function CameraScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  // Real screen size for the SVG flag frame below — it needs concrete pixel
  // dimensions, not percentages, to draw one continuous stroked rect.
  const { width: winW, height: winH } = useWindowDimensions();
  const { projectId } = route.params || {};
  const { projects, addPhoto, updateProject, deletePhoto, settings } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  const cam = useRef(null);
  const shotRef = useRef(null);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  const last = project?.photos?.[project.photos.length - 1];
  const [level, setLevel] = useState(last?.level || project?.levels?.[0] || '01');
  const [spaceType, setSpaceType] = useState(last?.space || project?.spaceTypes?.[0] || 'Space');
  const [spaceNum, setSpaceNum] = useState(last?.spaceNum || 1);
  // Systems are MULTI-SELECT and default to GENERAL. Every photo is saved
  // tagged 'GEN' rather than untagged, so nothing ever lands in the survey
  // with no discipline at all; the surveyor changes it (add MECH, drop GEN,
  // whatever) during the Finalize review pass. GEN is a real, removable tag
  // here — not a placeholder — so it toggles like any other.
  // `system` is still saved as a derived STRING ('MECH+ELEC' / 'GEN') so the
  // gallery, CSV and report code keep working unchanged, while `systems`
  // carries the structured truth.
  const [systems, setSystems] = useState(
    Array.isArray(last?.systems) && last.systems.length ? last.systems : ['GEN']
  );
  const system = systems.length ? systems.join('+') : 'GEN';


  // Explicit camera mode. CameraView must already be in 'video' mode BEFORE
  // recordAsync() is called; the old `recording ? 'video' : 'picture'`
  // derivation meant the mode was still 'picture' at the moment recording
  // started, so recordAsync never fired. This state is set first, on toggle.
  const [camMode, setCamMode] = useState('picture'); // 'picture' | 'video'

  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [labelsOn, setLabelsOn] = useState(true);
  const [torchOn, setTorchOn] = useState(false);
  const [spacePicker, setSpacePicker] = useState(false);
  const [newSpaceInput, setNewSpaceInput] = useState('');
  const [levelPicker, setLevelPicker] = useState(false);
  const [newLevelInput, setNewLevelInput] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [flagCount, setFlagCount] = useState(0);
  const [elapsed, setElapsed] = useState(0); // recording seconds, for the on-screen timer
  const [libWarning, setLibWarning] = useState(false); // MediaLibrary permission not granted
  const [libWarningDismissed, setLibWarningDismissed] = useState(false);

  // Persistent flag toggle for photo mode (replaces the old one-shot radial
  // "flag" option). While on, every photo taken is saved flagged and the
  // screen shows a yellow border so it's obvious flagging is active.
  const [flagOn, setFlagOn] = useState(false);

  // Zoom: expo-camera's `zoom` prop is 0..1 (fraction of the device's max
  // zoom), not an optical multiplier. We drive it from both a pinch gesture
  // and a vertical on-screen rail, like a normal camera app's zoom scale.
  // TRUE zoom factors, read from the hardware.
  //
  // Stock expo-camera only exposes `zoom` as a 0..1 fraction and floors it at
  // 1.0x, which is what made the ultra-wide unreachable. We ship a small
  // patch (patches/expo-camera+56.0.8.patch) adding an absolute `zoomRatio`
  // prop plus getZoomRangeAsync(), so these are measured, not guessed.
  const [zoomRatio, setZoomRatio] = useState(1);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 1 });
  // Whether the running BINARY actually has the patch compiled in. The probe
  // below is defensive (optional chaining + try/catch), but the `zoomRatio`
  // PROP was not: it was handed to CameraView unconditionally, so on a build
  // where the patch didn't apply, JS sets a prop the native view never
  // declared. Treat the prop as opt-in, proven by a successful probe, rather
  // than assumed. Starts null = unknown, so nothing is passed until proven.
  const [zoomSupported, setZoomSupported] = useState(null);
  const zoomRef = useRef(1);
  const pinchStartZoom = useSharedValue(1);
  const [ultraWide, setUltraWide] = useState(null); // iOS lens id, if any
  const [lensOverride, setLensOverride] = useState(null);

  // Android PHYSICAL ultra-wide (Pixel-class devices). Pixels don't fuse the
  // ultra-wide into the logical back camera's zoom range for third-party
  // apps — zoomState reports min 1.0 even though the lens is right there —
  // so sub-1.0 zoomRatio can never reach it. The extended expo-camera patch
  // adds getUltraWideInfo() (is there a separate back camera with intrinsic
  // zoom < 1?) and an `ultraWide` prop that rebinds CameraX to that physical
  // camera directly. These track that path:
  //   uwInfo — probe result { available, intrinsicZoom } once known
  //   uwCam  — currently bound to the physical ultra-wide
  const [uwInfo, setUwInfo] = useState(null);
  const [uwCam, setUwCam] = useState(false);
  const uwInfoRef = useRef(null);
  const uwCamRef = useRef(false);

  // Freeze-frame + burn-in state: while a photo is being composited we hold
  // the raw shot here so ViewShot can capture image+watermark together.
  const [pendingUri, setPendingUri] = useState(null);
  const [pendingFlag, setPendingFlag] = useState(false);
  const imageReadyResolve = useRef(null);

  // Video-record robustness: switching CameraView into 'video' mode is an
  // async native reconfigure. Previously we fired recordAsync() after a
  // fixed 80ms timer, which was too short on many devices and produced a
  // "recording" state (Stop button showing) with no actual capture underway.
  // Now we wait for onCameraReady to refire after the mode switch, with a
  // timeout fallback so we never hang forever if it doesn't refire.
  const [cameraReady, setCameraReady] = useState(true);
  const pendingRecordRef = useRef(false);
  const readyTimeoutRef = useRef(null);

  const recStart = useRef(null);
  const recFlags = useRef([]);

  // If the screen unmounts during the 900ms camera-mode-switch window, kill
  // the fallback timer so beginRecording can't fire against a dead screen.
  React.useEffect(() => () => {
    pendingRecordRef.current = false;
    if (readyTimeoutRef.current) clearTimeout(readyTimeoutRef.current);
  }, []);

  // Only ONE CameraView can hold the Android camera session at a time. When
  // Decoder (which has its own CameraView) is pushed on top, this screen's
  // preview loses the session and comes back BLACK on goBack(). Unmounting the
  // preview whenever the screen isn't focused makes it reacquire cleanly.
  const isFocused = useIsFocused();

  // isFocused flips true the instant navigation lands back on this screen,
  // but the OUTGOING screen's native camera session (e.g. Decoder's
  // CameraView) hasn't necessarily finished releasing yet — React unmount
  // and the native camera teardown aren't synchronized. Mounting this
  // screen's CameraView immediately raced that teardown and lost: the
  // acquire silently failed, onCameraReady never fired, and the preview
  // came back dead with no visible error. Stagger the remount by one beat
  // so the previous session has time to actually let go first.
  const [camMounted, setCamMounted] = useState(true);
  React.useEffect(() => {
    if (!isFocused) {
      setCamMounted(false);
      return undefined;
    }
    const t = setTimeout(() => setCamMounted(true), 120);
    return () => clearTimeout(t);
  }, [isFocused]);

  // Verified against the installed expo-camera native source (both platforms
  // read directly, not assumed):
  //
  // - getAvailableLensesAsync / selectedLens: real, iOS-only (there's no
  //   Android Kotlin Prop("selectedLens") at all). Apple's localized device
  //   name is "Back Ultra Wide Camera" — TWO words with a space. The old
  //   /ultrawide/i regex required them contiguous and never matched a real
  //   device, silently disabling 0.5x on every iPhone that has one.
  //
  // - getZoomRangeAsync / zoomRatio: a patch on top of CameraX's zoomState,
  //   and genuinely Android-only — there's no Swift Prop("zoomRatio")
  //   anywhere in the package. On iOS the JS wrapper still resolves (it
  //   always ??s to { min: 1, max: 1 } when the native method is absent),
  //   so the old code's "did it resolve to something finite?" check read
  //   that placeholder as a real measurement, flipped zoomSupported to true
  //   on EVERY iPhone, and then handed CameraView a zoomRatio prop iOS
  //   silently ignores — 2x/5x wouldn't actually move the lens at all.
  //   Branching on Platform.OS directly (documented capability, not
  //   inferred from a value that's ambiguous by construction) removes that
  //   whole failure mode.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      if (Platform.OS === 'ios') {
        try {
          const lenses = await cam.current?.getAvailableLensesAsync?.();
          if (alive && Array.isArray(lenses)) {
            const uw = lenses.find((l) => /ultra\s*-?\s*wide/i.test(l));
            if (uw) setUltraWide(uw);
          }
        } catch (e) { /* device has no ultra-wide, or no lens API */ }
      }
      if (Platform.OS === 'android') {
        // The camera binds asynchronously after mount; before it does,
        // zoomState is null and getZoomRange returns the {1,1} placeholder —
        // which used to get recorded as "no zoom on this device" forever if
        // the probe won the race. Retry a few beats instead of measuring
        // once against an unbound camera.
        for (let attempt = 0; attempt < 8 && alive; attempt++) {
          try {
            const r = await cam.current?.getZoomRangeAsync?.();
            if (r && Number.isFinite(r.min) && Number.isFinite(r.max) && r.max > r.min) {
              if (!alive) return;
              setZoomRange({ min: r.min, max: r.max });
              setZoomSupported(true);
              // Fused ultra-wide (min < 1) needs nothing more. Otherwise ask
              // whether a SEPARATE physical ultra-wide camera exists (Pixel).
              if (r.min >= 1) {
                try {
                  const uw = await cam.current?.getUltraWideInfoAsync?.();
                  if (alive && uw?.available) {
                    uwInfoRef.current = uw;
                    setUwInfo(uw);
                  }
                } catch (e) { /* patch predates getUltraWideInfo — fine */ }
              }
              return;
            }
          } catch (e) { /* not bound yet, or unpatched — fall through to retry */ }
          await new Promise((res) => setTimeout(res, 250));
        }
        if (alive) setZoomSupported(false);
      } else if (alive) {
        setZoomSupported(false);
      }
    })();
    return () => { alive = false; };
  }, [camMounted]);

  // Recording timer, so it's obvious capture is actually running.
  React.useEffect(() => {
    if (!recording) { setElapsed(0); return undefined; }
    const t = setInterval(() => {
      setElapsed(recStart.current ? Math.floor((Date.now() - recStart.current) / 1000) : 0);
    }, 500);
    return () => clearInterval(t);
  }, [recording]);

  // Camera permission is a hard gate below; MediaLibrary permission is not —
  // capture still works via app-private storage without it — but silently
  // skipping the camera-roll backup for an entire survey is exactly the kind
  // of thing that should be visible, not discovered later. Re-checked on
  // focus so returning from Settings after granting it clears the banner.
  useFocusEffect(
    React.useCallback(() => {
      let alive = true;
      getMediaLibraryPermissionStatus().then(({ granted }) => {
        if (alive) { setLibWarning(!granted); setLibWarningDismissed(false); }
      });
      return () => { alive = false; };
    }, [])
  );

  const toolbarOpacity = useSharedValue(1);
  const toolbarStyle = useAnimatedStyle(() => ({ opacity: toolbarOpacity.value }));
  const onArmChange = (armed) => {
    setMenuOpen(armed);
    toolbarOpacity.value = withTiming(armed ? 0.35 : 1, { duration: 160 });
  };

  const roomLabel = `${spaceType} #${pad2(spaceNum)}`;

  // On-screen + burned watermark. No date/time - removed per field feedback.
  const stamp = useMemo(() => {
    const firm = settings?.firmName ? `  \u00b7  ${settings.firmName}` : '';
    return `${project?.name ?? ''} \u00b7 FLOOR ${level} \u00b7 ${roomLabel.toUpperCase()}${firm}`;
  }, [project, level, roomLabel, settings]);

  // Union of this survey's own levels and the common presets, ordered
  // basement -> roof rather than alphabetically ('B1' would sort after '01').
  const levelOptions = React.useMemo(() => {
    const own = project?.levels || [];
    const all = [...new Set([...own, ...COMMON_LEVELS])];
    const rank = (x) => {
      const i = COMMON_LEVELS.indexOf(x);
      return i === -1 ? COMMON_LEVELS.length + 1 : i;
    };
    return all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [project?.levels]);

  const pickLevel = (item) => {
    // Picking a preset the survey doesn't have yet adds it, so it shows up in
    // exports and the ProjectHome "Levels:" line.
    const own = project?.levels || [];
    if (!own.includes(item)) updateProject(projectId, { levels: [...own, item] });
    setLevel(item);
    setLevelPicker(false);
  };

  // Systems are now tagged on the Finalize review screen, not here — see
  // FinalizeScreen.js. Photos still save with an empty systems[] at capture
  // time and pick up tags during review.

  const addNewLevel = () => {
    const val = newLevelInput.trim();
    if (!val) return;
    const levels = project?.levels?.length ? project.levels : [];
    if (!levels.includes(val)) {
      updateProject(projectId, { levels: [...levels, val] });
    }
    setNewLevelInput('');
    pickLevel(val);
  };

  const decRoom = () => setSpaceNum((n) => Math.max(1, n - 1));
  const incRoom = () => setSpaceNum((n) => n + 1);
  const pickSpaceType = (item) => {
    setSpaceType(item);
    setSpaceNum(1);
    setSpacePicker(false);
  };

  const addNewSpaceType = () => {
    const val = newSpaceInput.trim();
    if (!val) return;
    if (!project.spaceTypes.includes(val)) {
      updateProject(projectId, { spaceTypes: [...project.spaceTypes, val] });
    }
    setNewSpaceInput('');
    pickSpaceType(val);
  };

  // Delete a saved photo entirely (asset + app file + record). Used by the
  // blurry-shot Retake path so a retake replaces rather than duplicates.
  const removePhoto = async (photo) => {
    if (photo.assetId) await sweepAssets([photo.assetId]);
    await deleteAppFile(photo.uri);
    deletePhoto(projectId, photo.id);
  };

  /**
   * Non-blocking "this looks blurry" prompt, shared by both the watermarked
   * and raw-save paths. Honors Settings > Warn on blurry shots, so a surveyor
   * shooting fast in a dark plenum isn't fighting a popup every frame.
   */
  const maybeWarnBlurry = (quality, photoId, appUri, assetId) => {
    if (!quality?.blurry) return;
    if (settings?.blurCheck === false) return;
    Alert.alert(
      'Blurry shot',
      'This photo looks blurry. Keep it, or retake?',
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Retake',
          style: 'destructive',
          onPress: () => {
            const saved = project?.photos?.find((p) => p.id === photoId)
              || { id: photoId, uri: appUri, assetId };
            removePhoto(saved);
          },
        },
      ]
    );
  };

  /**
   * Take, burn watermark, persist, addPhoto - all inline, no Review screen.
   * After saving, run the blur check; if blurry, offer Keep / Retake.
   */
  const snap = async () => {
    if (busy || recording || !cam.current) return;
    setBusy(true);
    try {
      // Full-quality capture by default. `quality` here is JPEG compression on
      // the FULL-RESOLUTION sensor image, so there's no reason to spend
      // sharpness at capture time — the file is transient and re-encoded below
      // anyway. Configurable via Settings > Capture Quality.
      const q = typeof settings?.photoQuality === 'number' ? settings.photoQuality : 1;
      const photo = await cam.current.takePictureAsync({ quality: q });

      // Watermark off -> keep the ORIGINAL file untouched. The burn path below
      // captures an on-screen composite, which is inherently limited to the
      // preview's pixel dimensions — that downscale (not the JPEG quality
      // number) is what made saved photos look soft next to the live preview.
      // Skipping it entirely is the only way to keep true sensor resolution.
      // Three ways to land here: the Settings toggle, the on-screen labels
      // toggle, or simply nothing to draw.
      const burnOff = settings?.burnWatermark === false;
      if (burnOff || (!labelsOn && !flagOn)) {
        const appUri = await persistToApp(photo.uri, 'jpg');
        const assetId = await saveToProjectAlbum(appUri, project.name);
        const quality = await checkPhotoQuality(photo.uri);
        const photoId = addPhoto(projectId, {
          uri: appUri, assetId,
          level, space: spaceType, spaceNum, system, systems,
          // Still recorded as flagged even with no burned-in banner — the
          // stamp is a convenience for reading the JPEG standalone, not the
          // source of truth. Gallery, exports and the report all read this.
          flagged: flagOn, caption: '',
          type: 'photo', mode: 'photo', quality, nameplate: null,
        });
        maybeWarnBlurry(quality, photoId, appUri, assetId);
        return;
      }

      // Show the shot in a VISIBLE full-screen composite so ViewShot can
      // actually paint and capture it. Off-screen (-10000) views don't reliably
      // render on Android, which produced black captures. The brief freeze-frame
      // also doubles as capture feedback.
      setPendingUri(photo.uri);
      setPendingFlag(flagOn);
      // Wait for the freeze-frame <Image> to actually finish decoding and
      // painting before capturing — a fixed frame-count wait let ViewShot
      // fire before the image had visibly painted on slower devices, which
      // silently fell back to saving the RAW (unwatermarked) photo below.
      // Safety net bumped 400ms -> 700ms: on a cold-started camera screen
      // (first shot after opening Capture), onLoadEnd can lag noticeably
      // behind a fast tap-to-shoot, and this is a one-time cost per photo,
      // not per frame, so the extra margin is cheap insurance.
      await new Promise((resolve) => {
        imageReadyResolve.current = resolve;
        setTimeout(resolve, 700);
      });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      // quality: 1 — this composite is already downscaled to preview
      // dimensions, so compressing it again on top of that was stacking two
      // separate quality losses. Cheap to keep this step lossless.
      const burnOpts = { format: 'jpg', quality: 1 };
      let appUri;
      let stampFailed = false;
      // Three attempts, back-loaded with delay, before giving up — most
      // failures here are timing (the composite genuinely hadn't painted
      // yet), not permanent, so a beat between tries has a real chance of
      // succeeding where an immediate retry wouldn't.
      for (let attempt = 0; attempt < 3 && !appUri; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * attempt));
        try {
          appUri = await persistToApp(await captureRef(shotRef, burnOpts), 'jpg');
        } catch (e) {
          if (attempt === 2) {
            // All three tries failed. Falling back to the raw file keeps the
            // photo — losing it entirely would be worse — but a flagged
            // photo with no visible stamp is exactly the kind of gap a field
            // survey can't afford to discover later. `stampFailed` surfaces
            // it as a small badge in Gallery/Finalize instead of only a
            // console.warn no one in the field will ever see.
            console.warn('[CameraScreen] watermark burn failed 3x, saving raw photo:', e);
            appUri = await persistToApp(photo.uri, 'jpg');
            stampFailed = true;
          }
        }
      }
      const assetId = await saveToProjectAlbum(appUri, project.name);
      const quality = await checkPhotoQuality(photo.uri);
      const photoId = addPhoto(projectId, {
        uri: appUri, assetId,
        level, space: spaceType, spaceNum, system, systems,
        flagged: flagOn, caption: '', stampFailed,
        type: 'photo', mode: 'photo', quality, nameplate: null,
      });
      setPendingUri(null);
      if (stampFailed) {
        Alert.alert(
          'Stamp didn\u2019t save',
          'This photo saved, but the watermark/flag banner failed to burn in after 3 tries. The flag is still recorded in the app \u2014 just not visible if you export or share this file directly.'
        );
      }
      maybeWarnBlurry(quality, photoId, appUri, assetId);
    } catch (e) {
      // Even the raw-photo fallback threw — most commonly the device is out
      // of storage. Never let this fail silently: the whole point of a
      // walkthrough is not discovering a gap in the record after the fact.
      console.warn('[CameraScreen] photo capture failed completely:', e);
      setPendingUri(null);
      const lowStorage = /space|storage|enospc|disk/i.test(String(e?.message || e));
      Alert.alert(
        'Photo not saved',
        lowStorage
          ? 'Your device looks like it\u2019s low on storage. Free up space and try again \u2014 this shot was not saved.'
          : 'Something went wrong saving this photo, so it was not kept. Try again \u2014 if it keeps happening, check your device storage.',
      );
    } finally {
      setBusy(false);
    }
  };

  const markFlag = () => {
    if (!recording || recStart.current == null) return;
    recFlags.current.push((Date.now() - recStart.current) / 1000);
    setFlagCount(recFlags.current.length);
  };

  // Fires whenever the native camera session becomes ready — including after
  // a mode ('picture'|'video') switch, which triggers a real reconfigure.
  const onCameraReady = () => {
    setCameraReady(true);
    if (pendingRecordRef.current) {
      pendingRecordRef.current = false;
      if (readyTimeoutRef.current) { clearTimeout(readyTimeoutRef.current); readyTimeoutRef.current = null; }
      beginRecording();
    }
  };

  const beginRecording = async () => {
    if (!cam.current) return;
    setRecording(true);
    recStart.current = Date.now();
    recFlags.current = [];
    setFlagCount(0);
    let video;
    try {
      video = await cam.current.recordAsync({ maxDuration: 600 });
    } catch (e) {
      console.warn('[CameraScreen] recordAsync failed:', e);
      setRecording(false);
      Alert.alert('Recording stopped', 'The camera stopped recording unexpectedly. Nothing was saved for this clip \u2014 try again.');
      return;
    }
    setRecording(false);
    if (!video?.uri) return;
    try {
      const appUri = await persistToApp(video.uri, 'mp4');
      const assetId = await saveToProjectAlbum(appUri, project.name);
      const flags = recFlags.current;
      const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
      const cap = flags.length
        ? `Walkthrough \u00b7 ${flags.length} flag${flags.length > 1 ? 's' : ''} @ ${flags.map(fmt).join(', ')}`
        : 'Walkthrough';
      addPhoto(projectId, {
        uri: appUri, assetId, level, space: spaceType, spaceNum, system, systems,
        type: 'video', caption: cap, flags, flagged: flags.length > 0, nameplate: null,
      });
    } catch (e) {
      // The recording itself succeeded — it's sitting in the OS temp cache
      // (video.uri) — but copying it into the app failed, most likely low
      // storage. This is a much bigger loss than a single photo (could be
      // several minutes of walkthrough), so it gets a real alert, not just
      // a console log.
      console.warn('[CameraScreen] video save failed after recording completed:', e);
      const lowStorage = /space|storage|enospc|disk/i.test(String(e?.message || e));
      Alert.alert(
        'Video not saved',
        lowStorage
          ? 'Recording finished but your device is low on storage, so it couldn\u2019t be saved to the survey. Free up space \u2014 the clip may still be recoverable from your device\u2019s temp files, but re-recording is safer.'
          : 'Recording finished but saving it to the survey failed. Check your device storage and try again.',
      );
    }
  };

  // Switch into video mode WITHOUT recording. The shutter then acts as the
  // record button.
  const enterVideoMode = () => {
    if (recording) return;
    setCameraReady(false);
    setCamMode('video');
  };

  const startVideo = async () => {
    if (!cam.current || recording) return;
    if (!micPerm?.granted) {
      const r = await requestMicPerm();
      if (!r.granted) return;
    }
    if (camMode === 'video' && cameraReady) {
      // Already switched into video mode and the native session is ready.
      beginRecording();
      return;
    }
    // Switching into 'video' mode is an async native reconfigure. Wait for
    // onCameraReady to refire before calling recordAsync — starting it too
    // early was producing a "recording" UI with no actual capture.
    pendingRecordRef.current = true;
    setCameraReady(false);
    setCamMode('video');
    readyTimeoutRef.current = setTimeout(() => {
      if (pendingRecordRef.current) {
        pendingRecordRef.current = false;
        beginRecording();
      }
    }, 900);
  };

  const stopVideo = () => {
    if (recording && cam.current) cam.current.stopRecording();
  };

  // Leave video mode back to stills.
  const backToPhoto = () => {
    if (recording) return;
    setCamMode('picture');
  };

  const onPhoto = () => snap();
  const onSelectMode = (mode) => {
    // Picking "Video" from the radial only SWITCHES MODE — it must not start
    // recording. Previously it called startVideo() directly, so choosing the
    // camera immediately began capturing with no way to compose the shot.
    if (mode === 'video') enterVideoMode();
    else if (mode === 'photo') backToPhoto();
    else if (mode === 'panels') navigation?.navigate?.('Panels', { projectId });
    else if (mode === 'decoder') navigation?.navigate?.('Decoder', { projectId, level, spaceType, spaceNum, system });
  };
  // In video mode the shutter is a record button: tap to start, tap to stop.
  const onVideoTap = () => (recording ? stopVideo() : startVideo());

  // Clamp + commit an absolute zoom factor.
  const updateZoom = (r) => {
    // zoomRange only carries real hardware limits once the patched probe has
    // resolved. Before that (and forever, on an unpatched binary) it stays at
    // the {min:1,max:1} placeholder — clamping to it would pin EVERY preset to
    // 1x, which is the second half of why the zoom buttons did nothing. Only
    // clamp to a range that was actually measured.
    const measured = zoomSupported === true && zoomRange.max > zoomRange.min;
    // A physical ultra-wide (Pixel path) extends the reachable floor below
    // the logical camera's measured min — its own intrinsic factor is the
    // true bottom of the scale.
    const uwFloor = uwInfoRef.current?.available
      ? (Math.round((uwInfoRef.current.intrinsicZoom || 0.5) * 10) / 10)
      : null;
    let lo = measured ? zoomRange.min : (ultraWide ? 0.5 : 1);
    if (uwFloor != null) lo = Math.min(lo, uwFloor);
    const hi = measured ? zoomRange.max : ASSUMED_MAX_FACTOR;
    const clamped = Math.max(lo, Math.min(hi, r));
    // Crossing 1x on the physical-ultra-wide path means switching which
    // camera is bound, not just changing a ratio. Driven here (rather than
    // only from the preset buttons) so a pinch that crosses the line also
    // switches lenses, like the stock camera app.
    if (uwFloor != null) {
      const wantUw = clamped < 0.97;
      if (wantUw !== uwCamRef.current) {
        uwCamRef.current = wantUw;
        setUwCam(wantUw);
      }
    }
    zoomRef.current = clamped;
    setZoomRatio(clamped);
  };

  const pinchGesture = Gesture.Pinch()
    .onStart(() => { pinchStartZoom.value = zoomRef.current; })
    .onUpdate((e) => {
      // Multiplicative: pinch feel is proportional to current factor.
      runOnJS(updateZoom)(pinchStartZoom.value * e.scale);
    });

  // Presets, native-camera style.
  //
  // Two entirely separate mechanisms reach the ultra-wide, per platform (see
  // the capability effect above for what's actually verified in the native
  // source):
  //   iOS:     `ultraWide` — a real physical lens, switched via selectedLens.
  //            Always offered as "0.5" once detected; the lens itself defines
  //            what its own 0-zoom field of view is.
  //   Android: `zoomRange.min` — expo-camera has NO lens-switching API here,
  //            so this only works if CameraX itself fuses the ultra-wide into
  //            one continuous zoom range AND this device's camera reports a
  //            minZoomRatio below 1. Many Android phones don't and report
  //            min:1 even with an ultra-wide lens physically present — in
  //            that case there's no button to show; expo-camera has no way to
  //            reach it, full stop, short of a custom native module.
  // When Android IS reachable, the button shows the device's actual measured
  // minimum (rounded to 1 decimal) rather than an assumed "0.5" — hardcoding
  // 0.5 would clamp to whatever the real floor is anyway, silently landing
  // short of what the label promised.
  const androidWideMin = (Platform.OS === 'android' && zoomSupported === true && zoomRange.min < 1)
    ? Math.round(zoomRange.min * 10) / 10
    : null;
  // Third route to the ultra-wide (Pixel-class): a SEPARATE physical back
  // camera with intrinsic zoom < 1, reached by rebinding to it via the
  // `ultraWide` prop rather than by a sub-1 ratio on the logical camera.
  const androidPhysicalWide = (Platform.OS === 'android' && zoomSupported === true
      && zoomRange.min >= 1 && uwInfo?.available)
    ? (Math.round((uwInfo.intrinsicZoom || 0.5) * 10) / 10)
    : null;
  const ultraWideReachable = !!ultraWide || androidWideMin !== null || androidPhysicalWide !== null;
  const wideLabel = ultraWide ? 0.5 : (androidWideMin != null ? androidWideMin : androidPhysicalWide);
  const ZOOM_PRESETS = ultraWideReachable ? [wideLabel, 1, 2, 5] : [1, 2, 5];
  const fmtZoom = (r) => (r < 1 ? String(r).replace('0.', '.') : String(r));
  const isActive = (r) => Math.abs(zoomRatio - r) < 0.05;

  // Stock fallback (iOS always, Android when this device's zoom range never
  // measured — e.g. probe still pending). expo-camera's `zoom` is a 0..1
  // fraction, NOT a multiplier, and the mapping to real factors is
  // device-specific and unknowable without the Android patch. Approximate,
  // but it moves — which the old code, that handed CameraView a zoomRatio
  // prop iOS silently ignores, did not.
  const zoomFraction = Math.max(0, Math.min(1, (zoomRatio - 1) / (ASSUMED_MAX_FACTOR - 1)));

  // Exactly one zoom prop, chosen by documented platform capability rather
  // than inferred from an ambiguous probe result (see the effect above for
  // why that inference broke iOS).
  // While bound to the physical ultra-wide, that camera's own zoom scale
  // starts at ITS 1.0 (which is the ~0.5x field of view) — passing the
  // display value (0.5) would just clamp anyway, but passing 1 explicitly
  // keeps the intent readable. `ultraWide` is only ever handed to the native
  // view on a patched binary (zoomSupported === true is the probe-proven
  // signal the patch compiled in), same rule as zoomRatio.
  const zoomProps = Platform.OS === 'android' && zoomSupported === true
    ? { zoomRatio: uwCam ? 1 : zoomRatio, ultraWide: uwCam }
    : { zoom: zoomFraction };

  const applyPreset = (r) => {
    // iOS reaches the ultra-wide by swapping the physical lens; Android (when
    // reachable at all) does it by asking for a sub-1x ratio on the same
    // logical camera — two different mechanisms, both triggered here by "is
    // this preset below 1x".
    if (ultraWide) setLensOverride(r < 1 ? ultraWide : null);
    updateZoom(r);
  };

  if (!project) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.permText}>Project not found.</Text>
        <Pressable onPress={() => navigation?.goBack?.()} style={styles.permBtn}>
          <Text style={styles.permBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  if (!camPerm?.granted) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.permText}>Camera access is needed to capture survey photos.</Text>
        <Pressable onPress={requestCamPerm} style={styles.permBtn}>
          <Text style={styles.permBtnText}>Allow Camera</Text>
        </Pressable>
      </View>
    );
  }

  const inVideo = camMode === 'video';

  return (
    <View style={styles.root}>
      <GestureDetector gesture={pinchGesture}>
        {/* Unmounted while unfocused so Decoder's CameraView can take the
            camera session and hand it back cleanly. Remount is debounced
            via camMounted (not raw isFocused) so this doesn't try to
            reacquire the session before the outgoing screen has released it. */}
        {camMounted ? (
        <CameraView
          ref={cam}
          style={StyleSheet.absoluteFill}
          facing="back"
          mode={camMode}
          {...zoomProps}
          selectedLens={lensOverride || undefined}
          enableTorch={torchOn}
          // 'off' means "autofocus continuously as needed" per expo-camera;
          // 'on' locks focus after a single pass. This was set to 'on',
          // which is why refocusing as the phone moved looked like a glitch
          // instead of a normal continuous-AF adjustment.
          autofocus="off"
          onCameraReady={onCameraReady}
        />
        ) : <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />}
      </GestureDetector>

      {/* Flag frame is rendered LAST, near the end of this tree — see note
          there. Android composites sibling views in declaration order and
          treats zIndex as only a hint, so drawing it here left the bottom and
          side bars underneath the controls. */}

      {/* Visible full-screen composite: the just-taken photo with the watermark
          burned in. Shown briefly while ViewShot captures it (a black-frame-free
          capture requires the view to actually be on screen), which also serves
          as capture feedback. */}
      {pendingUri && (
        <View style={styles.freeze} pointerEvents="none">
          <ViewShot ref={shotRef} options={{ format: 'jpg', quality: 0.92 }} style={styles.freezeShot}>
            <Image
              source={{ uri: pendingUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              onLoadEnd={() => { imageReadyResolve.current?.(); imageReadyResolve.current = null; }}
            />
            {labelsOn && (
              <View style={[styles.burnBar, { bottom: insets.bottom + 8 }]}>
                <Text style={styles.burnText} numberOfLines={2}>{stamp}</Text>
              </View>
            )}
            {pendingFlag && (
              <View style={[styles.burnFlag, { top: insets.top + 12 }]}><Text style={styles.burnFlagText}>{'\u26a0 DEFICIENCY'}</Text></View>
            )}
          </ViewShot>
        </View>
      )}

      {recording && (
        <Pressable style={styles.flagMoment} onPress={markFlag}>
          <Text style={styles.flagMomentText}>
            {`\u2691 FLAG MOMENT${flagCount > 0 ? `  \u00b7  ${flagCount}` : ''}`}
          </Text>
        </Pressable>
      )}

      {/* Recording timer — unmistakable proof capture is actually running.
          Cleared the Floor/Room toolbar row, but the row is label + pill
          (an ~11px "ROOM" caption ABOVE a 38px pill), so offsetting by the
          pill height alone still left it grazing the room name. Offset by the
          full row height instead, plus a real gap. */}
      {recording && (
        <View style={[styles.recTimer, { top: insets.top + 12 + TOOLBAR_ROW_H + 22 }]}>
          <View style={styles.recDot} />
          <Text style={styles.recTimerText}>
            {`${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`}
          </Text>
        </View>
      )}

      {/* Zoom presets, styled after the stock Android camera: one dark pill,
          the active factor a filled white disc showing "1x", the rest plain
          glyphs. Hidden entirely if the device reports no range to move in. */}
      {!recording && ZOOM_PRESETS.length > 1 && (
        <View style={[styles.zoomPill, { bottom: insets.bottom + 172 }]}>
          {ZOOM_PRESETS.map((r) => {
            const on = isActive(r);
            return (
              <Pressable
                key={r}
                onPress={() => applyPreset(r)}
                style={[styles.zoomItem, on && styles.zoomItemOn]}
                hitSlop={8}
              >
                <Text style={[styles.zoomItemText, on && styles.zoomItemTextOn]}>
                  {on ? `${fmtZoom(r)}\u00d7` : fmtZoom(r)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Toolbar: Floor / Room / Finish */}
      <Animated.View
        style={[styles.toolbar, { paddingTop: insets.top + 12 }, toolbarStyle]}
        pointerEvents={menuOpen ? 'none' : 'auto'}
      >
        <View style={styles.toolbarRow}>
          <Pill label="FLOOR" style={{ minWidth: 62 }}>
            <Pressable onPress={() => setLevelPicker(true)} hitSlop={8} style={styles.floorHit}>
              <Text style={styles.tapValue}>{level}</Text>
            </Pressable>
          </Pill>

          <Pill label="ROOM" style={{ flex: 1 }} contentStyle={styles.roomContent}>
            <Pressable onPress={decRoom} disabled={spaceNum <= 1} hitSlop={8} style={styles.roomIconHit}>
              <MinusIcon stroke={spaceNum <= 1 ? color.text30 : color.textPrimary} />
            </Pressable>
            <View style={styles.divider} />
            <Pressable style={styles.roomNameHit} onPress={() => setSpacePicker(true)} hitSlop={6}>
              <Text numberOfLines={1} style={[styles.tapValue, styles.roomName]}>{roomLabel}</Text>
            </Pressable>
            <View style={styles.divider} />
            <Pressable onPress={incRoom} hitSlop={8} style={styles.roomIconHit}>
              <PlusIcon />
            </Pressable>
          </Pill>

          <Pressable onPress={() => navigation?.navigate?.('Finalize', { projectId })} disabled={recording}>
            <LinearGradient
              colors={gradient.action}
              locations={gradient.actionStops}
              start={angle.d160.start}
              end={angle.d160.end}
              style={[styles.finishPill, recording && { opacity: 0.4 }]}
            >
              <Text style={styles.finishLabel}>Finish</Text>
            </LinearGradient>
          </Pressable>
        </View>

        {/* System tagging moved to the Finalize review screen — tagging
            mid-shot in the field is where mistakes happen; tagging during
            review after the walkthrough is where they get caught. */}
      </Animated.View>

      {libWarning && !libWarningDismissed && (
        <View style={[styles.libBanner, { top: insets.top + 78, left: 12, right: 56 }]}>
          <Text style={styles.libBannerText}>{'Photos aren\u2019t backing up to your camera roll'}</Text>
          <View style={{ flexDirection: 'row', gap: 14 }}>
            <Pressable onPress={() => Linking.openSettings()}>
              <Text style={styles.libBannerAction}>ENABLE</Text>
            </Pressable>
            <Pressable onPress={() => setLibWarningDismissed(true)}>
              <Text style={styles.libBannerDismiss}>DISMISS</Text>
            </Pressable>
          </View>
        </View>
      )}

      {!menuOpen && !recording && (
        <Text style={[styles.hint, { bottom: insets.bottom + 150 }]}>
          {'HOLD FOR MORE OPTIONS'}
        </Text>
      )}

      {/* Bottom controls: tray | SHUTTER (true centre) | torch.
          Equal-width side slots keep the shutter optically centred — it used
          to sit left of centre because four items shared the row. */}
      <View style={[styles.controls, { bottom: insets.bottom + 54 }]}>
        <View style={styles.sideSlot}>
          <Pressable
            onPress={() => navigation?.navigate?.('Gallery', { projectId })}
            style={styles.tray}
          >
            {last?.type === 'photo' ? (
              <Image source={{ uri: last.uri }} style={styles.trayImg} />
            ) : null}
          </Pressable>
        </View>

        {recording ? (
          <Pressable style={styles.stopBtn} onPress={stopVideo}>
            <View style={styles.stopInner} />
          </Pressable>
        ) : (
          <HoldShutter
            onPhoto={inVideo ? onVideoTap : onPhoto}
            onSelectMode={onSelectMode}
            onArmChange={onArmChange}
            labelsOn={labelsOn}
            options={inVideo ? VIDEO_OPTIONS : PHOTO_OPTIONS}
            variant={inVideo ? 'video' : 'photo'}
          />
        )}

        <View style={styles.sideSlot}>
          <Pressable
            onPress={() => setTorchOn((v) => !v)}
            style={[styles.tray, torchOn && styles.trayActive]}
          >
            <TorchIcon active={torchOn} />
          </Pressable>
        </View>
      </View>

      {/* Very bottom, one line: labels toggle (left) | watermark text (middle)
          | flag toggle (right). */}
      <View style={[styles.bottomBar, { bottom: Math.max(insets.bottom, 8) }]}>
        <Pressable onPress={() => setLabelsOn((v) => !v)} hitSlop={10} style={styles.bottomBtn}>
          <LabelsToggleIcon on={labelsOn} />
        </Pressable>

        <Text numberOfLines={1} style={styles.bottomStamp}>
          {labelsOn ? stamp : 'Watermark off'}
        </Text>

        <Pressable
          onPress={() => setFlagOn((v) => !v)}
          hitSlop={10}
          style={[styles.bottomBtn, flagOn && styles.bottomBtnFlagOn]}
        >
          <FlagIcon size={18} stroke={flagOn ? '#1a1200' : color.textPrimary} />
        </Pressable>
      </View>

      {/* Room / space type picker */}
      <Modal visible={spacePicker} animationType="slide" transparent>
        <View style={styles.modalScrim}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.modalTitle}>Space Type</Text>
            <FlatList
              data={project.spaceTypes}
              keyExtractor={(x) => x}
              renderItem={({ item }) => (
                <Pressable style={styles.modalRow} onPress={() => pickSpaceType(item)}>
                  <Text style={styles.modalRowText}>{item}</Text>
                </Pressable>
              )}
            />
            <View style={styles.addRow}>
              <TextInput
                value={newSpaceInput}
                onChangeText={setNewSpaceInput}
                placeholder={'Add a new space type\u2026'}
                placeholderTextColor={color.text30}
                style={styles.addInput}
                returnKeyType="done"
                onSubmitEditing={addNewSpaceType}
              />
              <Pressable onPress={addNewSpaceType} style={styles.addBtn} hitSlop={8}>
                <PlusIcon />
              </Pressable>
            </View>
            <Pressable style={styles.modalClose} onPress={() => setSpacePicker(false)}>
              <Text style={styles.modalCloseText}>CANCEL</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Floor / level picker */}
      <Modal visible={levelPicker} animationType="slide" transparent>
        <View style={styles.modalScrim}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.modalTitle}>Floor</Text>
            <FlatList
              data={levelOptions}
              keyExtractor={(x) => x}
              renderItem={({ item }) => {
                const inSurvey = (project.levels || []).includes(item);
                return (
                  <Pressable style={styles.modalRow} onPress={() => pickLevel(item)}>
                    <Text style={[styles.modalRowText, !inSurvey && { color: color.text45 }]}>
                      {item === '00' ? '00  \u00b7  Ground' : item}
                      {item === level ? '   \u2713' : ''}
                    </Text>
                  </Pressable>
                );
              }}
            />
            <View style={styles.addRow}>
              <TextInput
                value={newLevelInput}
                onChangeText={setNewLevelInput}
                placeholder={'Add a new floor\u2026 e.g. 02, B1, Roof'}
                placeholderTextColor={color.text30}
                style={styles.addInput}
                returnKeyType="done"
                onSubmitEditing={addNewLevel}
              />
              <Pressable onPress={addNewLevel} style={styles.addBtn} hitSlop={8}>
                <PlusIcon />
              </Pressable>
            </View>
            <Pressable style={styles.modalClose} onPress={() => setLevelPicker(false)}>
              <Text style={styles.modalCloseText}>CANCEL</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Flagging indicator. Previously four separate absolutely-positioned
          bars — correct in the source (last child, zIndex 90) but still
          rendered top-edge-only in the field. GalleryScreen's viewer proves a
          plain borderWidth frame paints fine on a full-bleed Image, so the
          fault wasn't "React Native can't draw a border" — it was something
          about compositing four independent siblings over a native camera
          preview layer specifically on this screen.
          An <Svg> stroked rect sidesteps the whole question: it's ONE
          rasterized paint operation, not four Views that can each succeed or
          fail to composite independently, so partial rendering isn't
          structurally possible. The rx corner radius is also the fix for the
          separate "yellow looks cut off at the rounded corners" report — a
          frame drawn to the device's sharp mathematical corner gets visually
          clipped by the physical corner curvature; rounding it to roughly
          match a modern phone's corner radius reads as intentional instead. */}
      {flagOn && winW > 0 && winH > 0 && (
        <View pointerEvents="none" style={styles.flagFrame}>
          <Svg width={winW} height={winH}>
            <Rect
              x={FLAG_BAR / 2}
              y={FLAG_BAR / 2}
              width={winW - FLAG_BAR}
              height={winH - FLAG_BAR}
              rx={34}
              ry={34}
              fill="none"
              stroke="#f2c744"
              strokeWidth={FLAG_BAR}
            />
          </Svg>
        </View>
      )}
    </View>
  );
}

function Pill({ label, children, style, contentStyle }) {
  return (
    <View style={[{ minHeight: 38 }, style]}>
      <Text style={styles.pillLabel}>{label}</Text>
      <View style={[styles.pill, contentStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#15171c' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 30 },

  permText: { ...font(500, 14, { lh: 1.4 }), color: color.textPrimary, textAlign: 'center' },
  permBtn: {
    backgroundColor: color.accent, borderRadius: radius.button,
    paddingHorizontal: 22, paddingVertical: 14,
  },
  permBtnText: { ...font(700, 14), color: color.ink },

  // Off-screen burn composite: sized like the capture but pushed out of view.
  freeze: { ...StyleSheet.absoluteFillObject, zIndex: 50, backgroundColor: '#000' },
  freezeShot: { flex: 1 },
  burnBar: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 16, paddingVertical: 12 },
  burnText: { color: '#FFF', fontSize: 13, fontWeight: '700' },
  burnFlag: { position: 'absolute', left: 16, backgroundColor: '#e5484d', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  burnFlagText: { color: '#FFF', fontWeight: '800', fontSize: 13 },

  flagMoment: {
    position: 'absolute', bottom: 210, alignSelf: 'center',
    backgroundColor: color.accent, borderRadius: 12, paddingHorizontal: 22, height: 54,
    justifyContent: 'center', elevation: 4,
  },
  flagMomentText: { ...font(700, 14), color: color.ink },

  // Four-bar flagging frame. zIndex must beat every other overlay: the
  // controls row and bottom bar sit at zIndex 65 and the rec timer at 70, and
  // they're painted over the bottom/side bars — which is why only the TOP bar
  // was visible in the field. 90 puts the frame above the lot.
  // Container for the SVG frame — zIndex kept high defensively, though an
  // <Svg> paints as one unit so it no longer depends on winning a stacking
  // fight the way four separate bars did.
  flagFrame: { ...StyleSheet.absoluteFillObject, zIndex: 90 },

  zoomPill: {
    position: 'absolute', alignSelf: 'center', flexDirection: 'row',
    alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(0,0,0,.45)', borderRadius: 26, padding: 5,
  },
  zoomItem: {
    minWidth: 42, height: 42, borderRadius: 21, paddingHorizontal: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  // Active factor: filled white disc, dark text — the stock-camera treatment.
  zoomItemOn: { backgroundColor: '#f2f0ec' },
  zoomItemText: { ...font(700, 13), color: color.textPrimary },
  zoomItemTextOn: { ...font(700, 14), color: '#0d0f11' },

  recTimer: {
    position: 'absolute', alignSelf: 'center', flexDirection: 'row',
    alignItems: 'center', gap: 8, zIndex: 70,
    backgroundColor: 'rgba(0,0,0,.65)', borderRadius: 16,
    paddingHorizontal: 12, height: 32,
  },
  recDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#e5484d' },
  recTimerText: { ...font(700, 13, { mono: true }), color: '#fff' },

  bottomBar: {
    position: 'absolute', left: 12, right: 12, zIndex: 65,
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  bottomBtn: {
    width: 38, height: 38, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,22,26,.7)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,.1)',
  },
  bottomBtnFlagOn: { backgroundColor: '#f2c744', borderColor: '#f2c744' },
  bottomStamp: {
    flex: 1, textAlign: 'center',
    ...font(500, 9, { mono: true, ls: 1 }), color: 'rgba(245,243,239,.72)',
  },

  toolbar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 8, paddingBottom: 16 },
  toolbarRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },

  pillLabel: { ...font(700, 8, { mono: true, ls: 0.5 }), color: color.text30, marginBottom: 4, textAlign: 'center' },
  pill: {
    minHeight: 38, borderRadius: radius.pill,
    backgroundColor: color.pillFill,
    borderWidth: 1, borderColor: color.cardBorderSoft,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 12,
  },
  // alignItems: 'center' (not 'stretch') so the row's children — including
  // the room-name text — center vertically against the pill instead of
  // stretching to the tallest sibling, which combined with the font's
  // metrics on Android was pushing the "Office #01" label visibly high.
  roomContent: { flexDirection: 'row', gap: 10, paddingHorizontal: 12, alignItems: 'center' },
  roomNameHit: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  roomIconHit: { justifyContent: 'center' },
  floorHit: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  divider: { width: 1, alignSelf: 'stretch', marginVertical: 8, backgroundColor: 'rgba(255,255,255,.1)' },

  tapValue: {
    ...font(600, 14, { lh: 1.2 }), color: color.textPrimary, textAlign: 'center',
    textAlignVertical: 'center', includeFontPadding: false,
    borderBottomWidth: 1.5, borderStyle: 'dashed', borderColor: color.accentTint50,
    paddingBottom: 1,
  },
  roomName: { flex: 1 },

  finishPill: {
    minHeight: 38, borderRadius: radius.pill,
    paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center',
    alignSelf: 'flex-end',
  },
  finishLabel: { ...font(700, 13), color: color.ink },

  hint: { position: 'absolute', alignSelf: 'center', ...font(500, 9, { mono: true, ls: 1.5 }), color: color.text40 },

  controls: {
    position: 'absolute', left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 20,
  },
  // Fixed, equal-width flanks so the shutter lands on the true centre line.
  sideSlot: { width: 84, alignItems: 'center', justifyContent: 'center' },
  tray: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: 'rgba(20,22,26,.7)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,.1)',
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  trayActive: { backgroundColor: color.accentTint15, borderColor: color.accent },
  trayImg: { width: '100%', height: '100%' },

  stopBtn: {
    width: 84, height: 84, borderRadius: 42,
    borderWidth: 4, borderColor: 'rgba(255,255,255,.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  stopInner: { width: 32, height: 32, borderRadius: 6, backgroundColor: '#e5484d' },

  watermark: {
    position: 'absolute', alignSelf: 'center',
    ...font(500, 9, { mono: true, ls: 1 }), color: 'rgba(245,243,239,.55)',
  },

  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#15171c', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '70%', padding: 16 },
  modalTitle: { ...font(700, 16), color: color.textPrimary, marginBottom: 8 },
  modalRow: { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: color.cardBorder },
  modalRowText: { ...font(600, 16), color: color.textPrimary },
  addRow: { flexDirection: 'row', gap: 8, paddingTop: 12, paddingBottom: 4 },
  addInput: {
    flex: 1, height: 44, borderRadius: radius.spaceCard,
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
    paddingHorizontal: 14, ...font(500, 14), color: color.textPrimary,
  },
  addBtn: {
    width: 44, height: 44, borderRadius: radius.spaceCard,
    backgroundColor: color.accentTint12, alignItems: 'center', justifyContent: 'center',
  },
  modalClose: { paddingVertical: 16, alignItems: 'center' },
  modalCloseText: { ...font(700, 12, { mono: true, ls: 1 }), color: color.text40 },
});
