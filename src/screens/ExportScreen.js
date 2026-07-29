import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// NOT 'expo-file-system' — SDK 54+ made that the new File/Directory class
// API, which has no getContentUriAsync at all. utils/exports.js imports the
// same /legacy path.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Backdrop } from '../components/Surface';
import { color, radius, space, font } from '../theme/tokens';
import { useProjects } from '../store/ProjectContext';
import {
  exportPhotoLog, exportInventoryCSV, exportElectricalRiser, exportDesignerReport,
  exportReadiness, mimeOf, utiOf,
} from '../utils/exports';
import { sweepAssets, shareToGooglePhotos } from '../utils/media';

/**
 * OPENING A GENERATED FILE ON ANDROID — why this needs a native module.
 *
 * The previous implementation minted a content:// URI with
 * getContentUriAsync() and handed it to Linking.openURL(). That cannot
 * work, and it failed identically for every export, which is why "the
 * whole export screen is broken" was the accurate description.
 *
 * React Native's IntentModule.openURL builds
 *     Intent(ACTION_VIEW, uri)
 * and nothing else. Two things are missing and both are fatal:
 *
 *   1. No FLAG_GRANT_READ_URI_PERMISSION. expo-file-system's FileProvider
 *      is declared android:exported="false" (correctly — it is our private
 *      storage). Without an explicit grant on the intent, the receiving
 *      app gets a SecurityException the instant it tries to read the
 *      stream. The viewer opens and shows "can't open file", or nothing
 *      happens at all.
 *   2. No MIME type. ACTION_VIEW on a bare content:// URI matches very few
 *      intent filters, so resolution usually fails outright and openURL
 *      throws ActivityNotFoundException — which the old code caught and
 *      reported as "No viewer found", blaming the user's device for a bug
 *      in the intent.
 *
 * expo-intent-launcher sets both. It is a native module, so it needs a full
 * `eas build` — but it is required-lazily here so that this file still
 * works if it is shipped over `eas update` ahead of that build: View simply
 * degrades to the share sheet (which DOES grant URI permission — see
 * SharingModule's grantUriPermission call) instead of crashing.
 */
let IntentLauncher = null;
try {
  // eslint-disable-next-line global-require
  IntentLauncher = require('expo-intent-launcher');
} catch (e) {
  IntentLauncher = null;
}
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
// Without NEW_TASK the viewer is pushed onto Fieldset's own task stack, so
// the back gesture out of the PDF reader lands somewhere confusing instead
// of returning here.
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

