import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, FONT } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { sweepAssets } from '../utils/media';
import { processQueue, pendingCount, mergeDecoded } from '../utils/aidecode';
import { aiDecodeEnabled } from '../config';

const Tile = ({ title, sub, onPress, accent }) => (
  <TouchableOpacity style={[s.tile, accent && { borderColor: C.amber }]} activeOpacity={0.85} onPress={onPress}>
    <Text style={s.tileTitle}>{title}</Text>
    <Text style={s.tileSub}>{sub}</Text>
  </TouchableOpacity>
);

export default function ProjectHomeScreen({ route, navigation }) {
  const { projectId } = route.params;
  const { projects, updateProject, deleteProject, updatePhoto } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [aiPending, setAiPending] = useState(0);

  // Drain the AI decode queue whenever this screen mounts with connectivity.
  useEffect(() => {
    if (!aiDecodeEnabled()) return;
    let alive = true;
    (async () => {
      const applied = await processQueue();
      for (const { projectId: pid, photoId, decoded } of applied) {
        const proj = projects.find((p) => p.id === pid);
        const photo = proj?.photos.find((ph) => ph.id === photoId);
        if (photo) updatePhoto(pid, photoId, { nameplate: mergeDecoded(photo.nameplate, decoded) });
      }
      const n = await pendingCount(projectId);
      if (alive) setAiPending(n);
    })();
    return () => { alive = false; };
  }, [projectId]);

  if (!project) return null;

  const photoCount = project.photos.filter((p) => p.type !== 'video').length;
  const videoCount = project.photos.filter((p) => p.type === 'video').length;
  const npCount = project.photos.filter((p) => p.nameplate && (p.nameplate.make || p.nameplate.model)).length;
  const flagCount = project.photos.filter((p) => p.flagged).length;

  const sweep = () => {
    const ids = project.photos.map((p) => p.assetId).filter(Boolean);
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

  const remove = () => {
    Alert.alert('Delete survey?', 'This deletes the survey and its in-app data. Exports you have shared are not affected.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { deleteProject(projectId); navigation.popToTop(); } },
    ]);
  };

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={s.name}>{project.name}</Text>
        <Text style={s.meta}>{project.profile} · Levels: {project.levels.join(', ')}</Text>

        <View style={s.stats}>
          {[[photoCount, 'PHOTOS'], [videoCount, 'VIDEOS'], [npCount, 'NAMEPLATES'], [flagCount, 'FLAGS']].map(([v, l]) => (
            <View key={l} style={s.stat}>
              <Text style={[s.statNum, l === 'FLAGS' && v > 0 && { color: C.red }]}>{v}</Text>
              <Text style={s.statLabel}>{l}</Text>
            </View>
          ))}
        </View>

        {aiPending > 0 && (
          <View style={s.aiPending}>
            <Text style={s.aiPendingText}>☁ {aiPending} nameplate{aiPending > 1 ? 's' : ''} queued for AI decode — completes automatically when online</Text>
          </View>
        )}

        <Tile accent title="📷  CAPTURE" sub="Tagged photos, nameplates, video walkthrough"
          onPress={() => navigation.navigate('Capture', { projectId })} />
        <Tile title="🗂  REVIEW PHOTOS" sub="Grouped by level and space · quality badges"
          onPress={() => navigation.navigate('Gallery', { projectId })} />
        <Tile title="⚡  PANELBOARDS" sub={`${project.panels.length} panel sessions`}
          onPress={() => navigation.navigate('Panels', { projectId })} />
        <Tile title="📤  EXPORT DELIVERABLES" sub="Photo log PDF · equipment inventory · panel sheets"
          onPress={() => navigation.navigate('Export', { projectId })} />
        <Tile title="🧪  EXPERIMENTAL TOOLS" sub={`AR sizer · footcandles · color temp · ${(project.measurements || []).length} saved readings`}
          onPress={() => navigation.navigate('Experimental', { projectId })} />

        <TouchableOpacity style={s.sweep} onPress={sweep}>
          <Text style={s.sweepText}>🧹  Close out: sweep this survey from camera roll</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.delete} onPress={remove}>
          <Text style={s.deleteText}>Delete survey</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  name: { color: C.ink, fontSize: 21, fontWeight: '800' },
  meta: { color: C.inkDim, fontSize: 12, marginTop: 4, marginBottom: 16 },
  stats: { flexDirection: 'row', backgroundColor: C.panel, borderRadius: 12, borderWidth: 1, borderColor: C.panelEdge, marginBottom: 16 },
  aiPending: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.blue, borderRadius: 10, padding: 10, marginTop: -8, marginBottom: 16 },
  aiPendingText: { color: C.blue, fontSize: 11.5, fontWeight: '700' },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  statNum: { ...FONT.display, color: C.ink, fontSize: 20 },
  statLabel: { ...FONT.label, color: C.inkDim, fontSize: 8.5, marginTop: 2 },
  tile: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, borderRadius: 12, padding: 18, marginBottom: 10 },
  tileTitle: { color: C.ink, fontSize: 16, fontWeight: '800' },
  tileSub: { color: C.inkDim, fontSize: 12, marginTop: 4 },
  sweep: { marginTop: 18, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: C.panelEdge, alignItems: 'center' },
  sweepText: { color: C.ink, fontSize: 13, fontWeight: '600' },
  delete: { marginTop: 10, padding: 12, alignItems: 'center' },
  deleteText: { color: C.red, fontSize: 13 },
});
