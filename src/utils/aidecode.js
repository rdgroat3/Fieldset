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

// Give up on an individual item after this many SERVER-SIDE rejections.
// Transport failures (offline/timeout) deliberately do not count.
const MAX_ATTEMPTS = 10;

/**
 * Returns a discriminated result rather than a bare value:
 *   { ok: true,  data }
 *   { ok: false, reason: 'transport' }        network down / timed out
 *   { ok: false, reason: 'http-<status>' }    server reached, said no
 *   { ok: false, reason: 'bad-json' | 'bad-shape' }
 *
 * The old version returned null for all of these, which made it impossible
 * for processQueue to tell "the phone is in a basement" from "this one
 * record will never decode" — and it guessed wrong in the direction that
 * stalled the whole queue.
 */
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
    if (!res.ok) {
      // 5xx is the server having a bad day — treat it like transport so we
      // back off instead of burning through all ten attempts in one drain.
      return { ok: false, reason: res.status >= 500 ? 'transport' : `http-${res.status}` };
    }
    let data;
    try { data = await res.json(); }
    catch (e) { return { ok: false, reason: 'bad-json' }; }
    // Expected shape: {make, model, serial, capacity, year, confidence, notes}
    if (!data || typeof data !== 'object') return { ok: false, reason: 'bad-shape' };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: 'transport' }; // offline or timeout — stays queued
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain the queue. Returns [{projectId, photoId, decoded}] for the caller
 * to apply via the store (this module stays store-agnostic).
 *
 * STARVATION FIX
 * --------------
 * The previous loop did `if (!decoded) break;` on the FIRST failure and
 * treated that as "we must be offline". It isn't the same thing. A single
 * item that fails deterministically — a payload the Worker rejects with a
 * 400, OCR text so garbled the model returns nothing usable, a record whose
 * rawText got truncated in storage — returns null forever, and the break
 * meant every item behind it in the queue was never attempted at all. One
 * bad nameplate could stall an entire survey's AI decodes for ten
 * foreground cycles (the attempts<10 cap) before the queue unwedged itself.
 *
 * Distinguishing the two cases needs a signal the old callWorker threw
 * away: it collapsed "network unreachable" and "server said no" into the
 * same `null`. It now reports WHY it failed, so:
 *
 *   - a transport failure (offline / timeout) still stops the drain
 *     immediately, because hammering a dead network is pointless and
 *     burns battery; nothing is counted as an attempt.
 *   - a server-side rejection counts an attempt against THAT item only and
 *     the drain moves on to the next one.
 *
 * The head of the queue also rotates on failure, so even a pathological
 * item that somehow keeps returning a transport-shaped error can't pin the
 * same position forever.
 */
export async function processQueue() {
  if (!aiDecodeEnabled()) return [];
  const q = await getQueue();
  if (!q.length) return [];

  const applied = [];
  const remaining = [];
  let offline = false;

  for (let i = 0; i < q.length; i++) {
    const item = q[i];

    if (offline) { remaining.push(item); continue; }

    const res = await callWorker(item.rawText);

    if (res.ok && res.data && (res.data.make || res.data.model || res.data.capacity)) {
      applied.push({ projectId: item.projectId, photoId: item.photoId, decoded: res.data });
      continue;
    }

    if (res.reason === 'transport') {
      // Genuinely can't reach the Worker. Stop trying, keep everything
      // queued, and do NOT burn an attempt — being offline is not the
      // item's fault and shouldn't count toward giving up on it.
      offline = true;
      remaining.push(item);
      continue;
    }

    // Server reachable, this item didn't decode. That's on the item.
    const attempts = (item.attempts || 0) + 1;
    if (attempts < MAX_ATTEMPTS) {
      remaining.push({ ...item, attempts, lastError: res.reason || 'no-result' });
    }
    // else: dropped. It stays visible as a photo with no AI decode, which
    // is the honest outcome — better than a queue that never empties.
  }

  // Failed items go to the BACK. Without this, an item that fails in a way
  // we can't classify sits at position 0 on every future drain and gets
  // first crack at the network every time, which is exactly the starvation
  // shape this function exists to avoid.
  remaining.sort((a, b) => (a.attempts || 0) - (b.attempts || 0));

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
