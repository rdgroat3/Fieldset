// Native-module wrappers. Both lazy-load so the app still runs in Expo Go
// (the buttons explain that a dev build is needed instead of crashing).

// ---------- OCR (ML Kit / Apple Vision via react-native-ml-kit) ----------
export async function recognizeText(imageUri) {
  let TextRecognition;
  try {
    TextRecognition = require('@react-native-ml-kit/text-recognition').default;
  } catch (e) {
    return { ok: false, reason: 'dev-build', text: '' };
  }
  try {
    const result = await TextRecognition.recognize(imageUri);
    return { ok: true, text: result?.text || '' };
  } catch (e) {
    return { ok: false, reason: String(e), text: '' };
  }
}

// ---------- Voice (speech-to-text via expo-speech-recognition) ----------
let SR = null;
function speech() {
  if (SR !== null) return SR;
  try { SR = require('expo-speech-recognition').ExpoSpeechRecognitionModule; }
  catch (e) { SR = false; }
  return SR;
}

export function voiceAvailable() { return !!speech(); }

let listeners = [];

export function startDictation({ onResult, onEnd, onError }) {
  const M = speech();
  if (!M) { onError?.('dev-build'); return () => {}; }

  (async () => {
    try {
      const perm = await M.requestPermissionsAsync();
      if (!perm.granted) { onError?.('Microphone/speech permission denied'); return; }

      listeners = [
        M.addListener('result', (e) => {
          const t = e.results?.[0]?.transcript;
          if (t) onResult?.(t, !e.isFinal);
        }),
        M.addListener('end', () => { cleanup(); onEnd?.(); }),
        M.addListener('error', (e) => { cleanup(); onError?.(e.message || e.error || 'speech error'); }),
      ];

      M.start({ lang: 'en-US', interimResults: true, continuous: true });
    } catch (e) {
      onError?.(String(e));
    }
  })();

  return stopDictation;
}

function cleanup() {
  listeners.forEach((l) => { try { l.remove(); } catch (e) {} });
  listeners = [];
}

export function stopDictation() {
  const M = speech();
  if (M) { try { M.stop(); } catch (e) {} }
  cleanup();
}

export const DEV_BUILD_MSG =
  'This feature uses a native module that Expo Go does not include. ' +
  'Build the dev client once (`eas build --profile development`) and it lights up. See README.';
