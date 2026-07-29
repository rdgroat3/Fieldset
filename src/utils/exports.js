// ─────────────────────────────────────────────────────────────────────────
// EXPORT ENGINE
//
// Everything renders on-device: expo-print (HTML -> PDF), plain CSV text,
// and a self-contained HTML report. No servers, no network.
//
// WHY THIS FILE WAS REWRITTEN
// ---------------------------
// The previous version worked on a 5-photo test survey and fell over on a
// real one. Four independent failure modes, all of which presented to the
// surveyor as the same thing — "export is broken":
//
//   1. NO PER-ITEM ISOLATION. b64() was called bare inside the photo loop.
//      One photo whose file had gone missing (cleared app data, a failed
//      persistToApp, a legacy record with a stale cache:// uri, or simply
//      uri === null) threw, and the throw took down the ENTIRE export. A
//      200-photo report died because of one bad row. Now every image is
//      isolated: a missing file becomes a visible placeholder plus an entry
//      in a "Files not found" section, and the other 199 photos still ship.
//
//   2. UNBOUNDED PAYLOAD. Every image was inlined at a fixed 860px /
//      quality 0.6 regardless of how many there were. 200 photos is roughly
//      a 30 MB HTML string handed to expo-print, which renders through an
//      Android WebView and runs out of memory well before that. The export
//      "hung" or produced a blank/truncated PDF. Images are now sized from
//      the photo COUNT, and a running byte budget steps the size down
//      further mid-run if the estimate was optimistic. A big survey gets a
//      smaller-but-real PDF instead of no PDF.
//
//   3. STRING CONCATENATION IN A LOOP. `body += ...` over hundreds of
//      multi-hundred-KB base64 chunks is O(n^2) in Hermes and was a large
//      part of the perceived hang. All builders push into an array and
//      join once.
//
//   4. CRASH ON INCOMPLETE PANEL DATA. buildRiserRows sorted with
//      `a.panelId.localeCompare(...)`, which throws outright on any panel
//      whose panelId is undefined/null. That killed BOTH the riser PDF and
//      the designer report (which shares the same builder). Every field
//      read out of a panel is defensive now.
//
// Files are written to documentDirectory/exports/, not cacheDirectory.
// Cache can be reclaimed by Android between generating a file and the user
// picking a destination in the share sheet, which produced "file not found"
// at the worst possible moment.
// ─────────────────────────────────────────────────────────────────────────

import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { assessCondition, guessEquipmentType, refrigerantFlag, PRIORITY_META } from '../data/serviceLife';
import { decodeYearFromSerial } from '../data/hvacDecode';

/* ───────────────────────── small helpers ───────────────────────── */

const esc = (s = '') => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const safeName = (s = 'Survey') => (String(s || 'Survey').replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'Survey');

const EXPORT_DIR = FileSystem.documentDirectory + 'exports/';

async function ensureExportDir() {
  try {
    const info = await FileSystem.getInfoAsync(EXPORT_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(EXPORT_DIR, { intermediates: true });
  } catch (e) {
    // Non-fatal: finalize() falls back to cacheDirectory if this fails.
  }
}

const spaceLabel = (ph) => {
  const sp = ph.space || 'Unassigned';
  return ph.spaceNum ? `${sp} #${String(ph.spaceNum).padStart(2, '0')}` : sp;
};

const levelLabel = (ph) => ph.level || 'Unassigned';

// A takenAt that predates the field, or that got stored as something other
// than an ISO string, used to render as "Invalid Date" in the caption of
// every affected photo. Show nothing rather than nonsense.
const when = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
};

/* ───────────────────────── image budget ─────────────────────────
 *
 * expo-print renders through a WebView; the whole document has to fit in
 * memory as a string AND as a rendered page tree. There is no exact limit
 * published, and it varies by device RAM, so these are deliberately
 * conservative: better a slightly soft photo in a report that opens than a
 * crisp one in a report that doesn't exist.
 *
 * There used to be a second, larger allowance for the HTML report, on the
 * grounds that nothing rendered it on the phone. Every document is a PDF now,
 * so every document goes through the WebView print engine and every document
 * is bound by the same memory ceiling. The two-tier version is gone rather
 * than left in place unused, because a dead `print: false` branch reads like a
 * supported mode and the next person to add an export would reach for it.
 */

const PDF_BUDGET_BYTES = 14 * 1024 * 1024;

// Target width chosen from the photo count, before any budget feedback.
function widthForCount(n) {
  const tiers = [[24, 900], [60, 720], [120, 560], [240, 460], [Infinity, 380]];
  for (const [max, w] of tiers) if (n <= max) return w;
  return 380;
}

/**
 * Budgeted, failure-isolated image encoder.
 *
 * Returns { dataUri, bytes } on success or { dataUri: null, error } on
 * failure. It NEVER throws — that is the entire point. Callers render a
 * placeholder and keep going.
 *
 * `state` carries the running byte total so the encoder can step its own
 * width down when a survey turns out to be heavier than the count-based
 * estimate predicted (lots of detail-dense photos compress poorly).
 */
async function encodeImage(uri, state) {
  if (!uri) return { dataUri: null, error: 'no file recorded' };

  // Cheap existence check first. manipulateAsync on a missing file throws a
  // native error that is much harder to explain to a surveyor than "the
  // file is gone", and this is by far the most common real cause.
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return { dataUri: null, error: 'file no longer on this device' };
  } catch (e) {
    // A uri shape getInfoAsync can't stat (content://, ph://) still might
    // encode fine — fall through and let the encoder try.
  }

  const overBudget = state.bytes > state.budget * 0.75;
  const width = overBudget ? Math.round(state.width * 0.72) : state.width;
  const compress = overBudget ? 0.42 : state.compress;

  try {
    const r = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width } }],
      { compress, format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );
    if (!r?.base64) return { dataUri: null, error: 'could not be re-encoded' };
    const bytes = r.base64.length;
    state.bytes += bytes;
    return { dataUri: `data:image/jpeg;base64,${r.base64}`, bytes };
  } catch (e) {
    return { dataUri: null, error: String(e?.message || e).slice(0, 120) };
  }
}

function makeImageState(count) {
  return {
    width: widthForCount(count),
    compress: 0.55,
    budget: PDF_BUDGET_BYTES,
    bytes: 0,
  };
}

// Rendered in place of a photo whose file could not be read. Deliberately
// loud: a silently-absent photo in a numbered log is worse than an obvious
// gap, because the numbering still implies it was there.
const missingTile = (why) =>
  `<div class="missing">FILE NOT AVAILABLE<br/><span>${esc(why)}</span></div>`;

/* ───────────────────────── shared branding ───────────────────────── */


/* ─────────────────────── PRINT DESIGN SYSTEM ───────────────────────
 *
 * WHY THIS EXISTS
 * ---------------
 * The old stylesheet was eleven declarations of bare Helvetica with black
 * bars for headings. It produced a document that was legible and looked
 * exactly like what it was: raw output. That is a product problem, not a
 * cosmetic one. The reason a surveyor pays for this app is to walk out of a
 * building with something they can put their firm's name on and bill for. A
 * deliverable that visibly came out of a phone app undoes the hours it saved,
 * because the engineer now reformats it before sending it to a client.
 *
 * So this is written to the conventions of a consulting-engineering
 * existing-conditions report: a cover sheet with document control, numbered
 * sections, a contents list, figure numbers under every photograph, hairline
 * rules instead of solid black bars, small-caps letterspaced field labels,
 * and a limitations statement at the back.
 *
 * ENGINE CONSTRAINTS — these are the reason for some odd choices below.
 * expo-print renders through the platform WebView: Chromium on Android,
 * WKWebView on iOS. They do not agree on paged media, so this stylesheet
 * only uses what BOTH honour:
 *
 *   - No `position: fixed` running headers or footers. Chromium repeats them
 *     on every page; iOS paints them once and they vanish. A header that
 *     appears on page 1 of an iOS PDF and nowhere else looks worse than no
 *     header, so page furniture is done with real flowed elements instead.
 *   - No CSS counters for page numbers. Neither engine exposes page count to
 *     `content:`, so "Page 3 of 18" is not achievable. Sections are numbered
 *     instead, which is what makes a contents list useful without page refs.
 *   - `thead { display: table-header-group }` IS honoured by both, so long
 *     tables repeat their column headings across a page break. This is worth
 *     more than a running header on a document that is mostly tables.
 *   - Photo grids use inline-block, not flex. Flex children ignore
 *     `page-break-inside: avoid` in both engines, which sliced photographs in
 *     half across page boundaries.
 *   - `-webkit-print-color-adjust: exact` keeps priority fills from being
 *     dropped as "background decoration" — the colour IS the finding here.
 */
