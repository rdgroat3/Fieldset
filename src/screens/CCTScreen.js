// EXPERIMENTAL — Color Temperature (CCT) Estimator.
// Aim the target box at a WHITE surface (sheet of paper) lit by the fixture,
// tap ESTIMATE. We average the center pixels and run McCamy's chromaticity
// formula. Best use is COMPARATIVE (matching existing fixtures): auto white
// balance partially neutralizes the cast, so absolute accuracy is limited —
// keep some non-white surroundings in frame to reduce AWB cancellation.

import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import { Buffer } from 'buffer';
import { C, FONT } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { rgbToCCT, nearestCCTBin, cctDescription } from '../utils/photometry';

export default function CCTScreen({ route }) {
  const { projectId } = route.params;
  const { addMeasurement } = useProjects();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {cct, bin, rgb}

  if (!perm?.granted) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.center}>
          <Text style={s.permText}>Camera access is needed to sample light color.</Text>
          <TouchableOpacity style={s.permBtn} onPress={requestPerm}>
            <Text style={s.permBtnText}>ALLOW CAMERA</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const estimate = async () => {
    if (busy || !cam.current) return;
    setBusy(true);
    try {
      const photo = await cam.current.takePictureAsync({ quality: 0.6 });
      const small = await ImageManipulator.manipulateAsync(
        photo.uri, [{ resize: { width: 120 } }],
        { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true }
      );
      const raw = jpeg.decode(Buffer.from(small.base64, 'base64'), { useTArray: true });
      const { width: w, height: h, data } = raw;

      // Average the center 34% box (matches the on-screen target)
      const x0 = Math.floor(w * 0.33), x1 = Math.ceil(w * 0.67);
      const y0 = Math.floor(h * 0.33), y1 = Math.ceil(h * 0.67);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 4;
        r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
      }
      r /= n; g /= n; b /= n;

      const mean = (r + g + b) / 3;
      if (mean < 30) { Alert.alert('Too dark', 'Not enough light on the target to estimate color.'); return; }
      if (mean > 250) { Alert.alert('Blown out', 'Target is overexposed — back off or angle away from the fixture.'); return; }

      const cct = rgbToCCT(r, g, b);
      if (!cct) { Alert.alert('Could not estimate', 'Chromaticity out of range — make sure the target box is on a white surface.'); return; }
      setResult({ cct, bin: nearestCCTBin(cct), rgb: [Math.round(r), Math.round(g), Math.round(b)] });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!result) return;
    addMeasurement(projectId, {
      kind: 'cct',
      label: `≈ ${result.bin}K nominal (raw ${result.cct}K)`,
      detail: cctDescription(result.cct),
    });
    Alert.alert('Saved', 'Color temperature added to survey measurements.');
  };

  return (
    <View style={s.root}>
      <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" />
      <SafeAreaView style={s.overlay} edges={['top', 'bottom']}>
        <View style={s.banner}>
          <Text style={s.bannerText}>⚠ EXPERIMENTAL — rough estimate; auto white balance limits absolute accuracy. Best for matching fixtures, not photometric documentation.</Text>
        </View>

        <View style={s.targetWrap} pointerEvents="none">
          <View style={s.target}>
            <Text style={s.targetText}>AIM AT WHITE SURFACE UNDER THE FIXTURE</Text>
          </View>
        </View>

        <View>
          {result && (
            <View style={s.readout}>
              <Text style={s.big}>≈ {result.bin}K</Text>
              <Text style={s.sub}>raw estimate {result.cct}K · {cctDescription(result.cct)}</Text>
              <View style={s.swatchRow}>
                {[2700, 3000, 3500, 4000, 5000, 6500].map((k) => (
                  <View key={k} style={[s.bin, result.bin === k && s.binOn]}>
                    <Text style={[s.binText, result.bin === k && { color: C.amberInk }]}>{k / 100}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
          <View style={s.btnRow}>
            <TouchableOpacity style={[s.btn, { backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge }]} onPress={estimate} disabled={busy}>
              <Text style={[s.btnText, { color: C.ink }]}>{busy ? 'ANALYZING…' : 'ESTIMATE'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.btn, { backgroundColor: C.amber, opacity: result ? 1 : 0.4 }]} onPress={save} disabled={!result}>
              <Text style={s.btnText}>SAVE</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  permText: { color: C.ink, textAlign: 'center', fontSize: 15, marginBottom: 18 },
  permBtn: { backgroundColor: C.amber, borderRadius: 10, paddingHorizontal: 22, paddingVertical: 14 },
  permBtnText: { ...FONT.display, color: C.amberInk },
  overlay: { flex: 1, padding: 12, justifyContent: 'space-between' },
  banner: { backgroundColor: 'rgba(255,176,32,0.92)', borderRadius: 8, padding: 8 },
  bannerText: { color: C.amberInk, fontSize: 10.5, fontWeight: '800', textAlign: 'center' },
  targetWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  target: { width: '52%', aspectRatio: 1, borderWidth: 2.5, borderColor: C.amber, borderRadius: 14, alignItems: 'center', justifyContent: 'flex-start' },
  targetText: { ...FONT.label, color: C.amber, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 8, paddingVertical: 3, fontSize: 8.5, marginTop: -10 },
  readout: { backgroundColor: 'rgba(13,17,23,0.9)', borderRadius: 14, padding: 16, alignItems: 'center', marginBottom: 10 },
  big: { ...FONT.display, color: C.amber, fontSize: 44 },
  sub: { color: C.inkDim, fontSize: 12, marginTop: 4, textAlign: 'center' },
  swatchRow: { flexDirection: 'row', gap: 6, marginTop: 12 },
  bin: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge },
  binOn: { backgroundColor: C.amber, borderColor: C.amber },
  binText: { color: C.ink, fontWeight: '800', fontSize: 12 },
  btnRow: { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, height: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  btnText: { ...FONT.display, color: C.amberInk, fontSize: 14 },
});
