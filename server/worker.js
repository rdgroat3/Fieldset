// Fieldset — nameplate decode proxy (Cloudflare Worker).
//
// WHY THIS EXISTS: the app must never ship with an embedded API key
// (anyone can extract it from the binary and run up your bill). This
// ~60-line Worker holds the key server-side. Free tier: 100k requests/day.
//
// DEPLOY (one time, ~10 min):
//   1. npm install -g wrangler && wrangler login   (free Cloudflare account)
//   2. cd server && wrangler deploy
//   3. wrangler secret put ANTHROPIC_API_KEY       (paste your key)
//   4. wrangler secret put APP_TOKEN               (invent any long random string)
//   5. Put the deployed URL + the same APP_TOKEN into src/config.js
//
// The APP_TOKEN is a lightweight shared secret so random internet traffic
// can't burn your quota. Rotate it by updating both sides.

const SYSTEM_PROMPT = `You are an MEP equipment nameplate decoder. You receive raw OCR text from a photo of a mechanical or electrical equipment nameplate. Extract and decode what you can.

Respond ONLY with a JSON object, no markdown, no prose:
{
  "make": "manufacturer name or empty string",
  "model": "model number or empty string",
  "serial": "serial number or empty string",
  "capacity": "decoded capacity/rating with units (e.g. '5 Tons (60,000 BTU/h)', '480V 3Ø · 225A') or empty string",
  "year": "4-digit manufacturing year decoded from serial/date codes, or empty string",
  "confidence": "high" | "medium" | "low",
  "notes": "one short sentence on how you decoded capacity/year, or empty string"
}

Rules: OCR text is noisy (8/B, 0/O confusions are common — use judgment). Use manufacturer-specific nomenclature knowledge (Carrier/Trane/York/Daikin model digit capacity codes, serial date formats, etc). Never invent values you cannot support from the text; empty string beats a guess. Mark confidence "low" whenever decoding relies on an uncertain pattern.`;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    if (request.headers.get('X-App-Token') !== env.APP_TOKEN) {
      return new Response('unauthorized', { status: 401 });
    }

    let text;
    try {
      const body = await request.json();
      text = (body.text || '').slice(0, 4000);
    } catch (e) {
      return new Response('bad request', { status: 400 });
    }
    if (!text.trim()) return new Response('empty text', { status: 400 });

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `OCR text from nameplate:\n\n${text}` }],
      }),
    });

    if (!apiRes.ok) return new Response('upstream error', { status: 502 });

    const data = await apiRes.json();
    const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    // Parse the model's JSON (strip accidental fences defensively)
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      return new Response(JSON.stringify({ make: '', model: '', serial: '', capacity: '', year: '', confidence: 'low', notes: 'parse failure' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(parsed), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