const CSS = `
  @page { size: letter; margin: 0.6in 0.55in; }

  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #16191F;
    margin: 0;
    font-size: 10.5px;
    line-height: 1.45;
  }

  /* ── Cover sheet ── */
  .cover { page-break-after: always; padding-top: 18px; }
  .cover .rule { border-top: 3px solid #16191F; margin-bottom: 6px; }
  .cover .ruleThin { border-top: 1px solid #B9BEC7; margin-top: 6px; }
  .cover .firmRow { display: table; width: 100%; margin-bottom: 22px; }
  .cover .firmCell { display: table-cell; vertical-align: middle; }
  .cover .firmCellR { display: table-cell; vertical-align: middle; text-align: right; }
  .cover .firmName { font-size: 13px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .cover .docType { font-size: 8.5px; letter-spacing: .18em; text-transform: uppercase; color: #5A6270; }
  /* pre-line so a two-part title ("Existing Conditions" / "Survey Report")
     breaks where the caller put the newline instead of wrapping at whatever
     width the page happens to be. */
  .coverTitle { font-size: 30px; font-weight: 700; line-height: 1.12; margin: 104px 0 0; letter-spacing: -.012em; white-space: pre-line; }
  .coverSub { font-size: 15px; color: #3C4351; margin-top: 10px; font-weight: 400; }
  .coverMeta { margin-top: 112px; }

  /* Document control block — the table a reviewer looks at first. */
  .dcTable { width: 100%; border-collapse: collapse; font-size: 9.5px; }
  .dcTable td { padding: 7px 0; border-bottom: 1px solid #E3E6EA; vertical-align: top; }
  .dcTable td.k {
    width: 30%; color: #5A6270; text-transform: uppercase;
    letter-spacing: .1em; font-size: 8px; font-weight: 600; padding-right: 12px;
  }
  .dcTable td.v { font-weight: 600; color: #16191F; }

  /* ── Section headings ── */
  h1 { font-size: 17px; font-weight: 700; margin: 0 0 3px; letter-spacing: -.008em; }
  .sub { color: #5A6270; font-size: 9.5px; margin-bottom: 16px; }

  h2 {
    font-size: 12.5px; font-weight: 700; margin: 26px 0 2px; padding: 0 0 5px;
    border-bottom: 2px solid #16191F; letter-spacing: -.004em;
    page-break-after: avoid;
  }
  h2 .secNo { color: #7A828F; font-weight: 700; margin-right: 8px; font-variant-numeric: tabular-nums; }
  h2 .count { color: #7A828F; font-weight: 400; font-size: 10px; }
  h2.warn { border-bottom-color: #A3182B; }
  h2.warn .secNo { color: #A3182B; }

  h3 {
    font-size: 10.5px; font-weight: 700; margin: 16px 0 6px; padding: 4px 8px;
    background: #F0F2F5; border-left: 3px solid #16191F;
    text-transform: uppercase; letter-spacing: .08em;
    page-break-after: avoid;
  }
  h4 {
    font-size: 9.5px; font-weight: 700; margin: 12px 0 6px; padding-bottom: 3px;
    border-bottom: 1px solid #C8CDD4; color: #3C4351;
    letter-spacing: .05em; text-transform: uppercase;
    page-break-after: avoid;
  }

  .lead { font-size: 10.5px; color: #3C4351; margin: 0 0 12px; max-width: 92%; }

  /* ── Contents ── */
  .toc { margin: 4px 0 0; }
  .toc div { padding: 5px 0; border-bottom: 1px solid #EDEFF2; font-size: 10px; }
  .toc .n { display: inline-block; width: 30px; color: #7A828F; font-weight: 700; font-variant-numeric: tabular-nums; }
  .toc .t { font-weight: 600; }
  .toc .d { color: #7A828F; font-weight: 400; }

  /* ── Key findings tiles ── */
  .kpis { display: table; width: 100%; border-collapse: separate; border-spacing: 6px 0; margin: 10px 0 4px; }
  .kpi { display: table-cell; width: 25%; border: 1px solid #D7DBE1; border-top: 3px solid #16191F; padding: 9px 10px; vertical-align: top; }
  .kpi.alert { border-top-color: #A3182B; }
  .kpi.watch { border-top-color: #B07200; }
  .kpi .n { font-size: 21px; font-weight: 700; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .kpi .l { font-size: 7.5px; letter-spacing: .11em; text-transform: uppercase; color: #5A6270; font-weight: 600; margin-top: 3px; }

  /* ── Tables ── */
  table { width: 100%; border-collapse: collapse; font-size: 9px; margin: 6px 0 4px; }
  thead { display: table-header-group; }
  tfoot { display: table-row-group; }
  th {
    background: #16191F; color: #fff; text-align: left; padding: 5px 6px;
    font-size: 7.5px; letter-spacing: .09em; text-transform: uppercase; font-weight: 700;
    border: 1px solid #16191F;
  }
  td { border: 1px solid #D7DBE1; padding: 4px 6px; vertical-align: top; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) td { background: #F7F8FA; }
  tr { page-break-inside: avoid; }
  td.wrap { font-variant-numeric: normal; }

  /* ── Priority + hazard chips ── */
  .pill {
    display: inline-block; color: #fff; font-size: 7px; font-weight: 700;
    padding: 2px 5px; letter-spacing: .07em; text-transform: uppercase; white-space: nowrap;
  }
  .chip {
    display: inline-block; font-size: 7px; font-weight: 700; padding: 1px 4px;
    border: 1px solid; letter-spacing: .06em; white-space: nowrap;
  }
  .r-high { color: #A3182B; border-color: #A3182B; background: #FDF2F3; }
  .r-medium { color: #7A5000; border-color: #B07200; background: #FDF8EC; }
  .r-low { color: #2A4A7C; border-color: #4C74B0; background: #F2F6FC; }
  .flag { color: #A3182B; font-weight: 700; }
  .dim { font-size: 8.5px; color: #6B7280; }

  /* ── Figure plates ──
     inline-block, not flex: flex children ignore page-break-inside in both
     print engines, which cut photographs in half across page boundaries. */
  .grid { margin: 0; }
  .cell {
    display: inline-block; width: 47.6%; vertical-align: top;
    margin: 0 3.6% 12px 0; page-break-inside: avoid;
  }
  .cell:nth-of-type(2n) { margin-right: 0; }
  .cell img { width: 100%; display: block; border: 1px solid #C8CDD4; }
  .figNo {
    font-size: 7.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
    color: #5A6270; margin-top: 4px;
  }
  .cap { font-size: 8.5px; margin-top: 1px; line-height: 1.4; }
  .capNote { font-size: 8.5px; color: #3C4351; margin-top: 2px; }
  .np {
    font-size: 8px; color: #16191F; background: #F0F2F5;
    border-left: 2px solid #7A828F; padding: 3px 5px; margin-top: 3px;
  }
  .missing {
    border: 1px dashed #A3182B; color: #A3182B; font-size: 8px; font-weight: 700;
    text-align: center; padding: 30px 8px; background: #FDF2F3;
  }
  .missing span { font-weight: 400; color: #6B7280; display: block; margin-top: 3px; }

  /* ── Callouts ── */
  .note {
    font-size: 8.5px; color: #7A1524; background: #FDF2F3;
    border-left: 3px solid #A3182B; padding: 6px 8px; margin: 8px 0;
  }
  .caveat {
    font-size: 8.5px; color: #4B5262; background: #F7F8FA;
    border-left: 3px solid #B9BEC7; padding: 6px 8px; margin: 8px 0;
  }

  /* ── Limitations page ── */
  .limits { page-break-before: always; }
  .limits p { font-size: 9px; color: #3C4351; margin: 0 0 8px; }
  .signoff { margin-top: 26px; border-top: 1px solid #B9BEC7; padding-top: 8px; font-size: 8.5px; color: #5A6270; }

  .avoidBreak { page-break-inside: avoid; }
`;

/**
 * Independent cross-check on the reported manufacture year.
 *
 * The decoder resolves printed-date-vs-serial-decode conflicts at scan time
 * and records them, but only make/model/serial/capacity/year are persisted on
 * the photo — the conflict flag is not. Rather than re-parsing stored OCR
 * (which would fight any correction the surveyor typed by hand), this re-runs
 * just the serial decode against whatever year the record now holds.
 *
 * That is the better test anyway: it cross-checks a hand-entered year the same
 * way it cross-checks a decoded one. A unit whose plate reads 2018 while its
 * serial decodes to 2009 is worth a line in the schedule either way, because
 * one of the two is wrong and which one changes the replacement date by nine
 * years.
 */
