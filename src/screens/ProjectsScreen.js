import React from 'react';
import { View, Text, FlatList, StyleSheet, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop, ActionCardShell, Press } from '../components/Surface';
import { useProjects } from '../store/ProjectContext';
import { color, radius, space, font } from '../theme/tokens';

/**
 * Doubles as the survey list AND the "which survey?" picker for the
 * Deliverables shortcut on the landing screen.
 *
 * `route.params.pick === 'export'` switches the destination of a tap from
 * the survey home to its export screen. Same list, same rows — the only
 * thing that changes is where you land and what the header says you're
 * doing. That's deliberately lighter than a separate picker screen: there
 * is exactly one list of surveys in this app and it should stay that way.
 */
export default function ProjectsScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { projects, loaded, deleteProject } = useProjects();
  const pickForExport = route?.params?.pick === 'export';

  const confirmDelete = (project) => {
    Alert.alert(
      'Delete survey?',
      `This deletes "${project.name}" and its in-app data. Exports you have shared are not affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteProject(project.id) },
      ]
    );
  };

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={styles.header}>
          <Text style={styles.wordmark}>{pickForExport ? 'Export which survey?' : 'Recent Surveys'}</Text>
          <Text style={styles.sub}>
            {pickForExport
              ? 'Pick a survey to open its deliverables \u2014 report, photo log, inventory, riser.'
              : 'Point your phone at the building. Walk out with the deliverables done.'}
          </Text>
        </View>

        <FlatList
          data={projects}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: space.gutter, paddingTop: 6, paddingBottom: 40 }}
          ListEmptyComponent={
            loaded ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No surveys yet</Text>
                <Text style={styles.emptyBody}>Start a walkthrough from the main page to create one.</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const flags = item.photos.filter((p) => p.flagged).length;
            // Last ACTIVITY, not creation date. A survey resumed on a second
            // day should read as recent; the created date buries it.
            const lastAt = item.photos.reduce((acc, p) => {
              const t = new Date(p.takenAt).getTime();
              return isFinite(t) && t > acc ? t : acc;
            }, new Date(item.createdAt).getTime() || 0);
            const nameplates = item.photos.filter(
              (p) => p.nameplate && (p.nameplate.make || p.nameplate.model || p.nameplate.serial)
            ).length;
            return (
              <Press
                onPress={() => navigation.navigate(
                  pickForExport ? 'Export' : 'ProjectHome',
                  { projectId: item.id }
                )}
                onLongPress={() => confirmDelete(item)}
                scaleTo={0.985}
                style={{ marginBottom: 10 }}
              >
                <ActionCardShell>
                  <View style={styles.row}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={styles.cardTitle}>{item.name}</Text>
                      <Text style={styles.cardMeta}>
                        {/* Separators go through expressions, not JSX text.
                            A bare \u00b7 in a text node renders as the six
                            literal characters, not a middot. */}
                        {item.profile}{'\u00b7'.padStart(3, ' ')}last worked{' '}
                        {lastAt ? new Date(lastAt).toLocaleDateString() : '\u2014'}
                        {nameplates > 0 ? ` \u00b7 ${nameplates} nameplate${nameplates > 1 ? 's' : ''}` : ''}
                      </Text>
                    </View>
                    <View style={styles.counts}>
                      <Text style={styles.count}>{item.photos.length}</Text>
                      <Text style={styles.countLabel}>PHOTOS</Text>
                      {flags > 0 && <Text style={styles.flags}>⚠ {flags}</Text>}
                    </View>
                  </View>
                </ActionCardShell>
              </Press>
            );
          }}
        />

        <Text style={styles.hint}>
          {pickForExport ? 'Tap a survey to open its deliverables' : 'Long-press a survey to delete it'}
        </Text>
      </View>
    </Backdrop>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space.gutter, paddingTop: 22, paddingBottom: 14 },
  wordmark: { ...font(600, 20, { lh: 1, ls: -0.2 }), color: color.textPrimary },
  sub: { ...font(400, 12.5, { lh: 1.5 }), color: color.text50, marginTop: 6 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardTitle: { ...font(600, 15, { lh: 1.2 }), color: color.textPrimary },
  cardMeta: { ...font(400, 11, { lh: 1.4 }), color: color.text45, marginTop: 3 },
  counts: { alignItems: 'flex-end' },
  count: { ...font(700, 18), color: color.textPrimary },
  countLabel: { ...font(700, 8, { mono: true, ls: 0.5 }), color: color.text40, marginTop: 2 },
  flags: { ...font(700, 11), color: '#e5484d', marginTop: 4 },

  empty: { alignItems: 'center', marginTop: 80 },
  emptyTitle: { ...font(700, 17), color: color.textPrimary },
  emptyBody: { ...font(400, 13, { lh: 1.4 }), color: color.text45, marginTop: 6, textAlign: 'center' },

  hint: { ...font(500, 10, { mono: true, ls: 0.5 }), color: color.text30, textAlign: 'center', paddingBottom: 14 },
});
