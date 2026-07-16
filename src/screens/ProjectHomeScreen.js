import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop, Press } from '../components/Surface';
import { color, radius, space, font } from '../theme/tokens';
import { useProjects } from '../store/ProjectContext';
import { processQueue, pendingCount, mergeDecoded } from '../utils/aidecode';
import { aiDecodeEnabled } from '../config';

const Tile = ({ title, sub, onPress, accent }) => (
  <Press onPress={onPress} scaleTo={0.985}>
    <View style={[styles.tile, accent && styles.tileAccent]}>
      <Text style={styles.tileTitle}>{title}</Text>
      <Text style={styles.tileSub}>{sub}</Text>
    </View>
  </Press>
);

export default function ProjectHomeScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { projectId } = route.params;
  const { projects, updatePhoto } = useProjects();
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

  // "Finish Survey" replaces the old destructive Delete button — this is a
  // wrap-up action, not data loss, so it just returns to the main page.
  const finish = () => navigation.navigate('Landing');

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <ScrollView contentContainerStyle={{ padding: space.gutter, paddingTop: 16, paddingBottom: 40 }}>
          <View style={styles.topRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{project.name}</Text>
              <Text style={styles.meta}>{project.profile} · Levels: {project.levels.join(', ')}</Text>
            </View>
            <Press onPress={() => navigation.navigate('Capture', { projectId })} scaleTo={0.96}>
              <View style={styles.addPhotosBtn}>
                <Text style={styles.addPhotosBtnText}>+ Photos</Text>
              </View>
            </Press>
          </View>

          <View style={styles.stats}>
            {[[photoCount, 'PHOTOS'], [videoCount, 'VIDEOS'], [npCount, 'NAMEPLATES']].map(([v, l]) => (
              <View key={l} style={styles.stat}>
                <Text style={styles.statNum}>{v}</Text>
                <Text style={styles.statLabel}>{l}</Text>
              </View>
            ))}
            <Press
              onPress={() => flagCount > 0 && navigation.navigate('Gallery', { projectId, filterFlagged: true })}
              disabled={flagCount === 0}
              style={{ flex: 1 }}
            >
              <View style={styles.stat}>
                <Text style={[styles.statNum, flagCount > 0 && { color: '#e5484d' }]}>{flagCount}</Text>
                <Text style={styles.statLabel}>FLAGS{flagCount > 0 ? ' ›' : ''}</Text>
              </View>
            </Press>
          </View>

          {aiPending > 0 && (
            <View style={styles.aiPending}>
              <Text style={styles.aiPendingText}>☁ {aiPending} nameplate{aiPending > 1 ? 's' : ''} queued for AI decode — completes automatically when online</Text>
            </View>
          )}

          <Tile title="🗂  REVIEW PHOTOS" sub="Grouped by level and space · quality badges"
            onPress={() => navigation.navigate('Gallery', { projectId })} />
          <Tile title="⚡  PANELBOARDS" sub={`${project.panels.length} panel sessions`}
            onPress={() => navigation.navigate('Panels', { projectId })} />
          <Tile title="🔩  EQUIPMENT SCANS" sub={`${npCount} nameplates decoded`}
            onPress={() => navigation.navigate('Equipment', { projectId })} />
          <Tile accent title="📤  EXPORT DELIVERABLES" sub="Designer report · photo log · inventory · riser · save to Google Photos"
            onPress={() => navigation.navigate('Export', { projectId })} />

          <Press onPress={finish} scaleTo={0.98}>
            <View style={styles.finish}>
              <Text style={styles.finishText}>Finish Survey</Text>
            </View>
          </Press>
        </ScrollView>
      </View>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 16 },
  name: { ...font(700, 21, { lh: 1.2 }), color: color.textPrimary },
  meta: { ...font(400, 12, { lh: 1.4 }), color: color.text45, marginTop: 4 },
  addPhotosBtn: {
    backgroundColor: color.accent, borderRadius: radius.button,
    paddingHorizontal: 14, height: 38, alignItems: 'center', justifyContent: 'center',
  },
  addPhotosBtnText: { ...font(700, 13), color: color.ink },

  stats: {
    flexDirection: 'row', backgroundColor: color.cardFill, borderRadius: radius.card,
    borderWidth: 1, borderColor: color.cardBorder, marginBottom: 16,
  },
  aiPending: { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.accentTint40, borderRadius: radius.spaceCard, padding: 10, marginTop: -8, marginBottom: 16 },
  aiPendingText: { ...font(700, 11.5, { lh: 1.4 }), color: color.accentLight },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  statNum: { ...font(700, 20), color: color.textPrimary },
  statLabel: { ...font(700, 8.5, { mono: true, ls: 0.6 }), color: color.text40, marginTop: 2 },

  tile: { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder, borderRadius: radius.card, padding: 18, marginBottom: 10 },
  tileAccent: { borderColor: color.accentTint40 },
  tileTitle: { ...font(700, 16), color: color.textPrimary },
  tileSub: { ...font(400, 12, { lh: 1.4 }), color: color.text45, marginTop: 4 },

  finish: {
    marginTop: 18, padding: 16, borderRadius: radius.button, alignItems: 'center',
    backgroundColor: color.accent,
  },
  finishText: { ...font(700, 15), color: color.ink },
});
