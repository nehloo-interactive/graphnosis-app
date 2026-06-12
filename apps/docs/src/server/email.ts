/**
 * Email delivery for the magic-link claim flow.
 *
 * Uses Resend's HTTP API (Workers-friendly — pure fetch, no Node SDK).
 * Swap the provider by changing this file; the signature stays stable.
 */

import type { BillingEnv } from './env.js';

export interface MagicLinkParams {
  to: string;
  /** Full graphnosis://claim?code=... deep link. */
  deepLink: string;
  /** The HTTPS fallback that does the same redirect (for clients that can't
   *  intercept custom schemes — same code, just at https://.../claim?code=…). */
  webFallback: string;
}

export interface TeamInviteParams {
  to: string;
  /** Email address of the person or admin who provisioned this seat. */
  ownerEmail: string;
  /** graphnosis://claim?token=... deep link (token-bearing, not code-bearing). */
  deepLink: string;
  /** HTTPS fallback for the same activation. */
  webFallback: string;
}

export async function sendMagicLink(env: BillingEnv, params: MagicLinkParams): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_ADDRESS;
  if (!apiKey || apiKey === 're_REPLACE_ME' || !from) {
    // In dev, log the link instead of failing. The operator can still
    // copy it out of `wrangler tail` to test the desktop side.
    console.warn('[billing] Resend not configured — magic link logged below instead of emailed.');
    console.warn(`[billing] To: ${params.to}`);
    console.warn(`[billing] Link: ${params.deepLink}`);
    console.warn(`[billing] Fallback: ${params.webFallback}`);
    return;
  }

  const subject = 'Activate Graphnosis Pro on your device';
  const html = `
    <p>Hi,</p>
    <p>Thanks for subscribing to Graphnosis Pro. Click the button below on the
       device you'd like to activate — it'll open Graphnosis and unlock your
       Pro features automatically.</p>
    <p>
      <a href="${escape(params.deepLink)}"
         style="display:inline-block;padding:10px 18px;background:#1bb673;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">
        Activate Graphnosis Pro
      </a>
    </p>
    <p style="color:#888;font-size:13px;">If the button does nothing, copy this
       link into the app's Settings → License panel:</p>
    <p style="font-family:ui-monospace,monospace;background:#f4f4f4;padding:8px;border-radius:4px;word-break:break-all;">
      ${escape(params.deepLink)}
    </p>
    <p style="color:#888;font-size:13px;">Or open this URL in your browser if
       the graphnosis:// scheme isn't registered yet:</p>
    <p style="font-family:ui-monospace,monospace;background:#f4f4f4;padding:8px;border-radius:4px;word-break:break-all;">
      ${escape(params.webFallback)}
    </p>
    <p style="color:#888;font-size:12px;">— The Graphnosis team</p>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: params.to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
}

export async function sendTeamInvite(env: BillingEnv, params: TeamInviteParams): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_ADDRESS;
  if (!apiKey || apiKey === 're_REPLACE_ME' || !from) {
    console.warn('[billing] Resend not configured — team invite link logged below.');
    console.warn(`[billing] To: ${params.to}`);
    console.warn(`[billing] From: ${params.ownerEmail}`);
    console.warn(`[billing] Link: ${params.deepLink}`);
    return;
  }

  const subject = 'You have been given a Graphnosis Pro seat';
  const html = `
    <p>Hi,</p>
    <p><strong>${escape(params.ownerEmail)}</strong> has given you access to
       Graphnosis Pro. Click the button below on the device you'd like to activate.</p>
    <p>
      <a href="${escape(params.deepLink)}"
         style="display:inline-block;padding:10px 18px;background:#1bb673;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">
        Activate Graphnosis
      </a>
    </p>
    <p style="color:#888;font-size:13px;">If the button does nothing, copy this
       link into the app's Settings → License panel:</p>
    <p style="font-family:ui-monospace,monospace;background:#f4f4f4;padding:8px;border-radius:4px;word-break:break-all;">
      ${escape(params.deepLink)}
    </p>
    <p style="color:#888;font-size:13px;">Or open this URL in your browser:</p>
    <p style="font-family:ui-monospace,monospace;background:#f4f4f4;padding:8px;border-radius:4px;word-break:break-all;">
      ${escape(params.webFallback)}
    </p>
    <p style="color:#888;font-size:12px;">— The Graphnosis team</p>
  `;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: params.to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c));
}
