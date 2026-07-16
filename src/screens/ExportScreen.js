import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet, ScrollView, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop } from '../components/Surface';
import { color, radius, space, font } from '../theme/tokens';
import { useProjects } from '../store/ProjectContext';
import { exportPhotoLog, exportInventoryCSV, exportElectricalRiser, exportDesignerReport } from '../utils/exports';
import { sweepAssets, shareToGooglePhotos } from '../utils/media';

export default function ExportScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { projectId } = route.params;
  const { projects, settings, updateProject } = useProjects();
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

  const saveToGooglePhotos = async () => {
    const media = project.photos.filter((p) => p.uri);
    if (media.length === 0) { Alert.alert('Nothing to save', 'Capture some photos or video first.'); return; }
    Alert.alert(
      'Save to Google Photos',
      `Photos already save automatically to the "${project.name}" album in your photo library, and Google Photos backs that up if backup is turned on. ` +
      `To send all ${media.length} item(s) directly now, we'll open the share sheet once per item — pick Google Photos each time.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Share ${media.length} item(s)`,
          onPress: async () => {
            setBusy('gphotos');
            try {
              for (const p of media) await shareToGooglePhotos(p.uri);
            } catch (e) {
              Alert.alert('Share failed', String(e));
            } finally {
              setBusy(null);
            }
          },
        },
      ]
    );
  };

  const sweep = () => {
    const ids = project.photos.map((p) => p.assetId).filter(Boolean);
    if (ids.length === 0) { Alert.alert('Nothing to sweep', 'No camera-roll copies from this survey were found.'); return; }
    Alert.alert(
      'Sweep camera roll?',
      `Removes ${ids.length} photos/videos this survey saved to your photo library. App copies and exports are kept. Personal photos are never touched.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sweep',
          style: 'destructive',
          onPress: async () => {
            const n = await sweepAssets(ids);
            updateProject(projectId, {
              photos: project.photos.map((p) => ({ ...p, assetId: null })),
              sweptAt: new Date().toISOString(),
            });
            Alert.alert('Done', `${n} items removed from your photo library.`);
          },
        },
      ]
    );
  };

  const Card = ({ title, sub, cta, onPress, busyKey, accent }) => (
    <View style={[s.card, accent && s.cardAccent]}>
      <Text style={s.cardTitle}>{title}</Text>
      <Text style={s.cardSub}>{sub}</Text>
      <TouchableOpacity style={s.cta} onPress={onPress} disabled={busy !== null}>
        <Text style={s.ctaText}>{busy === busyKey ? 'GENERATING…' : cta}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={s.header}>
          <Pressable onPress={() => navigation?.goBack?.()} hitSlop={12}>
            <Text style={s.back}>{'\u2039 Back'}</Text>
          </Pressable>
          <Text style={s.h1}>Export</Text>
          <View style={{ width: 44 }} />
        </View>
        <ScrollView contentContainerStyle={{ padding: space.gutter, paddingTop: 4, paddingBottom: 40 }}>
          <Text style={s.sub}>Generated on-device. Share to email, Drive, Teams — anywhere.</Text>

          <Card
            accent
            title="🗺  Designer Report (start here)"
            sub="One navigable file — deficiencies, equipment, riser, and the full photo log, all cross-linked with click-to-zoom photos. Opens offline in any browser, no server."
            cta="GENERATE DESIGNER REPORT"
            busyKey="report"
            onPress={() => run('report', exportDesignerReport, photos === 0 ? 'Capture some photos first.' : null)}
          />
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
            onPress={() => run('csv', exportInventoryCSV, npCount === 0 ? 'Capture some nameplate photos first (Nameplate mode in Capture, or the Decoder tool).' : null)}
          />
          <Card
            title="⚡  Panel Profile Sheets"
            sub={`${project.panels.length} panel sessions. Export each panel as a single-page PDF from its session screen.`}
            cta="GO TO PANELBOARDS"
            busyKey="panels"
            onPress={() => navigation.navigate('Panels', { projectId })}
          />
          <Card
            title="🌳  Electrical Riser (Panel Feed Tree)"
            sub={`Built from each panel's "Fed From" tag — a starting point for the CAD one-line, not a substitute for it. ${project.panels.length} panel session(s) found.`}
            cta="GENERATE RISER PDF"
            busyKey="riser"
            onPress={() => run('riser', exportElectricalRiser, project.panels.length === 0 ? 'Start at least one panel session first, and tag "Fed From" as you go.' : null)}
          />
          <Card
            title="🖼  Save to Google Photos"
            sub={`Your photos already save to a "${project.name}" album in your phone's photo library — if Google Photos backup is on, they sync automatically. Use this to push all ${project.photos.length} item(s) across now via the share sheet.`}
            cta="SAVE TO GOOGLE PHOTOS"
            busyKey="gphotos"
            onPress={saveToGooglePhotos}
          />

          <TouchableOpacity style={s.sweep} onPress={sweep}>
            <Text style={s.sweepText}>🧹  Close out: sweep this survey from camera roll</Text>
          </TouchableOpacity>
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
  sub: { ...font(400, 12, { lh: 1.5 }), color: color.text45, marginBottom: 18 },
  card: { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder, borderRadius: radius.card, padding: 18, marginBottom: 12 },
  cardAccent: { borderColor: color.accent, borderWidth: 1.5 },
  cardTitle: { ...font(700, 16), color: color.textPrimary },
  cardSub: { ...font(400, 12, { lh: 1.4 }), color: color.text45, marginTop: 6 },
  cta: { marginTop: 14, backgroundColor: color.accent, borderRadius: radius.button, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  ctaText: { ...font(700, 13), color: color.ink },
  sweep: { marginTop: 8, padding: 14, alignItems: 'center' },
  sweepText: { ...font(600, 12), color: color.text40 },
});
