/**
 * Cloudflare Pages Function — single source of truth for /download/<platform>.
 *
 * WHY THIS EXISTS (and why the static lines in public/_redirects do NOT handle
 * these paths): Cloudflare Pages runs Functions BEFORE the _redirects file, and
 * _redirects is bypassed for any route a Function matches. This file matches
 * /download/* via the [platform] param, so EVERY /download/<platform> redirect
 * MUST be resolved here. See:
 *   https://developers.cloudflare.com/pages/functions/routing/
 *
 * Every platform tracks the latest release AUTOMATICALLY via CURRENT_VERSION,
 * which release.yml's `update-cloudflare` job sets as a Pages env var on every
 * tag. mac + win additionally read DMG_FILENAME / WINDOWS_FILENAME (the exact
 * asset names, which carry arch/locale specifics); linux uses the deterministic
 * canonical names the build-linux job uploads (Graphnosis_<semver>_amd64.*).
 * A new release just works with no code change here.
 *
 * NOTE: Linux artifacts are attached to a release by the build-linux workflow
 * (workflow_dispatch, upload_to_release=true). A release that has no Linux
 * bundle yet will 404 on /download/linux until that backfill runs.
 */

interface Env {
  CURRENT_VERSION?: string; // e.g. "v1.13.4" (includes the leading "v")
  DMG_FILENAME?: string; // e.g. "Graphnosis_1.13.4_aarch64.dmg"
  WINDOWS_FILENAME?: string; // e.g. "Graphnosis_1.13.4_x64_en-US.msi"
}

const RELEASES =
  'https://github.com/nehloo-interactive/graphnosis-app/releases/download';

// Last-resort fallback if the CURRENT_VERSION env var is ever missing/unset.
// Keep roughly current; should match public/_redirects.
const FALLBACK_VERSION = 'v1.23.0';

export const onRequestGet: PagesFunction<Env> = (ctx) => {
  const platform = String(ctx.params.platform ?? '').toLowerCase();
  const { CURRENT_VERSION, DMG_FILENAME, WINDOWS_FILENAME } = ctx.env;
  const version = CURRENT_VERSION || FALLBACK_VERSION; // "v1.13.4"
  const semver = version.replace(/^v/, ''); // "1.13.4"
  const asset = (file: string) => `${RELEASES}/${version}/${file}`;

  let target: string | undefined;
  switch (platform) {
    case 'mac':
      target = asset(DMG_FILENAME || `Graphnosis_${semver}_aarch64.dmg`);
      break;
    case 'win':
      target = asset(WINDOWS_FILENAME || `Graphnosis_${semver}_x64_en-US.msi`);
      break;
    case 'linux':
      target = asset(`Graphnosis_${semver}_amd64.AppImage`);
      break;
    case 'linux-deb':
      target = asset(`Graphnosis_${semver}_amd64.deb`);
      break;
  }

  // Unknown platform → send to the download landing page rather than 404.
  if (!target) {
    return Response.redirect(new URL('/download', ctx.request.url).toString(), 302);
  }
  return Response.redirect(target, 302);
};
