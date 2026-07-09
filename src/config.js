// App configuration.
// AI DECODE FALLBACK: deploy the Cloudflare Worker in /server (see README),
// then paste your Worker URL + the APP_TOKEN you chose below. Leave the URL
// empty to disable the feature entirely (everything else works offline).

export const AI_DECODE = {
  ENDPOINT: '',            // e.g. 'https://mep-decode.yourname.workers.dev'
  APP_TOKEN: '',           // must match the APP_TOKEN secret set on the Worker
  TIMEOUT_MS: 20000,
};

export const aiDecodeEnabled = () => !!AI_DECODE.ENDPOINT;
