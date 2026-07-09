import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, FONT } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { exportPhotoLog, exportInventoryCSV } from '../utils/exports';

export default function ExportScreen({ route, navigation }) {
  const { projectId } = route.params;
  const { projects, settings } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [busy, setBusy] = useState(null);
  if (!project) return null;

  const photos = project.photos.filter((p) => p.type !== 'video').length;
  const npCount = project.photos.filter((p) => p.nameplate && (p.nameplate.make || p.nameplate.model || p.nameplate.serial)).length;

  const run = async (key, fn, guardMsg) => {
    if (guardMsg) { Alert.alert('Nothing to export', guardMsg); return; }
    setBusy(key);
    try { await fn(project, settings); }
    catch (e) { Alert.alert('Export failed', String(e)); }
    finally { setBusy(null); }
  };

  const Card = ({ title, sub, cta, onPress, busyKey }) => (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      <Text style={s.cardSub}>{sub}</Text>
      <TouchableOpacity style={s.cta} onPress={onPress} disabled={busy !== null}>
        <Text style={s.ctaText}>{busy === busyKey ? 'GENERATING…' : cta}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={s.title}>Export Deliverables</Text>
        <Text style={s.sub}>Generated on-device. Share to email, Drive, Teams — anywhere.</Text>

        <Card
          title="📄  Existing Conditions Photo Log"
          sub={`${photos} photos grouped by level & space, numbered and captioned, with a deficiency summary table. PDF, ready to drop into your report as an appendix.`}
          cta="GENERATE PHOTO LOG PDF"
          busyKey="log"
          onPress={() => run('log', exportPhotoLog, photos === 0 ? 'Capture some photos first.' : null)}
        />
        <Card
          title="📊  Equipment Inventory"
          sub={`${npCount} nameplate records → CSV spreadsheet (make, model, serial, capacity, year, location). Opens in Excel; formatted for Revit schedule import.`}
          cta="GENERATE INVENTORY CSV"
          busyKey="csv"
          onPress={() => run('csv', exportInventoryCSV, npCount === 0 ? 'Capture some nameplate photos first (Nameplate mode in Capture).' : null)}
        />
        <Card
          title="⚡  Panel Profile Sheets"
          sub={`${project.panels.length} panel sessions. Export each panel as a single-page PDF from its session screen.`}
          cta="GO TO PANELBOARDS"
          busyKey="panels"
          onPress={() => navigation.navigate('Panels', { projectId })}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  title: { color: C.ink, fontSize: 22, fontWeight: '800' },
  sub: { color: C.inkDim, fontSize: 12, marginTop: 4, marginBottom: 18 },
  card: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, borderRadius: 12, padding: 18, marginBottom: 12 },
  cardTitle: { color: C.ink, fontSize: 16, fontWeight: '800' },
  cardSub: { color: C.inkDim, fontSize: 12, marginTop: 6, lineHeight: 17 },
  cta: { marginTop: 14, backgroundColor: C.amber, borderRadius: 10, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  ctaText: { ...FONT.display, color: C.amberInk, fontSize: 13 },
});