function yearCrossCheck(np, category) {
  if (!np) return null;
  const reported = parseInt(np.year, 10);
  if (!reported || !np.serial) return null;
  let d = null;
  try { d = decodeYearFromSerial(np.serial, np.make, category || np.category); } catch (e) { return null; }
  if (!d || !d.year) return null;
  if (Math.abs(d.year - reported) <= 1) return null;
  return { reported, decoded: d.year, note: d.note || null };
}

/* ───────────────────────── document furniture ─────────────────────────
 *
 * Every PDF this file produces now runs through the same cover / contents /
 * limitations scaffolding, so the four documents read as one report set from
 * one firm rather than four unrelated printouts. Shared, not copy-pasted,
 * because the previous four hand-rolled headers had already drifted apart:
 * two said "Generated", one said nothing, and only one carried the firm name.
 */

const fmtDate = (d = new Date()) =>
  d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/**
 * Deterministic document number so a re-issued report is identifiable and two
 * surveys can't collide in a shared project folder. Derived from the project
 * name and creation date rather than a timestamp, so regenerating the same
 * survey twice gives the same number — a document number that changed on
 * every export would be worse than none, because it implies a revision that
 * did not happen.
 */
function docNumber(project, suffix) {
  const base = `${project?.name || 'survey'}|${project?.createdAt || ''}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = ((h << 5) - h + base.charCodeAt(i)) | 0;
  const n = Math.abs(h % 9000) + 1000;
  const yr = String(new Date(project?.createdAt || Date.now()).getFullYear());
  return `FS-${yr}-${n}${suffix ? '-' + suffix : ''}`;
}

/**
 * Cover sheet. `rows` are the document-control entries specific to each
 * document type; everything else is common.
 */
async function coverPage(project, settings = {}, { title, subtitle, docSuffix, rows = [] }) {
  let logo = '';
  if (settings.logoUri) {
    const r = await encodeImage(settings.logoUri, { width: 320, compress: 0.85, budget: Infinity, bytes: 0 });
    if (r.dataUri) logo = `<img src="${r.dataUri}" style="height:42px"/>`;
  }
  const firm = settings.firmName ? `<div class="firmName">${esc(settings.firmName)}</div>` : '';
  // A logo already states who produced this. Repeating the firm name as text
  // beside its own logo is the kind of detail that makes a document look
  // machine-assembled, so the text name only appears when there is no logo.
  const left = logo || firm || '<div class="firmName">Field Survey</div>';
  const right = '';

  const control = [
    ['Project', project?.name || '—'],
    ...rows,
    ['Building type', project?.profile || '—'],
    ['Survey date', project?.createdAt ? fmtDate(new Date(project.createdAt)) : '—'],
    ['Issued', fmtDate()],
    ['Document no.', docNumber(project, docSuffix)],
    ['Revision', '—'],
    ['Prepared by', settings.firmName || '—'],
  ];

  return `<div class="cover">
    <div class="rule"></div>
    <div class="firmRow">
      <div class="firmCell">${left}<div class="docType">Field Survey Report Set</div></div>
      <div class="firmCellR">${right}</div>
    </div>
    <div class="coverTitle">${esc(title)}</div>
    ${subtitle ? `<div class="coverSub">${esc(subtitle)}</div>` : ''}
    <div class="coverMeta">
      <table class="dcTable">
        ${control.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td class="v">${esc(v)}</td></tr>`).join('')}
      </table>
      <div class="ruleThin"></div>
      <div class="dim" style="margin-top:8px">
        Recorded on site with Fieldset. Decoded equipment data is derived from
        nameplate photographs and is to be verified before it is relied upon for
        design, procurement or budget.
      </div>
    </div>
  </div>`;
}

/** Numbered contents list. `items` are {n, title, detail}. */
const contentsPage = (items) => !items.length ? '' : `
  <h2><span class="secNo">—</span>Contents</h2>
  <div class="toc">
    ${items.map((i) => `<div><span class="n">${i.n}</span><span class="t">${esc(i.title)}</span>${i.detail ? ` <span class="d">— ${esc(i.detail)}</span>` : ''}</div>`).join('')}
  </div>`;

/**
 * Limitations and basis-of-report page.
 *
 * Not boilerplate padding. A survey document with no stated basis invites the
 * reader to treat every decoded value as measured fact, and the decoder's own
 * notes say "verify" for good reason. Stating the basis is what makes the rest
 * of the document defensible, and its absence is one of the things that marks
 * a deliverable as unprofessional to an engineer reading it.
 */
const limitationsPage = (settings = {}, extra = [], secNo = null) => `
  <div class="limits">
    <h2><span class="secNo">${secNo == null ? '&mdash;' : secNo}</span>Basis of Report and Limitations</h2>
    <p><b>Scope.</b> This document records observed existing conditions at the
    locations photographed on the survey date. It is a record of what was
    visible and accessible at that time. It is not a commissioning report, a
    code-compliance review, or a condition assessment involving testing,
    disassembly or measurement of performance.</p>
    <p><b>Equipment data.</b> Make, model, serial number and manufacture date
    are read from nameplate photographs, in part by automated decoding of
    manufacturer numbering schemes. Those schemes are not published by most
    manufacturers and vary between plants and model years. Every decoded value
    is to be verified against the unit before it is used for procurement,
    warranty or budget purposes. Where a printed manufacture date and a
    serial-derived date disagree, the printed date is reported and the
    disagreement is noted in the equipment schedule.</p>
    <p><b>Service life.</b> Remaining useful life is calculated from ASHRAE
    median service-life data for the equipment class. It is a planning figure,
    not a prediction of failure: by definition roughly half of all units exceed
    the median, and maintenance history, duty cycle and environment affect an
    individual unit far more than its age does.</p>
    <p><b>Concealed conditions.</b> No finishes, enclosures or insulation were
    removed. Equipment above hard ceilings, inside shafts, behind locked doors
    or otherwise inaccessible on the survey date is not represented.</p>
    ${extra.map((e) => `<p>${e}</p>`).join('')}
    <div class="signoff">
      Prepared by ${esc(settings.firmName || '—')} &nbsp;&middot;&nbsp; Issued ${esc(fmtDate())}
      &nbsp;&middot;&nbsp; Recorded with Fieldset
    </div>
  </div>`;

/** Key-findings tiles. `tiles` are {n, label, tone}. */
const kpiRow = (tiles) => !tiles.length ? '' : `
  <div class="kpis">
    ${tiles.map((t) => `<div class="kpi ${t.tone || ''}"><div class="n">${esc(String(t.n))}</div><div class="l">${esc(t.label)}</div></div>`).join('')}
  </div>`;

/** Wraps a finished body in the print shell. */
const docShell = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(title)}</title>` +
  `<style>${CSS}</style></head><body>${body}</body></html>`;

/* ───────────────────────── grouping ───────────────────────── */

function groupByLevelSpace(photos) {
  const levels = new Map();
  for (const p of photos) {
    const lv = levelLabel(p);
    const sp = spaceLabel(p);
    if (!levels.has(lv)) levels.set(lv, new Map());
    const spaces = levels.get(lv);
    if (!spaces.has(sp)) spaces.set(sp, []);
    spaces.get(sp).push(p);
  }
  // Sorted, but numerically-aware: '10' should follow '2', not '1'.
  const cmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  return [...levels.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([lv, spaces]) => [lv, [...spaces.entries()].sort((a, b) => cmp(a[0], b[0]))]);
}

const nameplateOf = (p) => {
  const np = p?.nameplate;
  if (!np) return null;
  return (np.make || np.model || np.serial) ? np : null;
};

/**
 * Condition assessment for one nameplate, or null. Shared by the CSV and
 * the designer report so the two can never disagree about a unit's
 * priority — they used to run the same logic in two places.
 */
function conditionFor(np) {
  if (!np) return null;
  const year = parseInt(np.year, 10);
  if (!year || !isFinite(year)) return null;
  try {
    const typeId = np.equipmentType
      || guessEquipmentType(`${np.make || ''} ${np.model || ''} ${np.capacity || ''}`, np.category);
    return assessCondition(year, typeId);
  } catch (e) {
    return null;
  }
}

/**
 * Remaining-useful-life as a reader sees it.
 *
 * assessCondition() returns a SIGNED rul on purpose — the sign is how the
 * priority is decided, and "how far past median" is real information. But
 * printing the raw number put "22 / -4 yr" into a client-facing schedule, and a
 * negative quantity of remaining life reads as an arithmetic error rather than
 * as a finding. The first thing an engineer does with a table containing
 * "-10 yr" is stop trusting the rest of the table.
 *
 * So the model keeps the signed value and the document states the condition in
 * words. Nothing is concealed: past-life units already carry a REPLACE pill,
 * and the age column still shows exactly how old the unit is.
 */
const fmtAge = (cond) => (cond ? `${cond.age} yr` : '—');
const fmtRul = (cond) => {
  if (!cond) return '—';
  if (cond.rul > 0) return `${cond.rul} yr`;
  return 'past life';
};
const fmtAgeRul = (cond) => (cond ? `${fmtAge(cond)} / ${fmtRul(cond)}` : '—');

const priorityMeta = (cond) =>
  (cond && PRIORITY_META[cond.priority]) || { label: '', color: '#777', rank: 9 };

/* ───────────────────────── 1. PHOTO LOG (PDF) ───────────────────────── */

export async function exportPhotoLog(project, settings = {}, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const all = project.photos || [];
  const photos = all.filter((p) => p.type !== 'video');
  if (photos.length === 0) throw new Error('This survey has no photos to log.');

  const state = makeImageState(photos.length);
  const skipped = [];
  const out = [];
  let n = 0;
  let done = 0;

  out.push(`<h2><span class="secNo">1</span>Photographic Log <span class="count">(${photos.length})</span></h2>`);
  out.push(`<div class="lead">Photographs in survey order, grouped by level and space. Figure numbers are cited from the tables that follow.</div>`);
  for (const [lv, spaces] of groupByLevelSpace(photos)) {
    out.push(`<h3>Level ${esc(lv)}</h3>`);
    for (const [sp, list] of spaces) {
      out.push(`<h4>${esc(sp)}</h4><div class="grid">`);
      for (const p of list) {
        n += 1;
        done += 1;
        onProgress({ stage: 'photos', done, total: photos.length });

        const img = await encodeImage(p.uri, state);
        if (!img.dataUri) skipped.push({ n, photo: p, why: img.error });

        const np = nameplateOf(p);
        const npLine = np
          ? `<div class="np">${esc([np.make, np.model].filter(Boolean).join(' ') || 'Nameplate')}${np.serial ? ` &middot; S/N ${esc(np.serial)}` : ''}${np.capacity ? ` &middot; ${esc(np.capacity)}` : ''}${np.year ? ` &middot; Mfg ${esc(np.year)}` : ''}</div>`
          : '';
        const ts = when(p.takenAt);

        out.push(
          `<div class="cell">` +
          (img.dataUri ? `<img src="${img.dataUri}"/>` : missingTile(img.error)) +
          `<div class="figNo">Figure 1.${n} &middot; ${esc(p.system || 'GEN')}${ts ? ' &middot; ' + esc(ts) : ''}` +
          `${p.flagged ? ' &middot; <span class="flag">DEFICIENCY</span>' : ''}</div>` +
          `${p.caption ? `<div class="cap">${esc(p.caption)}</div>` : ''}${npLine}</div>`
        );
      }
      out.push(`</div>`);
    }
  }

  onProgress({ stage: 'building', done: photos.length, total: photos.length });

  // ── Deficiency summary ──
  const flagged = photos.filter((p) => p.flagged);
  const flaggedVids = all.filter((p) => p.type === 'video' && p.flagged);
  if (flagged.length || flaggedVids.length) {
    out.push(`<h2 class="warn"><span class="secNo">2</span>Observed Deficiencies <span class="count">(${flagged.length + flaggedVids.length})</span></h2>`);
    out.push(`<div class="lead">Conditions flagged by the surveyor on site. No repair scope or cost is implied.</div>`);
    out.push(`<table><thead><tr><th style="width:10%">Level</th><th style="width:24%">Space</th><th style="width:10%">System</th><th>Observation</th></tr></thead><tbody>`);
    for (const p of flagged) {
      out.push(`<tr><td>${esc(levelLabel(p))}</td><td class="wrap">${esc(spaceLabel(p))}</td><td>${esc(p.system || 'GEN')}</td><td class="wrap">${esc(p.caption || '\u2014')}</td></tr>`);
    }
    for (const v of flaggedVids) {
      out.push(`<tr><td>${esc(levelLabel(v))}</td><td class="wrap">${esc(spaceLabel(v))}</td><td>${esc(v.system || 'GEN')}</td><td class="wrap">${esc(v.caption || 'Walkthrough video')} (video &mdash; see survey files)</td></tr>`);
    }
    out.push(`</tbody></table>`);
  }

  // ── Equipment condition summary ──
  // The photo log is what actually gets bound into a report appendix, and
  // the single most useful table to have alongside the pictures is which
  // units are past their service life. It used to exist only in the CSV
  // and the HTML report, so the PDF an owner actually reads never carried
  // the finding the survey was done to produce.
  const npRows = photos
    .map((p) => ({ p, np: nameplateOf(p), cond: conditionFor(nameplateOf(p)) }))
    .filter((r) => r.np);
  if (npRows.length) {
    npRows.sort((a, b) => priorityMeta(a.cond).rank - priorityMeta(b.cond).rank);
    out.push(`<h2><span class="secNo">3</span>Equipment Condition Summary <span class="count">(${npRows.length})</span></h2>`);
    out.push(`<div class="lead">Sorted by replacement priority rather than capture order. Every decoded value is to be verified against the unit.</div>`);
    out.push(`<table><thead><tr><th style="width:9%">Priority</th><th style="width:24%">Make / Model</th><th style="width:7%">Mfg</th><th style="width:7%">Age</th><th style="width:9%">Est. RUL</th><th>Location</th><th style="width:10%">Refrigerant</th></tr></thead><tbody>`);
    for (const { p, np, cond } of npRows) {
      const refrig = refrigerantFlag(`${np.model || ''} ${np.capacity || ''}`, cond ? new Date().getFullYear() - cond.age : null);
      out.push(
        `<tr><td>${cond ? `<span class="pill" style="background:${priorityMeta(cond).color}">${esc(priorityMeta(cond).label)}</span>` : '<span class="dim">no year</span>'}</td>` +
        `<td class="wrap">${esc(np.make || '\u2014')} ${esc(np.model || '')}</td>` +
        `<td>${esc(np.year || '\u2014')}</td>` +
        `<td>${fmtAge(cond)}</td>` +
        `<td>${fmtRul(cond)}</td>` +
        `<td class="wrap">${esc(levelLabel(p))} &middot; ${esc(spaceLabel(p))}</td>` +
        `<td>${refrig ? `<span class="chip r-${esc(refrig.level)}">${esc(refrig.code)}</span>` : '\u2014'}</td></tr>`
      );
    }
    out.push(`</tbody></table>`);
    out.push(`<div class="caveat">Remaining useful life is an ASHRAE median-service-life planning figure, not a prediction of failure &mdash; roughly half of all units exceed the median.</div>`);
  }

  // ── AR measurements ──
  const meas = project.measurements || [];
  if (meas.length) {
    out.push(`<h2><span class="secNo">4</span>Field Readings <span class="count">(${meas.length})</span></h2>`);
    out.push(`<div class="note"><b>Experimental tool output.</b> Uncalibrated phone-hardware estimates. Not for code-compliance documentation &mdash; verify any critical value with instruments.</div>`);
    out.push(`<table><thead><tr><th style="width:6%">#</th><th style="width:20%">Tool</th><th style="width:22%">Result</th><th>Detail</th><th style="width:18%">Recorded</th></tr></thead><tbody>`);
    const TOOL = { pipe: 'AR Pipe Sizer', duct: 'AR Duct Sizer', light: 'Footcandle Meter', cct: 'Color Temp (CCT)' };
    meas.forEach((m, i) => {
      const detail = m.detail || [
        m.calcOD != null ? `calc OD ${m.calcOD}"` : null,
        m.insulation ? `insul ${m.insulation}"` : null,
        m.distanceM != null ? `range ${m.distanceM} m` : null,
      ].filter(Boolean).join(' \u00b7 ') || '\u2014';
      out.push(`<tr><td>${i + 1}</td><td class="wrap">${esc(TOOL[m.kind] || m.kind)}</td><td class="wrap">${esc(m.label)}</td><td class="wrap">${esc(detail)}</td><td>${esc(when(m.at))}</td></tr>`);
    });
    out.push(`</tbody></table>`);
  }

  // ── Missing files ──
  if (skipped.length) {
    out.push(`<h2 class="warn"><span class="secNo">5</span>Images Not Available <span class="count">(${skipped.length})</span></h2>`);
    out.push(`<div class="lead">These captures are recorded in the survey, but their image files could not be read on the device that produced this document. Tags and captions are intact and reproduced here so nothing is silently omitted.</div>`);
    out.push(`<table><thead><tr><th style="width:11%">Figure</th><th style="width:10%">Level</th><th style="width:22%">Space</th><th>Note</th><th style="width:22%">Reason</th></tr></thead><tbody>`);
    for (const s of skipped) {
      out.push(`<tr><td>1.${s.n}</td><td>${esc(levelLabel(s.photo))}</td><td class="wrap">${esc(spaceLabel(s.photo))}</td><td class="wrap">${esc(s.photo.caption || '\u2014')}</td><td class="wrap">${esc(s.why)}</td></tr>`);
    }
    out.push(`</tbody></table>`);
  }

  const cover = await coverPage(project, settings, {
    title: 'Existing Conditions\nPhotographic Log',
    subtitle: project.name,
    docSuffix: 'LOG',
    rows: [
      ['Photographs', String(photos.length)],
      ['Deficiencies noted', String(flagged.length + flaggedVids.length)],
    ],
  });
  const html = docShell(
    `${project.name} — Existing Conditions Photographic Log`,
    cover + out.join('') + limitationsPage(settings)
  );

  const { uri } = await Print.printToFileAsync({ html });
  return finalize(uri, `${safeName(project.name)}_PhotoLog.pdf`, opts.share === true);
}

