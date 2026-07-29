// Native-module wrappers. Lazy-loads so the app still runs in Expo Go
// (the caller explains that a dev build is needed instead of crashing).

// ---------- OCR (ML Kit / Apple Vision via react-native-ml-kit) ----------
//
// Returns BOTH the flat text and ML Kit's structured blocks. The blocks
// carry per-line bounding boxes (`frame: {left, top, width, height}`), which
// is what makes real table-layout decoding possible: "MODEL NUMBER" and its
// value sit in two different cells, and only geometry can say which value
// line belongs to which label. The flat `result.text` joins blocks in
// whatever order ML Kit detected them, which routinely interleaves columns —
// that scrambled ordering is a big part of why label→value pairing by text
// position alone kept mis-assigning fields.
export async function recognizeText(imageUri) {
  let TextRecognition;
  try {
    TextRecognition = require('@react-native-ml-kit/text-recognition').default;
  } catch (e) {
    return { ok: false, reason: 'dev-build', text: '', blocks: [] };
  }
  try {
    const result = await TextRecognition.recognize(imageUri);
    return { ok: true, text: result?.text || '', blocks: result?.blocks || [] };
  } catch (e) {
    return { ok: false, reason: String(e), text: '', blocks: [] };
  }
}

export const DEV_BUILD_MSG =
  'This feature uses a native module that Expo Go does not include. ' +
  'Build the dev client once (`eas build --profile development`) and it lights up. See README.';