export default function ExportScreen({ route, navigation }) {
  const insets = useSafeAreaInsets();
  const { projectId } = route.params || {};
  const { projects, settings, updateProject } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  const [busy, setBusy] = useState(null);       // `${key}:${mode}` or a bare key
  const [progress, setProgress] = useState(null); // { done, total, stage }

  const ready = useMemo(() => (project ? exportReadiness(project) : null), [project]);

  /**
   * OPEN — hand the file to a viewer app.
   *
   * The previous build fell back to the share sheet whenever the intent
   * path was unavailable, which is why Open still said "Sharing 1 file":
   * a silent fallback to the exact thing the other button already does.
   * Share is Share. Open must open, or say plainly why it can't.
   *
   * Two Android details that matter:
   *
   * 1. startActivityAsync's promise resolves when the VIEWER CLOSES, not
   *    when it launches — the native side uses startActivityForResult. So
   *    this must not be awaited to completion, or the button sits on
   *    "OPENING…" for as long as the person is reading their PDF. A launch
   *    failure rejects almost immediately, so racing the promise against a
   *    short timer cleanly separates "couldn't launch" from "launched, and
   *    they're still in there".
   *
   * 2. The module keeps a single `pendingPromise` and throws
   *    ActivityAlreadyStartedException if a second call arrives while one
   *    is outstanding. Navigating away from the viewer without closing it
   *    leaves that promise pending, so the NEXT Open would throw forever.
   *    That specific error means the previous viewer is still open, which
   *    is not a failure worth reporting.
   */
  const openFile = useCallback(async (uri) => {
    if (!uri) return;

    if (Platform.OS !== 'android') {
      // iOS has no general "open in" intent; Quick Look inside the share
      // sheet is the platform's actual document viewer.
      try { await Sharing.shareAsync(uri, { UTI: utiOf(uri), mimeType: mimeOf(uri) }); } catch (e) {}
      return;
    }

    if (!IntentLauncher?.startActivityAsync) {
      Alert.alert(
        'Open needs the new build',
        'The file was created and is saved on this device. Opening it in a viewer needs the expo-intent-launcher module, which only ships in a full build \u2014 an over-the-air update can\u2019t add it.\n\nUntil then, use Share to send it to Drive, Files, or a browser.',
        [
          { text: 'OK', style: 'cancel' },
          { text: 'Share instead', onPress: () => Sharing.shareAsync(uri, { mimeType: mimeOf(uri), UTI: utiOf(uri) }).catch(() => {}) },
        ]
      );
      return;
    }

    let contentUri;
    try {
      contentUri = await FileSystem.getContentUriAsync(uri);
    } catch (e) {
      Alert.alert('Could not open', `The file was created but couldn\u2019t be prepared for another app.\n\n${String(e?.message || e)}`);
      return;
    }

    const launch = IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
      type: mimeOf(uri),
    });

    // Swallow the eventual settle so a rejection after we've stopped
    // watching doesn't surface as an unhandled promise rejection.
    const outcome = await Promise.race([
      launch.then(() => ({ ok: true }), (err) => ({ ok: false, err })),
      new Promise((res) => setTimeout(() => res({ ok: true, launched: true }), 500)),
    ]);
    launch.catch(() => {});

    if (outcome.ok) return;

    const msg = String(outcome.err?.message || outcome.err || '');
    if (/AlreadyStarted/i.test(msg)) return; // a viewer from a previous Open is still up

    // Genuinely nothing on the device claims this type. Common for CSV on a
    // phone with no spreadsheet app; rare for PDF and HTML.
    const kind = /\.csv$/i.test(uri) ? 'spreadsheet' : /\.html?$/i.test(uri) ? 'browser' : 'PDF';
    Alert.alert(
      'No app to open this',
      `The file was created and saved. Nothing installed on this device opens ${/\.csv$/i.test(uri) ? 'CSV files' : /\.html?$/i.test(uri) ? 'local HTML files' : 'PDFs'} \u2014 install a ${kind} app, or send it somewhere else with Share.`,
      [
        { text: 'OK', style: 'cancel' },
        { text: 'Share', onPress: () => Sharing.shareAsync(uri, { mimeType: mimeOf(uri), UTI: utiOf(uri) }).catch(() => {}) },
      ]
    );
  }, []);

  const run = useCallback(async (key, fn, guardMsg, mode = 'view') => {
    if (guardMsg) { Alert.alert('Nothing to export yet', guardMsg); return; }
    setBusy(`${key}:${mode}`);
    setProgress(null);
    try {
      const uri = await fn(project, settings, {
        share: mode === 'share',
        onProgress: (p) => setProgress(p),
      });
      if (mode === 'view') await openFile(uri);
    } catch (e) {
      Alert.alert('Export failed', String(e?.message || e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [project, settings, openFile]);

  // A 200-photo report takes a couple of minutes and pins the phone. Say so
  // up front rather than letting it look frozen — "it hung" was a large part
  // of "exports are broken".
  const runHeavy = useCallback((key, fn, guardMsg, mode) => {
    if (guardMsg || !ready?.heavy) { run(key, fn, guardMsg, mode); return; }
    Alert.alert(
      'Large survey',
      `This survey has ${ready.photos} photos. Building the file re-encodes every one of them and can take a few minutes \u2014 keep the app open and on this screen while it runs.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Build it', onPress: () => run(key, fn, guardMsg, mode) },
      ]
    );
  }, [ready, run]);

  const saveToGooglePhotos = () => {
    const media = (project.photos || []).filter((p) => p.uri);
    if (media.length === 0) { Alert.alert('Nothing to save', 'Capture some photos or video first.'); return; }
    Alert.alert(
      'Save to Google Photos',
      `Photos already save automatically to the "${project.name}" album in your photo library, and Google Photos backs that up if backup is turned on. ` +
      `To send all ${media.length} item(s) directly now, the share sheet opens once per item \u2014 pick Google Photos each time.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Share ${media.length} item(s)`,
          onPress: async () => {
            setBusy('gphotos');
            let failed = 0;
            try {
              for (let i = 0; i < media.length; i++) {
                setProgress({ stage: 'photos', done: i + 1, total: media.length });
                try { await shareToGooglePhotos(media[i].uri); } catch (e) { failed += 1; }
              }
            } finally {
              setBusy(null);
              setProgress(null);
            }
            if (failed) Alert.alert('Partly done', `${failed} of ${media.length} item(s) could not be shared \u2014 their files may no longer be on this device.`);
          },
        },
      ]
    );
  };

  const sweep = () => {
    const ids = (project.photos || []).map((p) => p.assetId).filter(Boolean);
    if (ids.length === 0) { Alert.alert('Nothing to sweep', 'No camera-roll copies from this survey were found.'); return; }
    Alert.alert(
      'Sweep camera roll?',
      `Removes ${ids.length} photos/videos this survey saved to your photo library. App copies and exports are kept. Personal photos are never touched.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sweep',
          style: 'destructive',
          onPress: async () => {
            const n = await sweepAssets(ids);
            updateProject(projectId, {
              photos: project.photos.map((p) => ({ ...p, assetId: null })),
              sweptAt: new Date().toISOString(),
            });
            Alert.alert('Done', `${n} items removed from your photo library.`);
          },
        },
      ]
    );
  };

  if (!project) {
    // Reachable: the Deliverables shortcut used to pass an id for a survey
    // that had since been deleted, and this screen just rendered nothing —
    // a blank page with no way back, indistinguishable from a crash.
    return (
      <Backdrop>
        <View style={[s.centered, { paddingTop: insets.top + 60 }]}>
          <Text style={s.emptyTitle}>Survey not found</Text>
          <Text style={s.emptyBody}>It may have been deleted. Pick another from Recent Surveys.</Text>
          <TouchableOpacity style={[s.cta, { paddingHorizontal: 22, marginTop: 18 }]} onPress={() => navigation.navigate('Projects')}>
            <Text style={s.ctaText}>RECENT SURVEYS</Text>
          </TouchableOpacity>
        </View>
      </Backdrop>
    );
  }

  const label = (key, mode, fallback) => {
    if (busy !== `${key}:${mode}`) return fallback;
    if (progress?.total) {
      return progress.stage === 'building'
        ? 'ASSEMBLING\u2026'
        : `${progress.done}/${progress.total}\u2026`;
    }
    return 'WORKING\u2026';
  };

  const Card = ({ title, sub, status, statusTone, cta, onPress, onView, onShare, busyKey, accent }) => (
    <View style={[s.card, accent && s.cardAccent]}>
      <Text style={s.cardTitle}>{title}</Text>
      <Text style={s.cardSub}>{sub}</Text>
      {status ? (
        <Text style={[s.status, statusTone === 'warn' && s.statusWarn, statusTone === 'good' && s.statusGood]}>{status}</Text>
      ) : null}
      {onPress ? (
        <TouchableOpacity style={s.cta} onPress={onPress} disabled={busy !== null}>
          <Text style={s.ctaText}>
            {busy === busyKey
              ? (progress?.total ? `${progress.done}/${progress.total}\u2026` : 'WORKING\u2026')
              : cta}
          </Text>
        </TouchableOpacity>
      ) : (
        <View style={s.ctaRow}>
          <TouchableOpacity style={[s.cta, s.ctaPrimary]} onPress={onView} disabled={busy !== null}>
            <Text style={s.ctaText}>{label(busyKey, 'view', 'OPEN')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.cta, s.ctaGhost]} onPress={onShare} disabled={busy !== null}>
            <Text style={[s.ctaText, s.ctaGhostText]}>{label(busyKey, 'share', '\u2934  SHARE')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  const noPhotos = ready.photos === 0 ? 'Capture some photos first.' : null;
  const noNameplates = ready.nameplates === 0
    ? 'Scan some nameplates first \u2014 Nameplate mode in Capture, or the Decoder tool.'
    : null;
  const noPanels = ready.panels === 0
    ? 'Start at least one panel session first, and tag "Fed From" as you go.'
    : null;

  return (
    <Backdrop>
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <View style={s.header}>
          {/* No back button. It rendered as "bac" / "k" on two lines — the
              style gave it a fixed 44px width to balance the spacer on the
              right, and "‹ Back" doesn't fit in 44px at 14pt. Rather than
              re-tune the width: this screen is reached from the survey home
              tile and the Deliverables shortcut, both of which the hardware
              back gesture already returns to, and no other full-bleed screen
              in the app carries one either. Removing it also lets the title
              and project name use the full width. */}
          <Text style={s.h1}>Deliverables</Text>
          <Text numberOfLines={1} style={s.h2}>{project.name}</Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: space.gutter, paddingTop: 4, paddingBottom: 40 }}>
          <View style={s.summary}>
            <Stat n={ready.photos} l="PHOTOS" />
            <Stat n={ready.flagged} l="FLAGS" tone={ready.flagged > 0 ? 'warn' : null} />
            <Stat n={ready.nameplates} l="NAMEPLATES" />
            <Stat n={ready.panels} l="PANELS" />
          </View>
          <Text style={s.sub}>
            {'Everything is generated on this phone. Open one to check it, or share it to email, Drive, Teams \u2014 anywhere.'}
          </Text>

          <Text style={s.sectionLabel}>THE DELIVERABLE</Text>
          <Card
            accent
            title="Survey Report"
            sub="The full deliverable as one PDF \u2014 cover sheet, findings summary, deficiency schedule, equipment schedule sorted worst-first, riser, and the figure-numbered photo log, with a stated basis at the back. Opens anywhere a PDF opens."
            status={
              ready.atRisk > 0
                ? `${ready.atRisk} unit(s) at or near end of service life`
                : ready.nameplatesWithYear > 0
                  ? `${ready.nameplatesWithYear} unit(s) with a decoded manufacture year`
                  : null
            }
            statusTone={ready.atRisk > 0 ? 'warn' : 'good'}
            busyKey="report"
            onView={() => runHeavy('report', exportDesignerReport, noPhotos, 'view')}
            onShare={() => runHeavy('report', exportDesignerReport, noPhotos, 'share')}
          />

          <Text style={s.sectionLabel}>DOCUMENTS FOR THE REPORT SET</Text>
          <Card
            title="Existing Conditions Photo Log"
            sub={`${ready.photos} photos grouped by level and space, numbered and captioned, with deficiency and equipment-condition tables. PDF, ready to drop in as an appendix.`}
            busyKey="log"
            onView={() => runHeavy('log', exportPhotoLog, noPhotos, 'view')}
            onShare={() => runHeavy('log', exportPhotoLog, noPhotos, 'share')}
          />
          <Card
            title="Equipment Inventory"
            sub={`${ready.nameplates} nameplate record(s) \u2192 CSV (make, model, serial, capacity, year, age, remaining life, refrigerant flag, location). Opens in Excel.`}
            status={
              ready.nameplates > 0 && ready.nameplatesWithYear < ready.nameplates
                ? `${ready.nameplates - ready.nameplatesWithYear} record(s) have no decoded year \u2014 no condition assessment for those rows`
                : null
            }
            statusTone="warn"
            busyKey="csv"
            onView={() => run('csv', exportInventoryCSV, noNameplates, 'view')}
            onShare={() => run('csv', exportInventoryCSV, noNameplates, 'share')}
          />
          <Card
            title="Electrical Riser (Panel Feed Tree)"
            sub={'Built from each panel\u2019s "Fed From" tag \u2014 a starting point for the CAD one-line, not a substitute for it.'}
            status={
              ready.panels > 0 && ready.panelsFedFromSet < ready.panels
                ? `${ready.panels - ready.panelsFedFromSet} of ${ready.panels} panel(s) have no "Fed From" set \u2014 they will show under Utility Service`
                : ready.panels > 0 ? 'All panels tagged' : null
            }
            statusTone={ready.panelsFedFromSet < ready.panels ? 'warn' : 'good'}
            busyKey="riser"
            onView={() => run('riser', exportElectricalRiser, noPanels, 'view')}
            onShare={() => run('riser', exportElectricalRiser, noPanels, 'share')}
          />
          <Card
            title="Panel Profile Sheets"
            sub={`${ready.panels} panel session(s). Each panel exports as its own single-page PDF from its session screen.`}
            cta="GO TO PANELBOARDS"
            busyKey="panels"
            onPress={() => navigation.navigate('Panels', { projectId })}
          />

          <Text style={s.sectionLabel}>PHOTOS & CLOSE-OUT</Text>
          <Card
            title="Save to Google Photos"
            sub={`Photos already save to a "${project.name}" album in your phone\u2019s library \u2014 if Google Photos backup is on, they sync automatically. Use this to push all ${ready.photos + ready.videos} item(s) across now.`}
            cta="SAVE TO GOOGLE PHOTOS"
            busyKey="gphotos"
            onPress={saveToGooglePhotos}
          />

          <TouchableOpacity style={s.sweep} onPress={sweep} disabled={busy !== null}>
            <Text style={s.sweepText}>Close out: sweep this survey from camera roll</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Backdrop>
  );
}

function Stat({ n, l, tone }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statNum, tone === 'warn' && n > 0 && { color: '#e5484d' }]}>{n}</Text>
      <Text style={s.statLabel}>{l}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  header: { paddingHorizontal: space.gutter, paddingTop: 14, paddingBottom: 10 },
  h1: { ...font(600, 20, { lh: 1.1, ls: -0.2 }), color: color.textPrimary },
  h2: { ...font(400, 12), color: color.text45, marginTop: 4 },
  sub: { ...font(400, 12, { lh: 1.5 }), color: color.text45, marginBottom: 16 },

  summary: {
    flexDirection: 'row', backgroundColor: color.cardFill, borderRadius: radius.card,
    borderWidth: 1, borderColor: color.cardBorder, marginBottom: 14,
  },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  statNum: { ...font(700, 19), color: color.textPrimary },
  statLabel: { ...font(700, 8.5, { mono: true, ls: 0.6 }), color: color.text40, marginTop: 2 },

  sectionLabel: { ...font(700, 10, { mono: true, ls: 0.9 }), color: color.text40, marginTop: 10, marginBottom: 8 },

  card: { backgroundColor: color.cardFill, borderWidth: 1, borderColor: color.cardBorder, borderRadius: radius.card, padding: 18, marginBottom: 12 },
  cardAccent: { borderColor: color.accent, borderWidth: 1.5 },
  cardTitle: { ...font(700, 16), color: color.textPrimary },
  cardSub: { ...font(400, 12, { lh: 1.4 }), color: color.text45, marginTop: 6 },
  status: { ...font(600, 11, { lh: 1.4 }), color: color.text50, marginTop: 8 },
  statusWarn: { color: '#d29922' },
  statusGood: { color: '#3fb950' },

  cta: { marginTop: 14, backgroundColor: color.accent, borderRadius: radius.button, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  ctaText: { ...font(700, 13), color: color.ink },
  ctaRow: { flexDirection: 'row', gap: 8 },
  ctaPrimary: { flex: 1.3 },
  ctaGhost: { flex: 1, backgroundColor: color.accentTint12, borderWidth: 1, borderColor: color.accentTint40 },
  ctaGhostText: { color: color.accentLight },

  sweep: { marginTop: 8, padding: 14, alignItems: 'center' },
  sweepText: { ...font(600, 12), color: color.text40 },

  centered: { flex: 1, alignItems: 'center', paddingHorizontal: 32 },
  emptyTitle: { ...font(700, 17), color: color.textPrimary },
  emptyBody: { ...font(400, 13, { lh: 1.4 }), color: color.text45, marginTop: 6, textAlign: 'center' },
});