/* ───────────────────────── 2. EQUIPMENT INVENTORY (CSV) ───────────────── */

export async function exportInventoryCSV(project, settings = {}, opts = {}) {
  const rows = (project.photos || []).filter((p) => nameplateOf(p));
  if (rows.length === 0) throw new Error('No nameplate records in this survey yet.');

  // A raw newline inside a quoted CSV field is legal, but Excel's importer
  // and half the tools downstream of it disagree about that, and OCR text
  // is full of newlines. Flatten instead of gambling.
  const cell = (v) => {
    const s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();
    return `"${s.replace(/"/g, '""')}"`;
  };

  const header = [
    'Item', 'Level', 'Space', 'System', 'Make', 'Model', 'Serial', 'Capacity',
    'Mfg Year', 'Age (yr)', 'Est. Median Life (yr)', 'Remaining Life (yr)',
    'Condition', 'Assessed Type', 'Refrigerant Flag', 'Refrigerant Note',
    'Notes', 'Photo Timestamp',
  ].map(cell).join(',');

  const lines = rows.map((p, i) => {
    const np = p.nameplate;
    const cond = conditionFor(np);
    let refrig = null;
    try {
      refrig = refrigerantFlag(`${np.model || ''} ${np.capacity || ''}`, parseInt(np.year, 10) || null);
    } catch (e) { /* a bad flag must not cost the whole spreadsheet */ }
    return [
      i + 1, levelLabel(p), spaceLabel(p), p.system || 'GEN',
      np.make, np.model, np.serial, np.capacity, np.year,
      cond ? cond.age : '', cond ? cond.median : '', cond ? cond.rul : '',
      cond ? priorityMeta(cond).label : '',
      cond ? cond.typeLabel : '',
      refrig ? refrig.code : '',
      refrig ? refrig.note : '',
      p.caption || '', when(p.takenAt),
    ].map(cell).join(',');
  });

  // BOM + CRLF: without the BOM, Excel on Windows mis-decodes the degree
  // signs and fraction marks that come off nameplates, and the file lands
  // looking corrupted.
  const csv = '\uFEFF' + [header, ...lines].join('\r\n') + '\r\n';

  await ensureExportDir();
  const path = EXPORT_DIR + `${safeName(project.name)}_EquipmentInventory.csv`;
  await writeFile(path, csv);
  return finalize(path, null, opts.share === true);
}

