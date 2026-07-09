import React, { useMemo } from 'react';
import { View, Text, SectionList, Image, TouchableOpacity, StyleSheet, Alert, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, FONT } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { deleteAppFile, sweepAssets } from '../utils/media';

const pad2 = (n) => String(n).padStart(2, '0');

export default function GalleryScreen({ route }) {
  const { projectId } = route.params;
  const { projects, deletePhoto } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { width } = useWindowDimensions();

  const sections = useMemo(() => {
    if (!project) return [];
    const map = {};
    project.photos.forEach((p) => {
      const key = `LEVEL ${p.level}  ·  ${p.space} #${pad2(p.spaceNum || 1)}`;
      map[key] = map[key] || [];
      map[key].push(p);
    });
    return Object.keys(map).sort().map((k) => ({ title: k, data: [map[k]] }));
  }, [project]);

  if (!project) return null;

  const thumb = (width - 16 * 2 - 8 * 2) / 3;

  const confirmDelete = (photo) => {
    Alert.alert('Delete photo?', 'Removes it from this survey (and the camera roll copy if present).', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          if (photo.assetId) await sweepAssets([photo.assetId]);
          await deleteAppFile(photo.uri);
          deletePhoto(projectId, photo.id);
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <SectionList
        sections={sections}
        keyExtractor={(item, i) => 'row' + i}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        ListEmptyComponent={<Text style={s.empty}>No photos yet — hit Capture.</Text>}
        renderSectionHeader={({ section }) => <Text style={s.header}>{section.title}</Text>}
        renderItem={({ item: group }) => (
          <View style={s.grid}>
            {group.map((p) => (
              <TouchableOpacity key={p.id} onLongPress={() => confirmDelete(p)} activeOpacity={0.85}>
                <View>
                  <Image source={{ uri: p.uri }} style={{ width: thumb, height: thumb, borderRadius: 8, backgroundColor: C.panel }} />
                  <View style={s.badges}>
                    {p.type === 'video' && <Text style={s.badge}>▶</Text>}
                    {p.flagged && <Text style={[s.badge, { backgroundColor: C.red }]}>⚠</Text>}
                    {p.nameplate && (p.nameplate.make || p.nameplate.model) ? <Text style={[s.badge, { backgroundColor: C.blue }]}>NP</Text> : null}
                    {p.quality?.blurry && <Text style={[s.badge, { backgroundColor: C.amber, color: C.amberInk }]}>SOFT</Text>}
                  </View>
                  <Text style={s.sys}>{p.system}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
      />
      <Text style={s.hint}>Long-press a photo to delete</Text>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { ...FONT.label, color: C.amber, fontSize: 11, marginTop: 16, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badges: { position: 'absolute', top: 5, left: 5, flexDirection: 'row', gap: 4 },
  badge: { backgroundColor: 'rgba(0,0,0,0.65)', color: '#FFF', fontSize: 9, fontWeight: '800', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden' },
  sys: { position: 'absolute', bottom: 5, right: 6, color: '#FFF', fontSize: 9, fontWeight: '800', textShadowColor: '#000', textShadowRadius: 3 },
  empty: { color: C.inkDim, textAlign: 'center', marginTop: 60 },
  hint: { color: C.inkDim, fontSize: 11, textAlign: 'center', paddingVertical: 10 },
});
