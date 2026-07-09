import React, { useRef, useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Modal, FlatList } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, FONT, SYSTEMS, TAP } from '../theme';
import { useProjects } from '../store/ProjectContext';
import { persistToApp, saveToProjectAlbum } from '../utils/media';

const pad2 = (n) => String(n).padStart(2, '0');

export default function CaptureScreen({ route, navigation }) {
  const { projectId } = route.params;
  const { projects, addPhoto, settings } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  const cam = useRef(null);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  // Sticky tag state — initialized from the last photo taken, so parameters
  // persist across consecutive shots exactly like the spec.
  const last = project?.photos[project.photos.length - 1];
  const [level, setLevel] = useState(last?.level || project?.levels[0] || '01');
  const [space, setSpace] = useState(last?.space || project?.spaceTypes?.[0] || 'Space');
  const [spaceNum, setSpaceNum] = useState(last?.spaceNum || 1);
  const [system, setSystem] = useState(last?.system || 'MECH');
  const [mode, setMode] = useState('photo'); // photo | nameplate | video
  const [flagged, setFlagged] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [spacePicker, setSpacePicker] = useState(false);
  const [torch, setTorch] = useState(false);
  const recStart = useRef(null);
  const recFlags = useRef([]);
  const [flagCount, setFlagCount] = useState(0);

  const stamp = useMemo(() => {
    const spaceLabel = `${space} #${pad2(spaceNum)}`;
    const firm = settings?.firmName ? `  ·  ${settings.firmName}` : '';
    return `BLDG: ${project?.name ?? ''} | LVL: ${level} | SPACE: ${spaceLabel} | SYS: ${system}${firm}`;
  }, [project, level, space, spaceNum, system, settings]);

  if (!project) return null;

  if (!camPerm?.granted) {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.permBox}>
          <Text style={s.permText}>Camera access is needed to capture survey photos.</Text>
          <TouchableOpacity style={s.permBtn} onPress={requestCamPerm}>
            <Text style={s.permBtnText}>ALLOW CAMERA</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const snap = async () => {
    if (busy || !cam.current) return;
    setBusy(true);
    try {
      const photo = await cam.current.takePictureAsync({ quality: 0.9 });
      navigation.navigate('Review', {
        projectId,
        tempUri: photo.uri,
        tags: { level, space, spaceNum, system, flagged, mode },
        stamp,
      });
      setFlagged(false); // flag is per-shot; tags stay sticky
    } finally {
      setBusy(false);
    }
  };

  const markFlag = () => {
    if (!recording || recStart.current == null) return;
    recFlags.current.push((Date.now() - recStart.current) / 1000);
    setFlagCount(recFlags.current.length);
  };

  const toggleVideo = async () => {
    if (!cam.current) return;
    if (recording) {
      cam.current.stopRecording();
      return;
    }
    if (!micPerm?.granted) {
      const r = await requestMicPerm();
      if (!r.granted) return;
    }
    setRecording(true);
    recStart.current = Date.now();
    recFlags.current = [];
    setFlagCount(0);
    try {
      const video = await cam.current.recordAsync({ maxDuration: 600 });
      setRecording(false);
      if (video?.uri) {
        const appUri = await persistToApp(video.uri, 'mp4');
        const assetId = await saveToProjectAlbum(appUri, project.name);
        const flags = recFlags.current;
        const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
        const caption = flags.length
          ? `Walkthrough · ${flags.length} flag${flags.length > 1 ? 's' : ''} @ ${flags.map(fmt).join(', ')}`
          : 'Walkthrough';
        addPhoto(projectId, {
          uri: appUri, assetId, level, space, spaceNum, system,
          type: 'video', caption, flags, flagged: flags.length > 0, nameplate: null,
        });
      }
    } catch (e) {
      setRecording(false);
    }
  };

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      {/* TAG BAR — everything sticky, everything thumb-sized */}
      <View style={s.tagBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center' }}>
          {project.levels.map((lv) => (
            <TouchableOpacity key={lv} style={[s.tag, level === lv && s.tagOn]} onPress={() => setLevel(lv)}>
              <Text style={[s.tagText, level === lv && s.tagTextOn]}>L{lv}</Text>
            </TouchableOpacity>
          ))}
          <View style={s.divider} />
          {SYSTEMS.map((sys) => (
            <TouchableOpacity key={sys} style={[s.tag, system === sys && s.tagOn]} onPress={() => setSystem(sys)}>
              <Text style={[s.tagText, system === sys && s.tagTextOn]}>{sys}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* SPACE ROW: pick space type + big increment */}
      <View style={s.spaceRow}>
        <TouchableOpacity style={s.spaceBtn} onPress={() => setSpacePicker(true)}>
          <Text style={s.spaceBtnText} numberOfLines={1}>{space} #{pad2(spaceNum)}</Text>
          <Text style={s.spaceHint}>TAP TO CHANGE</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.minus} onPress={() => setSpaceNum(Math.max(1, spaceNum - 1))}>
          <Text style={s.incText}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.plus} onPress={() => setSpaceNum(spaceNum + 1)}>
          <Text style={[s.incText, { color: C.amberInk }]}>+1</Text>
        </TouchableOpacity>
      </View>

      {/* VIEWFINDER */}
      <View style={s.camWrap}>
        <CameraView
          ref={cam}
          style={StyleSheet.absoluteFill}
          facing="back"
          mode={mode === 'video' ? 'video' : 'picture'}
          enableTorch={torch}
        />
        {mode === 'nameplate' && (
          <View pointerEvents="none" style={s.npFrame}>
            <Text style={s.npFrameText}>FILL FRAME WITH NAMEPLATE</Text>
          </View>
        )}
        {/* Live watermark preview — this exact banner gets burned on save */}
        <View pointerEvents="none" style={s.stampBar}>
          <Text style={s.stampText} numberOfLines={2}>{stamp}</Text>
        </View>
        {recording && (
          <View style={s.recDot}><Text style={s.recText}>● REC{flagCount > 0 ? `  ·  ${flagCount} ⚑` : ''}</Text></View>
        )}
        {recording && (
          <TouchableOpacity style={s.flagMoment} onPress={markFlag} activeOpacity={0.7}>
            <Text style={s.flagMomentText}>⚑ FLAG MOMENT</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* BOTTOM CONTROLS */}
      <View style={s.controls}>
        <View style={s.modeRow}>
          {[['photo', 'PHOTO'], ['nameplate', 'NAMEPLATE'], ['video', 'WALKTHRU']].map(([m, lbl]) => (
            <TouchableOpacity key={m} style={[s.mode, mode === m && s.modeOn]} onPress={() => setMode(m)}>
              <Text style={[s.modeText, mode === m && { color: C.amberInk }]}>{lbl}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.shutterRow}>
          <TouchableOpacity style={[s.side, flagged && { backgroundColor: C.red, borderColor: C.red }]} onPress={() => setFlagged(!flagged)}>
            <Text style={s.sideText}>⚠</Text>
            <Text style={s.sideLabel}>{flagged ? 'FLAGGED' : 'FLAG'}</Text>
          </TouchableOpacity>

          {mode === 'video' ? (
            <TouchableOpacity style={[s.shutter, recording && { backgroundColor: C.red }]} onPress={toggleVideo}>
              <Text style={s.shutterText}>{recording ? 'STOP' : 'REC'}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.shutter} onPress={snap} disabled={busy}>
              <Text style={s.shutterText}>{busy ? '…' : ''}</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity style={[s.side, torch && { backgroundColor: C.amber, borderColor: C.amber }]} onPress={() => setTorch(!torch)}>
            <Text style={s.sideText}>🔦</Text>
            <Text style={[s.sideLabel, torch && { color: C.amberInk }]}>TORCH</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* SPACE PICKER */}
      <Modal visible={spacePicker} animationType="slide" transparent>
        <View style={s.modalScrim}>
          <View style={s.modalSheet}>
            <Text style={s.modalTitle}>Space Type</Text>
            <FlatList
              data={project.spaceTypes}
              keyExtractor={(x) => x}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={s.modalRow}
                  onPress={() => { setSpace(item); setSpaceNum(1); setSpacePicker(false); }}
                >
                  <Text style={s.modalRowText}>{item}</Text>
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity style={s.modalClose} onPress={() => setSpacePicker(false)}>
              <Text style={s.modalCloseText}>CANCEL</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  permBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  permText: { color: C.ink, textAlign: 'center', fontSize: 15, marginBottom: 18 },
  permBtn: { backgroundColor: C.amber, borderRadius: 10, paddingHorizontal: 22, paddingVertical: 14 },
  permBtnText: { ...FONT.display, color: C.amberInk },

  tagBar: { paddingHorizontal: 10, paddingVertical: 6 },
  tag: { paddingHorizontal: 13, height: 40, justifyContent: 'center', borderRadius: 8, backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, marginRight: 6 },
  tagOn: { backgroundColor: C.amber, borderColor: C.amber },
  tagText: { color: C.ink, fontWeight: '800', fontSize: 13 },
  tagTextOn: { color: C.amberInk },
  divider: { width: 1, height: 24, backgroundColor: C.panelEdge, marginHorizontal: 8 },

  spaceRow: { flexDirection: 'row', paddingHorizontal: 10, paddingBottom: 6, gap: 6 },
  spaceBtn: { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, borderRadius: 10, paddingHorizontal: 14, height: TAP + 4, justifyContent: 'center' },
  spaceBtnText: { color: C.ink, fontWeight: '800', fontSize: 16 },
  spaceHint: { ...FONT.label, color: C.inkDim, fontSize: 8 },
  minus: { width: 56, height: TAP + 4, borderRadius: 10, backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, alignItems: 'center', justifyContent: 'center' },
  plus: { width: 76, height: TAP + 4, borderRadius: 10, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center' },
  incText: { ...FONT.display, fontSize: 22, color: C.ink },

  camWrap: { flex: 1, marginHorizontal: 10, borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' },
  stampBar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 10, paddingVertical: 7 },
  stampText: { color: '#FFF', fontSize: 11, fontWeight: '700' },
  npFrame: { position: 'absolute', top: '22%', left: '8%', right: '8%', height: '34%', borderWidth: 2, borderColor: C.blue, borderRadius: 8, alignItems: 'center' },
  npFrameText: { ...FONT.label, color: C.blue, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 8, paddingVertical: 2, marginTop: -10 },
  recDot: { position: 'absolute', top: 10, right: 10, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  recText: { color: C.red, fontWeight: '800', fontSize: 12 },
  flagMoment: { position: 'absolute', bottom: 44, alignSelf: 'center', backgroundColor: C.amber, borderRadius: 12, paddingHorizontal: 22, height: 54, justifyContent: 'center', elevation: 4 },
  flagMomentText: { ...FONT.display, color: C.amberInk, fontSize: 14 },

  controls: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 },
  modeRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  mode: { flex: 1, height: 38, borderRadius: 8, backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, alignItems: 'center', justifyContent: 'center' },
  modeOn: { backgroundColor: C.amber, borderColor: C.amber },
  modeText: { ...FONT.label, color: C.ink, fontSize: 10 },
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  shutter: { width: 84, height: 84, borderRadius: 42, backgroundColor: C.amber, borderWidth: 5, borderColor: '#FFFFFF22', alignItems: 'center', justifyContent: 'center' },
  shutterText: { ...FONT.display, color: C.amberInk, fontSize: 15 },
  side: { width: 76, height: 64, borderRadius: 12, backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, alignItems: 'center', justifyContent: 'center' },
  sideText: { fontSize: 20, color: C.ink },
  sideLabel: { ...FONT.label, color: C.ink, fontSize: 8, marginTop: 2 },

  modalScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: C.panel, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '70%', padding: 16 },
  modalTitle: { ...FONT.display, color: C.ink, fontSize: 16, marginBottom: 8 },
  modalRow: { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.panelEdge },
  modalRowText: { color: C.ink, fontSize: 16, fontWeight: '600' },
  modalClose: { paddingVertical: 16, alignItems: 'center' },
  modalCloseText: { ...FONT.label, color: C.inkDim },
});