/* ───────────────────────── 3. PANEL PROFILE SHEET (PDF) ───────────────── */

export async function exportPanelSheet(project, panel, settings = {}, opts = {}) {
  if (!panel) throw new Error('No panel session selected.');
  const onProgress = opts.onProgress || (() => {});

  const left = Array.isArray(panel.leftPhotos) ? panel.leftPhotos : [];
  const right = Array.isArray(panel.rightPhotos) ? panel.rightPhotos : [];
  const total = (panel.schedulePhoto ? 1 : 0) + left.length + right.length;
  const state = makeImageState(Math.max(total, 1));
  const missing = [];
  let done = 0;

  const encode = async (uri, label) => {
    done += 1;
    onProgress({ stage: 'photos', done, total });
    const r = await encodeImage(uri, state);
    if (!r.dataUri) missing.push(`${label}: ${r.error}`);
    return r.dataUri;
  };

  const sched = panel.schedulePhoto ? await encode(panel.schedulePhoto, 'Directory schedule') : null;
  const leftImgs = [];
  for (let i = 0; i < left.length; i++) leftImgs.push(await encode(left[i], `Left column #${i + 1}`));
  const rightImgs = [];
  for (let i = 0; i < right.length; i++) rightImgs.push(await encode(right[i], `Right column #${i + 1}`));

  const col = (imgs, title) =>
    `<td style="width:50%;vertical-align:top;border:none;padding:0 6px 0 0">` +
    `<h4>${title}</h4>` +
    (imgs.length
      ? imgs.map((i) => (i
        ? `<img src="${i}" style="width:100%;border:1px solid #C8CDD4;margin-bottom:6px;display:block"/>`
        : missingTile('file no longer on this device'))).join('')
      : `<div class="dim">No photographs captured for this column.</div>`) +
    `</td>`;

  const id = panel.panelId || 'UNLABELED PANEL';
  const cover = await coverPage(project, settings, {
    title: `Panel Profile\n${id}`,
    subtitle: project.name,
    docSuffix: `PNL-${safeName(id)}`,
    rows: [
      ['Panel', id],
      ['Location', panel.location || '—'],
      ['Voltage', panel.voltage || '—'],
      ['Bus rating', panel.busAmps ? `${panel.busAmps} A` : '—'],
    ],
  });
  const schedSec = sched ? 2 : null;
  const body = `
    <h2><span class="secNo">1</span>Panel Data</h2>
    <table><thead><tr><th>Panel ID</th><th>Voltage</th><th>Bus Amps</th><th>Main</th><th>Location</th><th>Fed From</th></tr></thead>
    <tbody><tr><td>${esc(id)}</td><td>${esc(panel.voltage || '—')}</td><td>${esc(panel.busAmps || '—')}</td><td>${esc(panel.main || '—')}</td><td class="wrap">${esc(panel.location || '—')}</td><td>${esc(feedLabelFor(panel, new Map((project.panels || []).map((p) => [p.id, p]))))}</td></tr></tbody></table>
    ${sched ? `<h2><span class="secNo">2</span>Directory Schedule</h2><div class="avoidBreak"><img src="${sched}" style="width:100%;border:1px solid #C8CDD4"/><div class="figNo">Figure 2.1 &middot; Panel directory as found</div></div>` : ''}
    <h2><span class="secNo">${sched ? 3 : 2}</span>Breaker Columns</h2>
    <div class="lead">Photographed as found. Breaker positions are recorded left (odd) and right (even) as they appear in the enclosure.</div>
    <table style="border:none"><tbody><tr>${col(leftImgs, 'LEFT — ODD POSITIONS')}${col(rightImgs, 'RIGHT — EVEN POSITIONS')}</tr></tbody></table>
    ${missing.length ? `<div class="note">${missing.length} image(s) could not be read: ${esc(missing.join('; '))}</div>` : ''}`;
  const html = docShell(`${project.name} — Panel Profile ${id}`, cover + body + limitationsPage(settings));

  const { uri } = await Print.printToFileAsync({ html });
  return finalize(uri, `${safeName(project.name)}_Panel_${safeName(id)}.pdf`, opts.share === true);
}

/* ───────────────────────── 4. ELECTRICAL RISER (PDF) ───────────────────── */

