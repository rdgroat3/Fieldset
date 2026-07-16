import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Image, FlatList, Alert, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Backdrop } from '../components/Surface';
import { color, radius, space, font } from '../theme/tokens';
import { useProjects } from '../store/ProjectContext';
import { deleteAppFile, sweepAssets } from '../utils/media';
import { assessCondition, guessEquipmentType, refrigerantFlag, PRIORITY_META } from '../data/serviceLife';

// Compute condition for a nameplate photo (memo-friendly, pure).
function conditionFor(np) {
  const year = parseInt(np?.year, 10) || null;
  if (!year) return null;
  const typeId = np.equipmentType || guessEquipmentType(`${np.make} ${np.model} ${np.capacity}`, np.category);
  return assessCondition(year, typeId);
}

const pad2 = (n) => String(n).padStart(2, '0');

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Lists every nameplate-tagged photo for a project \u2014 same filter
 * exports.js's exportInventoryCSV uses, so this list and the CSV always
 * agree. There's no separate equipment store: a "scan" is just a photo
 * with photo.nameplate set, whether it came from the old in-flow Nameplate
 * mode or from Decoder.
 */
export default function EquipmentScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const { projectId } = route.params || {};
  const { projects, deletePhoto } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const [selected, setSelected] = useState(null);

  const items = useMemo(() => {
    if (!project) return [];
    return project.photos.filter((p) => p.nameplate && (p.nameplate.make || p.nameplate.model || p.nameplate.serial));
  }, [project]);

  if (!project) {
    return (
      <Backdrop>
        <View style={[styles.center, { flex: 1, paddingTop: insets.top }]}>
          <Text style={styles.emptyText}>Project not found.</Text>
        </View>
      </Backdrop>
    );
  }

  const onDelete = (item) => {
    Alert.alert('Delete this scan?', item.nameplate.model || item.nameplate.make || 'Untitled equipment', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          if (item.assetId) await sweepAssets([item.assetId]);
          await deleteAppFile(item.uri);
          deletePhoto(projectId, item.id);
          setSelected(null);
        },
      },
    ]);
  };

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={styles.header}>
          <Pressable onPress={() => navigation?.goBack?.()} hitSlop={12}>
            <Text style={styles.back}>{'\u2039 Back'}</Text>
          </Pressable>
          <Text style={styles.h1}>Equipment</Text>
          <Text style={styles.count}>{items.length}</Text>
        </View>

        {items.length === 0 ? (
          <View style={[styles.center, { flex: 1 }]}>
            <Text style={styles.emptyText}>No nameplates scanned yet for this survey.</Text>
            <Text style={styles.emptySub}>Use Nameplate mode in Capture, or the Decoder icon, to scan one.</Text>
          </View>
        ) : (
          <FlatList
            contentContainerStyle={{ padding: space.gutter, paddingTop: 4, paddingBottom: 30 }}
            data={[...items].reverse()}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const cond = conditionFor(item.nameplate);
              return (
              <Pressable onPress={() => setSelected(item)}>
                <View style={styles.card}>
                  <Image source={{ uri: item.uri }} style={styles.thumb} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {[item.nameplate.make, item.nameplate.model].filter(Boolean).join(' \u00b7 ') || 'Untitled equipment'}
                    </Text>
                    <Text style={styles.cardSub} numberOfLines={1}>
                      {item.nameplate.serial ? `S/N ${item.nameplate.serial}` : 'No serial recorded'}
                      {item.nameplate.aiDecoded ? '  \u00b7  AI-decoded' : ''}
                    </Text>
                    <Text style={styles.cardMeta} numberOfLines={1}>
                      {`LVL ${item.level} \u00b7 ${item.space} #${pad2(item.spaceNum || 1)} \u00b7 ${formatDate(item.takenAt)}`}
                    </Text>
                  </View>
                  {cond && (
                    <View style={[styles.prioBadge, { backgroundColor: PRIORITY_META[cond.priority].color }]}>
                      <Text style={styles.prioText}>{PRIORITY_META[cond.priority].label}</Text>
                      <Text style={styles.prioAge}>{cond.age}yr</Text>
                    </View>
                  )}
                </View>
              </Pressable>
              );
            }}
          />
        )}

        <Modal visible={!!selected} animationType="slide" transparent>
          <View style={styles.modalScrim}>
            <View style={styles.modalSheet}>
              {selected && (
                <>
                  <Image source={{ uri: selected.uri }} style={styles.detailImg} />
                  <DetailRow label="Make" value={selected.nameplate.make} />
                  <DetailRow label="Model" value={selected.nameplate.model} />
                  <DetailRow label="Serial No." value={selected.nameplate.serial} />
                  <DetailRow label="Capacity / Rating" value={selected.nameplate.capacity} />
                  <DetailRow label="Mfg Year" value={selected.nameplate.year} />
                  {(() => {
                    const cond = conditionFor(selected.nameplate);
                    if (!cond) return null;
                    return (
                      <>
                        <View style={styles.detailRow}>
                          <Text style={styles.detailLabel}>CONDITION</Text>
                          <View style={styles.condLine}>
                            <View style={[styles.prioBadge, { backgroundColor: PRIORITY_META[cond.priority].color, marginRight: 8 }]}>
                              <Text style={styles.prioText}>{PRIORITY_META[cond.priority].label}</Text>
                            </View>
                            <Text style={[styles.detailValue, { flex: 1, marginTop: 0 }]}>{cond.summary}</Text>
                          </View>
                        </View>
                        <DetailRow label="Assessed Type" value={`${cond.typeLabel} · median ${cond.median} yr (ASHRAE)`} />
                      </>
                    );
                  })()}
                  <DetailRow label="Caption" value={selected.caption} />
                  <DetailRow label="Location" value={`LVL ${selected.level} \u00b7 ${selected.space} #${pad2(selected.spaceNum || 1)}`} />
                  <DetailRow label="Scanned" value={formatDate(selected.takenAt)} />
                  {selected.nameplate.aiDecoded && (
                    <DetailRow label="AI decode" value={`confidence: ${selected.nameplate.aiConfidence || 'unknown'}${selected.nameplate.aiNotes ? ' \u2014 ' + selected.nameplate.aiNotes : ''}`} />
                  )}

                  <View style={styles.detailActions}>
                    <Pressable style={styles.deleteBtn} onPress={() => onDelete(selected)}>
                      <Text style={styles.deleteBtnText}>Delete</Text>
                    </Pressable>
                    <Pressable style={styles.closeBtn} onPress={() => setSelected(null)}>
                      <Text style={styles.closeBtnText}>Close</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          </View>
        </Modal>
      </View>
    </Backdrop>
  );
}

