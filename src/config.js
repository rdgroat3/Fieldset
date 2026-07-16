// App configuration.
// AI DECODE FALLBACK: deploy the Cloudflare Worker in /server (see README),
// then create a .env file (see .env.example) with your Worker URL + the
// APP_TOKEN you chose. .env is already gitignored, so the token never ends
// up in the repo. Leave it unset to disable the feature entirely
// (everything else works offline).
//
// EXPO_PUBLIC_-prefixed vars are inlined at build time by Expo automatically
// — no extra package needed. Restart `expo start` after editing .env.

export const AI_DECODE = {
  ENDPOINT: process.env.EXPO_PUBLIC_AI_DECODE_ENDPOINT || '',
  APP_TOKEN: process.env.EXPO_PUBLIC_AI_DECODE_TOKEN || '',
  TIMEOUT_MS: 20000,
};

export const aiDecodeEnabled = () => !!AI_DECODE.ENDPOINT;
