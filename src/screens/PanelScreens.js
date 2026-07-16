import React, { useState } from 'react';
import { View, Text, ScrollView, Image, TouchableOpacity, Pressable, StyleSheet, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Backdrop } from '../components/Surface';
import { color, radius, space, font } from '../theme/tokens';
import { Btn, Field, Chip } from '../components/UI';
import { useProjects } from '../store/ProjectContext';
import { persistToApp, saveToProjectAlbum } from '../utils/media';
import { exportPanelSheet } from '../utils/exports';

function ScreenHeader({ title, onBack }) {
  return (
    <View style={s.header}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={s.back}>{'\u2039 Back'}</Text>
      </Pressable>
      <Text style={s.h1}>{title}</Text>
      <View style={{ width: 44 }} />
    </View>
  );
}

// --- List of panel sessions ---
export function PanelsScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { projectId } = route.params;
  const { projects, addPanel } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [panelId, setPanelId] = useState('');

  if (!project) return null;

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <ScreenHeader title="Panelboard Audits" onBack={() => navigation?.goBack?.()} />
        <ScrollView contentContainerStyle={{ padding: space.gutter, paddingTop: 4, paddingBottom: 40 }}>
          <Field label="New Panel ID" value={panelId} onChangeText={setPanelId} placeholder="e.g. LP-2A" autoCapitalize="characters" />
          <Btn label="+ START PANEL SESSION" onPress={() => {
            if (!panelId.trim()) return;
            const id = addPanel(projectId, { panelId: panelId.trim(), voltage: '', busAmps: '', main: '', location: '', schedulePhoto: null, fedFrom: null });
            setPanelId('');
            navigation.navigate('PanelDetail', { projectId, panelId: id });
          }} />
          {project.panels.map((pn) => {
            const feedLabel = pn.fedFrom === 'utility'
              ? 'Utility'
              : pn.fedFrom
                ? project.panels.find((x) => x.id === pn.fedFrom)?.panelId
                : null;
            return (
              <TouchableOpacity key={pn.id} style={s.card} onPress={() => navigation.navigate('PanelDetail', { projectId, panelId: pn.id })}>
                <Text style={s.cardTitle}>⚡ {pn.panelId}</Text>
                <Text style={s.cardMeta}>
                  {pn.voltage || '—'} · {pn.busAmps ? pn.busAmps + 'A bus' : '—'} · {pn.leftPhotos.length + pn.rightPhotos.length} breaker photos{pn.schedulePhoto ? ' · schedule ✓' : ''}
                  {feedLabel ? ` · fed from ${feedLabel}` : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </Backdrop>
  );
}

// --- Single panel session: Zone A (schedule) + Zone B (breaker columns) ---
export function PanelDetailScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { projectId, panelId } = route.params;
  const { projects, updatePanel, settings } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const panel = project?.panels.find((pn) => pn.id === panelId);
  const [exporting, setExporting] = useState(false);
  if (!panel) return null;

  const shoot = async (zone) => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const r = await ImagePicker.launchCameraAsync({ quality: 0.9, allowsEditing: zone === 'schedule' });
    if (r.canceled || !r.assets?.[0]) return;
    try {
      const appUri = await persistToApp(r.assets[0].uri, 'jpg');
      await saveToProjectAlbum(appUri, project.name);
      if (zone === 'schedule') updatePanel(projectId, panelId, { schedulePhoto: appUri });
      if (zone === 'left') updatePanel(projectId, panelId, { leftPhotos: [...panel.leftPhotos, appUri] });
      if (zone === 'right') updatePanel(projectId, panelId, { rightPhotos: [...panel.rightPhotos, appUri] });
    } catch (e) {
      console.warn('[PanelScreens] shoot() failed to save:', e);
      const lowStorage = /space|storage|enospc|disk/i.test(String(e?.message || e));
      Alert.alert(
        'Photo not saved',
        lowStorage
          ? 'Your device looks like it\u2019s low on storage, so this photo couldn\u2019t be saved. Free up space and try again.'
          : 'Something went wrong saving this photo. Try again \u2014 if it keeps happening, check your device storage.',
      );
    }
  };

  const doExport = async () => {
    setExporting(true);
    try { await exportPanelSheet(project, panel, settings); }
    catch (e) { Alert.alert('Export failed', String(e)); }
    finally { setExporting(false); }
  };

  const Zone = ({ label, uris, zone, single }) => (
    <View style={s.zone}>
      <Text style={s.zoneLabel}>{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {(single ? (uris ? [uris] : []) : uris).map((u, i) => (
          <Image key={i} source={{ uri: u }} style={s.zoneImg} />
        ))}
        <TouchableOpacity style={s.zoneAdd} onPress={() => shoot(zone)}>
          <Text style={s.zoneAddText}>＋</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <ScreenHeader title={`⚡ ${panel.panelId}`} onBack={() => navigation?.goBack?.()} />
        <ScrollView contentContainerStyle={{ padding: space.gutter, paddingTop: 4, paddingBottom: 40 }}>
          <Field label="Voltage" value={panel.voltage} onChangeText={(v) => updatePanel(projectId, panelId, { voltage: v })} placeholder="480/277V 3Ø 4W" />
          <Field label="Bus Amps" value={panel.busAmps} onChangeText={(v) => updatePanel(projectId, panelId, { busAmps: v })} keyboardType="number-pad" placeholder="225" />
          <Field label="Main" value={panel.main} onChangeText={(v) => updatePanel(projectId, panelId, { main: v })} placeholder="MLO / 200A MCB" />
          <Field label="Location" value={panel.location} onChangeText={(v) => updatePanel(projectId, panelId, { location: v })} placeholder="L02 Electrical Room" />

          <Text style={s.fedFromLabel}>FED FROM</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <Chip
              label="⚡ Utility Service"
              active={panel.fedFrom === 'utility'}
              onPress={() => updatePanel(projectId, panelId, { fedFrom: 'utility' })}
            />
            {project.panels
              .filter((pn) => pn.id !== panel.id)
              .map((pn) => (
                <Chip
                  key={pn.id}
                  label={pn.panelId}
                  active={panel.fedFrom === pn.id}
                  onPress={() => updatePanel(projectId, panelId, { fedFrom: pn.id })}
                />
              ))}
          </View>
          <Text style={s.fedFromHint}>
            Sets this panel's spot in the electrical riser export — one tap per panel as you go.
          </Text>

          <Zone label="ZONE A — DIRECTORY SCHEDULE (door card)" uris={panel.schedulePhoto} zone="schedule" single />
          <Zone label="ZONE B — LEFT BREAKER COLUMN (odd)" uris={panel.leftPhotos} zone="left" />
          <Zone label="ZONE B — RIGHT BREAKER COLUMN (even)" uris={panel.rightPhotos} zone="right" />

          <Btn label={exporting ? 'BUILDING PDF…' : 'EXPORT PANEL PROFILE SHEET (PDF)'} onPress={doExport} style={{ marginTop: 16 }} />
        </ScrollView>
      </View>
    </Backdrop>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.gutter, paddingVertical: 12,
  },
  back: { ...font(700, 14), color: color.accent },
  h1: { ...font(600, 16), color: color.textPrimary },
  card: { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder, borderRadius: radius.card, padding: 16, marginTop: 10 },
  cardTitle: { ...font(700, 16), color: color.textPrimary },
  cardMeta: { ...font(400, 12, { lh: 1.4 }), color: color.text45, marginTop: 3 },
  fedFromLabel: { ...font(700, 11, { mono: true, ls: 0.8 }), color: color.text45, marginBottom: 8, marginTop: 4 },
  fedFromHint: { ...font(400, 11, { lh: 1.4 }), color: color.text40, marginTop: -2, marginBottom: 14 },
  zone: { marginTop: 16 },
  zoneLabel: { ...font(700, 11, { mono: true, ls: 0.8 }), color: color.accent, marginBottom: 8 },
  zoneImg: { width: 84, height: 84, borderRadius: radius.spaceCard, backgroundColor: color.cardFill },
  zoneAdd: { width: 84, height: 84, borderRadius: radius.spaceCard, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.cardBorder, alignItems: 'center', justifyContent: 'center' },
  zoneAddText: { color: color.text45, fontSize: 28 },
});