function DetailRow({ label, value }) {
  if (!value) return null;
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: 8, padding: 30 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.gutter, paddingVertical: 12 },
  back: { ...font(700, 14), color: color.accent },
  h1: { ...font(600, 16), color: color.textPrimary },
  count: { ...font(700, 14), color: color.text45 },

  emptyText: { ...font(700, 15), color: color.textPrimary, textAlign: 'center' },
  emptySub: { ...font(400, 12, { lh: 1.4 }), color: color.text45, textAlign: 'center', marginTop: 6 },

  card: {
    flexDirection: 'row', gap: 12, alignItems: 'center',
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
    borderRadius: radius.card, padding: 12, marginBottom: 10,
  },
  thumb: { width: 52, height: 52, borderRadius: radius.spaceCard, backgroundColor: '#000' },
  prioBadge: { alignItems: 'center', justifyContent: 'center', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, minWidth: 58 },
  prioText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  prioAge: { color: 'rgba(255,255,255,.85)', fontSize: 9, fontWeight: '700', marginTop: 1 },
  condLine: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  cardTitle: { ...font(700, 14), color: color.textPrimary },
  cardSub: { ...font(400, 12), color: color.text45, marginTop: 2 },
  cardMeta: { ...font(600, 10), color: color.text40, marginTop: 3 },

  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,.6)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#15171c', borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '80%', padding: 20 },
  detailImg: { width: '100%', height: 180, borderRadius: radius.card, backgroundColor: '#000', marginBottom: 14 },

  detailRow: { marginBottom: 12 },
  detailLabel: { ...font(700, 11, { mono: true, ls: 0.8 }), color: color.text45 },
  detailValue: { ...font(400, 15, { lh: 1.35 }), color: color.textPrimary, marginTop: 3 },

  detailActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  deleteBtn: {
    flex: 1, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(229,72,77,.12)', borderWidth: 1, borderColor: '#e5484d',
  },
  deleteBtnText: { ...font(700, 14), color: '#e5484d' },
  closeBtn: {
    flex: 1, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder,
  },
  closeBtnText: { ...font(700, 14), color: color.textPrimary },
});
