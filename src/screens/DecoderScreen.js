import React, { useRef, useState, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, Image, Modal, FlatList, Alert, ActivityIndicator, useWindowDimensions, Animated } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import ViewShot, { captureRef } from 'react-native-view-shot';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { color, font } from '../theme/tokens';
import { Btn, Field } from '../components/UI';
import { useProjects } from '../store/ProjectContext';
import { persistToApp, saveToProjectAlbum } from '../utils/media';
import { recognizeText, DEV_BUILD_MSG } from '../utils/native';
import { parseNameplateText, guessCategory } from '../data/nomenclature';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { flattenBlocks, assessCaptureQuality, buildScanDiagnostics } from '../data/nameplateSmart';
import { decodeCapacity, decodeYearFromSerial, detectBrand, detectBrandFromModel, brandInfo, ageFromYear } from '../data/hvacDecode';
import { assessCondition, classifyEquipment, refrigerantFlag, PRIORITY_META, EQUIPMENT_TYPE_OPTIONS } from '../data/serviceLife';
import { queueForDecode } from '../utils/aidecode';
import { aiDecodeEnabled } from '../config';

/**
 * Standalone/mid-walkthrough front end for the SAME nameplate pipeline used
 * elsewhere in the app — same recognizeText() wrapper, same
 * parseNameplateText() brand-aware dictionary, same photo.nameplate
 * schema, same AI-decode queue. This screen used to write into a separate
 * `project.equipment` array with its own weaker regex parser; that's gone
 * now. A "nameplate scan" is just a photo with photo.nameplate set,
 * wherever it was taken from.
 *
 * Two entry modes:
 *  - Standalone (Landing -> Decoder, no params): quick read, nothing is
 *    forced to save. Tapping Save opens a project picker.
 *  - Mid-walkthrough (CameraScreen's Decoder icon, passes projectId +
 *    current level/space/system): Save persists straight into that
 *    project with the current tags, no picker.
 */
