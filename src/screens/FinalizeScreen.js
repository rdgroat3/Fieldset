import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, Image, FlatList, SectionList, Modal, Alert, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop, Press } from '../components/Surface';
import { color, radius, space, font, gradient, angle } from '../theme/tokens';
import { LinearGradient } from 'expo-linear-gradient';
import { SYSTEMS } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { deleteAppFile, sweepAssets } from '../utils/media';

const pad2 = (n) => String(n).padStart(2, '0');
const roomKey = (p) => `${p.level}\u0000${p.space}\u0000${p.spaceNum || 1}`;
const roomLabelOf = (p) => `LEVEL ${p.level}  \u00b7  ${p.space} #${pad2(p.spaceNum || 1)}`;

/**
 * Sits between CameraScreen's "Finish" and ProjectHome (the survey hub).
 * This is the review-and-clean-up pass: select individual photos/videos OR
 * whole rooms, then bulk-tag (Mech/Elec/Plmb/FP/Gen — multi-select, same as
 * the tags that used to live on the camera toolbar), bulk-delete, or bulk
 * re-tag to a different room (e.g. a mis-tagged "Office #01" batch moved to
 * "Office #02" in one action instead of one photo at a time).
 *
 * "Complete" hands off to ProjectHome, which remains the true final page
 * (summary + export).
 */
