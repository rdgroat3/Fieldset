// AI decode fallback — offline-first store-and-forward.
//
// Flow: OCR runs offline as always. If the local dictionary can't fully
// decode a nameplate, the raw OCR text is queued here. Whenever the app
// comes to the foreground with connectivity, the queue drains through your
// Cloudflare Worker (which holds the API key — never embed keys in the app)
// and decoded fields flow back into the photo records, labeled
// "AI-decoded — verify".

import AsyncStorage from '@react-native-async-storage/async-storage';
import { AI_DECODE, aiDecodeEnabled } from '../config';

const QKEY = 'mepsurvey.aidecode.queue.v1';

export async function getQueue() {
  try { return JSON.parse((await AsyncStorage.getItem(QKEY)) || '[]'); }
  catch (e) { return []; }
}

async function setQueue(q) {
  await AsyncStorage.setItem(QKEY, JSON.stringify(q)).catch(() => {});
}

export async function queueForDecode(projectId, photoId, rawText) {
  if (!aiDecodeEnabled() || !rawText?.trim()) return false;
  const q = await getQueue();
  if (q.some((i) => i.photoId === photoId)) return true; // already queued
  q.push({ projectId, photoId, rawText, queuedAt: new Date().toISOString(), attempts: 0 });
  await setQueue(q);
  return true;
}

export async function pendingCount(projectId) {
  const q = await getQueue();
  return projectId ? q.filter((i) => i.projectId === projectId).length : q.length;
}

async function callWorker(rawText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_DECODE.TIMEOUT_MS);
  try {
    const res = await fetch(AI_DECODE.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': AI_DECODE.APP_TOKEN },
      body: JSON.stringify({ text: rawText }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Expected shape: {make, model, serial, capacity, year, confidence, notes}
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch (e) {
    return null; // offline or timeout — stays queued
  } finally {
    clearTimeout(timer);
  }
}

// Drain the queue. Returns [{projectId, photoId, decoded}] for the caller
// to apply via the store (this module stays store-agnostic).
export async function processQueue() {
  if (!aiDecodeEnabled()) return [];
  let q = await getQueue();
  if (!q.length) return [];

  const applied = [];
  const remaining = [];

  for (const item of q) {
    const decoded = await callWorker(item.rawText);
    if (decoded && (decoded.make || decoded.model || decoded.capacity)) {
      applied.push({ projectId: item.projectId, photoId: item.photoId, decoded });
    } else {
      item.attempts += 1;
      if (item.attempts < 10) remaining.push(item); // give up after 10 tries
    }
    if (!decoded) break; // likely offline — stop hammering, keep the rest queued
  }

  // Anything after an offline break stays queued untouched
  const processedIds = new Set([...applied.map((a) => a.photoId), ...remaining.map((r) => r.photoId)]);
  for (const item of q) if (!processedIds.has(item.photoId)) remaining.push(item);

  await setQueue(remaining);
  return applied;
}

// Merge AI results into an existing nameplate record without clobbering
// anything the engineer typed by hand.
export function mergeDecoded(nameplate = {}, decoded = {}) {
  const keep = (manual, ai) => (manual && manual.trim() ? manual : (ai || ''));
  return {
    ...nameplate,
    make: keep(nameplate.make, decoded.make),
    model: keep(nameplate.model, decoded.model),
    serial: keep(nameplate.serial, decoded.serial),
    capacity: keep(nameplate.capacity, decoded.capacity),
    year: keep(nameplate.year, decoded.year ? String(decoded.year) : ''),
    aiDecoded: true,
    aiConfidence: decoded.confidence || 'unknown',
    aiNotes: decoded.notes || '',
  };
}