export async function exportElectricalRiser(project, settings = {}, opts = {}) {
  const panels = project.panels || [];
  if (panels.length === 0) throw new Error('No panel sessions to build a riser from.');

  const { rows, byId } = buildRiserRows(panels);

  const body = [`<table><thead><tr><th style="width:26%">Panel</th><th style="width:18%">Fed From</th><th style="width:13%">Voltage</th><th style="width:9%">Bus</th><th style="width:11%">Main</th><th>Location</th></tr></thead><tbody>`];
  for (const { panel, depth, cyclic } of rows) {
    const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(depth) + (depth > 0 ? '\u2514 ' : '');
    body.push(
      `<tr><td>${indent}${esc(panelLabel(panel))}${cyclic ? ' <span class="flag">&#9888; CYCLE &mdash; CHECK</span>' : ''}</td>` +
      `<td>${esc(feedLabelFor(panel, byId))}</td><td>${esc(panel.voltage || '\u2014')}</td>` +
      `<td>${esc(panel.busAmps ? panel.busAmps + 'A' : '\u2014')}</td><td>${esc(panel.main || '\u2014')}</td>` +
      `<td>${esc(panel.location || '\u2014')}</td></tr>`
    );
  }
  body.push(`</tbody></table>`);

  const unset = panels.filter((p) => !p.fedFrom).length;
  const unlabeled = panels.filter((p) => !p.panelId).length;
  const notes = [];
  if (unset > 0) notes.push(`${unset} panel(s) have no "Fed From" set and are shown under Utility Service by default \u2014 set them in each panel's session for an accurate tree.`);
  if (unlabeled > 0) notes.push(`${unlabeled} panel session(s) have no panel ID and appear as "UNLABELED".`);

  const cover = await coverPage(project, settings, {
    title: 'Electrical Riser\nPanel Feed Tree',
    subtitle: project.name,
    docSuffix: 'RSR',
    rows: [
      ['Panel sessions', String(panels.length)],
      ['Feeds untagged', String(unset)],
    ],
  });
  const html = docShell(`${project.name} — Electrical Riser`, cover + `
    <h2><span class="secNo">1</span>Panel Feed Tree <span class="count">(${panels.length})</span></h2>
    <div class="lead">Assembled from "Fed From" tags recorded at each panel during the survey. This is a field record, not a drawn one-line: use it as the starting point for the CAD riser, not as a substitute for it.</div>
    ${notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}
    ${body.join('')}` + limitationsPage(settings));

  const { uri } = await Print.printToFileAsync({ html });
  return finalize(uri, `${safeName(project.name)}_ElectricalRiser.pdf`, opts.share === true);
}

/**
 * Shared by exportElectricalRiser and the designer report.
 *
 * Every read out of a panel is defensive. The previous version sorted with
 * `a.panelId.localeCompare(b.panelId)`, which throws a TypeError the moment
 * ANY panel has no panelId — and since the designer report calls this same
 * builder, one unlabeled panel session took out both the riser PDF and the
 * whole report. Panels can legitimately arrive unlabeled: older records
 * predate the field, and a session can be created and left mid-entry.
 */
function buildRiserRows(panels) {
  const list = (panels || []).filter(Boolean);
  const byId = new Map(list.map((p) => [p.id, p]));
  const childrenOf = new Map();
  const addChild = (key, panel) => {
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(panel);
  };
  for (const p of list) {
    if (p.fedFrom === 'utility') { addChild('utility', p); continue; }
    if (p.fedFrom && byId.has(p.fedFrom) && p.fedFrom !== p.id) { addChild(p.fedFrom, p); continue; }
    addChild('utility', p);
  }

  const sortKey = (p) => String(p?.panelId || '\uFFFF');   // unlabeled sorts last
  const cmp = (a, b) => sortKey(a).localeCompare(sortKey(b), undefined, { numeric: true, sensitivity: 'base' });

  const rows = [];
  const seen = new Set();
  const walk = (key, depth, visited) => {
    const kids = (childrenOf.get(key) || []).slice().sort(cmp);
    for (const p of kids) {
      if (visited.has(p.id)) { rows.push({ panel: p, depth, cyclic: true }); continue; }
      seen.add(p.id);
      rows.push({ panel: p, depth, cyclic: false });
      walk(p.id, depth + 1, new Set([...visited, p.id]));
    }
  };
  walk('utility', 0, new Set());
  for (const p of list) if (!seen.has(p.id)) rows.push({ panel: p, depth: 0, cyclic: true });
  return { rows, byId };
}

const panelLabel = (panel) => panel?.panelId || 'UNLABELED';

function feedLabelFor(panel, byId) {
  if (!panel || panel.fedFrom === 'utility' || !panel.fedFrom) return 'Utility Service';
  const parent = byId?.get?.(panel.fedFrom);
  return parent ? panelLabel(parent) : 'Utility Service';
}

/* ───────────────────────── 5. DESIGNER REPORT (HTML) ───────────────────── */
//
/* ───────────────────── 1. SURVEY REPORT (PDF) ─────────────────────
 *
 * WHY THIS IS NOW A PDF
 * ---------------------
 * This was an HTML file, deliberately, and the previous reasoning is worth
 * stating because it was not stupid: click-to-zoom and jump links need a real
 * browser, and a designer working at a desk would plausibly keep a tab open
 * while drafting.
 *
 * It was still the wrong call, for a reason that only shows up once the file
 * leaves the phone. A `.html` file has no useful life outside a desktop
 * browser. Tapped in Gmail or Outlook on a phone it downloads instead of
 * opening. In Drive it renders as source or not at all. In Teams it is an
 * attachment nobody can preview. Dropped into a submittal or an appendix it
 * cannot be page-numbered, stamped or bound. So the one document the whole app
 * exists to produce was the one document the recipient could not reliably open
 * — and the surveyor discovers that in front of the client.
 *
 * The interactive affordances were real but they were not the point. What
 * makes this deliverable worth paying for is that it looks like an engineer's
 * report: cover sheet, numbered sections, contents, an equipment schedule that
 * leads with what needs replacing, figure-numbered photographs, and a stated
 * basis. All of that survives the move to PDF. Click-to-zoom does not, and is
 * traded knowingly: full-resolution photographs remain in the survey, and a
 * PDF reader zooms.
 */

