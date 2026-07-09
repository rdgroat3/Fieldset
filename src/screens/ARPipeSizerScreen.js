// EXPERIMENTAL — AR Pipe & Duct Sizer.
// Flow: aim reticle at the pipe → LOCK DISTANCE (AR hit test measures range)
// → drag the two guide lines to bracket the pipe edges → read the size.
// Math (per spec §Tool 4): OD = 2 · d · tan(θ/2), where θ is the angular
// width between the guides derived from screen fraction × camera FOV.
// Requires the dev build (ViroReact is a native module — not in Expo Go).

import React, { useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, PanResponder, useWindowDimensions, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, FONT } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { nearestNominal, PIPE_TABLES } from '../data/nomenclature';
import { DEV_BUILD_MSG } from '../utils/native';

// Lazy-load Viro so Expo Go doesn't crash on import.
let Viro = null;
try { Viro = require('@reactvision/react-viro'); } catch (e) { Viro = null; }

// Horizontal FOV assumption; calibrate per device against a known object.
const H_FOV_DEG = 60;

const INSULATION = [0, 0.5, 1, 2];

export default function ARPipeSizerScreen({ route }) {
  const { projectId } = route.params;
  const { addMeasurement } = useProjects();
  const { width: screenW, height: screenH } = useWindowDimensions();

  const [distanceM, setDistanceM] = useState(null); // meters, locked
  const [tracking, setTracking] = useState(false);
  const [leftX, setLeftX] = useState(screenW * 0.38);
  const [rightX, setRightX] = useState(screenW * 0.62);
  const [insul, setInsul] = useState(0);
  const [table, setTable] = useState('Steel (Sch 40)');
  const [shape, setShape] = useState('pipe'); // pipe | duct
  const [ductW, setDuctW] = useState(null);   // saved width when measuring duct H

  const sceneRef = useRef(null);
  const camPos = useRef([0, 0, 0]);

  // ---- AR scene (only mounted when Viro is available) ----
  const ARScene = useCallback((props) => {
    const { ViroARScene } = Viro;
    return (
      <ViroARScene
        ref={sceneRef}
        onTrackingUpdated={(state) => setTracking(state === Viro.ViroTrackingStateConstants?.TRACKING_NORMAL || state === 3)}
        onCameraTransformUpdate={(t) => { camPos.current = t.position; }}
      />
    );
  }, []);

  const lockDistance = async () => {
    if (!sceneRef.current) return;
    try {
      const results = await sceneRef.current.performARHitTestWithPoint(Math.round(screenW / 2), Math.round(screenH / 2));
      const hit = results?.find((r) => r.type === 'ExistingPlaneUsingExtent') || results?.[0];
      if (!hit) { Alert.alert('No surface lock', 'Sweep the phone slowly so AR can map the area, then try again.'); return; }
      const [hx, hy, hz] = hit.transform.position;
      const [cx, cy, cz] = camPos.current;
      const d = Math.sqrt((hx - cx) ** 2 + (hy - cy) ** 2 + (hz - cz) ** 2);
      if (d < 0.15 || d > 25) { Alert.alert('Range looks wrong', 'Got ' + d.toFixed(1) + ' m — re-aim at the pipe and retry.'); return; }
      setDistanceM(d);
    } catch (e) {
      Alert.alert('Hit test failed', String(e));
    }
  };

  // ---- Guide line drag handlers ----
  const mkResponder = (setX) => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderMove: (_, g) => setX(Math.max(10, Math.min(screenW - 10, g.moveX))),
  });
  const leftPan = useRef(mkResponder(setLeftX)).current;
  const rightPan = useRef(mkResponder(setRightX)).current;

  // ---- The math ----
  const pixelW = Math.abs(rightX - leftX);
  const thetaRad = (pixelW / screenW) * (H_FOV_DEG * Math.PI / 180);
  const odMeters = distanceM ? 2 * distanceM * Math.tan(thetaRad / 2) : null;
  const odInches = odMeters ? odMeters * 39.3701 : null;
  const structuralOD = odInches != null ? Math.max(0, odInches - 2 * insul) : null;
  const nominal = structuralOD != null && shape === 'pipe' ? nearestNominal(structuralOD, table) : null;

  const save = () => {
    if (structuralOD == null) return;
    const label = shape === 'duct'
      ? (ductW == null
          ? `Duct width ${structuralOD.toFixed(1)}"`
          : `Duct ${ductW.toFixed(0)}" × ${structuralOD.toFixed(0)}"`)
      : `${nominal?.label || '?'} ${table} (calc OD ${structuralOD.toFixed(2)}")`;
    addMeasurement(projectId, {
      kind: shape, label,
      calcOD: Number(structuralOD.toFixed(2)),
      insulation: insul, distanceM: Number(distanceM.toFixed(2)),
    });
    if (shape === 'duct' && ductW == null) { setDuctW(structuralOD); Alert.alert('Width saved', 'Now rotate the guides mentally 90° — bracket the duct HEIGHT and save again.'); }
    else { setDuctW(null); Alert.alert('Saved', label + ' added to survey measurements.'); }
  };

  if (!Viro) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.center}>
          <Text style={s.devTitle}>AR sizer not installed</Text>
          <Text style={s.devBody}>
            The AR module (@reactvision/react-viro) is not included in this build. Every other tool —
            including the footcandle meter and color temperature estimator — works normally.
            {'\n\n'}
            To enable AR later: install the Viro package, add it to the plugins in app.json, and rebuild.
            See the README.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const { ViroARSceneNavigator } = Viro;

  return (
    <View style={s.root}>
      <ViroARSceneNavigator autofocus initialScene={{ scene: ARScene }} style={StyleSheet.absoluteFill} />

      {/* EXPERIMENTAL banner */}
      <SafeAreaView pointerEvents="none" style={s.bannerWrap} edges={['top']}>
        <View style={s.banner}>
          <Text style={s.bannerText}>⚠ EXPERIMENTAL — estimate only. Not for code-compliance documentation. Verify critical dimensions by hand.</Text>
        </View>
      </SafeAreaView>

      {/* Center reticle */}
      <View pointerEvents="none" style={[s.reticle, { left: screenW / 2 - 14, top: screenH / 2 - 14 }]}>
        <Text style={{ color: distanceM ? C.green : C.amber, fontSize: 24 }}>⌖</Text>
      </View>

      {/* Draggable edge guides */}
      <View {...leftPan.panHandlers} style={[s.guide, { left: leftX - 22 }]}>
        <View style={s.guideLine} /><View style={s.guideGrip}><Text style={s.gripText}>◂</Text></View>
      </View>
      <View {...rightPan.panHandlers} style={[s.guide, { left: rightX - 22 }]}>
        <View style={s.guideLine} /><View style={s.guideGrip}><Text style={s.gripText}>▸</Text></View>
      </View>

      {/* Readout + controls */}
      <SafeAreaView style={s.hud} edges={['bottom']}>
        <View style={s.readout}>
          {distanceM == null ? (
            <Text style={s.readoutHint}>{tracking ? 'Aim ⌖ at the pipe, then LOCK DISTANCE' : 'Sweep phone slowly to map the space…'}</Text>
          ) : (
            <>
              <Text style={s.readoutBig}>
                {shape === 'pipe'
                  ? (nominal ? `${nominal.label} ${table.split(' ')[0]}` : '—')
                  : `${structuralOD?.toFixed(1)}" ${ductW == null ? 'width' : 'height'}`}
              </Text>
              <Text style={s.readoutSub}>
                calc OD {odInches?.toFixed(2)}" · range {distanceM.toFixed(2)} m
                {insul > 0 ? ` · −${insul}" insul ×2 → ${structuralOD?.toFixed(2)}"` : ''}
                {nominal ? ` · Δ ${nominal.err.toFixed(2)}"` : ''}
              </Text>
            </>
          )}
        </View>

        <View style={s.chipsRow}>
          {['pipe', 'duct'].map((sh) => (
            <TouchableOpacity key={sh} style={[s.chip, shape === sh && s.chipOn]} onPress={() => { setShape(sh); setDuctW(null); }}>
              <Text style={[s.chipText, shape === sh && { color: C.amberInk }]}>{sh.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
          <View style={s.chipDivider} />
          {INSULATION.map((i) => (
            <TouchableOpacity key={i} style={[s.chip, insul === i && s.chipOn]} onPress={() => setInsul(i)}>
              <Text style={[s.chipText, insul === i && { color: C.amberInk }]}>{i === 0 ? 'NO INSUL' : `${i}"`}</Text>
            </TouchableOpacity>
          ))}
          {shape === 'pipe' && (
            <>
              <View style={s.chipDivider} />
              {Object.keys(PIPE_TABLES).map((t) => (
                <TouchableOpacity key={t} style={[s.chip, table === t && s.chipOn]} onPress={() => setTable(t)}>
                  <Text style={[s.chipText, table === t && { color: C.amberInk }]}>{t.split(' ')[0].toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
            </>
          )}
        </View>

        <View style={s.btnRow}>
          <TouchableOpacity style={[s.bigBtn, { backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge }]} onPress={lockDistance}>
            <Text style={[s.bigBtnText, { color: C.ink }]}>{distanceM ? 'RE-LOCK' : 'LOCK DISTANCE'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.bigBtn, { backgroundColor: C.amber, opacity: structuralOD == null ? 0.4 : 1 }]} onPress={save} disabled={structuralOD == null}>
            <Text style={s.bigBtnText}>SAVE {shape === 'duct' && ductW == null ? 'WIDTH' : shape === 'duct' ? 'HEIGHT' : 'SIZE'}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  devTitle: { ...FONT.display, color: C.amber, fontSize: 18, marginBottom: 10 },
  devBody: { color: C.inkDim, textAlign: 'center', lineHeight: 20 },
  bannerWrap: { position: 'absolute', top: 0, left: 0, right: 0 },
  banner: { backgroundColor: 'rgba(255,176,32,0.92)', margin: 10, borderRadius: 8, padding: 8 },
  bannerText: { color: C.amberInk, fontSize: 10.5, fontWeight: '800', textAlign: 'center' },
  reticle: { position: 'absolute' },
  guide: { position: 'absolute', top: 0, bottom: 0, width: 44, alignItems: 'center', justifyContent: 'center' },
  guideLine: { position: 'absolute', top: '18%', bottom: '30%', width: 2, backgroundColor: C.amber },
  guideGrip: { width: 40, height: 56, borderRadius: 10, backgroundColor: 'rgba(255,176,32,0.9)', alignItems: 'center', justifyContent: 'center' },
  gripText: { color: C.amberInk, fontSize: 18, fontWeight: '900' },
  hud: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 10 },
  readout: { backgroundColor: 'rgba(13,17,23,0.88)', borderRadius: 12, padding: 12, alignItems: 'center', marginBottom: 8 },
  readoutHint: { color: C.ink, fontSize: 13, fontWeight: '600' },
  readoutBig: { ...FONT.display, color: C.amber, fontSize: 26 },
  readoutSub: { color: C.inkDim, fontSize: 11, marginTop: 3 },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  chip: { paddingHorizontal: 10, height: 34, justifyContent: 'center', borderRadius: 8, backgroundColor: 'rgba(22,28,36,0.9)', borderWidth: 1, borderColor: C.panelEdge, marginRight: 6, marginBottom: 6 },
  chipOn: { backgroundColor: C.amber, borderColor: C.amber },
  chipText: { color: C.ink, fontWeight: '800', fontSize: 11 },
  chipDivider: { width: 8 },
  btnRow: { flexDirection: 'row', gap: 8 },
  bigBtn: { flex: 1, height: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  bigBtnText: { ...FONT.display, color: C.amberInk, fontSize: 14 },
});
