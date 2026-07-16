// Export engine. Everything renders on-device via expo-print (HTML -> PDF)
// and plain CSV text. Images are downscaled to keep PDFs email-friendly.

import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { assessCondition, guessEquipmentType, refrigerantFlag, PRIORITY_META } from '../data/serviceLife';

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function b64(uri, width = 860) {
  const r = await ImageManipulator.manipulateAsync(uri, [{ resize: { width } }], {
    compress: 0.6, format: ImageManipulator.SaveFormat.JPEG, base64: true,
  });
  return `data:image/jpeg;base64,${r.base64}`;
}

const spaceLabel = (ph) => ph.spaceNum ? `${ph.space} #${String(ph.spaceNum).padStart(2, '0')}` : ph.space;

async function brandHeader(settings = {}) {
  let logoImg = '';
  if (settings.logoUri) {
    try { logoImg = `<img src="${await b64(settings.logoUri, 220)}" style="height:36px;float:right"/>`; } catch (err) {}
  }
  const firm = settings.firmName ? `<div style="font-size:11px;font-weight:bold;color:#333">${esc(settings.firmName)}</div>` : '';
  return logoImg + firm;
}

const CSS = `
  body { font-family: Helvetica, Arial, sans-serif; color: #111; margin: 28px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #555; font-size: 11px; margin-bottom: 18px; }
  h2 { font-size: 13px; background: #111; color: #fff; padding: 5px 9px; margin: 22px 0 8px; }
  h3 { font-size: 12px; border-bottom: 1.5px solid #111; padding-bottom: 3px; margin: 14px 0 8px; }
  .grid { display: flex; flex-wrap: wrap; gap: 10px; }
  .cell { width: 47%; page-break-inside: avoid; margin-bottom: 10px; }
  .cell img { width: 100%; border: 1px solid #999; }
  .cap { font-size: 10px; margin-top: 3px; line-height: 1.35; }
  .num { font-weight: bold; }
  .flag { color: #B00020; font-weight: bold; }
  .np { font-size: 9.5px; color: #333; background: #F2F2F2; padding: 3px 5px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  td, th { border: 1px solid #999; padding: 4px 6px; text-align: left; }
  th { background: #EEE; }
`;

