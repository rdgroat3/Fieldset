import React, { useMemo, useState } from 'react';
import { View, Text, SectionList, Image, TouchableOpacity, Pressable, Modal, StyleSheet, Alert, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop, Press } from '../components/Surface';
import { color, radius, space, font } from '../theme/tokens';
import { useProjects } from '../store/ProjectContext';
import { deleteAppFile, sweepAssets, openVideoExternally } from '../utils/media';

const pad2 = (n) => String(n).padStart(2, '0');

export default function GalleryScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { projectId, filterFlagged: initialFlagged, filterType: initialType } = route.params;
  const { projects, deletePhoto, updatePhoto } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { width } = useWindowDimensions();
  const [viewer, setViewer] = useState(null);

  // A single active filter, switchable in-screen rather than fixed by how you
  // navigated in. Coming from ProjectHome's PHOTOS/VIDEOS/NAMEPLATES/FLAGS
  // tiles seeds this; from here on it's just another control on the page.
  const [filter, setFilter] = useState(() => {
    if (initialFlagged) return 'flagged';
    if (initialType) return initialType;
    return 'all';
  });

  const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'photo', label: 'Photos' },
    { key: 'video', label: 'Videos' },
    { key: 'nameplate', label: 'Nameplates' },
    { key: 'flagged', label: 'Flagged' },
  ];

  const matchesFilter = (p) => {
    switch (filter) {
      case 'photo': return p.type !== 'video';
      case 'video': return p.type === 'video';
      case 'nameplate': return !!(p.nameplate && (p.nameplate.make || p.nameplate.model));
      case 'flagged': return !!p.flagged;
      default: return true;
    }
  };

  const titleFor = {
    all: 'Photos', photo: 'Photos', video: 'Videos', nameplate: 'Nameplates', flagged: 'Flagged Photos',
  }[filter];

  const emptyFor = {
    all: 'No photos yet — hit Capture.',
    photo: 'No photos yet — hit Capture.',
    video: 'No videos yet.',
    nameplate: 'No nameplates decoded yet — try Nameplate mode in Capture, or the Decoder tool.',
    flagged: 'No flagged photos.',
  }[filter];

  // Videos can't render in the full-screen <Image> viewer (an mp4 there is
  // just a black frame, and the app deliberately has no in-app player —
  // that'd be a native dep + full build). Hand them to the device's own
  // player via the share sheet instead.
  const openViewer = (p) => {
    if (p.type === 'video') {
      openVideoExternally(p.uri).catch((e) => Alert.alert('Could not open video', String(e)));
      return;
    }
    setViewer(p);
  };
  const toggleFlag = () => {
    if (!viewer) return;
    const next = !viewer.flagged;
    updatePhoto(projectId, viewer.id, { flagged: next });
    setViewer((v) => (v ? { ...v, flagged: next } : v));
  };

  const sections = useMemo(() => {
    if (!project) return [];
    const map = {};
    const source = project.photos.filter(matchesFilter);
    source.forEach((p) => {
      const key = `LEVEL ${p.level}  ·  ${p.space} #${pad2(p.spaceNum || 1)}`;
      map[key] = map[key] || [];
      map[key].push(p);
    });
    return Object.keys(map).sort().map((k) => ({ title: k, data: [map[k]] }));
  }, [project, filter]);

  if (!project) return null;

  const thumb = (width - space.gutter * 2 - 8 * 2) / 3;

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
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={s.header}>
          <Pressable onPress={() => navigation?.goBack?.()} hitSlop={12}>
            <Text style={s.back}>{'\u2039 Back'}</Text>
          </Pressable>
          <Text style={s.h1}>{titleFor}</Text>
          <View style={{ width: 44 }} />
        </View>
        <View style={s.filterRow}>
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={[s.filterChip, active && s.filterChipOn]}
              >
                <Text style={[s.filterChipText, active && s.filterChipTextOn]}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <SectionList
          sections={sections}
          keyExtractor={(item, i) => 'row' + i}
          contentContainerStyle={{ padding: space.gutter, paddingTop: 8, paddingBottom: 40 }}
          ListEmptyComponent={<Text style={s.empty}>{emptyFor}</Text>}
          renderSectionHeader={({ section }) => <Text style={s.sectionHeader}>{section.title}</Text>}
          renderItem={({ item: group }) => (
            <View style={s.grid}>
              {group.map((p) => (
                <TouchableOpacity key={p.id} onPress={() => openViewer(p)} onLongPress={() => confirmDelete(p)} activeOpacity={0.85}>
                  <View>
                    <Image source={{ uri: p.uri }} style={{ width: thumb, height: thumb, borderRadius: radius.spaceCard, backgroundColor: color.cardFill }} />
                    <View style={s.badges}>
                      {p.type === 'video' && <Text style={s.badge}>▶</Text>}
                      {p.flagged && <Text style={[s.badge, { backgroundColor: '#e5484d' }]}>⚠</Text>}
                      {p.nameplate && (p.nameplate.make || p.nameplate.model) ? <Text style={[s.badge, { backgroundColor: color.accent }]}>NP</Text> : null}
                      {p.quality?.blurry && <Text style={[s.badge, { backgroundColor: '#f2c744', color: '#1a1200' }]}>SOFT</Text>}
                      {p.stampFailed && <Text style={[s.badge, { backgroundColor: '#e5484d' }]}>NO STAMP</Text>}
                    </View>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        />
        <Text style={s.hint}>Tap a photo to view · long-press to delete</Text>
      </View>

      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <View style={s.viewerScrim}>
          <Pressable style={s.viewerImgWrap} onPress={() => setViewer(null)}>
            {viewer && (
              <Image
                source={{ uri: viewer.uri }}
                style={[s.viewerImg, viewer.flagged && s.viewerImgFlagged]}
                resizeMode="contain"
              />
            )}
          </Pressable>
          <View style={s.viewerPanel}>
            <Text style={s.viewerMetaText}>
              {viewer ? `LEVEL ${viewer.level}  ·  ${viewer.space} #${pad2(viewer.spaceNum || 1)}` : ''}
            </Text>
            <View style={s.viewerBtns}>
              <TouchableOpacity style={s.noteCancel} onPress={() => setViewer(null)}>
                <Text style={s.noteCancelText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.flagBtn, viewer?.flagged && s.flagBtnOn]}
                onPress={toggleFlag}
              >
                <Text style={[s.flagBtnText, viewer?.flagged && s.flagBtnTextOn]}>
                  {viewer?.flagged ? '⚠ FLAGGED — TAP TO CLEAR' : '⚠ FLAG THIS PHOTO'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
  filterRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    paddingHorizontal: space.gutter, paddingBottom: 12,
  },
  filterChip: {
    paddingHorizontal: 14, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
  },
  filterChipOn: { backgroundColor: color.accent, borderColor: color.accent },
  filterChipText: { ...font(700, 12), color: color.text45 },
  filterChipTextOn: { color: color.ink },
  sectionHeader: { ...font(700, 11, { mono: true, ls: 0.8 }), color: color.accent, marginTop: 16, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badges: { position: 'absolute', top: 5, left: 5, flexDirection: 'row', gap: 4 },
  badge: { backgroundColor: 'rgba(0,0,0,0.65)', color: '#FFF', fontSize: 9, fontWeight: '800', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden' },
  empty: { ...font(500, 13), color: color.text45, textAlign: 'center', marginTop: 60 },
  hint: { ...font(500, 11), color: color.text40, textAlign: 'center', paddingVertical: 10 },
  viewerScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  viewerImgWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImg: { width: '100%', height: '100%' },
  // Yellow border feedback matching the camera's flag toggle — visible at a
  // glance whether the photo you're looking at is flagged. Rounded to roughly
  // match a modern phone's physical corner radius; a sharp-cornered border
  // against a rounded screen edge reads as "cut off" rather than intentional.
  viewerImgFlagged: { borderWidth: 6, borderColor: '#f2c744', borderRadius: 34 },
  viewerPanel: { padding: 16, paddingBottom: 28, borderTopWidth: 1, borderTopColor: '#222', backgroundColor: '#0d0d0f' },
  viewerMetaText: { ...font(700, 12, { mono: true, ls: 0.5 }), color: '#FFF', marginBottom: 8 },
  viewerBtns: { flexDirection: 'row', gap: 10, marginTop: 4 },
  noteCancel: { flex: 1, height: 46, borderRadius: radius.spaceCard, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1a1e', borderWidth: 1, borderColor: '#2a2a30' },
  noteCancelText: { ...font(700, 14), color: color.textPrimary },
  flagBtn: {
    flex: 2, height: 46, borderRadius: radius.spaceCard, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#1a1a1e', borderWidth: 1, borderColor: '#e5484d',
  },
  flagBtnOn: { backgroundColor: '#f2c744', borderColor: '#f2c744' },
  flagBtnText: { ...font(800, 13), color: '#e5484d' },
  flagBtnTextOn: { color: '#1a1200' },
});
