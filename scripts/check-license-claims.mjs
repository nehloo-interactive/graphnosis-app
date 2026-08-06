#!/usr/bin/env node
/**
 * Assert that license claims in README.md match the licenses they describe.
 *
 * The README summarizes licensing in prose, and prose drifts from the files it
 * describes. This repo's README stated that a sibling library was Apache 2.0
 * when it had been FSL-1.1 since the day it was extracted — a public repo
 * advertising more permission than the license grants. The LICENSE file, the
 * package manifest, and the Terms of Use were all correct; only the summary was
 * wrong, so nothing contradicted it and it survived five weeks.
 *
 * Two checks, deliberately different in strictness:
 *
 *   1. THIS repo's own claim, against its own LICENSE file. Offline, always
 *      enforced — a mismatch fails.
 *   2. Claims about sibling repos, against their LICENSE on GitHub. Requires
 *      network; when unavailable the check is skipped with a warning rather
 *      than failing, so an offline machine or a rate limit never blocks a
 *      commit. A mismatch, when we can see one, fails.
 *
 * Usage: node scripts/check-license-claims.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Map a LICENSE file's opening text to the identifier a README would cite. */
function identify(licenseText) {
  const head = licenseText.slice(0, 400).toLowerCase();
  // Order matters: FSL's full title contains "Apache 2.0 Future License", so a
  // naive Apache test would match it and report the permissive license.
  if (head.includes('functional source license')) return 'FSL-1.1-Apache-2.0';
  if (head.includes('apache license')) return 'Apache-2.0';
  if (head.includes('mit license')) return 'MIT';
  return null;
}

/** The license section of the README — where the summary lives.
 *  Runs to the next heading of the same level, or to end of file when the
 *  section is last (which it usually is). */
function licenseSection(readme) {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^##+\s*Licen[cs]e\s*$/i.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const failures = [];
const warnings = [];

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const section = licenseSection(readme);
if (!section.trim()) {
  failures.push('README.md has no "## License" section to check.');
}

// ── 1. This repo's own license ───────────────────────────────────────────────
const own = identify(readFileSync(join(ROOT, 'LICENSE'), 'utf8'));
if (!own) {
  failures.push('Could not identify this repo\'s LICENSE.');
} else if (!section.includes(own)) {
  failures.push(
    `README licence section does not cite this repo's actual licence (${own}).`,
  );
} else {
  console.log(`  ok  this repo: README cites ${own}`);
}

// ── 2. Claims about sibling repos ────────────────────────────────────────────
// Matches: [`name`](https://github.com/OWNER/REPO) (CLAIM)
const CLAIM_RE =
  /\]\(https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/?\)\s*\(([A-Za-z0-9.\-]+)\)/g;

const claims = [...section.matchAll(CLAIM_RE)].map(([, owner, repo, claimed]) => ({
  slug: `${owner}/${repo}`,
  claimed,
}));

if (claims.length === 0) {
  console.log('  --  no sibling licence claims found to verify');
}

for (const { slug, claimed } of claims) {
  let actual = null;
  try {
    for (const branch of ['HEAD', 'main', 'master']) {
      const res = await fetch(`https://raw.githubusercontent.com/${slug}/${branch}/LICENSE`);
      if (res.ok) { actual = identify(await res.text()); break; }
    }
  } catch (err) {
    warnings.push(`${slug}: could not fetch LICENSE (${err.message}) — claim unverified`);
    continue;
  }
  if (!actual) {
    warnings.push(`${slug}: LICENSE unreadable or unrecognised — claim unverified`);
  } else if (actual !== claimed) {
    failures.push(`${slug}: README claims ${claimed}, actual licence is ${actual}.`);
  } else {
    console.log(`  ok  ${slug}: README claims ${claimed}`);
  }
}

for (const w of warnings) console.warn(`  warn  ${w}`);

if (failures.length > 0) {
  console.error('\nLicence claim check FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nA README that overstates a licence grants permission the licence does not.\n' +
    'Fix the summary, or the LICENSE file if the summary is the correct one.',
  );
  process.exit(1);
}

console.log('Licence claims match the licences they describe.');