// ---------- 1. PHOTO LOG (PDF) ----------
export async function exportPhotoLog(project, settings = {}) {
  const photos = project.photos.filter((p) => p.type !== 'video');
  // Group: level -> space label -> photos
  const levels = {};
  photos.forEach((p) => {
    const lv = p.level || 'Unassigned';
    const sp = spaceLabel(p);
    levels[lv] = levels[lv] || {};
    levels[lv][sp] = levels[lv][sp] || [];
    levels[lv][sp].push(p);
  });

  let n = 0;
  let body = '';
  for (const lv of Object.keys(levels).sort()) {
    body += `<h2>LEVEL ${esc(lv)}</h2>`;
    for (const sp of Object.keys(levels[lv]).sort()) {
      body += `<h3>${esc(sp)}</h3><div class="grid">`;
      for (const p of levels[lv][sp]) {
        n += 1;
        const img = await b64(p.uri);
        const npLine = p.nameplate && (p.nameplate.make || p.nameplate.model)
          ? `<div class="np">NAMEPLATE — ${esc(p.nameplate.make || '')} ${esc(p.nameplate.model || '')} · S/N ${esc(p.nameplate.serial || '—')} · ${esc(p.nameplate.capacity || '')} ${p.nameplate.year ? '· MFG ' + esc(p.nameplate.year) : ''}</div>`
          : '';
        body += `<div class="cell"><img src="${img}"/><div class="cap"><span class="num">Photo ${n}</span> — ${esc(p.system)} · ${esc(new Date(p.takenAt).toLocaleString())}${p.flagged ? ' <span class="flag">⚠ DEFICIENCY</span>' : ''}${p.caption ? '<br/>' + esc(p.caption) : ''}</div>${npLine}</div>`;
      }
      body += `</div>`;
    }
  }

  // Deficiency summary — includes flagged walkthrough videos, whose captions
  // carry the timestamped flag moments recorded during the walk.
  const flagged = photos.filter((p) => p.flagged);
  const flaggedVids = project.photos.filter((p) => p.type === 'video' && p.flagged);
  if (flagged.length || flaggedVids.length) {
    body += `<h2>OBSERVED DEFICIENCIES (${flagged.length + flaggedVids.length})</h2><table><tr><th>Level</th><th>Space</th><th>System</th><th>Note</th></tr>`;
    flagged.forEach((p) => {
      body += `<tr><td>${esc(p.level)}</td><td>${esc(spaceLabel(p))}</td><td>${esc(p.system)}</td><td>${esc(p.caption || '—')}</td></tr>`;
    });
    flaggedVids.forEach((v) => {
      body += `<tr><td>${esc(v.level)}</td><td>${esc(spaceLabel(v))}</td><td>${esc(v.system)}</td><td>${esc(v.caption || 'Walkthrough video')} (video — see survey files)</td></tr>`;
    });
    body += `</table>`;
  }

  // AR measurements (experimental — clearly labeled)
  const meas = project.measurements || [];
  if (meas.length) {
    body += `<h2>FIELD READINGS — EXPERIMENTAL TOOL ESTIMATES (${meas.length})</h2>
      <div style="font-size:9px;color:#B00020;margin-bottom:6px">EXPERIMENTAL TOOL OUTPUT — uncalibrated phone-hardware estimates, not for code-compliance documentation. Verify critical values with instruments.</div>
      <table><tr><th>#</th><th>Tool</th><th>Result</th><th>Detail</th><th>Time</th></tr>`;
    const TOOL = { pipe: 'AR Pipe Sizer', duct: 'AR Duct Sizer', light: 'Footcandle Meter', cct: 'Color Temp (CCT)' };
    meas.forEach((m, i) => {
      const detail = m.detail || [m.calcOD != null ? `calc OD ${m.calcOD}"` : null, m.insulation ? `insul ${m.insulation}"` : null, m.distanceM != null ? `range ${m.distanceM} m` : null].filter(Boolean).join(' · ') || '—';
      body += `<tr><td>${i + 1}</td><td>${esc(TOOL[m.kind] || m.kind)}</td><td>${esc(m.label)}</td><td>${esc(detail)}</td><td>${esc(new Date(m.at).toLocaleString())}</td></tr>`;
    });
    body += `</table>`;
  }

  const brand = await brandHeader(settings);
  const html = `<html><head><style>${CSS}</style></head><body>
    ${brand}
    <h1>${esc(project.name)} — Existing Conditions Photo Log</h1>
    <div class="sub">${esc(project.profile || '')} · Generated ${new Date().toLocaleDateString()} · ${photos.length} photos${settings.firmName ? ' · ' + esc(settings.firmName) : ''}</div>
    ${body}</body></html>`;

  const { uri } = await Print.printToFileAsync({ html });
  return finalize(uri, `${safeName(project.name)}_PhotoLog.pdf`);
}

// ---------- 2. EQUIPMENT INVENTORY (CSV) ----------
export async function exportInventoryCSV(project) {
  const rows = project.photos.filter((p) => p.nameplate && (p.nameplate.make || p.nameplate.model || p.nameplate.serial));
  const csvEsc = (v = '') => `"${String(v).replace(/"/g, '""')}"`;
  const header = 'Item,Level,Space,System,Make,Model,Serial,Capacity,Mfg Year,Age (yr),Est. Median Life (yr),Remaining Life (yr),Condition,Assessed Type,Refrigerant Flag,Notes,Photo Timestamp';
  const lines = rows.map((p, i) => {
    const np = p.nameplate;
    const year = parseInt(np.year, 10) || null;
    const typeId = np.equipmentType || guessEquipmentType(`${np.make} ${np.model} ${np.capacity}`, np.category);
    const cond = year ? assessCondition(year, typeId) : null;
    const refrig = refrigerantFlag(`${np.model} ${np.capacity}`, year);
    return [
      i + 1, p.level, spaceLabel(p), p.system,
      np.make, np.model, np.serial, np.capacity, np.year,
      cond ? cond.age : '', cond ? cond.median : '', cond ? cond.rul : '',
      cond ? PRIORITY_META[cond.priority].label : '',
      cond ? cond.typeLabel : '',
      refrig ? refrig.code : '',
      p.caption || '', p.takenAt,
    ].map(csvEsc).join(',');
  });
  const csv = [header, ...lines].join('\n');
  const path = FileSystem.cacheDirectory + `${safeName(project.name)}_EquipmentInventory.csv`;
  await FileSystem.writeAsStringAsync(path, csv);
  return finalize(path, null);
}