export async function exportDesignerReport(project, settings = {}, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const all = project.photos || [];
  const photos = all.filter((p) => p.type !== 'video');
  const videos = all.filter((p) => p.type === 'video');
  if (photos.length === 0 && videos.length === 0) throw new Error('This survey has no captures to report on.');

  const flagged = photos.filter((p) => p.flagged);
  const flaggedVideos = videos.filter((v) => v.flagged);
  const npPhotos = photos.filter((p) => nameplateOf(p));
  const panels = project.panels || [];

  const state = makeImageState(photos.length);
  const skipped = [];

  // ── Equipment condition, computed once and reused ──
  const equipRows = npPhotos
    .map((p) => {
      const np = p.nameplate;
      const cond = conditionFor(np);
      return { p, np, cond, conflict: yearCrossCheck(np, np.category) };
    })
    .sort((a, b) => priorityMeta(a.cond).rank - priorityMeta(b.cond).rank);

  const replaceNow = equipRows.filter((r) => r.cond && r.cond.priority === 'replace').length;
  const planSoon = equipRows.filter((r) => r.cond && r.cond.priority === 'plan').length;
  const conflicts = equipRows.filter((r) => r.conflict);
  const deficiencyCount = flagged.length + flaggedVideos.length;

  /* ── Section numbering, planned before anything is rendered ──
   *
   * This has to be a plan rather than a running counter, because the document
   * is circular: the deficiency and equipment tables cite figure numbers, and
   * a figure number is "<log section>.<n>", so the log's section number must be
   * known before the tables that reference it can be written. An earlier draft
   * of this function allocated numbers as it went and then "rebuilt" the body
   * afterwards, which silently did nothing — every figure reference in the
   * tables came out blank.
   *
   * So: decide which sections exist, number them, number the figures, then
   * render. The two sections whose existence is not knowable in advance
   * (unreadable images) are appended afterwards.
   */
  const toc = [];
  let secN = 0;
  const sec = (title, detail) => { secN += 1; toc.push({ n: secN, title, detail }); return secN; };

  const summarySec = sec('Summary of Findings', 'counts, priorities and what drives them');
  const deficSec = deficiencyCount ? sec('Observed Deficiencies', `${deficiencyCount} item${deficiencyCount === 1 ? '' : 's'}`) : null;
  const equipSec = equipRows.length ? sec('Equipment Schedule', 'sorted worst-first by remaining service life') : null;
  const riserSec = panels.length ? sec('Electrical Riser', 'panel feed tree from field-tagged data') : null;
  const logSec = photos.length ? sec('Photographic Log', `${photos.length} figure${photos.length === 1 ? '' : 's'}, by level and space`) : null;

  // Figure numbers, assigned in the same walk order the log will render in.
  // Held in a Map rather than written onto the photo objects: these are the
  // caller's records, and an export has no business mutating them.
  const figNo = new Map();
  if (logSec) {
    let i = 0;
    for (const [, spaces] of groupByLevelSpace(photos)) {
      for (const [, list] of spaces) {
        for (const ph of list) { i += 1; figNo.set(ph.id, `${logSec}.${i}`); }
      }
    }
  }
  const figOf = (ph) => figNo.get(ph?.id) || null;

  const body = [];

  /* ── Executive summary ── */
  {
    const n = summarySec;
    const tiles = [
      { n: photos.length, label: 'Locations photographed' },
      { n: equipRows.length, label: 'Units inventoried' },
      { n: deficiencyCount, label: 'Deficiencies noted', tone: deficiencyCount ? 'alert' : '' },
      { n: replaceNow + planSoon, label: 'At or near end of life', tone: replaceNow ? 'alert' : planSoon ? 'watch' : '' },
    ];
    const sentences = [];
    sentences.push(
      `This report records existing conditions observed across ${photos.length} photographed ` +
      `location${photos.length === 1 ? '' : 's'}${videos.length ? ` and ${videos.length} walkthrough video${videos.length === 1 ? '' : 's'}` : ''}` +
      `${panels.length ? `, together with ${panels.length} electrical panel session${panels.length === 1 ? '' : 's'}` : ''}.`
    );
    if (equipRows.length) {
      sentences.push(
        `${equipRows.length} unit${equipRows.length === 1 ? ' was' : 's were'} identified from nameplate data.` +
        (replaceNow
          ? ` ${replaceNow} ${replaceNow === 1 ? 'has' : 'have'} reached or passed median service life and ${replaceNow === 1 ? 'is' : 'are'} listed first in the equipment schedule.`
          : planSoon
            ? ` ${planSoon} ${planSoon === 1 ? 'is' : 'are'} approaching median service life and should be carried in the capital plan.`
            : ' None have reached median service life on the data available.')
      );
    }
    if (deficiencyCount) {
      sentences.push(`${deficiencyCount} condition${deficiencyCount === 1 ? '' : 's'} ${deficiencyCount === 1 ? 'was' : 'were'} flagged in the field and ${deficiencyCount === 1 ? 'is' : 'are'} listed in full below, each cross-referenced to its photograph.`);
    }
    body.push(`<h2><span class="secNo">${n}</span>Summary of Findings</h2>`);
    body.push(kpiRow(tiles));
    body.push(`<div class="lead" style="margin-top:12px">${sentences.map(esc).join(' ')}</div>`);
    if (conflicts.length) {
      body.push(
        `<div class="note"><b>${conflicts.length} unit${conflicts.length === 1 ? '' : 's'} ` +
        `with a conflicting manufacture year.</b> The year recorded and the year implied by the serial ` +
        `number disagree by more than one year. Both are shown in the equipment schedule. Confirm at the ` +
        `unit before using the age or replacement date — a manufacturer serial scheme that does not apply ` +
        `to a given model era can be out by a decade.</div>`
      );
    }
  }

  /* ── Deficiencies ── */
  if (deficiencyCount) {
    const n = deficSec;
    body.push(`<h2 class="warn"><span class="secNo">${n}</span>Observed Deficiencies <span class="count">(${deficiencyCount})</span></h2>`);
    body.push(`<div class="lead">Conditions flagged by the surveyor on site. Each is recorded where it was observed; no repair scope or cost is implied.</div>`);
    body.push(`<table><thead><tr><th style="width:9%">Level</th><th style="width:22%">Space</th><th style="width:9%">System</th><th>Observation</th><th style="width:11%">Figure</th></tr></thead><tbody>`);
    for (const p of flagged) {
      body.push(
        `<tr><td>${esc(levelLabel(p))}</td><td class="wrap">${esc(spaceLabel(p))}</td><td>${esc(p.system || 'GEN')}</td>` +
        `<td class="wrap">${esc(p.caption || 'Flagged on site; no note recorded.')}</td>` +
        `<td>${figOf(p) ? 'Fig. ' + esc(figOf(p)) : '—'}</td></tr>`
      );
    }
    for (const v of flaggedVideos) {
      body.push(
        `<tr><td>${esc(levelLabel(v))}</td><td class="wrap">${esc(spaceLabel(v))}</td><td>${esc(v.system || 'GEN')}</td>` +
        `<td class="wrap">${esc(v.caption || 'Walkthrough video')}</td><td>Video</td></tr>`
      );
    }
    body.push(`</tbody></table>`);
  }

  /* ── Equipment schedule ── */
  if (equipRows.length) {
    const n = equipSec;
    body.push(`<h2><span class="secNo">${n}</span>Equipment Schedule <span class="count">(${equipRows.length})</span></h2>`);
    body.push(`<div class="lead">Sorted by replacement priority rather than capture order, so the units that drive the capital plan appear first. Every decoded value is to be verified against the unit.</div>`);
    body.push(
      `<table><thead><tr><th style="width:8%">Priority</th><th style="width:10%">Make</th><th style="width:16%">Model</th>` +
      `<th style="width:13%">Serial</th><th style="width:9%">Capacity</th><th style="width:6%">Mfg</th>` +
      `<th style="width:9%">Age / RUL</th><th style="width:8%">Refrig.</th><th>Location</th></tr></thead><tbody>`
    );
    for (const { p, np, cond, conflict } of equipRows) {
      const meta = priorityMeta(cond);
      const priCell = cond
        ? `<span class="pill" style="background:${meta.color}">${esc(meta.label)}</span>`
        : '<span class="dim">no year</span>';
      const ageCell = fmtAgeRul(cond);
      let refrig = null;
      try { refrig = refrigerantFlag(`${np.model || ''} ${np.capacity || ''}`, parseInt(np.year, 10) || null); } catch (e) {}
      const yearCell = conflict
        ? `<span style="white-space:nowrap">${esc(np.year)}&nbsp;<span class="flag">&#9888;</span></span>`
        : esc(np.year || '—');
      body.push(
        `<tr><td>${priCell}</td><td class="wrap">${esc(np.make || '—')}</td><td>${esc(np.model || '—')}</td>` +
        `<td>${esc(np.serial || '—')}</td><td>${esc(np.capacity || '—')}</td><td>${yearCell}</td><td>${ageCell}</td>` +
        `<td>${refrig ? `<span class="chip r-${esc(refrig.level)}">${esc(refrig.code)}</span>` : '—'}</td>` +
        `<td class="wrap">${esc(levelLabel(p))} &middot; ${esc(spaceLabel(p))}${figOf(p) ? ` &middot; Fig. ${esc(figOf(p))}` : ''}</td></tr>`
      );
    }
    body.push(`</tbody></table>`);
    if (conflicts.length) {
      body.push(`<div class="note"><b>Manufacture year conflicts.</b> ` +
        conflicts.map(({ np, conflict }) =>
          `${esc(np.make || 'Unit')} ${esc(np.model || '')} (S/N ${esc(np.serial || '—')}): recorded ${conflict.reported}, serial implies ${conflict.decoded}.`
        ).join(' ') + ` Confirm at the unit.</div>`);
    }
    body.push(`<div class="caveat">Remaining useful life (RUL) is an ASHRAE median-service-life planning figure, not a prediction of failure — roughly half of all units exceed the median. Refrigerant chips flag phase-down exposure, not a defect.</div>`);
  }

  /* ── Riser ── */
  if (panels.length) {
    const n = riserSec;
    const { rows, byId } = buildRiserRows(panels);
    body.push(`<h2><span class="secNo">${n}</span>Electrical Riser — Panel Feed Tree <span class="count">(${panels.length})</span></h2>`);
    body.push(`<div class="lead">Assembled from "Fed From" tags recorded at each panel. A starting point for the CAD one-line, not a substitute for it.</div>`);
    body.push(`<table><thead><tr><th style="width:26%">Panel</th><th style="width:18%">Fed From</th><th style="width:13%">Voltage</th><th style="width:9%">Bus</th><th style="width:11%">Main</th><th>Location</th></tr></thead><tbody>`);
    for (const { panel, depth, cyclic } of rows) {
      const indent = '&nbsp;&nbsp;&nbsp;'.repeat(depth) + (depth > 0 ? '&#9492;&nbsp;' : '');
      body.push(
        `<tr><td>${indent}${esc(panelLabel(panel))}${cyclic ? ' <span class="flag">&#9888; CYCLE</span>' : ''}</td>` +
        `<td>${esc(feedLabelFor(panel, byId))}</td><td>${esc(panel.voltage || '—')}</td>` +
        `<td>${esc(panel.busAmps ? panel.busAmps + 'A' : '—')}</td><td>${esc(panel.main || '—')}</td>` +
        `<td class="wrap">${esc(panel.location || '—')}</td></tr>`
      );
    }
    body.push(`</tbody></table>`);
  }

  /* ── Photographic log ── */
  const log = logSec ? [
    `<h2><span class="secNo">${logSec}</span>Photographic Log <span class="count">(${photos.length})</span></h2>`,
    `<div class="lead">Grouped by level and space in survey order. Figure numbers are cited from the tables above.</div>`,
  ] : [];
  let photoIdx = 0;
  for (const [lv, spaces] of groupByLevelSpace(photos)) {
    log.push(`<h3>Level ${esc(lv)}</h3>`);
    for (const [sp, list] of spaces) {
      log.push(`<h4>${esc(sp)}</h4><div class="grid">`);
      for (const p of list) {
        photoIdx += 1;
        onProgress({ stage: 'photos', done: photoIdx, total: photos.length });

        const img = await encodeImage(p.uri, state);
        if (!img.dataUri) skipped.push({ n: figOf(p), photo: p, why: img.error });

        const np = nameplateOf(p);
        const npLine = np
          ? `<div class="np">${esc([np.make, np.model].filter(Boolean).join(' ') || 'Nameplate')}${np.serial ? ` &middot; S/N ${esc(np.serial)}` : ''}${np.year ? ` &middot; Mfg ${esc(np.year)}` : ''}</div>`
          : '';
        log.push(
          `<div class="cell">` +
          (img.dataUri ? `<img src="${img.dataUri}"/>` : missingTile(img.error)) +
          `<div class="figNo">Figure ${esc(figOf(p))} &middot; ${esc(p.system || 'GEN')}${p.flagged ? ' &middot; <span class="flag">DEFICIENCY</span>' : ''}</div>` +
          (p.caption ? `<div class="cap">${esc(p.caption)}</div>` : '') +
          npLine +
          `</div>`
        );
      }
      log.push(`</div>`);
    }
  }

  onProgress({ stage: 'building', done: photos.length, total: photos.length });

  /* ── Videos ── */
  const extras = [];
  if (videos.length) {
    const n = sec('Walkthrough Videos', 'recorded on site, held with the survey files');
    extras.push(`<h2><span class="secNo">${n}</span>Walkthrough Videos <span class="count">(${videos.length})</span></h2>`);
    extras.push(`<div class="caveat">Video files are not embedded in this document — they are held alongside the survey. Timestamps flagged during the walk are recorded in the notes below.</div>`);
    extras.push(`<table><thead><tr><th style="width:10%">Level</th><th style="width:24%">Space</th><th style="width:10%">System</th><th>Notes</th></tr></thead><tbody>`);
    for (const v of videos) {
      extras.push(`<tr><td>${esc(levelLabel(v))}</td><td class="wrap">${esc(spaceLabel(v))}</td><td>${esc(v.system || 'GEN')}</td><td class="wrap">${esc(v.caption || '—')}</td></tr>`);
    }
    extras.push(`</tbody></table>`);
  }

  /* ── Files not available ── */
  if (skipped.length) {
    const n = sec('Images Not Available', `${skipped.length} record${skipped.length === 1 ? '' : 's'}`);
    extras.push(`<h2 class="warn"><span class="secNo">${n}</span>Images Not Available <span class="count">(${skipped.length})</span></h2>`);
    extras.push(`<div class="lead">These captures are recorded in the survey, but their image files could not be read on the device that produced this document. Tags and captions are intact and are reproduced here so nothing is silently omitted.</div>`);
    extras.push(`<table><thead><tr><th style="width:11%">Figure</th><th style="width:10%">Level</th><th style="width:22%">Space</th><th>Note</th><th style="width:22%">Reason</th></tr></thead><tbody>`);
    for (const sk of skipped) {
      extras.push(`<tr><td>${esc(sk.n || '—')}</td><td>${esc(levelLabel(sk.photo))}</td><td class="wrap">${esc(spaceLabel(sk.photo))}</td><td class="wrap">${esc(sk.photo.caption || '—')}</td><td class="wrap">${esc(sk.why)}</td></tr>`);
    }
    extras.push(`</tbody></table>`);
  }

  const limitsSec = sec('Basis of Report and Limitations', 'scope, verification and concealed conditions');

  const cover = await coverPage(project, settings, {
    title: 'Existing Conditions\nSurvey Report',
    subtitle: project.name,
    docSuffix: 'RPT',
    rows: [
      ['Captures', `${photos.length} photograph${photos.length === 1 ? '' : 's'}${videos.length ? `, ${videos.length} video${videos.length === 1 ? '' : 's'}` : ''}`],
      ['Equipment inventoried', String(equipRows.length)],
      ['Deficiencies noted', String(deficiencyCount)],
    ],
  });

  const html = docShell(
    `${project.name} — Existing Conditions Survey Report`,
    cover + contentsPage(toc) + body.join('') + log.join('') + extras.join('') + limitationsPage(settings, [], limitsSec)
  );

  const { uri } = await Print.printToFileAsync({ html });
  return finalize(uri, `${safeName(project.name)}_SurveyReport.pdf`, opts.share === true);
}

