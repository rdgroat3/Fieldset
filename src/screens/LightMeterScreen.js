// EXPERIMENTAL — Footcandle Meter.
// Android: reads the hardware ambient light sensor live (works in Expo Go).
// iOS: no public light sensor, so we estimate from camera exposure EXIF —
// tap SAMPLE with the phone facing the work plane.
// Disclaimer everywhere: ±20% class estimate, not a calibrated instrument.

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { C, FONT } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { exifToLux, luxToFc, FC_TARGETS } from '../utils/photometry';

let LightSensor = null;
try { LightSensor = require('expo-sensors').LightSensor; } catch (e) { LightSensor = null; }

export default function LightMeterScreen({ route }) {
  const { projectId } = route.params;
  const { addMeasurement } = useProjects();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef(null);

  const [liveLux, setLiveLux] = useState(null);      // Android stream
  const [samples, setSamples] = useState([]);        // fc values
  const [sensorMode, setSensorMode] = useState(false);
  const [busy, setBusy] = useState(false);

  // Android hardware sensor path
  useEffect(() => {
    let sub = null;
    (async () => {
      if (Platform.OS === 'android' && LightSensor) {
        try {
          const ok = await LightSensor.isAvailableAsync();
          if (ok) {
            setSensorMode(true);
            LightSensor.setUpdateInterval(250);
            sub = LightSensor.addListener(({ illuminance }) => setLiveLux(illuminance));
          }
        } catch (e) {}
      }
    })();
    return () => sub?.remove();
  }, []);

  const takeSample = async () => {
    if (sensorMode) {
      if (liveLux == null) return;
      setSamples((s) => [...s, luxToFc(liveLux)]);
      return;
    }
    // iOS / no-sensor path: EXIF estimate
    if (!perm?.granted) { requestPerm(); return; }
    if (!cam.current || busy) return;
    setBusy(true);
    try {
      const photo = await cam.current.takePictureAsync({ quality: 0.2, exif: true });
      const lux = exifToLux(photo.exif || {});
      if (lux == null) { Alert.alert('No exposure data', 'This device did not return EXIF exposure values.'); return; }
      setSamples((s) => [...s, luxToFc(lux)]);
    } finally {
      setBusy(false);
    }
  };

  const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
  const currentFc = sensorMode && liveLux != null ? luxToFc(liveLux) : avg;

  const nearestTarget = currentFc != null
    ? FC_TARGETS.reduce((best, t) => (Math.abs(t[1] - currentFc) < Math.abs(best[1] - currentFc) ? t : best), FC_TARGETS[0])
    : null;

  const save = () => {
    if (avg == null && currentFc == null) return;
    const fc = avg ?? currentFc;
    addMeasurement(projectId, {
      kind: 'light',
      label: `${fc.toFixed(0)} fc (${(fc * 10.7639).toFixed(0)} lux)`,
      detail: `${samples.length || 1} sample(s) · ${sensorMode ? 'ambient sensor' : 'camera EXIF estimate'}`,
    });
    Alert.alert('Saved', 'Light level added to survey measurements.');
    setSamples([]);
  };

  return (
    <View style={s.root}>
      {!sensorMode && perm?.granted && (
        <CameraView ref={cam} style={StyleSheet.absoluteFill} facing="back" />
      )}
      <SafeAreaView style={s.overlay} edges={['top', 'bottom']}>
        <View style={s.banner}>
          <Text style={s.bannerText}>⚠ EXPERIMENTAL — ±20% class estimate, not a calibrated light meter. Verify compliance readings with an instrument.</Text>
        </View>

        <View style={s.readout}>
          <Text style={s.big}>{currentFc != null ? currentFc.toFixed(currentFc < 10 ? 1 : 0) : '——'}</Text>
          <Text style={s.unit}>FOOTCANDLES{currentFc != null ? `  ·  ${(currentFc * 10.7639).toFixed(0)} lux` : ''}</Text>
          <Text style={s.mode}>
            {sensorMode ? 'LIVE — hardware ambient light sensor' : perm?.granted ? 'Aim at the work plane, tap SAMPLE (camera EXIF estimate)' : 'Camera permission needed for iOS estimation'}
          </Text>
          {samples.length > 0 && (
            <Text style={s.avg}>Session: {samples.length} samples · avg {avg.toFixed(0)} fc</Text>
          )}
          {nearestTarget && (
            <Text style={s.target}>≈ {nearestTarget[0]} target ({nearestTarget[1]} fc)</Text>
          )}
        </View>

        <ScrollView style={s.targets} contentContainerStyle={{ paddingBottom: 8 }}>
          {FC_TARGETS.map(([name, fc]) => (
            <View key={name} style={s.targetRow}>
              <Text style={s.targetName}>{name}</Text>
              <Text style={[s.targetVal, currentFc != null && currentFc >= fc && { color: C.green }]}>{fc} fc</Text>
            </View>
          ))}
        </ScrollView>

        <View style={s.btnRow}>
          <TouchableOpacity style={[s.btn, { backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge }]} onPress={takeSample} disabled={busy}>
            <Text style={[s.btnText, { color: C.ink }]}>{busy ? 'SAMPLING…' : sensorMode ? 'MARK SAMPLE' : 'SAMPLE'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, { backgroundColor: C.amber, opacity: currentFc == null ? 0.4 : 1 }]} onPress={save} disabled={currentFc == null}>
            <Text style={s.btnText}>SAVE READING</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  overlay: { flex: 1, padding: 12, justifyContent: 'space-between' },
  banner: { backgroundColor: 'rgba(255,176,32,0.92)', borderRadius: 8, padding: 8 },
  bannerText: { color: C.amberInk, fontSize: 10.5, fontWeight: '800', textAlign: 'center' },
  readout: { backgroundColor: 'rgba(13,17,23,0.9)', borderRadius: 14, padding: 18, alignItems: 'center', marginTop: 10 },
  big: { ...FONT.display, color: C.amber, fontSize: 64 },
  unit: { ...FONT.label, color: C.ink, marginTop: 2 },
  mode: { color: C.inkDim, fontSize: 11, marginTop: 8, textAlign: 'center' },
  avg: { color: C.green, fontSize: 12, fontWeight: '700', marginTop: 6 },
  target: { color: C.blue, fontSize: 12, fontWeight: '700', marginTop: 4 },
  targets: { backgroundColor: 'rgba(13,17,23,0.85)', borderRadius: 12, marginTop: 10, paddingHorizontal: 14, paddingTop: 8, maxHeight: 210 },
  targetRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: C.panelEdge },
  targetName: { color: C.ink, fontSize: 13 },
  targetVal: { color: C.inkDim, fontSize: 13, fontWeight: '800' },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: { flex: 1, height: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  btnText: { ...FONT.display, color: C.amberInk, fontSize: 14 },
});