export default function DecoderScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const { projectId, level, spaceType, spaceNum, system } = route.params || {};
  const { projects, addPhoto } = useProjects();

  const [camPerm, requestCamPerm] = useCameraPermissions();
  const cam = useRef(null);
  const shotRef = useRef(null);

  const isFocused = useIsFocused();
  const [phase, setPhase] = useState('camera'); // camera | captured
  const [photoUri, setPhotoUri] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [caption, setCaption] = useState('');
  const [np, setNp] = useState({ make: '', model: '', serial: '', capacity: '', year: '' });
  const [rawOcr, setRawOcr] = useState('');
  // ML Kit's structured blocks from the most recent scan — per-line bounding
  // boxes. Kept so the Decode button can re-parse under a new category with
  // full geometry, not just the flat text.
  const [ocrBlocks, setOcrBlocks] = useState(null);
  // Skew/tilt advisory from the most recent scan — see assessCaptureQuality
  // in nameplateSmart.js. Surfaced as a non-blocking prompt (same pattern as
  // CameraScreen's blur check) rather than blocking the scan outright: a
  // tilted photo sometimes still reads fine, and the surveyor is in the
  // best position to judge whether a retake is worth the extra thirty
  // seconds crouched under a rooftop unit.
  const [captureQuality, setCaptureQuality] = useState(null);
  const [decodeNotes, setDecodeNotes] = useState([]);
  const [lines, setLines] = useState([]);
  const [chooserFor, setChooserFor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [projectPicker, setProjectPicker] = useState(false);
  const [category, setCategory] = useState('hvac'); // hvac | waterheater | electrical | vav | backflow
  const [categoryAuto, setCategoryAuto] = useState(true); // false once the user taps a category button themselves
  const [typeOverride, setTypeOverride] = useState(null); // manual equipment-type correction
  const [typePicker, setTypePicker] = useState(false);
  // Full result of the most recent parseNameplateText call, kept separately
  // from `np` so "Decode" can (re-)apply it on demand without needing
  // another OCR pass — see runOCR/applyParsed below.
  const [lastParsed, setLastParsed] = useState(null);
  // Nameplates come in every proportion — a tall narrow VAV tag, a wide
  // squat water-heater plate, a roughly square electrical label. This used
  // to be a 3-way wide/square/tall toggle, but the frame is only a visual
  // aiming guide (capture() always saves the full, uncropped photo — see
  // below), so switching shapes never actually changed what got scanned.
  // One fixed, generously-sized rectangle that comfortably fits most plates
  // is simpler to use and one less thing to tap mid-walkthrough.

  // Tap-to-focus: shows a brief reticle at the tapped point and asks the
  // native layer for a one-shot focus+exposure pass there (see the
  // `focusAt` patch in expo-camera). Continuous AF handles most shots fine,
  // but up-close nameplate reads are exactly the case where it hunts
  // instead of settling, so a manual nudge matters here more than on the
  // regular capture screen.
  const [focusPoint, setFocusPoint] = useState(null); // { x, y } in screen px, or null when hidden
  const focusAnim = useRef(new Animated.Value(0)).current;

  // Live decode: recomputes whenever model/serial/make/category change (typed,
  // tapped from OCR, or auto-parsed). The model number gives capacity (tonnage
  // for HVAC, gallons for water heaters), the serial gives mfg year — each with
  // a confidence level. Category matters: the same brand can encode differently
  // across equipment types (e.g. Rheem HVAC vs Rheem water heater).
  const live = useMemo(() => {
    // Brand resolution order matters: text the surveyor typed or tapped wins,
    // then brand read off the nameplate text, and only then a guess from the
    // model nomenclature. The model fallback is last because a wrong brand
    // selects the wrong serial rules — a confidently wrong year is worse than
    // no year at all.
    const brand = np.make
      || detectBrand(`${np.model} ${np.serial}`, category)
      || detectBrandFromModel(np.model, category)
      || null;
    // VAV/backflow capacity (inlet size, heater kW, pipe size+type) isn't
    // decoded from the model number at all — decodeCapacity correctly
    // returns null for these categories (see hvacDecode.js). The real value
    // is whatever parseNameplateText already read straight off the plate
    // into np.capacity, so wrap that as a display-only "capacity" here
    // rather than showing a false "enter model #" prompt for a field this
    // category never uses.
    const capacity = (category === 'vav' || category === 'backflow')
      ? (np.capacity ? { kind: 'text', label: np.capacity, code: null, confidence: 'medium' } : null)
      : decodeCapacity(np.model, category, brand);
    let yearInfo = decodeYearFromSerial(np.serial, brand, category);
    // Same reasoning for year: VAV/backflow plates print the date directly
    // rather than encoding it in a serial (see literalDateField in
    // nomenclature.js), so decodeYearFromSerial legitimately has nothing to
    // decode from the serial field and returns noRule/null. If np.year
    // already holds a value — read straight off the plate — show that
    // instead of telling the surveyor to go re-read a plate they already
    // read.
    if ((!yearInfo || yearInfo.noRule || !yearInfo.year) && np.year) {
      yearInfo = { year: parseInt(np.year, 10) || null, confidence: 'high', note: 'read directly from plate', ambiguous: false };
    }
    const age = yearInfo?.year ? ageFromYear(yearInfo.year) : null;
    const info = brand ? brandInfo(brand, category) : null;
    // Condition assessment — the wedge. Decoded year + equipment type -> RUL.
    // Type is auto-classified from OCR text (strongest), model prefix, then
    // category. `typeOverride` lets the user correct a rare miss.
    const auto = classifyEquipment({ text: rawOcr, make: np.make, model: np.model, capacity: np.capacity, category });
    const typeId = typeOverride || auto.typeId;
    const condition = yearInfo?.year ? assessCondition(yearInfo.year, typeId) : null;
    const refrigerant = refrigerantFlag(`${np.model} ${np.capacity} ${rawOcr}`, yearInfo?.year);
    return { brand, capacity, yearInfo, age, condition, refrigerant, auto, typeId, info };
  }, [np.model, np.serial, np.make, np.capacity, category, rawOcr, typeOverride]);

  const reset = () => {
    setPhotoUri(null);
    setCaption('');
    setNp({ make: '', model: '', serial: '', capacity: '', year: '' });
    setRawOcr('');
    setOcrBlocks(null);
    setDecodeNotes([]);
    setLines([]);
    setPhase('camera');
    setTypeOverride(null);
  };

  const [capturing, setCapturing] = useState(false);

  const capture = async () => {
    if (!cam.current || capturing) return;
    setCapturing(true);
    try {
      // Explicit focus-and-settle pass before the shot. Continuous AF often
      // hasn't converged yet at the moment the shutter is tapped — especially
      // right after repositioning the phone for a close-up nameplate read —
      // and a picture taken mid-focus-hunt comes out soft no matter how good
      // the OCR is downstream. (0.5, 0.35) aims at roughly the frame's
      // center, not the whole screen's, since the plate is what needs to be
      // sharp. Trading ~450ms of shutter lag for an actually-sharp photo.
      try {
        await cam.current.focusAtAsync?.(0.5, 0.35);
      } catch {
        // focusAtAsync is only wired up on Android builds carrying the
        // expo-camera patch; harmless no-op everywhere else.
      }
      await new Promise((resolve) => setTimeout(resolve, 450));
      const photo = await cam.current.takePictureAsync({ quality: 0.9 });
      setPhotoUri(photo.uri);
      setPhase('captured');
      // Auto-decode: pressing the shutter in Decoder mode IS the decode request.
      // Pass the uri explicitly — setPhotoUri hasn't flushed yet, so reading it
      // back off state here would scan null. `auto` suppresses the
      // low-confidence Alert: on this path the surveyor didn't ask a question,
      // so a modal they have to dismiss on every miss is a nag. The empty
      // fields already say it, and the manual re-scan button still speaks up.
      runOCR(photo.uri, { auto: true });
    } finally {
      setCapturing(false);
    }
  };

  const runOCR = async (uri = photoUri, { auto = false } = {}) => {
    if (!uri) return;
    setScanning(true);
    try {
      const r = await recognizeText(uri);
      if (!r.ok) {
        Alert.alert(r.reason === 'dev-build' ? 'OCR needs the dev build' : 'OCR failed',
          r.reason === 'dev-build' ? DEV_BUILD_MSG : r.reason);
        return;
      }
      // Auto-pick the equipment category from the plate text itself — VAV,
      // water heater, electrical gear, and backflow assemblies usually name
      // themselves somewhere on the label. Only overrides the category if
      // the user hasn't manually chosen one themselves; a deliberate tap on
      // a category button should stick even if a later re-scan's guess
      // disagrees; `categoryAuto` tracks that.
      const guessedCat = guessCategory(r.text);
      const effectiveCat = categoryAuto && guessedCat ? guessedCat : category;
      if (categoryAuto && guessedCat && guessedCat !== category) setCategory(guessedCat);

      const parsed = parseNameplateText(r.text, effectiveCat, r.blocks);
      setRawOcr(r.text);
      setOcrBlocks(r.blocks || null);
      // Geometry-ordered lines (top-to-bottom, left-to-right) read far more
      // naturally in the chooser than ML Kit's raw block order, which
      // interleaves table columns.
      const geomLines = r.blocks?.length ? flattenBlocks(r.blocks).map((l) => l.text) : null;
      setLines(geomLines?.length ? geomLines : r.text.split(/\n+/).map((l) => l.trim()).filter(Boolean));
      setDecodeNotes(parsed.decodeNotes);
      setLastParsed(parsed);

      // Skew check: a plate photographed at a steep angle defeats field
      // assignment no matter how good the parsing logic is downstream — the
      // fix there is a retake, not a smarter regex. Only worth bothering the
      // surveyor about when the scan ALSO came back thin, so a plate that's
      // tilted but still read fine doesn't get second-guessed.
      const quality = r.blocks?.length ? assessCaptureQuality({ blocks: r.blocks }) : null;
      setCaptureQuality(quality);
      const sparse = !parsed.make && !parsed.model && !parsed.serial;

      // OCR itself is never destructive: this only ever FILLS BLANK fields,
      // same as the very first scan. Re-running OCR after repositioning the
      // shot used to silently overwrite whatever the surveyor had already
      // typed or corrected the moment it found ANY new value — that was the
      // actual "re-scan deletes what I typed" bug. Fixing that meant
      // splitting the single old button into two clearly separate actions:
      // this one (safe, automatic, no prompt) and the explicit "Decode"
      // button below (applies the scan on purpose, confirming first if it
      // would change something already filled in).
      applyParsed(parsed, { force: false });

      if (sparse && quality?.skewed) {
        Alert.alert(
          'Photo looks tilted',
          (quality.note || 'The plate looks tilted in this photo, which can throw off field detection.') +
            ' Keep this scan, or retake?',
          [
            { text: 'Keep', style: 'cancel' },
            { text: 'Retake', style: 'destructive', onPress: () => { setPhotoUri(null); setPhase('camera'); } },
          ]
        );
      } else if (!auto && sparse) {
        Alert.alert('Low-confidence scan', 'Text was read but no labeled fields found \u2014 check the raw values and fill in manually, or use "Insert from scan" on each field.');
      }
    } finally {
      setScanning(false);
    }
  };

  /**
   * Applies a parsed OCR result to the np fields.
   *
   * force=false (used by Re-Scan): only fills fields that are CURRENTLY
   * EMPTY. Never touches a field the surveyor already has a value in,
   * whether that value came from typing or an earlier scan — this is what
   * makes Re-Scan safe to tap at any time.
   *
   * force=true (used by Decode): applies every parsed value it has,
   * overwriting existing ones. Called directly from a Decode tap; a
   * confirmation for any field that would actually CHANGE happens in
   * decodeNow() before this runs, so by the time force=true fires here the
   * user has already agreed to it.
   */
  const applyParsed = (parsed, { force }) => {
    if (!parsed) return;
    setNp((prev) => ({
      make: force ? (parsed.make || prev.make) : (prev.make || parsed.make),
      model: force ? (parsed.model || prev.model) : (prev.model || parsed.model),
      serial: force ? (parsed.serial || prev.serial) : (prev.serial || parsed.serial),
      capacity: force ? (parsed.capacity || prev.capacity) : (prev.capacity || parsed.capacity),
      year: force ? (parsed.year || prev.year) : (prev.year || parsed.year),
    }));
  };

  /**
   * The "Decode" button. Re-applies the MOST RECENT scan's parsed values —
   * no new OCR pass, no new photo needed — which matters when the surveyor
   * just changed the category (say, from HVAC to Water Heater) and wants
   * the fields re-read under the new category's rules. Confirms once,
   * naming exactly which fields would change, if anything currently filled
   * in disagrees with what the scan says; applies immediately if nothing
   * would actually change.
   */
  const decodeNow = () => {
    if (!lastParsed) {
      Alert.alert('Nothing to decode yet', 'Scan the nameplate first (tap the shutter or Re-Scan).');
      return;
    }
    // Re-parse under the CURRENT category in case it changed since the
    // last scan — capacity decode rules differ per category (tons vs
    // gallons vs inlet size), so a stale parse would show the wrong kind.
    const parsed = parseNameplateText(rawOcr, category, ocrBlocks);
    setLastParsed(parsed);
    const changed = FIELDS
      .map((f) => f.key)
      .filter((k) => parsed[k] && np[k] && parsed[k] !== np[k])
      .map((k) => FIELDS.find((f) => f.key === k).label);
    if (changed.length === 0) {
      applyParsed(parsed, { force: true });
      return;
    }
    Alert.alert(
      'Overwrite entered values?',
      `The scan disagrees with what's currently in: ${changed.join(', ')}. Decode will replace ${changed.length > 1 ? 'them' : 'it'} with the scanned values.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Overwrite', style: 'destructive', onPress: () => applyParsed(parsed, { force: true }) },
      ]
    );
  };

  const setField = (key, value) => setNp((f) => ({ ...f, [key]: value }));

  /**
   * Exports the exact raw OCR result from the most recent scan — text,
   * every line's frame, and (crucially) whatever ML Kit actually returned
   * for cornerPoints, whether that's populated or empty. This whole
   * decoder's geometry engine depends on cornerPoints being real on-device
   * data, which can't be confirmed from a dev sandbox — only from an
   * actual scan on an actual phone. When a field lands wrong, this is the
   * one file that turns "it didn't work" into something fixable: real
   * ground truth instead of a description of the symptom.
   */
  const sendScanDiagnostics = async () => {
    if (!ocrBlocks?.length) {
      Alert.alert('Nothing to send', 'Scan a nameplate first.');
      return;
    }
    try {
      const json = buildScanDiagnostics({ text: rawOcr, blocks: ocrBlocks }, {
        category, make: np.make, model: np.model,
      });
      const path = FileSystem.cacheDirectory + `nameplate-scan-diagnostics-${Date.now()}.json`;
      await FileSystem.writeAsStringAsync(path, json);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'application/json', UTI: 'public.json' });
      } else {
        Alert.alert('Scan data saved', path);
      }
    } catch (e) {
      Alert.alert('Could not export scan data', String(e));
    }
  };

  /**
   * Same diagnostics JSON as sendScanDiagnostics (raw OCR text, block
   * geometry, cornerPoints) — but framed as a save, not a send. Opens the
   * OS share sheet, which includes "Save to Files" / Drive / device
   * storage as options, so a scan can be dropped onto the phone right now
   * and batched up for sending all at once later, instead of going
   * through a share/email flow after every single scan.
   */
  const saveScanDiagnostics = async () => {
    if (!ocrBlocks?.length) {
      Alert.alert('Nothing to save', 'Scan a nameplate first.');
      return;
    }
    try {
      const json = buildScanDiagnostics({ text: rawOcr, blocks: ocrBlocks }, {
        category, make: np.make, model: np.model,
      });
      const path = FileSystem.cacheDirectory + `nameplate-scan-diagnostics-${Date.now()}.json`;
      await FileSystem.writeAsStringAsync(path, json);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, { mimeType: 'application/json', UTI: 'public.json' });
      } else {
        Alert.alert('Scan data saved', path);
      }
    } catch (e) {
      Alert.alert('Could not save scan data', String(e));
    }
  };

  const stampFor = (targetProject) => {
    if (level && spaceType) {
      const spaceLabel = `${spaceType} #${String(spaceNum || 1).padStart(2, '0')}`;
      return `${targetProject.name} | LVL: ${level} | SPACE: ${spaceLabel} | SYS: ${system || 'MECH'}`;
    }
    return `${targetProject.name} | Nameplate Scan | ${new Date().toLocaleDateString()}`;
  };

  const saveToProject = async (targetId) => {
    const targetProject = projects.find((p) => p.id === targetId);
    if (!targetProject || saving) return;
    setSaving(true);
    try {
      const burned = await captureRef(shotRef, { format: 'jpg', quality: 0.92, result: 'tmpfile' });
      const appUri = await persistToApp(burned, 'jpg');
      const assetId = await saveToProjectAlbum(appUri, targetProject.name);
      const photoId = addPhoto(targetId, {
        uri: appUri,
        assetId,
        level: level || targetProject.levels?.[0] || '01',
        space: spaceType || 'Nameplate Scan',
        spaceNum: spaceNum || 1,
        system: system || 'MECH',
        flagged: false,
        caption: caption.trim(),
        type: 'photo',
        mode: 'nameplate',
        quality: null,
        nameplate: { ...np, rawOcr, category, equipmentType: live.typeId },
      });
      if (aiDecodeEnabled() && rawOcr && (!np.make || !np.capacity || !np.year)) {
        await queueForDecode(targetId, photoId, rawOcr);
      }
      setProjectPicker(false);
      Alert.alert('Saved', 'Nameplate saved to the project.', [
        { text: 'View Equipment', onPress: () => navigation?.navigate?.('Equipment', { projectId: targetId }) },
        { text: 'Done', onPress: () => navigation?.goBack?.() },
      ]);
    } catch (e) {
      // A nameplate scan represents real OCR/decode work — don't let it
      // vanish silently if the save fails (most commonly low storage).
      console.warn('[DecoderScreen] saveToProject failed:', e);
      const lowStorage = /space|storage|enospc|disk/i.test(String(e?.message || e));
      Alert.alert(
        'Not saved',
        lowStorage
          ? 'Your device looks like it\u2019s low on storage, so this scan couldn\u2019t be saved. Free up space and try again.'
          : 'Something went wrong saving this scan. Try again \u2014 if it keeps happening, check your device storage.',
      );
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => {
    if (projectId) {
      saveToProject(projectId);
    } else if (projects.length === 0) {
      Alert.alert('No surveys yet', 'Start a walkthrough first, or discard this scan.');
    } else {
      setProjectPicker(true);
    }
  };

  if (!camPerm?.granted) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.permText}>Camera access is needed to scan nameplates.</Text>
        <Btn label="ALLOW CAMERA" onPress={requestCamPerm} />
      </View>
    );
  }

  if (phase === 'camera') {
    // Tall rectangle, sized generously — most of what actually gets scanned
    // (VAV tags, breaker/panel labels, compressor data plates) reads
    // portrait, and the frame is only ever a visual aiming guide anyway
    // (capture() always saves the full, uncropped photo). Clamped against
    // winH so it can't run off the bottom of a shorter phone screen.
    const geom = {
      w: winW * 0.7,
      h: Math.min(winW * 0.7 * 1.6, winH * 0.58),
    };

    const handleFocusTap = (evt) => {
      const { locationX, locationY } = evt.nativeEvent;
      // Native side wants normalized (0..1) coordinates relative to the
      // CameraView, which fills the whole screen here.
      cam.current?.focusAtAsync?.(locationX / winW, locationY / winH);
      setFocusPoint({ x: locationX, y: locationY });
      focusAnim.setValue(1);
      Animated.sequence([
        Animated.delay(450),
        Animated.timing(focusAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
      ]).start(({ finished }) => { if (finished) setFocusPoint(null); });
    };

    return (
      <View style={styles.root}>
        {/* Only one CameraView may hold the camera session. Unmounting while
            unfocused lets the capture screen reacquire it on goBack() instead
            of coming back to a black preview. */}
        {isFocused ? (
          <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" zoom={0}
            // Explicit rather than relying on expo-camera's default: 'off'
            // here means CONTINUOUS autofocus (confusingly), 'on' means
            // one-shot-then-lock. Written out so it doesn't silently change
            // behavior on an expo-camera upgrade.
            autofocus="off"
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
        )}
        {/* Tap-to-focus: continuous AF handles most shots, but up-close
            nameplate reads are exactly the case where it hunts instead of
            settling, so a manual nudge helps here more than it would on the
            general capture screen. Sits above the CameraView but below the
            frame/buttons in touch priority only in the sense that it's
            declared first — later siblings (shutter, close) still win on
            their own hit areas. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={handleFocusTap} />
        <View pointerEvents="none" style={[styles.frame, {
          top: insets.top + 84, width: geom.w, height: geom.h,
          left: (winW - geom.w) / 2,
        }]}>
          <Text style={styles.frameHint}>FILL FRAME WITH NAMEPLATE</Text>
        </View>
        {focusPoint && (
          <Animated.View
            pointerEvents="none"
            style={[styles.focusReticle, {
              left: focusPoint.x - 34, top: focusPoint.y - 34,
              opacity: focusAnim,
              transform: [{ scale: focusAnim.interpolate({ inputRange: [0, 1], outputRange: [1.15, 1] }) }],
            }]}
          />
        )}
        <View style={[styles.shutterRow, { paddingBottom: insets.bottom + 40 }]}>
          <Pressable onPress={capture} disabled={capturing} style={[styles.shutterOuter, capturing && { opacity: 0.45 }]}>
            <View style={styles.shutterInner} />
          </Pressable>
        </View>
        <Pressable onPress={() => navigation?.goBack?.()} style={[styles.closeBtn, { top: insets.top + 8 }]}>
          <Text style={styles.closeBtnText}>{'\u2715'}</Text>
        </Pressable>
      </View>
    );
  }

  // phase === 'captured'
  const stampPreview = projectId
    ? stampFor(projects.find((p) => p.id === projectId) || { name: '' })
    : null;

  return (
    <View style={{ flex: 1, backgroundColor: '#15171c' }}>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <FlatList
          contentContainerStyle={{ padding: 16, paddingBottom: 30 }}
          ListHeaderComponent={
            <>
              <ViewShot ref={shotRef} options={{ format: 'jpg', quality: 0.92 }}>
                <Image source={{ uri: photoUri }} style={styles.photo} resizeMode="cover" />
                {stampPreview && (
                  <View style={styles.burnBar}>
                    <Text style={styles.burnText} numberOfLines={2}>{stampPreview}</Text>
                  </View>
                )}
              </ViewShot>

              {/* Two separate, honestly-labeled actions, where there used to
                  be one that quietly did both:
                  RE-SCAN reads the photo again and only fills fields that
                  are still blank — always safe, never overwrites anything
                  you've typed or corrected.
                  DECODE (re-)applies the last scan's parsed values to the
                  fields on purpose, and asks first if that would actually
                  change something already filled in. That confirm is what's
                  missing before: the old single button applied on every tap
                  with no warning, which is what silently wiped out manual
                  corrections. */}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 4 }}>
                <Pressable style={[styles.ocrBtn, { flex: 1, marginTop: 0 }]} onPress={() => runOCR()} disabled={scanning}>
                  <Text style={styles.ocrBtnText}>
                    {scanning ? 'READING\u2026' : '\ud83d\udd0e RE-SCAN'}
                  </Text>
                  {scanning && <ActivityIndicator color="#04121F" style={{ marginLeft: 8 }} />}
                </Pressable>
                <Pressable
                  style={[styles.ocrBtn, styles.decodeBtn, { flex: 1, marginTop: 0 }]}
                  onPress={decodeNow}
                  disabled={scanning}
                >
                  <Text style={[styles.ocrBtnText, styles.decodeBtnText]}>{'\u2699 DECODE'}</Text>
                </Pressable>
              </View>
              <Text style={styles.ocrHint}>Re-Scan only fills blank fields. Decode re-applies the scan on purpose \u2014 it'll ask first if that would change something you've entered.</Text>

              {decodeNotes.map((n, i) => (
                <Text key={i} style={styles.decodeNote}>{'\u25c8 ' + n}</Text>
              ))}

              {/* Unit type — controls which decode rules apply. The same brand
                  can encode date/capacity differently across equipment types.
                  Auto-picked from the scan (see runOCR); tapping one here is
                  a deliberate override that sticks through later re-scans. */}
              <View style={styles.catRow}>
                {[['hvac', 'HVAC / AC'], ['waterheater', 'Water Htr'], ['electrical', 'Electrical'],
                  ['vav', 'VAV / Fan'], ['backflow', 'Backflow']].map(([id, lbl]) => (
                  <Pressable key={id} onPress={() => { setCategory(id); setCategoryAuto(false); }}
                    style={[styles.catBtn, category === id && styles.catBtnOn]}>
                    <Text style={[styles.catBtnText, category === id && styles.catBtnTextOn]}>{lbl}</Text>
                  </Pressable>
                ))}
              </View>
              {categoryAuto && rawOcr ? (
                <Text style={styles.autoTag}>{'\u26a1 Auto-detected from scan \u2014 tap to override'}</Text>
              ) : null}

              {/* Live decode result — the core of the tool. Recomputes as the
                  model/serial fields change. Shows capacity + mfg year/age with
                  confidence-based coloring. */}
              {(live.capacity || live.yearInfo) && (
                <View style={styles.liveCard}>
                  <Text style={styles.liveTitle}>{'\u2699 DECODED' + (live.brand ? '  \u00b7  ' + live.brand.toUpperCase() : '')}</Text>
                  <View style={styles.liveRow}>
                    <View style={styles.liveCell}>
                      <Text style={styles.liveLabel}>
                        {category === 'waterheater' ? 'CAPACITY'
                          : category === 'electrical' ? 'RATING'
                          : category === 'vav' ? 'INLET / HEATER'
                          : category === 'backflow' ? 'SIZE / TYPE'
                          : 'TONNAGE'}
                      </Text>
                      {live.capacity ? (
                        <>
                          <Text style={styles.liveValue}>{live.capacity.label.split(' (')[0]}</Text>
                          {live.capacity.code ? (
                            <Text style={styles.liveSub}>{`code ${live.capacity.code}`}</Text>
                          ) : (
                            <Text style={styles.liveSub}>read from plate</Text>
                          )}
                          <ConfidenceTag level={live.capacity.confidence} />
                        </>
                      ) : (
                        <Text style={styles.liveNone}>
                          {category === 'vav' || category === 'backflow' ? 'enter size / rating' : 'enter model #'}
                        </Text>
                      )}
                    </View>
                    <View style={styles.liveDivider} />
                    <View style={styles.liveCell}>
                      <Text style={styles.liveLabel}>MFG YEAR</Text>
                      {live.yearInfo?.noRule ? (
                        // Brand is known but has no verified public serial
                        // scheme. Say that plainly — "read the plate" costs ten
                        // seconds; a fabricated year corrupts the assessment.
                        <>
                          <Text style={styles.liveNone}>read the plate</Text>
                          <ConfidenceTag level="none" />
                        </>
                      ) : live.yearInfo ? (
                        <>
                          <Text style={styles.liveValue}>{live.yearInfo.year}</Text>
                          <Text style={styles.liveSub}>
                            {live.age != null ? `${live.age} yr${live.age === 1 ? '' : 's'} old` : ''}{live.yearInfo.note ? ` · ${live.yearInfo.note}` : ''}
                          </Text>
                          <ConfidenceTag level={live.yearInfo.confidence} />
                        </>
                      ) : (
                        <Text style={styles.liveNone}>enter serial #</Text>
                      )}
                    </View>
                  </View>

                  {/* Ambiguity is a finding, not a failure. Some schemes (York's
                      pre-2004 21-year letter cycle) genuinely cannot resolve to
                      one year from the serial alone. Show the surveyor the fork
                      so they can settle it at the unit, rather than flipping a
                      coin behind their back. */}
                  {live.yearInfo?.ambiguous && (
                    <View style={styles.altBanner}>
                      <Text style={styles.altText}>
                        {'\u26a0 Ambiguous serial \u2014 could also read: '}
                        {[...new Set([
                          ...(live.yearInfo.altYears || []),
                          ...(live.yearInfo.alternates || []).map((a) => a.year),
                        ])].filter((y) => y && y !== live.yearInfo.year).join(', ') || 'another year'}
                        {'. Confirm against the unit.'}
                      </Text>
                    </View>
                  )}

                  {live.yearInfo?.plateNote && (
                    <Text style={styles.decodeNote}>{'\u25c8 ' + live.yearInfo.plateNote}</Text>
                  )}

                  {/* Hazard brands (Federal Pacific / Stab-Lok, Zinsco,
                      Challenger) are flagged on identity alone — the failure
                      mode is breakers that don't trip, which no amount of
                      remaining service life makes safe. */}
                  {live.info?.hazard && (
                    <View style={styles.hazBanner}>
                      <Text style={styles.hazText}>{'\u26a0 ' + live.info.hazard}</Text>
                    </View>
                  )}

                  {live.condition && (
                    <View style={[styles.condBanner, { borderColor: PRIORITY_META[live.condition.priority].color }]}>
                      <View style={[styles.condPill, { backgroundColor: PRIORITY_META[live.condition.priority].color }]}>
                        <Text style={styles.condPillText}>{PRIORITY_META[live.condition.priority].label}</Text>
                      </View>
                      <Text style={styles.condText}>{live.condition.summary}</Text>
                    </View>
                  )}
                  {live.condition && (
                    <Pressable onPress={() => setTypePicker(true)}>
                      <Text style={styles.condType}>
                        {`Type: ${live.condition.typeLabel} · median ${live.condition.median} yr`}
                        {live.auto ? ` · auto (${live.auto.basis})` : ''}
                        {'  ✎ change'}
                      </Text>
                    </Pressable>
                  )}
                  {live.refrigerant && (
                    <Text style={[styles.refrigText, { color: PRIORITY_META[live.refrigerant.level === 'high' ? 'replace' : live.refrigerant.level === 'medium' ? 'plan' : 'monitor'].color }]}>
                      {`\u2744 ${live.refrigerant.code} — ${live.refrigerant.note}`}
                    </Text>
                  )}
                </View>
              )}

              {rawOcr ? (
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.npHint}>{'Decoded values are estimates \u2014 confirm each field before saving.'}</Text>
                  <View style={{ flexDirection: 'row', gap: 16 }}>
                    <Pressable onPress={saveScanDiagnostics} hitSlop={8}>
                      <Text style={styles.insertLink}>Save scan data</Text>
                    </Pressable>
                    <Pressable onPress={sendScanDiagnostics} hitSlop={8}>
                      <Text style={styles.insertLink}>Send scan data</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Text style={styles.npHint}>Scan to auto-fill, or type the model & serial to decode.</Text>
              )}

              <Field label="Caption / observation" value={caption} onChangeText={setCaption}
                placeholder="e.g. Rooftop unit serving Suite 220" />
            </>
          }
          data={FIELDS}
          keyExtractor={(f) => f.key}
          renderItem={({ item }) => (
            <View>
              <View style={styles.fieldHead}>
                <Text style={styles.fieldHeadLabel}>{item.label}</Text>
                {lines.length > 0 && (
                  <Pressable onPress={() => setChooserFor(item.key)} hitSlop={8}>
                    <Text style={styles.insertLink}>Insert from scan</Text>
                  </Pressable>
                )}
              </View>
              <Field
                label=""
                value={np[item.key]}
                onChangeText={(v) => setField(item.key, v)}
                placeholder={item.placeholder}
                keyboardType={item.keyboardType}
                autoCapitalize={item.autoCapitalize}
              />
            </View>
          )}
          ListFooterComponent={
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
              <Btn label="RETAKE" kind="ghost" onPress={reset} style={{ flex: 1 }} />
              <Btn
                label={saving ? 'SAVING\u2026' : (projectId ? 'SAVE TO SURVEY' : 'SAVE\u2026')}
                onPress={onSave}
                style={{ flex: 2 }}
              />
            </View>
          }
        />
      </View>

      {/* Line chooser: pick which detected value fills the active field.
          Best guesses first — the smart extractor's ranked candidates for
          THIS field (with the reason each one is plausible), then every
          scanned line in reading order as the catch-all. One tap either way. */}
      <Modal visible={!!chooserFor} animationType="slide" transparent>
        <View style={styles.modalScrim}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.modalTitle}>
              {'Insert into ' + (FIELDS.find((f) => f.key === chooserFor)?.label || '')}
            </Text>
            <FlatList
              data={(() => {
                const sugg = (lastParsed?.candidates?.[chooserFor] || []).map((c) => ({
                  kind: 'sugg', value: c.value, why: c.why?.[0] || null,
                }));
                const suggKeys = new Set(sugg.map((s) => s.value.toUpperCase().replace(/\s+/g, '')));
                const rest = lines
                  .filter((l) => !suggKeys.has(l.toUpperCase().replace(/\s+/g, '')))
                  .map((l) => ({ kind: 'line', value: l }));
                const items = [];
                if (sugg.length) items.push({ kind: 'hdr', value: 'BEST GUESSES' }, ...sugg);
                if (rest.length) items.push({ kind: 'hdr', value: sugg.length ? 'ALL SCANNED LINES' : 'SCANNED LINES' }, ...rest);
                return items;
              })()}
              keyExtractor={(it, i) => `${i}-${it.kind}-${it.value}`}
              renderItem={({ item }) => {
                if (item.kind === 'hdr') {
                  return <Text style={styles.chooserHdr}>{item.value}</Text>;
                }
                return (
                  <Pressable
                    style={styles.modalRow}
                    onPress={() => { setField(chooserFor, item.value); setChooserFor(null); }}
                  >
                    <Text style={[styles.modalRowText, item.kind === 'sugg' && { color: color.accent }]}>
                      {item.value}
                    </Text>
                    {item.kind === 'sugg' && item.why ? (
                      <Text style={styles.modalRowSub}>{item.why}</Text>
                    ) : null}
                  </Pressable>
                );
              }}
            />
            <Pressable style={styles.modalClose} onPress={() => setChooserFor(null)}>
              <Text style={styles.modalCloseText}>CANCEL</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Equipment-type correction — auto-classified by default, tap to change */}
      <Modal visible={typePicker} animationType="slide" transparent>
        <View style={styles.modalScrim}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.modalTitle}>Equipment Type</Text>
            <Text style={styles.modalHint}>Auto-selected from the nameplate. Change it if it's wrong — this sets the ASHRAE service life used for the condition assessment.</Text>
            <FlatList
              data={EQUIPMENT_TYPE_OPTIONS}
              keyExtractor={(t) => t.id}
              renderItem={({ item }) => {
                const activeId = live.typeId;
                return (
                  <Pressable style={styles.modalRow} onPress={() => { setTypeOverride(item.id); setTypePicker(false); }}>
                    <Text style={[styles.modalRowText, item.id === activeId && { color: color.accent }]}>{item.label}</Text>
                    <Text style={styles.modalRowSub}>{`median ${item.years} yr`}</Text>
                  </Pressable>
                );
              }}
            />
            <Pressable style={styles.modalClose} onPress={() => { setTypeOverride(null); setTypePicker(false); }}>
              <Text style={styles.modalCloseText}>RESET TO AUTO</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Project picker \u2014 standalone scans only */}
      <Modal visible={projectPicker} animationType="slide" transparent>
        <View style={styles.modalScrim}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.modalTitle}>Save to which survey?</Text>
            <FlatList
              data={projects}
              keyExtractor={(p) => p.id}
              renderItem={({ item }) => (
                <Pressable style={styles.modalRow} onPress={() => saveToProject(item.id)}>
                  <Text style={styles.modalRowText}>{item.name}</Text>
                </Pressable>
              )}
            />
            <Pressable style={styles.modalClose} onPress={() => setProjectPicker(false)}>
              <Text style={styles.modalCloseText}>CANCEL</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ConfidenceTag({ level }) {
  const map = {
    high: { bg: 'rgba(63,185,80,.16)', fg: '#3fb950', text: 'HIGH CONFIDENCE' },
    medium: { bg: 'rgba(210,153,34,.16)', fg: '#d29922', text: 'MEDIUM \u00b7 VERIFY' },
    low: { bg: 'rgba(229,72,77,.16)', fg: '#e5484d', text: 'LOW \u00b7 CONFIRM' },
    // "none" is not a weak guess — it means we have no verified rule for this
    // brand and are declining to invent one. Rendering it as LOW would imply a
    // reading exists and is merely shaky, which is a different (and false)
    // claim. Neutral gray, not alarm red.
    none: { bg: 'rgba(139,148,158,.16)', fg: '#8b949e', text: 'NO RULE \u00b7 READ PLATE' },
  };
  // Unknown levels fall back to `low` rather than crashing, but `none` and the
  // three real levels are all explicit above.
  const c = map[level] || map.low;
  return (
    <View style={[styles.confTag, { backgroundColor: c.bg }]}>
      <Text style={[styles.confTagText, { color: c.fg }]}>{c.text}</Text>
    </View>
  );
}

