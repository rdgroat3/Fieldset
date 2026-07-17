import React, { useRef, useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, Pressable, Image, Modal, FlatList, TextInput, Alert, Linking,
} from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import ViewShot, { captureRef } from 'react-native-view-shot';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import HoldShutter, { PHOTO_OPTIONS, VIDEO_OPTIONS } from '../components/HoldShutter';
import { MinusIcon, PlusIcon, LabelsToggleIcon, FlagIcon, TorchIcon } from '../components/Icons';
import { color, radius, font, gradient, angle } from '../theme/tokens';
import { SYSTEMS } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { persistToApp, saveToProjectAlbum, deleteAppFile, sweepAssets, getMediaLibraryPermissionStatus } from '../utils/media';
import { checkPhotoQuality } from '../utils/quality';

const pad2 = (n) => String(n).padStart(2, '0');

// Standard floor level presets: basement levels (B1, B2), ground through roof,
// penthouse, etc. Provides sensible defaults for the level picker when the
// surveyor hasn't custom-added levels yet.
const COMMON_LEVELS = ['B2', 'B1', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', 'P', 'RF'];

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
  // Systems are MULTI-SELECT. Most survey photos are general or cover more
  // than one discipline; forcing exactly one tag (and silently defaulting to
  // MECH) mislabels the majority of shots. Empty = GENERAL.
  // `system` is still saved as a derived STRING ('MECH+ELEC' / 'GEN') so the
  // gallery, CSV and report code keep working unchanged, while `systems`
  // carries the structured truth.
  const [systems, setSystems] = useState(
    Array.isArray(last?.systems) ? last.systems : []
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

  // Ask the OS which physical lenses exist. iOS-only in expo-camera; resolves
  // to [] on Android, which is exactly why 0.5x can't be offered there.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const lenses = await cam.current?.getAvailableLensesAsync?.();
        if (alive && Array.isArray(lenses)) {
          const uw = lenses.find((l) => /ultrawide/i.test(l));
          if (uw) setUltraWide(uw);
        }
      } catch (e) { /* iOS-only API */ }
      try {
        // Patched into expo-camera. Gives the device's real factors, e.g.
        // { min: 0.5, max: 10 } on a phone with an ultra-wide.
        const r = await cam.current?.getZoomRangeAsync?.();
        if (alive && r && Number.isFinite(r.min) && Number.isFinite(r.max)) {
          setZoomRange({ min: r.min, max: r.max });
          setZoomSupported(true);
        } else if (alive) {
          // Method missing or returned nothing => unpatched binary.
          setZoomSupported(false);
        }
      } catch (e) {
        // unpatched build - presets fall back to 1x+ and the prop stays off
        if (alive) setZoomSupported(false);
      }
    })();
    return () => { alive = false; };
  }, [isFocused]);

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

  // Toggle a discipline on/off. No selection at all is a valid, meaningful
  // state (a general shot) — it saves as 'GEN'.
  const toggleSystem = (id) =>
    setSystems((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

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
   * Take, burn watermark, persist, addPhoto - all inline, no Review screen.
   * After saving, run the blur check; if blurry, offer Keep / Retake.
   */
  const snap = async () => {
    if (busy || recording || !cam.current) return;
    setBusy(true);
    try {
      const photo = await cam.current.takePictureAsync({ quality: 0.9 });
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
      await new Promise((resolve) => {
        imageReadyResolve.current = resolve;
        setTimeout(resolve, 400); // safety net if onLoadEnd never fires
      });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      let appUri;
      try {
        appUri = await persistToApp(
          await captureRef(shotRef, { format: 'jpg', quality: 0.92 }),
          'jpg'
        );
      } catch (e1) {
        // One retry after a short beat before giving up on the burn — most
        // failures here are timing, not permanent.
        try {
          await new Promise((r) => setTimeout(r, 150));
          appUri = await persistToApp(
            await captureRef(shotRef, { format: 'jpg', quality: 0.92 }),
            'jpg'
          );
        } catch (e2) {
          console.warn('[CameraScreen] watermark burn failed twice, saving raw photo:', e2);
          appUri = await persistToApp(photo.uri, 'jpg');
        }
      }
      const assetId = await saveToProjectAlbum(appUri, project.name);
      const quality = await checkPhotoQuality(photo.uri);
      const photoId = addPhoto(projectId, {
        uri: appUri, assetId,
        level, space: spaceType, spaceNum, system, systems,
        flagged: flagOn, caption: '',
        type: 'photo', mode: 'photo', quality, nameplate: null,
      });
      setPendingUri(null);

      if (quality?.blurry) {
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
      }
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
    const clamped = Math.max(zoomRange.min, Math.min(zoomRange.max, r));
    zoomRef.current = clamped;
    setZoomRatio(clamped);
  };

  const pinchGesture = Gesture.Pinch()
    .onStart(() => { pinchStartZoom.value = zoomRef.current; })
    .onUpdate((e) => {
      // Multiplicative: pinch feel is proportional to current factor.
      runOnJS(updateZoom)(pinchStartZoom.value * e.scale);
    });

  // Presets, native-camera style. Only offer what the hardware reports it can
  // actually do — .5 appears solely when minZoomRatio really is sub-1x.
  const ZOOM_PRESETS = [0.5, 1, 2, 5].filter(
    (r) => r >= zoomRange.min - 0.001 && r <= zoomRange.max + 0.001
  );
  const fmtZoom = (r) => (r < 1 ? String(r).replace('0.', '.') : String(r));
  const isActive = (r) => Math.abs(zoomRatio - r) < 0.05;

  const applyPreset = (r) => {
    // iOS reaches the ultra-wide by swapping lens; Android does it by asking
    // for a sub-1x ratio on the logical camera.
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
            camera session and hand it back cleanly (was: black preview). */}
        {isFocused ? (
        <CameraView
          ref={cam}
          style={StyleSheet.absoluteFill}
          facing="back"
          mode={camMode}
          {...(zoomSupported ? { zoomRatio } : null)}
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

      {/* Flagging indicator. Drawn as four explicit edge bars rather than a
          borderWidth on one absolute-fill View — that only rendered along the
          top edge in the field. Bars can't be partially clipped. */}
      {flagOn && (
        <View pointerEvents="none" style={styles.flagFrame}>
          <View style={[styles.flagBar, { top: 0, left: 0, right: 0, height: FLAG_BAR }]} />
          <View style={[styles.flagBar, { bottom: 0, left: 0, right: 0, height: FLAG_BAR }]} />
          <View style={[styles.flagBar, { top: 0, bottom: 0, left: 0, width: FLAG_BAR }]} />
          <View style={[styles.flagBar, { top: 0, bottom: 0, right: 0, width: FLAG_BAR }]} />
        </View>
      )}

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

      {/* Recording timer — unmistakable proof capture is actually running. */}
      {recording && (
        <View style={[styles.recTimer, { top: insets.top + 12 }]}>
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

          <Pressable onPress={() => navigation?.navigate?.('ProjectHome', { projectId })} disabled={recording}>
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

        {/* SYSTEM is multi-select: tap any that apply, or none for a
            general shot. Most survey photos aren't single-discipline. */}
        <View style={[styles.toolbarRow, { marginTop: 6, gap: 6 }]}>
          {SYSTEMS.filter((x) => x !== 'GEN').map((id) => {
            const on = systems.includes(id);
            return (
              <Pressable
                key={id}
                onPress={() => toggleSystem(id)}
                style={[styles.sysChip, on && styles.sysChipOn]}
                hitSlop={6}
              >
                <Text style={[styles.sysChipText, on && styles.sysChipTextOn]}>{id}</Text>
              </Pressable>
            );
          })}
          {systems.length === 0 && <Text style={styles.sysGeneral}>GENERAL</Text>}
        </View>
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

  // Four-bar flagging frame (see render note).
  flagFrame: { ...StyleSheet.absoluteFillObject, zIndex: 60 },
  flagBar: { position: 'absolute', backgroundColor: '#f2c744' },

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

  sysChip: {
    height: 30, paddingHorizontal: 11, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.pillFill,
    borderWidth: 1, borderColor: color.cardBorderSoft,
  },
  sysChipOn: { backgroundColor: color.accent, borderColor: color.accent },
  sysChipText: { ...font(700, 11, { mono: true, ls: 0.4 }), color: color.text45 },
  sysChipTextOn: { color: color.ink },
  sysGeneral: { ...font(700, 10, { mono: true, ls: 0.8 }), color: color.text40, alignSelf: 'center', marginLeft: 2 },

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