// ---------- 3. PANEL PROFILE SHEET (PDF) ----------
export async function exportPanelSheet(project, panel, settings = {}) {
  const sched = panel.schedulePhoto ? await b64(panel.schedulePhoto, 760) : null;
  const left = [];
  for (const u of panel.leftPhotos) left.push(await b64(u, 560));
  const right = [];
  for (const u of panel.rightPhotos) right.push(await b64(u, 560));

  const col = (imgs, title) =>
    `<td style="width:50%;vertical-align:top"><div style="font-size:10px;font-weight:bold;margin-bottom:4px">${title}</div>${imgs.map((i) => `<img src="${i}" style="width:100%;border:1px solid #999;margin-bottom:6px"/>`).join('')}</td>`;

  const brand = await brandHeader(settings);
  const html = `<html><head><style>${CSS}</style></head><body>
    ${brand}
    <h1>Panel Profile — ${esc(panel.panelId)}</h1>
    <div class="sub">${esc(project.name)} · ${esc(panel.location || '')} · Generated ${new Date().toLocaleDateString()}</div>
    <table><tr><th>Panel ID</th><th>Voltage</th><th>Bus Amps</th><th>Main</th><th>Location</th></tr>
    <tr><td>${esc(panel.panelId)}</td><td>${esc(panel.voltage || '—')}</td><td>${esc(panel.busAmps || '—')}</td><td>${esc(panel.main || '—')}</td><td>${esc(panel.location || '—')}</td></tr></table>
    ${sched ? `<h2>DIRECTORY SCHEDULE</h2><img src="${sched}" style="width:100%;border:1px solid #999"/>` : ''}
    <h2>BREAKER COLUMNS</h2>
    <table style="border:none"><tr>${col(left, 'LEFT (ODD)')}${col(right, 'RIGHT (EVEN)')}</tr></table>
  </body></html>`;

  const { uri } = await Print.printToFileAsync({ html });
  return finalize(uri, `${safeName(project.name)}_Panel_${safeName(panel.panelId)}.pdf`);
}

// ---------- 4. ELECTRICAL RISER (PDF) ----------
// Builds a fed-from tree from panel.fedFrom (set in PanelDetailScreen) and
// renders it as an indented one-line-style summary — not a drawn diagram,
// but it does the topology legwork so drafting the actual one-line in CAD
// is a transcription pass instead of detective work across loose photos.
//
// Defensive by design: a fedFrom that points at 'utility', at nothing
// (null/unset), or at a panel id that no longer exists all resolve to a
// root node rather than crashing. A cycle (A feeds B feeds A, however it
// happened) is caught by the visited-set guard in walk() so rendering can
// never infinite-loop — the offending panel is dropped to a root and
// flagged instead.
export async function exportElectricalRiser(project, settings = {}) {
  const panels = project.panels || [];
  if (panels.length === 0) throw new Error('No panel sessions to build a riser from.');

  const { rows, byId } = buildRiserRows(panels);

  let body = `<table><tr><th>Panel</th><th>Fed From</th><th>Voltage</th><th>Bus</th><th>Main</th><th>Location</th></tr>`;
  for (const { panel, depth, cyclic } of rows) {
    const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(depth) + (depth > 0 ? '└ ' : '');
    body += `<tr><td>${indent}${esc(panel.panelId)}${cyclic ? ' <span class="flag">⚠ CYCLE — CHECK</span>' : ''}</td>` +
      `<td>${esc(feedLabelFor(panel, byId))}</td><td>${esc(panel.voltage || '—')}</td>` +
      `<td>${esc(panel.busAmps ? panel.busAmps + 'A' : '—')}</td><td>${esc(panel.main || '—')}</td>` +
      `<td>${esc(panel.location || '—')}</td></tr>`;
  }
  body += `</table>`;

  const unset = panels.filter((p) => !p.fedFrom).length;
  const note = unset > 0
    ? `<div style="font-size:9.5px;color:#B00020;margin:8px 0">${unset} panel(s) have no "Fed From" set and are shown under Utility Service by default — set them in each panel's session for an accurate tree.</div>`
    : '';

  const brand = await brandHeader(settings);
  const html = `<html><head><style>${CSS}</style></head><body>
    ${brand}
    <h1>${esc(project.name)} — Electrical Riser (Panel Feed Tree)</h1>
    <div class="sub">${esc(project.profile || '')} · Generated ${new Date().toLocaleDateString()} · ${panels.length} panel session(s)</div>
    <div style="font-size:9.5px;color:#555;margin-bottom:10px">Built from field-tagged "Fed From" data, not a drawn one-line — use as a starting point for the CAD riser, not a substitute for it.</div>
    ${note}
    ${body}
  </body></html>`;

  const { uri } = await Print.printToFileAsync({ html });
  return finalize(uri, `${safeName(project.name)}_ElectricalRiser.pdf`);
}

