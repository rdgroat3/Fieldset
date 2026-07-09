import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { C, FONT } from '../theme';
import { useProjects } from '../store/ProjectContext';

export default function ExperimentalScreen({ route, navigation }) {
  const { projectId } = route.params;
  const { projects } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const meas = project?.measurements || [];
  const count = (kind) => meas.filter((m) => m.kind === kind || (kind === 'pipe' && m.kind === 'duct')).length;

  const Tool = ({ emoji, title, sub, screen, badge }) => (
    <TouchableOpacity style={s.tool} activeOpacity={0.85} onPress={() => navigation.navigate(screen, { projectId })}>
      <Text style={s.emoji}>{emoji}</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.toolTitle}>{title}</Text>
        <Text style={s.toolSub}>{sub}</Text>
      </View>
      {badge > 0 && <View style={s.badge}><Text style={s.badgeText}>{badge}</Text></View>}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={s.root} edges={['top']}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={s.disclaimer}>
          <Text style={s.disclaimerTitle}>🧪 EXPERIMENTAL TOOLS</Text>
          <Text style={s.disclaimerBody}>
            These tools produce ESTIMATES from uncalibrated phone hardware. They are field-triage aids —
            not instruments — and must not be used for code-compliance documentation. Verify critical
            values with calibrated equipment. Saved readings appear in the Photo Log PDF under a clearly
            labeled estimates table.
          </Text>
        </View>

        <Tool emoji="📏" title="AR Pipe & Duct Sizer" screen="ARPipeSizer" badge={count('pipe')}
          sub="Not included in this build — requires the Viro AR module. See README to enable." />
        <Tool emoji="💡" title="Footcandle Meter" screen="LightMeter" badge={count('light')}
          sub="Work-plane light level vs. IES-style targets. Live sensor on Android; camera estimate on iOS." />
        <Tool emoji="🌡" title="Color Temperature (CCT)" screen="CCT" badge={count('cct')}
          sub="Aim at a white surface to estimate 2700K–6500K. Best for matching existing fixtures." />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  disclaimer: { backgroundColor: C.panel, borderWidth: 1.5, borderColor: C.amber, borderRadius: 12, padding: 14, marginBottom: 16 },
  disclaimerTitle: { ...FONT.display, color: C.amber, fontSize: 14, marginBottom: 6 },
  disclaimerBody: { color: C.inkDim, fontSize: 12, lineHeight: 17 },
  tool: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.panel, borderWidth: 1, borderColor: C.panelEdge, borderRadius: 12, padding: 16, marginBottom: 10, gap: 12 },
  emoji: { fontSize: 26 },
  toolTitle: { color: C.ink, fontSize: 15, fontWeight: '800' },
  toolSub: { color: C.inkDim, fontSize: 11.5, marginTop: 3, lineHeight: 16 },
  badge: { backgroundColor: C.amber, borderRadius: 12, minWidth: 24, height: 24, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { color: C.amberInk, fontWeight: '900', fontSize: 12 },
});
