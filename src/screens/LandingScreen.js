import React, { useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, BackHandler, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Backdrop, HeroCard, ActionCardShell, GlassCard, Press } from '../components/Surface';
import {
  SlidersIcon, PlayGlyph, DecoderIcon, ListIcon, DocIcon,
} from '../components/Icons';
import { color, radius, space, font, gradient, angle, shadow } from '../theme/tokens';
import { useProjects } from '../store/ProjectContext';

export default function LandingScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { projects } = useProjects();

  const surveysThisMonth = useMemo(() => {
    const now = new Date();
    return projects.filter((p) => {
      const d = new Date(p.createdAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
  }, [projects]);

  /**
   * Target for the Deliverables shortcut.
   *
   * Two things were wrong with the old version. It sorted by `createdAt`,
   * which is the wrong clock — resume an older survey for a second day of
   * capture and the shortcut still pointed at whatever was started most
   * recently, i.e. a survey you weren't working on. And when there were
   * several surveys it silently picked one and gave no indication which,
   * so tapping "Deliverables" landed you in an export screen for a job you
   * hadn't touched in weeks with nothing on screen naming it.
   *
   * Now: ranked by last ACTIVITY (newest capture, falling back to creation),
   * the card names the survey it will open, and when there is more than one
   * survey it stops guessing and sends you to the list to choose.
   */
  const lastActivity = (p) => {
    let t = new Date(p.createdAt).getTime() || 0;
    for (const ph of p.photos || []) {
      const c = new Date(ph.takenAt).getTime();
      if (c > t) t = c;
    }
    return t;
  };

  const recent = useMemo(() => {
    if (!projects.length) return null;
    return [...projects].sort((a, b) => lastActivity(b) - lastActivity(a))[0];
  }, [projects]);

  const deliverablesSub = projects.length === 0
    ? 'No surveys yet'
    : projects.length === 1
      ? `Export \u201c${recent.name}\u201d`
      : 'Pick a survey';

  const openDeliverables = () => {
    if (projects.length === 1) {
      navigation?.navigate?.('Export', { projectId: recent.id });
    } else {
      // pick:'export' makes the list route straight to the export screen
      // instead of the survey home — same list, explicit destination.
      navigation?.navigate?.('Projects', { pick: 'export' });
    }
  };

  // Back button on the main page asks for confirmation before exiting,
  // rather than just closing the app.
  useFocusEffect(
    React.useCallback(() => {
      const onBack = () => {
        Alert.alert('Exit Fieldset?', 'This will close the app.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Exit', style: 'destructive', onPress: () => BackHandler.exitApp() },
        ]);
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
      return () => sub.remove();
    }, [])
  );

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.wordmark}>Fieldset</Text>
          <Press onPress={() => navigation?.navigate?.('Settings')} scaleTo={0.9}>
            <View style={styles.iconHit}>
              <SlidersIcon />
            </View>
          </Press>
        </View>

        {/* Main stack */}
        <View style={styles.stack}>
          <Press onPress={() => navigation?.navigate?.('SpaceType')} scaleTo={0.985}>
            <HeroCard>
              <View style={styles.rowBetween}>
                <View style={{ flexShrink: 1 }}>
                  <Text style={styles.heroTitle}>Start Walkthrough</Text>
                  <Text style={styles.heroSub}>
                    Capture photos, readings, and nameplates as you walk the floor.
                  </Text>
                </View>
                <LinearGradient
                  colors={gradient.play}
                  locations={gradient.playStops}
                  start={angle.d160.start}
                  end={angle.d160.end}
                  style={[styles.playBtn, shadow.play]}
                >
                  <View style={{ marginLeft: 3 }}>
                    <PlayGlyph />
                  </View>
                </LinearGradient>
              </View>
            </HeroCard>
          </Press>

          <ActionCard
            title="Decoder"
            sub="Scan a nameplate for make, model & capacity"
            icon={<DecoderIcon />}
            onPress={() => navigation?.navigate?.('Decoder')}
          />
        </View>

        {/* Shortcut row */}
        <View style={[styles.shortcutRow, { paddingBottom: 22 }]}>
          <ShortcutCard
            title="Recent Surveys"
            sub={`${surveysThisMonth} this month`}
            icon={<ListIcon />}
            onPress={() => navigation?.navigate?.('Projects')}
          />
          {/* Deliverables is an ACTION on a survey, not a second copy of the
              survey list — the card names its target, and defers to the
              list rather than guessing when there's more than one. */}
          <ShortcutCard
            title="Deliverables"
            sub={deliverablesSub}
            icon={<DocIcon />}
            onPress={openDeliverables}
          />
        </View>
      </View>
    </Backdrop>
  );
}

function ActionCard({ title, sub, icon, onPress }) {
  return (
    <Press onPress={onPress} scaleTo={0.985}>
      <ActionCardShell>
        <View style={styles.rowBetween}>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.cardTitle}>{title}</Text>
            <Text style={styles.cardSub}>{sub}</Text>
          </View>
          <View style={styles.actionIcon}>{icon}</View>
        </View>
      </ActionCardShell>
    </Press>
  );
}

function ShortcutCard({ title, sub, icon, onPress }) {
  return (
    <Press onPress={onPress} style={{ flex: 1 }} scaleTo={0.97}>
      <View style={styles.shortcut}>
        <View style={styles.shortcutIcon}>{icon}</View>
        <View style={{ minWidth: 0 }}>
          <Text numberOfLines={1} style={styles.shortcutTitle}>{title}</Text>
          <Text numberOfLines={1} style={styles.shortcutSub}>{sub}</Text>
        </View>
      </View>
    </Press>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 22,
    paddingHorizontal: space.gutter,
  },
  wordmark: { ...font(600, 17, { lh: 1, ls: -0.2 }), color: color.textPrimary },
  iconHit: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },

  stack: {
    flex: 1,
    justifyContent: 'center',
    gap: space.stackGap,
    paddingHorizontal: space.gutter,
    paddingVertical: 22,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },

  heroTitle: { ...font(600, 24, { lh: 1.2, ls: -0.3 }), color: color.textPrimary },
  heroSub: { ...font(400, 12.5, { lh: 1.5 }), color: color.text50, marginTop: 6, maxWidth: 210 },
  playBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },

  cardTitle: { ...font(600, 15, { lh: 1.2 }), color: color.textPrimary },
  cardSub: { ...font(400, 11, { lh: 1.4 }), color: color.text45, marginTop: 3 },
  actionIcon: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: color.accentTint12,
    borderWidth: 1, borderColor: color.accentTint30,
    alignItems: 'center', justifyContent: 'center',
  },

  shortcutRow: { flexDirection: 'row', gap: space.shortcutGap, paddingHorizontal: space.gutter, paddingTop: 14 },
  shortcut: {
    gap: 9,
    backgroundColor: color.cardFill,
    borderWidth: 1, borderColor: color.cardBorder,
    borderRadius: radius.shortcut,
    paddingVertical: 14, paddingHorizontal: 16,
  },
  shortcutIcon: {
    width: 30, height: 30, borderRadius: radius.iconSquare,
    backgroundColor: color.accentTint12,
    alignItems: 'center', justifyContent: 'center',
  },
  shortcutTitle: { ...font(500, 13), color: color.textPrimary },
  shortcutSub: { ...font(400, 10.5, { mono: true }), color: color.text40, marginTop: 2 },
});
