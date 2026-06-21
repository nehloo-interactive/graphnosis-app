/**
 * GET /download/:platform — runtime download redirect.
 *
 * Replaces the dead apps/docs/functions/download/[platform].ts: when Astro's
 * Cloudflare adapter emits _worker.js the functions/ directory is bypassed
 * entirely, so the only way to intercept /download/* at the Worker layer is
 * via a server-rendered Astro route (export const prerender = false).
 *
 * Reads CURRENT_VERSION / DMG_FILENAME / WINDOWS_FILENAME from the Cloudflare
 * runtime env (set by release.yml's update-cloudflare* jobs). Because these
 * are read at request time — not at build time — bumping the env vars in the
 * Cloudflare dashboard immediately updates what every platform downloads,
 * with no redeployment needed.
 *
 * public/_redirects remains as a last-resort fallback for the unlikely event
 * this route is removed, but it is never reached while this endpoint exists.
 */

import type { APIRoute } from 'astro';
import { getEnv } from '../../server/env.js';

export const prerender = false;

const RELEASES =
  'https://github.com/nehloo-interactive/graphnosis-app/releases/download';

// Keep in sync with tauri.conf.json version. Only used if CURRENT_VERSION is
// absent from Cloudflare env vars (should never happen after a successful release).
const FALLBACK_VERSION = 'v1.21.0';

export const GET: APIRoute = ({ params, locals, request }) => {
  const env = getEnv(locals);
  const platform = String(params.platform ?? '').toLowerCase();
  const version = env.CURRENT_VERSION || FALLBACK_VERSION;
  const semver = version.replace(/^v/, '');
  const asset = (file: string) => `${RELEASES}/${version}/${file}`;

  let target: string | undefined;
  switch (platform) {
    case 'mac':
      target = asset(env.DMG_FILENAME || `Graphnosis_${semver}_aarch64.dmg`);
      break;
    case 'win':
      target = asset(env.WINDOWS_FILENAME || `Graphnosis_${semver}_x64_en-US.msi`);
      break;
    case 'linux':
      target = asset(`Graphnosis_${semver}_amd64.AppImage`);
      break;
    case 'linux-deb':
      target = asset(`Graphnosis_${semver}_amd64.deb`);
      break;
  }

  if (!target) {
    return Response.redirect(new URL('/download', request.url).toString(), 302);
  }
  return Response.redirect(target, 302);
};
