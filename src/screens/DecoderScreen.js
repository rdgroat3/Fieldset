import React, { useRef, useState, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, Image, Modal, FlatList, Alert, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import ViewShot, { captureRef } from 'react-native-view-shot';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { color, font } from '../theme/tokens';
import { Btn, Field } from '../components/UI';
import { useProjects } from '../store/ProjectContext';
import { persistToApp, saveToProjectAlbum } from '../utils/media';
import { recognizeText, DEV_BUILD_MSG } from '../utils/native';
import { parseNameplateText } from '../data/nomenclature';
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
  const [decodeNotes, setDecodeNotes] = useState([]);
  const [lines, setLines] = useState([]);
  const [chooserFor, setChooserFor] = useState(null);
  const [saving, setSaving] = useState(false);
  const [projectPicker, setProjectPicker] = useState(false);
  const [category, setCategory] = useState('hvac'); // hvac | waterheater | electrical
  const [typeOverride, setTypeOverride] = useState(null); // manual equipment-type correction
  const [typePicker, setTypePicker] = useState(false);

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
    const capacity = decodeCapacity(np.model, category, brand);
    const yearInfo = decodeYearFromSerial(np.serial, brand, category);
    const age = yearInfo ? ageFromYear(yearInfo.year) : null;
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
    setDecodeNotes([]);
    setLines([]);
    setPhase('camera');
    setTypeOverride(null);
  };

  const capture = async () => {
    if (!cam.current) return;
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
      const parsed = parseNameplateText(r.text, category);
      setRawOcr(r.text);
      setLines(r.text.split(/\n+/).map((l) => l.trim()).filter(Boolean));
      setNp((prev) => ({
        make: parsed.make || prev.make,
        model: parsed.model || prev.model,
        serial: parsed.serial || prev.serial,
        capacity: parsed.capacity || prev.capacity,
        year: parsed.year || prev.year,
      }));
      setDecodeNotes(parsed.decodeNotes);
      if (!auto && !parsed.make && !parsed.model && !parsed.serial) {
        Alert.alert('Low-confidence scan', 'Text was read but no labeled fields found \u2014 check the raw values and fill in manually.');
      }
    } finally {
      setScanning(false);
    }
  };

  const setField = (key, value) => setNp((f) => ({ ...f, [key]: value }));

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
    return (
      <View style={styles.root}>
        {/* Only one CameraView may hold the camera session. Unmounting while
            unfocused lets the capture screen reacquire it on goBack() instead
            of coming back to a black preview. */}
        {isFocused ? (
          <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" zoom={0} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
        )}
        <View pointerEvents="none" style={[styles.frame, { top: insets.top + 84 }]}>
          <Text style={styles.frameHint}>FILL FRAME WITH NAMEPLATE</Text>
        </View>
        <View style={[styles.shutterRow, { paddingBottom: insets.bottom + 40 }]}>
          <Pressable onPress={capture} style={styles.shutterOuter}>
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

              {/* Manual re-scan. The shutter already auto-decodes; this is for
                  a second attempt after repositioning or wiping the plate.
                  Must be wrapped — a bare `onPress={runOCR}` would hand the
                  press event to the uri parameter. */}
              <Pressable style={styles.ocrBtn} onPress={() => runOCR()} disabled={scanning}>
                <Text style={styles.ocrBtnText}>
                  {scanning ? 'READING TAG\u2026' : '\ud83d\udd0e RE-SCAN TEXT (OCR) + DECODE'}
                </Text>
                {scanning && <ActivityIndicator color="#04121F" style={{ marginLeft: 8 }} />}
              </Pressable>

              {decodeNotes.map((n, i) => (
                <Text key={i} style={styles.decodeNote}>{'\u25c8 ' + n}</Text>
              ))}

              {/* Unit type — controls which decode rules apply. The same brand
                  can encode date/capacity differently across equipment types. */}
              <View style={styles.catRow}>
                {[['hvac', 'HVAC / AC'], ['waterheater', 'Water Heater'], ['electrical', 'Electrical']].map(([id, lbl]) => (
                  <Pressable key={id} onPress={() => setCategory(id)}
                    style={[styles.catBtn, category === id && styles.catBtnOn]}>
                    <Text style={[styles.catBtnText, category === id && styles.catBtnTextOn]}>{lbl}</Text>
                  </Pressable>
                ))}
              </View>

              {/* Live decode result — the core of the tool. Recomputes as the
                  model/serial fields change. Shows capacity + mfg year/age with
                  confidence-based coloring. */}
              {(live.capacity || live.yearInfo) && (
                <View style={styles.liveCard}>
                  <Text style={styles.liveTitle}>{'\u2699 DECODED' + (live.brand ? '  \u00b7  ' + live.brand.toUpperCase() : '')}</Text>
                  <View style={styles.liveRow}>
                    <View style={styles.liveCell}>
                      <Text style={styles.liveLabel}>{category === 'waterheater' ? 'CAPACITY' : category === 'electrical' ? 'RATING' : 'TONNAGE'}</Text>
                      {live.capacity ? (
                        <>
                          <Text style={styles.liveValue}>{live.capacity.label.split(' (')[0]}</Text>
                          <Text style={styles.liveSub}>{`code ${live.capacity.code}`}</Text>
                          <ConfidenceTag level={live.capacity.confidence} />
                        </>
                      ) : (
                        <Text style={styles.liveNone}>enter model #</Text>
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
                <Text style={styles.npHint}>{'Decoded values are estimates \u2014 confirm each field before saving.'}</Text>
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

      {/* Line chooser: pick which detected line fills the active field.
          A correction aid on top of parseNameplateText's auto-fill \u2014
          useful when a brand isn't in the dictionary or OCR is noisy. */}
      <Modal visible={!!chooserFor} animationType="slide" transparent>
        <View style={styles.modalScrim}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.modalTitle}>
              {'Insert into ' + (FIELDS.find((f) => f.key === chooserFor)?.label || '')}
            </Text>
            <FlatList
              data={lines}
              keyExtractor={(l, i) => `${i}-${l}`}
              renderItem={({ item }) => (
                <Pressable style={styles.modalRow} onPress={() => { setField(chooserFor, item); setChooserFor(null); }}>
                  <Text style={styles.modalRowText}>{item}</Text>
                </Pressable>
              )}
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
  catRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  catBtn: {
    flex: 1, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
  },
  catBtnOn: { borderColor: color.accent, backgroundColor: 'rgba(91,141,239,.12)' },
  catBtnText: { ...font(700, 11, { mono: true, ls: 1.2 }), color: color.text45, textTransform: 'uppercase' },
  catBtnTextOn: { color: color.accent },

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

  // Wider + taller: most nameplates are broad plates, and the old 80%x30%
  // box forced the user to stand too far back to fill it.
  frame: {
    position: 'absolute', left: '5%', right: '5%', height: '42%',
    borderWidth: 2, borderColor: color.accent, borderRadius: 12, alignItems: 'center',
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
  modalHint: { color: color.text45, fontSize: 12, lineHeight: 17, marginBottom: 10 },
  modalClose: { paddingVertical: 16, alignItems: 'center' },
  modalCloseText: { ...font(700, 11, { mono: true, ls: 1.2 }), color: color.text45, textTransform: 'uppercase' },
});
