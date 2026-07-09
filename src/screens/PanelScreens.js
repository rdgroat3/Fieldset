import React, { useState } from 'react';
import { View, Text, ScrollView, Image, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { C, FONT } from '../theme';
import { Btn, Field } from '../components/UI';
import { useProjects } from '../store/ProjectContext';
import { persistToApp, saveToProjectAlbum } from '../utils/media';
import { exportPanelSheet } from '../utils/exports';

// --- List of panel sessions ---
export function PanelsScreen({ route, navigation }) {
  const { projectId } = route.params;
  const { projects, addPanel } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [panelId, setPanelId] = useState('');

  if (!project) return null;

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={s.title}>Panelboard Audits</Text>
        <Field label="New Panel ID" value={panelId} onChangeText={setPanelId} placeholder="e.g. LP-2A" autoCapitalize="characters" />
        <Btn label="+ START PANEL SESSION" onPress={() => {
          if (!panelId.trim()) return;
          const id = addPanel(projectId, { panelId: panelId.trim(), voltage: '', busAmps: '', main: '', location: '', schedulePhoto: null });
          setPanelId('');
          navigation.navigate('PanelDetail', { projectId, panelId: id });
        }} />
        {project.panels.map((pn) => (
          <TouchableOpacity key={pn.id} style={s.card} onPress={() => navigation.navigate('PanelDetail', { projectId, panelId: pn.id })}>
            <Text style={s.cardTitle}>⚡ {pn.panelId}</Text>
            <Text style={s.cardMeta}>
              {pn.voltage || '—'} · {pn.busAmps ? pn.busAmps + 'A bus' : '—'} · {pn.leftPhotos.length + pn.rightPhotos.length} breaker photos{pn.schedulePhoto ? ' · schedule ✓' : ''}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

// --- Single panel session: Zone A (schedule) + Zone B (breaker columns) ---
export function PanelDetailScreen({ route }) {
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
    const appUri = await persistToApp(r.assets[0].uri, 'jpg');
    await saveToProjectAlbum(appUri, project.name);
    if (zone === 'schedule') updatePanel(projectId, panelId, { schedulePhoto: appUri });
    if (zone === 'left') updatePanel(projectId, panelId, { leftPhotos: [...panel.leftPhotos, appUri] });
    if (zone === 'right') updatePanel(projectId, panelId, { rightPhotos: [...panel.rightPhotos, appUri] });
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
    <SafeAreaView style={s.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={s.title}>⚡ {panel.panelId}</Text>
        <Field label="Voltage" value={panel.voltage} onChangeText={(v) => updatePanel(projectId, panelId, { voltage: v })} placeholder="480/277V 3Ø 4W" />
        <Field label="Bus Amps" value={panel.busAmps} onChangeText={(v) => updatePanel(projectId, panelId, { busAmps: v })} keyboardType="number-pad" placeholder="225" />
        <Field label="Main" value={panel.main} onChangeText={(v) => updatePanel(projectId, panelId, { main: v })} placeholder="MLO / 200A MCB" />
        <Field label="Location" value={panel.location} onChangeText={(v) => updatePanel(projectId, panelId, { location: v })} placeholder="L02 Electrical Room" />

        <Zone label="ZONE A — DIRECTORY SCHEDULE (door card)" uris={panel.schedulePhoto} zone="schedule" single />
        <Zone label="ZONE B — LEFT BREAKER COLUMN (odd)" uris={panel.leftPhotos} zone="left" />
        <Zone label="ZONE B — RIGHT BREAKER COLUMN (even)" uris={panel.rightPhotos} zone="right" />

        <Btn label={exporting ? 'BUILDING PDF…' : 'EXPORT PANEL PROFILE SHEET (PDF)'} onPress={doExport} style={{ marginTop: 16 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  title: { color: C.ink, fontSize: 20, fontWeight: '800', marginBottom: 14 },
  card: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, borderRadius: 12, padding: 16, marginTop: 10 },
  cardTitle: { color: C.ink, fontSize: 16, fontWeight: '800' },
  cardMeta: { color: C.inkDim, fontSize: 12, marginTop: 3 },
  zone: { marginTop: 16 },
  zoneLabel: { ...FONT.label, color: C.amber, marginBottom: 8 },
  zoneImg: { width: 84, height: 84, borderRadius: 8, backgroundColor: C.panel },
  zoneAdd: { width: 84, height: 84, borderRadius: 8, borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.panelEdge, alignItems: 'center', justifyContent: 'center' },
  zoneAddText: { color: C.inkDim, fontSize: 28 },
});
