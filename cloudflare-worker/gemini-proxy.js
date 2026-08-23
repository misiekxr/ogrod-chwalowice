/**
 * Cloudflare Worker: proxy do Gemini API dla ogrod-pwa.
 * Klucz Gemini trzymany jako sekret w Cloudflare (env.GEMINI_API_KEY) — NIGDY
 * nie trafia do publicznego kodu na GitHub Pages.
 *
 * WDROZENIE (dashboard.cloudflare.com, konto darmowe):
 *   1. Workers & Pages -> Create -> Create Worker -> nadaj nazwe (np. "ogrod-gemini-proxy")
 *   2. Edit code -> wklej cala zawartosc tego pliku -> Deploy
 *   3. Settings -> Variables and Secrets -> Add secret:
 *        GEMINI_API_KEY = <klucz z aistudio.google.com/apikey>
 *        SHARED_TOKEN   = <dowolny losowy string, np. wygenerowany w PowerShell:
 *                          [Convert]::ToBase64String((1..24|%{Get-Random -Max 256}))>
 *   4. Skopiuj URL Workera (https://ogrod-gemini-proxy.<twoj-subdomain>.workers.dev)
 *      i SHARED_TOKEN do app.js (GEMINI_PROXY_URL / GEMINI_PROXY_TOKEN)
 */

const ALLOWED_ORIGIN = 'https://misiekxr.github.io';
const GEMINI_MODEL = 'gemini-3.6-flash';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Token',
  };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    // lekka ochrona przed przypadkowym/masowym naduzyciem samego Workera —
    // nie jest to "prawdziwy sekret" (tez siedzi w publicznym app.js), ale
    // odcina automatyczne skanery szukajace wzorcow kluczy Google.
    if (request.headers.get('X-Proxy-Token') !== env.SHARED_TOKEN) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders() });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('Invalid JSON', { status: 400, headers: corsHeaders() });
    }

    const { prompt, mime, data } = body;
    if (!prompt || !mime || !data) {
      return new Response('Missing prompt/mime/data', { status: 400, headers: corsHeaders() });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
        }),
      }
    );

    const text = await geminiRes.text();
    return new Response(text, {
      status: geminiRes.status,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  },
};
