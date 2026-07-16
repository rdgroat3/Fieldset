import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as MediaLibrary from 'expo-media-library';
import { useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { color, radius, space, font } from '../theme/tokens';

const SEEN_KEY = 'fieldset.permissionPrimerSeen.v1';

/**
 * First-run permission primer.
 *
 * Without this, permissions were requested ad-hoc at the moment each feature
 * was first touched — so a surveyor could be standing in a mechanical room
 * mid-walkthrough when Android interrupts to ask about the microphone, and
 * the camera-roll permission was never asked for at all until a save silently
 * failed.
 *
 * This asks once, up front, having first explained WHY each one is needed
 * (priming markedly improves grant rates). It is deliberately NOT a hard gate:
 * every permission here except the camera is optional, and the app degrades
 * rather than blocks. Shown once ever — after that the OS is the source of
 * truth and CameraScreen's own banner covers a later revocation.
 */
export default function PermissionGate({ children }) {
  const insets = useSafeAreaInsets();
  const [checked, setChecked] = useState(false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [, requestMicPerm] = useMicrophonePermissions();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(SEEN_KEY);
        if (!alive) return;
        setShow(!seen);
      } catch (e) {
        // If storage is unreadable, don't trap the user behind the primer.
        if (alive) setShow(false);
      } finally {
        if (alive) setChecked(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  const requestAll = async () => {
    setBusy(true);
    const out = { camera: false, mic: false, library: false };
    try {
      out.camera = !!(await requestCamPerm())?.granted;
    } catch (e) { /* leave false */ }
    try {
      out.mic = !!(await requestMicPerm())?.granted;
    } catch (e) { /* leave false */ }
    try {
      const r = await MediaLibrary.requestPermissionsAsync();
      out.library = r?.status === 'granted';
    } catch (e) { /* leave false */ }

    try { await AsyncStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* non-fatal */ }
    setResult(out);
    setBusy(false);

    // Camera is the only one worth pausing on — everything else degrades.
    if (out.camera) setShow(false);
  };

  const skip = async () => {
    try { await AsyncStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* non-fatal */ }
    setShow(false);
  };

  if (!checked) return null;
  if (!show) return children;

  // Asked, but camera was denied — the one case worth explaining, since
  // nothing in the app works without it.
  if (result && !result.camera) {
    return (
      <View style={[s.root, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}>
        <Text style={s.h1}>Camera access is required</Text>
        <Text style={s.body}>
          Fieldset is a camera app — capturing tagged photos is the whole job. Enable camera
          access in Settings, then come back.
        </Text>
        <Pressable style={s.primary} onPress={() => Linking.openSettings()}>
          <Text style={s.primaryText}>Open Settings</Text>
        </Pressable>
        <Pressable style={s.ghost} onPress={skip}>
          <Text style={s.ghostText}>Continue anyway</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top + 36, paddingBottom: insets.bottom + 24 }]}>
      <Text style={s.h1}>Before your first walkthrough</Text>
      <Text style={s.body}>
        Fieldset needs a few permissions. We ask now so nothing interrupts you in the field.
      </Text>

      <Row
        title="Camera"
        need="Required"
        detail="Capture survey photos, walkthrough video, and nameplate scans."
      />
      <Row
        title="Microphone"
        need="Optional"
        detail="Audio on walkthrough videos. Skip it and video records silently."
      />
      <Row
        title="Photo library"
        need="Optional"
        detail="Saves a backup copy to a per-survey album. Skip it and photos stay in the app only."
      />

      <View style={{ flex: 1 }} />

      <Text style={s.fine}>
        Everything is processed on your device. Fieldset never touches photos it didn't take,
        and the close-out sweep only removes its own.
      </Text>

      <Pressable style={[s.primary, busy && { opacity: 0.6 }]} onPress={requestAll} disabled={busy}>
        <Text style={s.primaryText}>{busy ? 'Requesting\u2026' : 'Continue'}</Text>
      </Pressable>
      <Pressable style={s.ghost} onPress={skip} disabled={busy}>
        <Text style={s.ghostText}>Not now</Text>
      </Pressable>
    </View>
  );
}

function Row({ title, need, detail }) {
  const required = need === 'Required';
  return (
    <View style={s.row}>
      <View style={s.rowHead}>
        <Text style={s.rowTitle}>{title}</Text>
        <Text style={[s.rowNeed, required && s.rowNeedReq]}>{need.toUpperCase()}</Text>
      </View>
      <Text style={s.rowDetail}>{detail}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bgBottom, paddingHorizontal: space.gutter },
  h1: { ...font(700, 24, { lh: 1.25, ls: -0.3 }), color: color.textPrimary },
  body: { ...font(400, 13.5, { lh: 1.5 }), color: color.text50, marginTop: 10, marginBottom: 22 },

  row: {
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
    borderRadius: radius.card, padding: 14, marginBottom: 10,
  },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { ...font(700, 15), color: color.textPrimary },
  rowNeed: { ...font(700, 9, { mono: true, ls: 0.8 }), color: color.text40 },
  rowNeedReq: { color: color.accent },
  rowDetail: { ...font(400, 12, { lh: 1.45 }), color: color.text45, marginTop: 5 },

  fine: { ...font(400, 11, { lh: 1.5 }), color: color.text40, marginBottom: 14 },

  primary: {
    height: 52, borderRadius: radius.button, backgroundColor: color.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { ...font(700, 15), color: color.ink },
  ghost: { height: 46, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  ghostText: { ...font(600, 13), color: color.text40 },
});