export default function FinalizeScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { projectId } = route.params || {};
  const { projects, updatePhotos, deletePhotos } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const { width } = useWindowDimensions();

  const [selected, setSelected] = useState(() => new Set());
  const [roomPicker, setRoomPicker] = useState(false);
  const [tagPicker, setTagPicker] = useState(false);
  const [viewer, setViewer] = useState(null);

  const sections = useMemo(() => {
    if (!project) return [];
    const map = {};
    project.photos.forEach((p) => {
      const key = roomKey(p);
      map[key] = map[key] || { key, label: roomLabelOf(p), items: [] };
      map[key].items.push(p);
    });
    return Object.values(map)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((g) => ({ title: g.label, key: g.key, data: [g.items] }));
  }, [project]);

  if (!project) return null;

  const thumb = (width - space.gutter * 2 - 8 * 2) / 3;
  const selCount = selected.size;

  const toggleOne = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const roomIds = (key) => {
    const group = sections.find((s) => s.key === key);
    return group ? group.data[0].map((p) => p.id) : [];
  };

  const isRoomFullySelected = (key) => {
    const ids = roomIds(key);
    return ids.length > 0 && ids.every((id) => selected.has(id));
  };

  const toggleRoom = (key) => {
    const ids = roomIds(key);
    const allOn = isRoomFullySelected(key);
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (allOn ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  // Bulk tag: SYSTEMS is multi-select and additive/removable per tap, same
  // model as the old camera chips — tapping a tag here toggles it across
  // every selected item. Because selected items may currently hold a mix of
  // tags, "toggle" is evaluated against whether the MAJORITY already have it
  // (simpler and more predictable than a tri-state control): if most already
  // have it, tapping removes it from all; otherwise tapping adds it to all.
  // Photos saved before the GEN default shipped have no systems[] at all.
  // Reading them as GEN (rather than as untagged) keeps the badge, the tag
  // picker's on/off state, and applyTag's floor all telling the same story
  // without needing a storage migration.
  const systemsOf = (p) => (Array.isArray(p.systems) && p.systems.length ? p.systems : ['GEN']);

  const selectedPhotos = project.photos.filter((p) => selected.has(p.id));
  const tagCoverage = (tag) => {
    if (selectedPhotos.length === 0) return 0;
    const withTag = selectedPhotos.filter((p) => systemsOf(p).includes(tag)).length;
    return withTag / selectedPhotos.length;
  };

  const applyTag = (tag) => {
    const majorityHasIt = tagCoverage(tag) >= 0.5;
    updatePhotos(projectId, Array.from(selected), (ph) => {
      const cur = systemsOf(ph);
      let nextSystems = majorityHasIt ? cur.filter((x) => x !== tag) : [...new Set([...cur, tag])];
      // Adding a real discipline retires the GEN default automatically —
      // "GEN+MECH" isn't meaningful, and making the surveyor un-tick GEN by
      // hand on every photo would defeat the point of defaulting to it.
      if (!majorityHasIt && tag !== 'GEN') nextSystems = nextSystems.filter((x) => x !== 'GEN');
      // Never leave a photo with nothing: untagged is exactly the state the
      // GEN default exists to prevent, so falling to empty here would let it
      // back in through the side door.
      if (nextSystems.length === 0) nextSystems = ['GEN'];
      return { systems: nextSystems, system: nextSystems.join('+') };
    });
  };

  const applyRoom = (spaceType, spaceNum) => {
    updatePhotos(projectId, Array.from(selected), { space: spaceType, spaceNum });
    setRoomPicker(false);
    clearSelection();
  };

  const confirmDelete = () => {
    const ids = Array.from(selected);
    const toDelete = project.photos.filter((p) => ids.includes(p.id));
    Alert.alert(
      `Delete ${ids.length} item${ids.length > 1 ? 's' : ''}?`,
      'Removes them from this survey (and the camera roll copy if present). This can\u2019t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            const assetIds = toDelete.map((p) => p.assetId).filter(Boolean);
            if (assetIds.length) await sweepAssets(assetIds);
            await Promise.all(toDelete.map((p) => deleteAppFile(p.uri)));
            deletePhotos(projectId, ids);
            clearSelection();
          },
        },
      ]
    );
  };

  const complete = () => navigation.navigate('ProjectHome', { projectId });

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={s.header}>
          <Pressable onPress={() => navigation?.goBack?.()} hitSlop={12}>
            <Text style={s.back}>{'\u2039 Back'}</Text>
          </Pressable>
          <Text style={s.h1}>Finalize</Text>
          <View style={{ width: 44 }} />
        </View>

        <Text style={s.subhead}>
          {selCount > 0
            ? `${selCount} selected`
            : 'Select photos or whole rooms to tag, move, or delete'}
        </Text>

        <SectionList
          style={{ flex: 1 }}
          sections={sections}
          keyExtractor={(item, i) => 'row' + i}
          contentContainerStyle={{ padding: space.gutter, paddingTop: 4, paddingBottom: selCount > 0 ? 210 : 100 }}
          ListEmptyComponent={<Text style={s.empty}>No photos yet.</Text>}
          ListFooterComponent={
            selCount === 0 ? (
              <Text style={s.hint}>{'Tap to select \u00b7 long-press to preview \u00b7 tap a room header to select the whole room'}</Text>
            ) : null
          }
          renderSectionHeader={({ section }) => (
            <Pressable style={s.sectionHeaderRow} onPress={() => toggleRoom(section.key)}>
              <View style={[s.roomCheck, isRoomFullySelected(section.key) && s.roomCheckOn]}>
                {isRoomFullySelected(section.key) && <Text style={s.roomCheckMark}>{'\u2713'}</Text>}
              </View>
              <Text style={s.sectionHeader}>{section.title}</Text>
              <Text style={s.sectionHint}>SELECT ROOM</Text>
            </Pressable>
          )}
          renderItem={({ item: group }) => (
            <View style={s.grid}>
              {group.map((p) => {
                const on = selected.has(p.id);
                return (
                  <Pressable
                    key={p.id}
                    onPress={() => toggleOne(p.id)}
                    onLongPress={() => setViewer(p)}
                  >
                    <View>
                      <Image
                        source={{ uri: p.uri }}
                        style={{ width: thumb, height: thumb, borderRadius: radius.spaceCard, backgroundColor: color.cardFill }}
                      />
                      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius.spaceCard }, on && s.thumbSelectedOverlay]} />
                      <View style={s.badges}>
                        {p.type === 'video' && <Text style={s.badge}>{'\u25b6'}</Text>}
                        {p.flagged && <Text style={[s.badge, { backgroundColor: '#e5484d' }]}>{'\u26a0'}</Text>}
                        {p.stampFailed && <Text style={[s.badge, { backgroundColor: '#e5484d' }]}>NO STAMP</Text>}
                        <Text style={[s.badge, { backgroundColor: color.accent }]}>{systemsOf(p).join('+')}</Text>
                      </View>
                      <View style={[s.selectDot, on && s.selectDotOn]}>
                        {on && <Text style={s.selectDotMark}>{'\u2713'}</Text>}
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        />
      </View>

      {/* Bulk action bar — appears once anything is selected. */}
      {selCount > 0 && (
        <View style={[s.actionBar, { paddingBottom: insets.bottom + 12 }]}>
          <View style={s.actionRow}>
            <Press onPress={() => setTagPicker(true)} style={{ flex: 1 }}>
              <View style={s.actionBtn}>
                <Text style={s.actionBtnText}>{'\ud83c\udff7 TAG'}</Text>
              </View>
            </Press>
            <Press onPress={() => setRoomPicker(true)} style={{ flex: 1 }}>
              <View style={s.actionBtn}>
                <Text style={s.actionBtnText}>{'\ud83d\udeaa MOVE'}</Text>
              </View>
            </Press>
            <Press onPress={confirmDelete} style={{ flex: 1 }}>
              <View style={[s.actionBtn, s.actionBtnDanger]}>
                <Text style={[s.actionBtnText, s.actionBtnDangerText]}>{'\ud83d\uddd1 DELETE'}</Text>
              </View>
            </Press>
          </View>
          <Press onPress={clearSelection}>
            <Text style={s.clearSel}>Clear selection</Text>
          </Press>
        </View>
      )}

      {/* Complete — hands off to the survey hub / summary page. */}
      {selCount === 0 && (
        <View style={[s.completeBar, { paddingBottom: insets.bottom + 12 }]}>
          <Press onPress={complete} scaleTo={0.98}>
            <LinearGradient
              colors={gradient.action}
              locations={gradient.actionStops}
              start={angle.d160.start}
              end={angle.d160.end}
              style={s.completeBtn}
            >
              <Text style={s.completeBtnText}>Done</Text>
            </LinearGradient>
          </Press>
        </View>
      )}

      {/* Bulk tag picker */}
      <Modal visible={tagPicker} animationType="slide" transparent>
        <View style={s.modalScrim}>
          <View style={[s.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={s.modalTitle}>Tag {selCount} item{selCount > 1 ? 's' : ''}</Text>
            <Text style={s.modalSub}>{'Tap to add across all selected \u00b7 tap again to remove'}</Text>
            <View style={s.tagGrid}>
              {/* GEN is included, not filtered out. Photos are saved tagged
                  GEN by default, so excluding it here made the default the one
                  tag the surveyor couldn't remove. It's a normal tag: toggle
                  it off once a real discipline is assigned. */}
              {SYSTEMS.map((tag) => {
                const coverage = tagCoverage(tag);
                const on = coverage >= 0.5;
                return (
                  <Pressable key={tag} onPress={() => applyTag(tag)} style={[s.tagChip, on && s.tagChipOn]}>
                    <Text style={[s.tagChipText, on && s.tagChipTextOn]}>{tag}</Text>
                    {coverage > 0 && coverage < 1 && <Text style={s.tagChipPartial}>MIXED</Text>}
                  </Pressable>
                );
              })}
            </View>
            <Pressable style={s.modalClose} onPress={() => setTagPicker(false)}>
              <Text style={s.modalCloseText}>DONE</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Bulk room reassignment: pick a space type, then a number, exactly
          like the camera's room control, so "Office #01" -> "Office #02" is
          two taps. */}
      <Modal visible={roomPicker} animationType="slide" transparent onRequestClose={() => setRoomPicker(false)}>
        <RoomPickerSheet
          insets={insets}
          spaceTypes={project.spaceTypes}
          onPick={applyRoom}
          onClose={() => setRoomPicker(false)}
        />
      </Modal>

      {/* Long-press preview */}
      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <View style={s.viewerScrim}>
          <Pressable style={s.viewerImgWrap} onPress={() => setViewer(null)}>
            {viewer && viewer.type !== 'video' && (
              <Image source={{ uri: viewer.uri }} style={s.viewerImg} resizeMode="contain" />
            )}
          </Pressable>
          <View style={s.viewerPanel}>
            <Text style={s.viewerMetaText}>{viewer ? roomLabelOf(viewer) : ''}</Text>
            <Pressable style={s.noteCancel} onPress={() => setViewer(null)}>
              <Text style={s.noteCancelText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </Backdrop>
  );
}

/** Space-type -> room-number picker, mirroring CameraScreen's room control
 *  so re-tagging a batch to "Office #02" feels the same as picking it live. */
function RoomPickerSheet({ insets, spaceTypes, onPick, onClose }) {
  const [spaceType, setSpaceType] = useState(spaceTypes?.[0] || 'Space');
  const [spaceNum, setSpaceNum] = useState(1);

  return (
    <View style={s.modalScrim}>
      <View style={[s.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
        <Text style={s.modalTitle}>Move to room</Text>
        <FlatList
          data={spaceTypes}
          keyExtractor={(x) => x}
          style={{ maxHeight: 220 }}
          renderItem={({ item }) => (
            <Pressable style={s.modalRow} onPress={() => setSpaceType(item)}>
              <Text style={[s.modalRowText, item === spaceType && { color: color.accent }]}>
                {item}{item === spaceType ? '  \u2713' : ''}
              </Text>
            </Pressable>
          )}
        />
        <View style={s.numRow}>
          <Pressable
            onPress={() => setSpaceNum((n) => Math.max(1, n - 1))}
            style={s.numBtn}
          >
            <Text style={s.numBtnText}>{'\u2212'}</Text>
          </Pressable>
          <Text style={s.numLabel}>{spaceType} #{pad2(spaceNum)}</Text>
          <Pressable onPress={() => setSpaceNum((n) => n + 1)} style={s.numBtn}>
            <Text style={s.numBtnText}>+</Text>
          </Pressable>
        </View>
        <Pressable style={s.confirmBtn} onPress={() => onPick(spaceType, spaceNum)}>
          <Text style={s.confirmBtnText}>MOVE HERE</Text>
        </Pressable>
        <Pressable style={s.modalClose} onPress={onClose}>
          <Text style={s.modalCloseText}>CANCEL</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.gutter, paddingVertical: 12,
  },
  back: { ...font(700, 14), color: color.accent },
  h1: { ...font(600, 16), color: color.textPrimary },
  subhead: { ...font(500, 12), color: color.text45, textAlign: 'center', paddingBottom: 6 },

  sectionHeaderRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginTop: 16, marginBottom: 8,
  },
  roomCheck: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: color.cardBorderSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  roomCheckOn: { backgroundColor: color.accent, borderColor: color.accent },
  roomCheckMark: { color: color.ink, fontSize: 12, fontWeight: '800' },
  sectionHeader: { ...font(700, 11, { mono: true, ls: 0.8 }), color: color.accent, flex: 1 },
  sectionHint: { ...font(700, 8, { mono: true, ls: 0.6 }), color: color.text30 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badges: { position: 'absolute', top: 5, left: 5, flexDirection: 'row', gap: 4, flexWrap: 'wrap', maxWidth: '80%' },
  badge: { backgroundColor: 'rgba(0,0,0,0.65)', color: '#FFF', fontSize: 9, fontWeight: '800', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, overflow: 'hidden' },
  thumbSelectedOverlay: { backgroundColor: 'rgba(91,141,239,.32)', borderWidth: 2, borderColor: color.accent },
  selectDot: {
    position: 'absolute', bottom: 6, right: 6, width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,.55)', borderWidth: 1.5, borderColor: 'rgba(255,255,255,.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  selectDotOn: { backgroundColor: color.accent, borderColor: color.accent },
  selectDotMark: { color: color.ink, fontSize: 12, fontWeight: '800' },

  empty: { ...font(500, 13), color: color.text45, textAlign: 'center', marginTop: 60 },
  hint: { ...font(500, 11), color: color.text40, textAlign: 'center', paddingVertical: 10 },

  actionBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#0d0d0f', borderTopWidth: 1, borderTopColor: '#222',
    paddingTop: 12, paddingHorizontal: space.gutter,
  },
  actionRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  actionBtn: {
    height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.accentTint12, borderWidth: 1, borderColor: color.accentTint40,
  },
  actionBtnText: { ...font(700, 12, { mono: true, ls: 0.4 }), color: color.accentLight },
  actionBtnDanger: { backgroundColor: 'rgba(229,72,77,.12)', borderColor: '#e5484d' },
  actionBtnDangerText: { color: '#e5484d' },
  clearSel: { ...font(600, 12), color: color.text45, textAlign: 'center' },

  completeBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingTop: 12, paddingHorizontal: space.gutter,
  },
  completeBtn: { height: 52, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' },
  completeBtnText: { ...font(700, 15), color: color.ink },

  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#15171c', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '78%', padding: 16 },
  modalTitle: { ...font(700, 16), color: color.textPrimary, marginBottom: 4 },
  modalSub: { ...font(500, 12), color: color.text45, marginBottom: 14 },
  modalRow: { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: color.cardBorder },
  modalRowText: { ...font(600, 16), color: color.textPrimary },
  modalClose: { paddingVertical: 16, alignItems: 'center' },
  modalCloseText: { ...font(700, 12, { mono: true, ls: 1 }), color: color.text40 },

  tagGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  tagChip: {
    height: 40, paddingHorizontal: 16, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6,
    backgroundColor: color.pillFill, borderWidth: 1, borderColor: color.cardBorderSoft,
  },
  tagChipOn: { backgroundColor: color.accent, borderColor: color.accent },
  tagChipText: { ...font(700, 13, { mono: true, ls: 0.4 }), color: color.text45 },
  tagChipTextOn: { color: color.ink },
  tagChipPartial: { ...font(700, 8, { mono: true, ls: 0.4 }), color: '#f2c744' },

  numRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, marginTop: 14, marginBottom: 16 },
  numBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
  },
  numBtnText: { ...font(700, 20), color: color.textPrimary },
  numLabel: { ...font(700, 15), color: color.textPrimary, minWidth: 140, textAlign: 'center' },

  confirmBtn: {
    height: 50, borderRadius: radius.button, backgroundColor: color.accent,
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  confirmBtnText: { ...font(700, 13, { mono: true, ls: 0.6 }), color: color.ink },

  viewerScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)' },
  viewerImgWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImg: { width: '100%', height: '100%' },
  viewerPanel: { padding: 16, paddingBottom: 28, borderTopWidth: 1, borderTopColor: '#222', backgroundColor: '#0d0d0f' },
  viewerMetaText: { ...font(700, 12, { mono: true, ls: 0.5 }), color: '#FFF', marginBottom: 8 },
  noteCancel: { height: 46, borderRadius: radius.spaceCard, alignItems: 'center', justifyContent: 'center', backgroundColor: '#1a1a1e', borderWidth: 1, borderColor: '#2a2a30' },
  noteCancelText: { ...font(700, 14), color: color.textPrimary },
});