// Shared by exportElectricalRiser and the HTML designer report. See the
// verification notes above for why the orphaned-panel pass exists — a pure
// A<->B cycle disconnected from Utility would otherwise never be visited by
// the walk and would silently vanish.
function buildRiserRows(panels) {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const childrenOf = new Map(); // parent key ('utility' | panelId) -> [panel]
  const addChild = (key, panel) => {
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(panel);
  };
  for (const p of panels) {
    if (p.fedFrom === 'utility') { addChild('utility', p); continue; }
    if (p.fedFrom && byId.has(p.fedFrom) && p.fedFrom !== p.id) { addChild(p.fedFrom, p); continue; }
    addChild('utility', p);
  }
  const rows = [];
  const seen = new Set();
  const walk = (key, depth, visited) => {
    const kids = (childrenOf.get(key) || []).slice().sort((a, b) => a.panelId.localeCompare(b.panelId));
    for (const p of kids) {
      if (visited.has(p.id)) { rows.push({ panel: p, depth, cyclic: true }); continue; }
      seen.add(p.id);
      rows.push({ panel: p, depth, cyclic: false });
      walk(p.id, depth + 1, new Set([...visited, p.id]));
    }
  };
  walk('utility', 0, new Set());
  const orphaned = panels.filter((p) => !seen.has(p.id));
  for (const p of orphaned) rows.push({ panel: p, depth: 0, cyclic: true });
  return { rows, byId };
}

function feedLabelFor(panel, byId) {
  if (panel.fedFrom === 'utility' || !panel.fedFrom) return 'Utility Service';
  return byId.get(panel.fedFrom)?.panelId || 'Utility Service';
}

const safeName = (s = 'Survey') => s.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);

