// Native-module wrappers. Lazy-loads so the app still runs in Expo Go
// (the caller explains that a dev build is needed instead of crashing).

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

export const DEV_BUILD_MSG =
  'This feature uses a native module that Expo Go does not include. ' +
  'Build the dev client once (`eas build --profile development`) and it lights up. See README.';
