// ─────────────────────────────────────────────────────────────────────────
// DECODE FEEDBACK — the safe half of "self-learning".
//
// WHAT THIS IS
// Every nameplate photo already persists its raw OCR text, the parsed
// fields, and any AI-decoded results (via utils/aidecode.js, labeled
// "AI-decoded — verify"). That means the app is ALREADY collecting field
// observations — they just aren't being harvested. This module mines the
// existing photo records into a REVIEW QUEUE: a list of candidate catalog
// improvements, each backed by a real plate, for a human (or a Claude dev
// session with the human present) to verify before anything touches
// decodeDB.js.
//
// WHAT THIS IS DELIBERATELY NOT
// This module does NOT write to the decode catalog, and nothing should.
// Auto-promoting AI-inferred readings into DECODE_DB would violate the DB's
// own design principle #1 (nothing asserted without provenance): an AI guess
// has no ground truth behind it, and one wrong rule silently mis-dates every
// future unit of that brand — corrupting condition reports in a way no one
// notices until a client does. The catalog only grows through data edits
// whose `examples` pass the test harness, with the plate photo as evidence.
//
// PIPELINE
//   field photos (already stored)
//     -> buildReviewQueue(projects)        finds gaps + disagreements
//     -> reviewQueueToCSV(queue)           exportable for a dev session
//     -> human-verified data edit to decodeDB.js (+ example, + test run)
// ─────────────────────────────────────────────────────────────────────────

import { decodeYearFromSerial, detectBrand, brandInfo } from './hvacDecode';

// A plate-printed MFG year is ground truth; a decoded year is inference.
// When both exist and disagree, that photo is the single most valuable kind
// of observation the app can produce: it either falsifies a rule or exposes
// a variant format.
const plateYearFrom = (rawOcr) => {
  const m = String(rawOcr || '').match(/(?:MFG|MANUF|DATE)[^\d]*((?:19|20)\d{2})/i);
  return m ? parseInt(m[1], 10) : null;
};

const nameplatePhotos = (project) =>
  (project?.photos || []).filter((p) => p.nameplate);

// Classify one nameplate photo into zero or one review-queue reasons,
// most valuable first.
function classifyObservation(p, projectName) {
  const np = p.nameplate || {};
  const category = np.category || 'hvac';
  const brand = np.make || detectBrand(np.rawOcr || '', category) || null;
  const plateYear = plateYearFrom(np.rawOcr);
  const decoded = np.serial ? decodeYearFromSerial(np.serial, brand, category) : null;

  const base = {
    project: projectName || '',
    photoId: p.id || '',
    brand: brand || '(unknown)',
    category,
    model: np.model || '',
    serial: np.serial || '',
    plateYear: plateYear || '',
    decodedYear: decoded?.year || '',
    confidence: decoded?.confidence || '',
    ruleId: decoded?.ruleId || '',
  };

  // 1) Rule contradiction — a decode that disagrees with the plate's own
  //    printed year. Falsifies or refines an existing rule.
  if (decoded?.year && plateYear && decoded.year !== plateYear) {
    return { ...base, reason: 'RULE_CONTRADICTION',
      detail: `rule ${decoded.ruleId} decoded ${decoded.year} but plate prints ${plateYear}` };
  }
  // 2) Rule confirmation with ground truth — decode matches the printed
  //    year. Harvest as a new declared example for the test suite.
  if (decoded?.year && plateYear && decoded.year === plateYear) {
    return { ...base, reason: 'CONFIRMED_EXAMPLE',
      detail: 'decode matches plate-printed year - candidate test example' };
  }
  // 3) Known brand, no rule, but the plate prints a year — a (serial, year)
  //    pair for a rule-free brand. Enough of these and a scheme may emerge.
  if (brand && np.serial && !decoded?.year && plateYear) {
    const info = brandInfo(brand, category);
    if (info && !info.hasSerialRules) {
      return { ...base, reason: 'RULE_FREE_GROUND_TRUTH',
        detail: 'serial + plate year captured for a brand with no verified rule' };
    }
  }
  // 4) Brand the catalog doesn't know at all.
  if (!brand && (np.model || np.serial)) {
    return { ...base, reason: 'UNKNOWN_BRAND',
      detail: 'nameplate parsed but no catalog brand matched - candidate new entry' };
  }
  return null;
}

// Build the full review queue across projects, most actionable first.
export function buildReviewQueue(projects = []) {
  const ORDER = { RULE_CONTRADICTION: 0, CONFIRMED_EXAMPLE: 1, RULE_FREE_GROUND_TRUTH: 2, UNKNOWN_BRAND: 3 };
  const out = [];
  for (const proj of projects) {
    for (const p of nameplatePhotos(proj)) {
      const obs = classifyObservation(p, proj.name);
      if (obs) out.push(obs);
    }
  }
  out.sort((a, b) => (ORDER[a.reason] ?? 9) - (ORDER[b.reason] ?? 9));
  return out;
}

const csvEsc = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function reviewQueueToCSV(queue) {
  const cols = ['reason', 'brand', 'category', 'model', 'serial', 'plateYear',
    'decodedYear', 'confidence', 'ruleId', 'detail', 'project', 'photoId'];
  const rows = [cols.join(',')];
  for (const q of queue) rows.push(cols.map((c) => csvEsc(q[c])).join(','));
  return rows.join('\n');
}

// Tiny summary for a Settings/Export badge: "12 decode observations to review".
export function reviewQueueStats(projects = []) {
  const q = buildReviewQueue(projects);
  const byReason = {};
  for (const o of q) byReason[o.reason] = (byReason[o.reason] || 0) + 1;
  return { total: q.length, byReason };
}