const FIELDS = [
  { key: 'make', label: 'Make', placeholder: 'Carrier / Trane / Square D\u2026' },
  { key: 'model', label: 'Model', placeholder: '48TCED12', autoCapitalize: 'characters' },
  { key: 'serial', label: 'Serial', autoCapitalize: 'characters' },
  { key: 'capacity', label: 'Capacity / Rating', placeholder: '10 Tons \u00b7 460V/3\u00d8 \u00b7 225A\u2026' },
  { key: 'year', label: 'Mfg Year', keyboardType: 'number-pad' },
];

const styles = StyleSheet.create({
  catRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  catBtn: {
    width: '31.5%', height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
  },
  catBtnOn: { borderColor: color.accent, backgroundColor: 'rgba(91,141,239,.12)' },
  catBtnText: { ...font(700, 10, { mono: true, ls: 0.8 }), color: color.text45, textTransform: 'uppercase' },
  catBtnTextOn: { color: color.accent },
  autoTag: { ...font(600, 11), color: color.accent, marginBottom: 10 },

  liveCard: {
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.accent,
    borderRadius: 12, padding: 14, marginTop: 4, marginBottom: 10,
  },
  liveTitle: { ...font(700, 11, { mono: true, ls: 1.2 }), color: color.accent, textTransform: 'uppercase', marginBottom: 10 },
  condBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: color.cardBorder, borderWidth: 0 },
  condPill: { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3 },
  condPillText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  condText: { flex: 1, color: color.textPrimary, fontSize: 12, lineHeight: 16 },
  condType: { color: color.text45, fontSize: 10, marginTop: 6 },
  refrigText: { fontSize: 11, marginTop: 6, fontWeight: '600' },
  liveRow: { flexDirection: 'row', alignItems: 'stretch' },
  liveCell: { flex: 1, alignItems: 'center' },
  liveDivider: { width: 1, backgroundColor: color.cardBorder, marginHorizontal: 8 },
  liveLabel: { ...font(700, 10, { mono: true, ls: 1.2 }), color: color.text45, textTransform: 'uppercase', marginBottom: 4 },
  liveValue: { color: color.textPrimary, fontSize: 22, fontWeight: '800' },
  liveSub: { color: color.text45, fontSize: 10, textAlign: 'center', marginTop: 2 },
  liveNone: { color: color.text45, fontSize: 13, fontStyle: 'italic', marginTop: 6 },
  confTag: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2, marginTop: 6 },
  confTagText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },

  root: { flex: 1, backgroundColor: '#15171c' },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 30 },
  permText: { color: color.textPrimary, textAlign: 'center', fontSize: 15 },

  // Geometry (width/height/left) is computed once and passed inline; this
  // only carries the shared visual styling.
  frame: {
    position: 'absolute',
    borderWidth: 2, borderColor: color.accent, borderRadius: 12, alignItems: 'center',
  },
  // Tap-to-focus reticle: a short-lived ring at the tapped point, faded in
  // via focusAnim and cleared once the fade-out finishes (see handleFocusTap).
  focusReticle: {
    position: 'absolute', width: 68, height: 68, borderRadius: 34,
    borderWidth: 1.5, borderColor: color.accent,
  },
  // Sits ABOVE the frame instead of straddling the top border — the old
  // marginTop:-12 dropped the label right on top of the line.
  frameHint: {
    position: 'absolute', top: -24,
    ...font(700, 11, { mono: true, ls: 1.2 }), color: color.accent, textTransform: 'uppercase',
    backgroundColor: 'rgba(0,0,0,.6)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
  },
  closeBtn: {
    position: 'absolute', right: 12, width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(20,22,26,.7)', alignItems: 'center', justifyContent: 'center',
  },
  closeBtnText: { color: '#fff', fontSize: 16 },
  shutterRow: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
  shutterOuter: {
    width: 74, height: 74, borderRadius: 37, borderWidth: 4, borderColor: 'rgba(255,255,255,.9)',
    alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#f2f0ec' },

  photo: { width: '100%', height: 260, borderRadius: 12, backgroundColor: '#000' },
  burnBar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 10, paddingVertical: 7 },
  burnText: { color: '#FFF', fontSize: 11, fontWeight: '700' },

  ocrBtn: {
    flexDirection: 'row', backgroundColor: color.accent, borderRadius: 10, minHeight: 46,
    alignItems: 'center', justifyContent: 'center', marginTop: 12, marginBottom: 8,
  },
  ocrBtnText: { ...font(700, 13), color: '#04121F' },
  decodeBtn: { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.accent },
  decodeBtnText: { color: color.accent },
  ocrHint: { color: color.text45, fontSize: 10, lineHeight: 14, marginBottom: 10 },
  decodeNote: { color: '#3fb950', fontSize: 11, marginBottom: 4 },
  altBanner: {
    marginTop: 10, padding: 8, borderRadius: 8,
    backgroundColor: 'rgba(210,153,34,.10)', borderWidth: 1, borderColor: 'rgba(210,153,34,.45)',
  },
  altText: { ...font(600, 11), color: '#d29922', lineHeight: 15 },
  hazBanner: {
    marginTop: 10, padding: 8, borderRadius: 8,
    backgroundColor: 'rgba(229,72,77,.12)', borderWidth: 1, borderColor: 'rgba(229,72,77,.5)',
  },
  hazText: { ...font(700, 11), color: '#e5484d', lineHeight: 15 },
  npHint: { color: color.text45, fontSize: 11, marginBottom: 14 },

  fieldHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  fieldHeadLabel: { ...font(700, 11, { mono: true, ls: 1.2 }), color: color.text45, textTransform: 'uppercase' },
  insertLink: { color: color.accent, fontSize: 11, fontWeight: '700' },

  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: color.cardFill, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '70%', padding: 16 },
  modalTitle: { ...font(700, 16), color: color.textPrimary, marginBottom: 8 },
  modalRow: { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: color.cardBorder },
  modalRowText: { color: color.textPrimary, fontSize: 15, fontWeight: '600' },
  modalRowSub: { color: color.text45, fontSize: 11, marginTop: 2 },
  chooserHdr: {
    ...font(700, 10, { mono: true, ls: 1.2 }), color: color.text45,
    textTransform: 'uppercase', marginTop: 12, marginBottom: 2,
  },
  modalHint: { color: color.text45, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  modalClose: { paddingVertical: 16, alignItems: 'center' },
  modalCloseText: { ...font(700, 11, { mono: true, ls: 1.2 }), color: color.text45, textTransform: 'uppercase' },
});
