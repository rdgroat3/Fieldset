// Export engine. Everything renders on-device via expo-print (HTML -> PDF)
// and plain CSV text. Images are downscaled to keep PDFs email-friendly.

import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

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

  // Deficiency summary
  const flagged = photos.filter((p) => p.flagged);
  if (flagged.length) {
    body += `<h2>OBSERVED DEFICIENCIES (${flagged.length})</h2><table><tr><th>Level</th><th>Space</th><th>System</th><th>Note</th></tr>`;
    flagged.forEach((p) => {
      body += `<tr><td>${esc(p.level)}</td><td>${esc(spaceLabel(p))}</td><td>${esc(p.system)}</td><td>${esc(p.caption || '—')}</td></tr>`;
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
  const header = 'Item,Level,Space,System,Make,Model,Serial,Capacity,Mfg Year,Notes,Photo Timestamp';
  const lines = rows.map((p, i) => [
    i + 1, p.level, spaceLabel(p), p.system,
    p.nameplate.make, p.nameplate.model, p.nameplate.serial,
    p.nameplate.capacity, p.nameplate.year, p.caption || '', p.takenAt,
  ].map(csvEsc).join(','));
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

const safeName = (s = 'Survey') => s.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);

async function finalize(uri, rename) {
  let out = uri;
  if (rename) {
    out = FileSystem.cacheDirectory + rename;
    try { await FileSystem.moveAsync({ from: uri, to: out }); } catch (e) { out = uri; }
  }
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(out);
  return out;
}