/* ───────────────────────── file plumbing ───────────────────────── */

async function writeFile(path, contents) {
  try {
    // Overwrite semantics: writeAsStringAsync replaces, but a stale file
    // left by a half-finished previous run can hold a lock on some devices.
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(path, contents);
  } catch (e) {
    // documentDirectory can be unwritable (full disk, restricted profile).
    // Cache is not as durable but it is better than failing outright.
    const fallback = FileSystem.cacheDirectory + path.split('/').pop();
    await FileSystem.writeAsStringAsync(fallback, contents);
    return fallback;
  }
  return path;
}

/**
 * Give the generated file its real name and, optionally, hand it to the
 * share sheet.
 *
 * `share` is opt-IN and defaults to false. The old default was true, which
 * meant "generate" and "send it somewhere" were the same indivisible
 * action — there was no way to just look at what you'd made.
 *
 * The destination is deleted before the move. expo-print writes to a random
 * cache name every run, so the rename collided with the previous export's
 * file on every repeat generation; moveAsync throws on an existing
 * destination, the throw was swallowed, and the caller silently got back
 * the ugly `print-<uuid>.pdf` path instead of the named one. Users saw a
 * file called "print-9f2c...pdf" land in Drive and reasonably assumed the
 * export had failed.
 */
async function finalize(uri, rename, share = false) {
  let out = uri;
  if (rename) {
    await ensureExportDir();
    const dest = EXPORT_DIR + rename;
    try {
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
      await FileSystem.moveAsync({ from: uri, to: dest });
      out = dest;
    } catch (e) {
      // Keep the generated file rather than losing it to a rename failure.
      out = uri;
    }
  }
  if (share) {
    try {
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(out, { mimeType: mimeOf(out), UTI: utiOf(out) });
    } catch (e) { /* user dismissed the sheet, or no target — not an error */ }
  }
  return out;
}

/* ───────────────────────── mime helpers (shared with the UI) ──────────── */

export const mimeOf = (uri = '') => {
  if (/\.pdf$/i.test(uri)) return 'application/pdf';
  if (/\.html?$/i.test(uri)) return 'text/html';
  if (/\.csv$/i.test(uri)) return 'text/csv';
  return '*/*';
};

export const utiOf = (uri = '') => {
  if (/\.pdf$/i.test(uri)) return 'com.adobe.pdf';
  if (/\.html?$/i.test(uri)) return 'public.html';
  if (/\.csv$/i.test(uri)) return 'public.comma-separated-values-text';
  return 'public.item';
};

/* ───────────────────────── readiness summary ───────────────────────── */
//
// Powers the Export screen's per-deliverable status. Previously each card
// hand-rolled its own count inline and they drifted apart from what the
// exporter actually looks at — a card could say "12 nameplate records" and
// then the export would say there were none.

export function exportReadiness(project) {
  const all = project?.photos || [];
  const photos = all.filter((p) => p.type !== 'video');
  const videos = all.filter((p) => p.type === 'video');
  const nameplates = photos.filter((p) => nameplateOf(p));
  const panels = project?.panels || [];
  const withYear = nameplates.filter((p) => conditionFor(p.nameplate));
  const atRisk = withYear.filter((p) => {
    const c = conditionFor(p.nameplate);
    return c && (c.priority === 'replace' || c.priority === 'plan');
  });

  return {
    photos: photos.length,
    videos: videos.length,
    flagged: photos.filter((p) => p.flagged).length,
    nameplates: nameplates.length,
    nameplatesWithYear: withYear.length,
    atRisk: atRisk.length,
    panels: panels.length,
    panelsFedFromSet: panels.filter((p) => p.fedFrom).length,
    measurements: (project?.measurements || []).length,
    // A rough "this is going to take a while" signal for the UI, so a
    // 300-photo report can warn before it starts instead of looking hung.
    heavy: photos.length > 80,
  };
}
