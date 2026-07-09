import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, useWindowDimensions, Image, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ViewShot, { captureRef } from 'react-native-view-shot';
import { C, FONT } from '../theme';
import { Btn, Field } from '../components/UI';
import { useProjects } from '../store/ProjectContext';
import { checkPhotoQuality } from '../utils/quality';
import { persistToApp, saveToProjectAlbum } from '../utils/media';
import { recognizeText, startDictation, stopDictation, DEV_BUILD_MSG } from '../utils/native';
import { parseNameplateText } from '../data/nomenclature';
import { queueForDecode } from '../utils/aidecode';
import { aiDecodeEnabled } from '../config';

const pad2 = (n) => String(n).padStart(2, '0');

export default function ReviewScreen({ route, navigation }) {
  const { projectId, tempUri, tags, stamp } = route.params;
  const { projects, addPhoto, settings } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { width } = useWindowDimensions();

  const shotRef = useRef(null);
  const [quality, setQuality] = useState(null); // null = checking
  const [caption, setCaption] = useState('');
  const [np, setNp] = useState({ make: '', model: '', serial: '', capacity: '', year: '' });
  const [imgRatio, setImgRatio] = useState(4 / 3);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [decodeNotes, setDecodeNotes] = useState([]);
  const [listening, setListening] = useState(false);
  const [rawOcr, setRawOcr] = useState('');

  const isNameplate = tags.mode === 'nameplate';

  const runOCR = async () => {
    setScanning(true);
    try {
      const r = await recognizeText(tempUri);
      if (!r.ok) {
        Alert.alert(r.reason === 'dev-build' ? 'OCR needs the dev build' : 'OCR failed',
          r.reason === 'dev-build' ? DEV_BUILD_MSG : r.reason);
        return;
      }
      const parsed = parseNameplateText(r.text);
      setRawOcr(r.text);
      setNp((prev) => ({
        make: parsed.make || prev.make,
        model: parsed.model || prev.model,
        serial: parsed.serial || prev.serial,
        capacity: parsed.capacity || prev.capacity,
        year: parsed.year || prev.year,
      }));
      setDecodeNotes(parsed.decodeNotes);
      if (!parsed.make && !parsed.model && !parsed.serial) {
        Alert.alert('Low-confidence scan', 'Text was read but no labeled fields found — check the raw values and fill in manually.');
      }
    } finally {
      setScanning(false);
    }
  };

  const toggleDictation = () => {
    if (listening) { stopDictation(); setListening(false); return; }
    setListening(true);
    startDictation({
      onResult: (text) => setCaption(text),
      onEnd: () => setListening(false),
      onError: (err) => {
        setListening(false);
        if (err === 'dev-build') Alert.alert('Voice needs the dev build', DEV_BUILD_MSG);
      },
    });
  };

  useEffect(() => {
    Image.getSize(tempUri, (w, h) => setImgRatio(w / h), () => {});
    checkPhotoQuality(tempUri, { nameplate: isNameplate }).then(setQuality);
  }, [tempUri]);

  const fullStamp = `${stamp} | ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${settings.firmName ? '  ·  ' + settings.firmName : ''}`;

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Burn the watermark: capture the image+banner composite view.
      const burned = await captureRef(shotRef, { format: 'jpg', quality: 0.92, result: 'tmpfile' });
      const appUri = await persistToApp(burned, 'jpg');
      const assetId = await saveToProjectAlbum(appUri, project.name);
      const photoId = addPhoto(projectId, {
        uri: appUri,
        assetId,
        level: tags.level,
        space: tags.space,
        spaceNum: tags.spaceNum,
        system: tags.system,
        flagged: tags.flagged,
        caption: caption.trim(),
        type: 'photo',
        mode: tags.mode,
        quality,
        nameplate: isNameplate ? { ...np, rawOcr } : null,
      });
      // If the local dictionary couldn't fully decode, queue for AI decode
      // (drains automatically when the phone is back online).
      if (isNameplate && aiDecodeEnabled() && rawOcr && (!np.make || !np.capacity || !np.year)) {
        await queueForDecode(projectId, photoId, rawOcr);
      }
      navigation.goBack();
    } finally {
      setSaving(false);
    }
  };

  const imgW = width - 32;
  const imgH = imgW / imgRatio;

  const verdict = quality === null
    ? { color: C.inkDim, text: 'CHECKING SHARPNESS…' }
    : quality.blurry
      ? { color: C.red, text: isNameplate ? '✕ TOO BLURRY TO READ — RETAKE' : '✕ BLURRY — RETAKE RECOMMENDED' }
      : quality.dark
        ? { color: C.amber, text: '◐ TOO DARK — TRY TORCH MODE' }
        : { color: C.green, text: '✓ SHARP & USABLE' };

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 30 }}>
          {/* Verdict banner */}
          <View style={[s.verdict, { borderColor: verdict.color }]}>
            <Text style={[s.verdictText, { color: verdict.color }]}>{verdict.text}</Text>
          </View>

          {/* The composite that gets burned to disk */}
          <ViewShot ref={shotRef} options={{ format: 'jpg', quality: 0.92 }} style={{ width: imgW, height: imgH }}>
            <Image source={{ uri: tempUri }} style={{ width: imgW, height: imgH }} resizeMode="cover" />
            <View style={s.burnBar}>
              <Text style={s.burnText} numberOfLines={2}>{fullStamp}</Text>
            </View>
            {tags.flagged && (
              <View style={s.burnFlag}><Text style={s.burnFlagText}>⚠ DEFICIENCY</Text></View>
            )}
          </ViewShot>

          <Text style={s.tagLine}>
            L{tags.level} · {tags.space} #{pad2(tags.spaceNum)} · {tags.system}{tags.flagged ? ' · ⚠ FLAGGED' : ''}
          </Text>

          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field label="Caption / observation" value={caption} onChangeText={setCaption}
                placeholder="e.g. Corroded condensate pan, recommend replacement" />
            </View>
            <TouchableOpacity
              style={[s.mic, listening && { backgroundColor: C.red, borderColor: C.red }]}
              onPress={toggleDictation}
            >
              <Text style={{ fontSize: 20 }}>{listening ? '⏺' : '🎙️'}</Text>
            </TouchableOpacity>
          </View>
          {listening && <Text style={s.listening}>Listening… tap again to stop</Text>}

          {isNameplate && (
            <View style={s.npBox}>
              <Text style={s.npTitle}>NAMEPLATE DATA</Text>
              <TouchableOpacity style={s.ocrBtn} onPress={runOCR} disabled={scanning}>
                <Text style={s.ocrBtnText}>{scanning ? 'READING TAG…' : '🔎 SCAN TEXT (OCR) + DECODE'}</Text>
              </TouchableOpacity>
              {decodeNotes.map((n, i) => (
                <Text key={i} style={s.decodeNote}>◈ {n}</Text>
              ))}
              <Text style={s.npHint}>Decoded values are estimates — confirm each field before saving.</Text>
              <Field label="Make" value={np.make} onChangeText={(v) => setNp({ ...np, make: v })} placeholder="Carrier / Trane / Square D…" />
              <Field label="Model" value={np.model} onChangeText={(v) => setNp({ ...np, model: v })} placeholder="48TCED12" autoCapitalize="characters" />
              <Field label="Serial" value={np.serial} onChangeText={(v) => setNp({ ...np, serial: v })} autoCapitalize="characters" />
              <Field label="Capacity / Rating" value={np.capacity} onChangeText={(v) => setNp({ ...np, capacity: v })} placeholder="10 Tons · 460V/3Ø · 225A…" />
              <Field label="Mfg Year" value={np.year} onChangeText={(v) => setNp({ ...np, year: v })} keyboardType="number-pad" />
            </View>
          )}

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
            <Btn label="RETAKE" kind="ghost" onPress={() => navigation.goBack()} style={{ flex: 1 }} />
            <Btn label={saving ? 'SAVING…' : 'SAVE PHOTO'} onPress={save} style={{ flex: 2 }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  verdict: { borderWidth: 1.5, borderRadius: 10, padding: 12, marginBottom: 12, alignItems: 'center', backgroundColor: C.panel },
  verdictText: { ...FONT.display, fontSize: 14 },
  burnBar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 8, paddingVertical: 6 },
  burnText: { color: '#FFF', fontSize: 11, fontWeight: '700' },
  burnFlag: { position: 'absolute', top: 8, left: 8, backgroundColor: C.red, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  burnFlagText: { color: '#FFF', fontWeight: '800', fontSize: 11 },
  tagLine: { color: C.inkDim, fontSize: 12, fontWeight: '700', marginTop: 8, marginBottom: 14 },
  npBox: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.blue, borderRadius: 12, padding: 14, marginBottom: 12 },
  npTitle: { ...FONT.label, color: C.blue, marginBottom: 8 },
  npHint: { color: C.inkDim, fontSize: 11, marginBottom: 12 },
  mic: { width: 52, height: 52, borderRadius: 10, backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  listening: { color: C.red, fontSize: 11, fontWeight: '700', marginTop: -8, marginBottom: 10 },
  ocrBtn: { backgroundColor: C.blue, borderRadius: 10, minHeight: 46, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  ocrBtnText: { ...FONT.display, color: '#04121F', fontSize: 13 },
  decodeNote: { color: C.green, fontSize: 11, marginBottom: 4 },
});
