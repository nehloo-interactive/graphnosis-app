/**
 * GET /claim?code=...
 *
 * Two purposes:
 *
 *   1. If the client browser is the desktop app's webview (or any browser
 *      where graphnosis:// is registered), we 303-redirect to
 *      graphnosis://claim?token=... so the desktop catches it via the
 *      registered URL scheme handler.
 *
 *   2. If the user lands here in a regular browser (e.g. they clicked a
 *      magic-link email on their phone), we render a friendly page with the
 *      token + copy-paste fallback so they can move it onto the device they
 *      want activated.
 *
 * The claim code is one-time: takeClaim() deletes it on first use.
 */

import type { APIRoute } from 'astro';
import { takeClaim, getToken } from '../server/kv.js';
import { getEnv, requireKv } from '../server/env.js';

export const prerender = false;

export const GET: APIRoute = async ({ url, request, locals }) => {
  const code = url.searchParams.get('code');
  if (!code) {
    return new Response('Missing claim code.', { status: 400 });
  }

  const env = getEnv(locals);
  const kv = requireKv(env, 'BILLING_KV');
  const claim = await takeClaim(kv, code);
  if (!claim) {
    return new Response('This claim code is invalid or has already been used. Open Graphnosis and the status poll will pick up your license automatically.', {
      status: 410,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const tokenRec = await getToken(kv, claim.email);
  if (!tokenRec) {
    return new Response(
      'Your subscription is confirmed but the license token is still being minted. Refresh this page in a few seconds, or open Graphnosis and unlock your cortex — it will poll automatically.',
      { status: 425, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }

  const accept = request.headers.get('accept') ?? '';
  const wantsRedirect = accept.includes('text/html');

  // Carry the poll secret so the app can refresh silently later (the by-email
  // poll now requires it). The paste fallback below stays token-only — a manual
  // paste sets the token directly and doesn't need the poll path.
  const keyParam = tokenRec.pollSecret ? `&key=${encodeURIComponent(tokenRec.pollSecret)}` : '';
  const deepLink = `graphnosis://claim?token=${encodeURIComponent(tokenRec.token)}${keyParam}`;

  if (!wantsRedirect) {
    return Response.redirect(deepLink, 303);
  }

  const safeToken = htmlEscape(tokenRec.token);
  const safeEmail = htmlEscape(claim.email);
  const body = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><title>Activate Graphnosis</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: 560px; margin: 6vh auto; padding: 0 24px; color: #1a1a1a; line-height: 1.55; }
  h1 { font-size: 26px; }
  .card { padding: 18px; border-radius: 10px; background: #f4f6f5;
          border: 1px solid #d8e0db; margin: 18px 0; }
  .btn { display: inline-block; padding: 10px 18px; background: #1bb673;
         color: #fff; border-radius: 6px; text-decoration: none; font-weight: 600; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px;
          background: #fff; padding: 10px; border-radius: 4px;
          word-break: break-all; border: 1px solid #e0e0e0; }
  .muted { color: #777; font-size: 13px; }
</style></head><body>
  <h1>Activating Graphnosis for ${safeEmail}…</h1>
  <p class="muted">If Graphnosis is installed on this device, it should open
     automatically. If nothing happens after a few seconds, copy the token
     below into Graphnosis → Settings → License.</p>
  <div class="card">
    <a class="btn" id="open-app" href="${htmlEscape(deepLink)}">Open Graphnosis</a>
  </div>
  <p class="muted">License token (paste into Settings → License if needed):</p>
  <div class="mono">${safeToken}</div>
  <script>
    setTimeout(() => { window.location.href = document.getElementById('open-app').href; }, 250);
  </script>
</body></html>`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
};

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}
