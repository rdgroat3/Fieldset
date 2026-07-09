import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, FONT } from '../theme';
import { Btn } from '../components/UI';
import { useProjects } from '../store/ProjectContext';

export default function ProjectsScreen({ navigation }) {
  const { projects, loaded } = useProjects();

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <View style={s.header}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={s.brand}>MEP SURVEY PRO</Text>
          <TouchableOpacity style={s.gear} onPress={() => navigation.navigate('Settings')}>
            <Text style={{ fontSize: 20 }}>⚙️</Text>
          </TouchableOpacity>
        </View>
        <Text style={s.tag}>Point your phone at the building. Walk out with the deliverables done.</Text>
      </View>

      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        ListEmptyComponent={
          loaded ? (
            <View style={s.empty}>
              <Text style={s.emptyTitle}>No surveys yet</Text>
              <Text style={s.emptyBody}>Create a survey to start capturing tagged photos.</Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => {
          const flags = item.photos.filter((p) => p.flagged).length;
          return (
            <TouchableOpacity
              style={s.card}
              activeOpacity={0.85}
              onPress={() => navigation.navigate('ProjectHome', { projectId: item.id })}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.cardTitle}>{item.name}</Text>
                <Text style={s.cardMeta}>
                  {item.profile} · {new Date(item.createdAt).toLocaleDateString()}
                </Text>
              </View>
              <View style={s.counts}>
                <Text style={s.count}>{item.photos.length}</Text>
                <Text style={s.countLabel}>PHOTOS</Text>
                {flags > 0 && <Text style={s.flags}>⚠ {flags}</Text>}
              </View>
            </TouchableOpacity>
          );
        }}
      />

      <View style={s.footer}>
        <Btn label="+ NEW SURVEY" onPress={() => navigation.navigate('NewProject')} />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  brand: { ...FONT.display, color: C.amber, fontSize: 22 },
  gear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tag: { color: C.inkDim, fontSize: 12, marginTop: 4 },
  card: {
    flexDirection: 'row',
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.panelEdge,
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    alignItems: 'center',
  },
  cardTitle: { color: C.ink, fontSize: 16, fontWeight: '700' },
  cardMeta: { color: C.inkDim, fontSize: 12, marginTop: 3 },
  counts: { alignItems: 'flex-end' },
  count: { ...FONT.display, color: C.ink, fontSize: 20 },
  countLabel: { ...FONT.label, color: C.inkDim, fontSize: 9 },
  flags: { color: C.red, fontWeight: '800', marginTop: 2, fontSize: 12 },
  empty: { alignItems: 'center', marginTop: 80 },
  emptyTitle: { color: C.ink, fontSize: 17, fontWeight: '700' },
  emptyBody: { color: C.inkDim, marginTop: 6, fontSize: 13 },
  footer: { position: 'absolute', bottom: 24, left: 16, right: 16 },
});