// ---------- 5. DESIGNER REPORT (self-contained HTML) ----------
// The actual product wedge: one file a designer opens and navigates instead
// of excavating a folder of loose photos. Everything — images, styling, the
// lightbox — is inlined, so it works offline with a double-click and no
// server. Deliberately NOT a PDF: click-to-zoom and jump links need a real
// browser, and a designer is far more likely to leave this open in a tab
// while drafting than to scroll a 40-page PDF.
export async function exportDesignerReport(project, settings = {}) {
  const photos = project.photos.filter((p) => p.type !== 'video');
  const videos = project.photos.filter((p) => p.type === 'video');
  const flagged = photos.filter((p) => p.flagged);
  const npPhotos = photos.filter((p) => p.nameplate && (p.nameplate.make || p.nameplate.model || p.nameplate.serial));
  const panels = project.panels || [];

  // Report images are for on-screen review, not print — smaller than the
  // PDF exports' width to keep the single HTML file a reasonable size.
  const THUMB_W = 480;

  // A stable, escaped anchor id so the equipment table and photo log can
  // link to the exact same photo card.
  const anchorFor = (p) => `photo-${p.id}`;

  let photoIdx = 0;

  // ---- Deficiency summary ----
  // Includes flagged walkthrough VIDEOS too — their captions carry the
  // timestamped flag moments ("Walkthrough · 2 flags @ 1:22, 3:45"), which
  // is often the most precise deficiency data in the survey.
  const flaggedVideos = videos.filter((v) => v.flagged);
  let deficiencyHtml = '';
  if (flagged.length || flaggedVideos.length) {
    deficiencyHtml = `<section id="sec-deficiencies"><h2>⚠ Observed Deficiencies (${flagged.length + flaggedVideos.length})</h2><table class="tbl"><tr><th>Level</th><th>Space</th><th>System</th><th>Note</th><th>Photo</th></tr>`;
    for (const p of flagged) {
      deficiencyHtml += `<tr><td>${esc(p.level)}</td><td>${esc(spaceLabel(p))}</td><td>${esc(p.system)}</td><td>${esc(p.caption || '—')}</td>` +
        `<td><a href="#${anchorFor(p)}" class="jump">view photo ↓</a></td></tr>`;
    }
    for (const v of flaggedVideos) {
      deficiencyHtml += `<tr><td>${esc(v.level)}</td><td>${esc(spaceLabel(v))}</td><td>${esc(v.system)}</td><td>${esc(v.caption || 'Walkthrough video')}</td>` +
        `<td>video — see survey files</td></tr>`;
    }
    deficiencyHtml += `</table></section>`;
  }

  // ---- Equipment inventory (linked to nameplate photos) ----
  let equipHtml = '';
  if (npPhotos.length) {
    equipHtml = `<section id="sec-equipment"><h2>🔩 Equipment Inventory (${npPhotos.length})</h2><table class="tbl">
      <tr><th>Make</th><th>Model</th><th>Serial</th><th>Capacity</th><th>Mfg Year</th><th>Condition</th><th>Location</th><th>Photo</th></tr>`;
    for (const p of npPhotos) {
      const np = p.nameplate;
      const year = parseInt(np.year, 10) || null;
      const typeId = np.equipmentType || guessEquipmentType(`${np.make} ${np.model} ${np.capacity}`, np.category);
      const cond = year ? assessCondition(year, typeId) : null;
      const condCell = cond
        ? `<span class="pill" style="background:${PRIORITY_META[cond.priority].color}">${PRIORITY_META[cond.priority].label}</span> ${cond.age}yr`
        : '—';
      equipHtml += `<tr><td>${esc(np.make || '—')}</td><td>${esc(np.model || '—')}</td><td>${esc(np.serial || '—')}</td>` +
        `<td>${esc(np.capacity || '—')}</td><td>${esc(np.year || '—')}</td><td>${condCell}</td>` +
        `<td>${esc(p.level)} · ${esc(spaceLabel(p))}</td><td><a href="#${anchorFor(p)}" class="jump">view ↓</a></td></tr>`;
    }
    equipHtml += `</table></section>`;
  }

  // ---- Electrical riser (if any panel sessions exist) ----
  let riserHtml = '';
  if (panels.length) {
    const { rows, byId } = buildRiserRows(panels);
    riserHtml = `<section id="sec-riser"><h2>🌳 Electrical Riser (Panel Feed Tree)</h2>
      <div class="dim">Built from field-tagged "Fed From" data — a starting point for the CAD one-line, not a substitute.</div>
      <table class="tbl"><tr><th>Panel</th><th>Fed From</th><th>Voltage</th><th>Bus</th><th>Main</th><th>Location</th></tr>`;
    for (const { panel, depth, cyclic } of rows) {
      const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(depth) + (depth > 0 ? '└ ' : '');
      riserHtml += `<tr><td>${indent}${esc(panel.panelId)}${cyclic ? ' <span class="flagText">⚠ CYCLE</span>' : ''}</td>` +
        `<td>${esc(feedLabelFor(panel, byId))}</td><td>${esc(panel.voltage || '—')}</td>` +
        `<td>${esc(panel.busAmps ? panel.busAmps + 'A' : '—')}</td><td>${esc(panel.main || '—')}</td><td>${esc(panel.location || '—')}</td></tr>`;
    }
    riserHtml += `</table></section>`;
  }

  // ---- Photo log, grouped by level -> space ----
  const levels = {};
  photos.forEach((p) => {
    const lv = p.level || 'Unassigned';
    const sp = spaceLabel(p);
    levels[lv] = levels[lv] || {};
    levels[lv][sp] = levels[lv][sp] || [];
    levels[lv][sp].push(p);
  });

  let logHtml = '<section id="sec-photolog"><h2>📷 Photo Log</h2>';
  for (const lv of Object.keys(levels).sort()) {
    logHtml += `<h3 class="levelHead">Level ${esc(lv)}</h3>`;
    for (const sp of Object.keys(levels[lv]).sort()) {
      logHtml += `<h4 class="spaceHead">${esc(sp)}</h4><div class="grid">`;
      for (const p of levels[lv][sp]) {
        photoIdx += 1;
        const img = await b64(p.uri, THUMB_W);
        const npLine = p.nameplate && (p.nameplate.make || p.nameplate.model)
          ? `<div class="np">${esc(p.nameplate.make || '')} ${esc(p.nameplate.model || '')} · S/N ${esc(p.nameplate.serial || '—')}</div>`
          : '';
        logHtml += `<div class="card" id="${anchorFor(p)}">
          <img src="${img}" onclick="openLightbox(this)" class="thumb"/>
          <div class="cap"><b>#${photoIdx}</b> ${esc(p.system)}${p.flagged ? ' <span class="flagText">⚠ FLAGGED</span>' : ''}</div>
          ${p.caption ? `<div class="capNote">${esc(p.caption)}</div>` : ''}
          ${npLine}
        </div>`;
      }
      logHtml += `</div>`;
    }
  }
  logHtml += '</section>';

  const brandLogo = settings.logoUri ? await b64(settings.logoUri, 220) : null;
  const brand = brandLogo
    ? `<img src="${brandLogo}" style="height:34px"/>`
    : (settings.firmName ? `<div class="firm">${esc(settings.firmName)}</div>` : '');

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <title>${esc(project.name)} — Survey Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; background: #f4f4f5; }
    header { background: #14161a; color: #fff; padding: 22px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
    header h1 { font-size: 18px; margin: 0; }
    header .sub { font-size: 11px; color: #aaa; margin-top: 3px; }
    nav { background: #1e2128; padding: 10px 24px; display: flex; gap: 16px; flex-wrap: wrap; position: sticky; top: 68px; z-index: 9; }
    nav a { color: #9db4e8; font-size: 12px; font-weight: 600; text-decoration: none; }
    main { max-width: 980px; margin: 0 auto; padding: 20px 24px 60px; }
    section { background: #fff; border-radius: 10px; padding: 18px 20px; margin-bottom: 18px; border: 1px solid #e2e2e5; }
    h2 { font-size: 15px; margin: 0 0 10px; }
    h3.levelHead { font-size: 13px; background: #14161a; color: #fff; padding: 6px 10px; border-radius: 6px; margin: 18px 0 8px; }
    h4.spaceHead { font-size: 12px; color: #444; border-bottom: 1.5px solid #ccc; padding-bottom: 4px; margin: 10px 0 8px; }
    .dim { font-size: 11px; color: #777; margin-bottom: 10px; }
    .firm { font-size: 12px; font-weight: 700; }
    .tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
    .tbl th, .tbl td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
    .tbl th { background: #f0f0f2; }
    .jump { color: #3a5bbf; font-weight: 600; text-decoration: none; }
    .pill { color: #fff; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
    .flagText { color: #b00020; font-weight: 700; }
    .grid { display: flex; flex-wrap: wrap; gap: 12px; }
    .card { width: 220px; scroll-margin-top: 130px; }
    .thumb { width: 100%; border-radius: 6px; border: 1px solid #ccc; cursor: zoom-in; display: block; }
    .cap { font-size: 11px; margin-top: 5px; }
    .capNote { font-size: 11px; color: #444; margin-top: 2px; }
    .np { font-size: 10px; color: #333; background: #f0f0f2; padding: 3px 5px; margin-top: 3px; border-radius: 4px; }
    #lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.92); z-index: 100; align-items: center; justify-content: center; }
    #lightbox img { max-width: 92%; max-height: 92%; }
    #lightbox .close { position: absolute; top: 16px; right: 20px; color: #fff; font-size: 28px; cursor: pointer; }
  </style>
  </head><body>
    <header>
      <div><h1>${esc(project.name)}</h1><div class="sub">${esc(project.profile || '')} · Generated ${new Date().toLocaleDateString()} · ${photos.length} photos${videos.length ? ` · ${videos.length} videos` : ''}${flagged.length ? ` · ${flagged.length} flagged` : ''}</div></div>
      ${brand}
    </header>
    <nav>
      ${flagged.length || flaggedVideos.length ? '<a href="#sec-deficiencies">⚠ Deficiencies</a>' : ''}
      ${npPhotos.length ? '<a href="#sec-equipment">🔩 Equipment</a>' : ''}
      ${panels.length ? '<a href="#sec-riser">🌳 Riser</a>' : ''}
      <a href="#sec-photolog">📷 Photo Log</a>
    </nav>
    <main id="top">
      ${deficiencyHtml}
      ${equipHtml}
      ${riserHtml}
      ${logHtml}
    </main>
    <div id="lightbox" onclick="closeLightbox()">
      <span class="close">&times;</span>
      <img id="lightboxImg" src=""/>
    </div>
    <script>
      function openLightbox(el) {
        document.getElementById('lightboxImg').src = el.src;
        document.getElementById('lightbox').style.display = 'flex';
      }
      function closeLightbox() {
        document.getElementById('lightbox').style.display = 'none';
      }
    </script>
  </body></html>`;

  const path = FileSystem.cacheDirectory + `${safeName(project.name)}_Report.html`;
  await FileSystem.writeAsStringAsync(path, html);
  return finalize(path, null);
}

async function finalize(uri, rename) {
  let out = uri;
  if (rename) {
    out = FileSystem.cacheDirectory + rename;
    try { await FileSystem.moveAsync({ from: uri, to: out }); } catch (e) { out = uri; }
  }
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(out);
  return out;
}
