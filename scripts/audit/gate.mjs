#!/usr/bin/env node
/**
 * The dependency-audit gate. SH10.
 *
 * Why this exists: CI ran typecheck, lint, unit tests and a build, and no dependency
 * audit at all. That is how 16 Dependabot alerts accumulated before anyone looked. The
 * gate closes the loop: a new high or critical advisory in a SHIPPED dependency fails
 * the build on the pull request that introduces it.
 *
 * The design borrows RoleOS's `scripts/audit-gate.mjs` and fixes its one real defect.
 * RoleOS's allowlist entries carried a "review 2026-08" note in a free-text reason
 * string. Nothing read that string, so every entry sailed past its review date in
 * silence and the allowlist quietly became permanent. Here the expiry is a machine-read
 * field and **an expired entry fails the build**. An allowlist you cannot forget about
 * is the whole point; an allowlist that only ever grows is worse than no allowlist,
 * because it looks like a control.
 *
 * What is gated: `npm audit --omit=dev`, i.e. production dependencies. A high advisory
 * in eslint is a fact about the build box, not about what 64 people load in a browser.
 * Dev advisories are reported by `npm audit` on demand and are deliberately not a merge
 * blocker.
 *
 * Failure modes, all of which fail the build rather than passing quietly:
 *   - a high/critical prod advisory with no allowlist entry;
 *   - an allowlist entry whose `expires` date has passed;
 *   - an allowlist entry missing any required field, or with an unparseable date.
 *
 * One condition warns rather than fails: an entry whose advisory no longer appears in
 * the audit (upstream shipped a fix). That is good news, and turning good news into a
 * red build trains people to delete the gate. It is printed loudly and the entry should
 * be removed at the next pass.
 *
 * Usage:
 *   node scripts/audit/gate.mjs                 # runs npm audit itself
 *   node scripts/audit/gate.mjs --audit <file>  # scores a saved audit JSON (tests)
 *   node scripts/audit/gate.mjs --now 2027-01-01  # pin the clock (tests)
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ALLOWLIST_PATH = resolve(HERE, 'allowlist.json');

/** Severities that block a merge. Moderate and below are reported, never gating. */
export const BLOCKING_SEVERITIES = ['high', 'critical'];

/** An entry expiring inside this window is called out while there is still time to act. */
export const EXPIRY_WARNING_DAYS = 21;

const DAY_MS = 86_400_000;
const REQUIRED_FIELDS = ['ghsa', 'package', 'severity', 'reason', 'link', 'expires'];

/** `https://github.com/advisories/GHSA-xxxx-yyyy-zzzz` -> `GHSA-xxxx-yyyy-zzzz`. */
export function advisoryIdOf(via) {
  if (typeof via !== 'object' || via === null) return null;
  const fromUrl = String(via.url ?? '').split('/').pop();
  return fromUrl && fromUrl.startsWith('GHSA-') ? fromUrl : null;
}

/**
 * Every blocking-severity advisory in an `npm audit --json` payload, flattened to one
 * row per (package, advisory) pair. npm nests the same advisory under every package that
 * pulls it in, so the same GHSA legitimately appears more than once.
 */
export function blockingAdvisories(audit) {
  const rows = [];
  for (const [pkg, info] of Object.entries(audit?.vulnerabilities ?? {})) {
    if (!BLOCKING_SEVERITIES.includes(info?.severity)) continue;
    for (const via of info.via ?? []) {
      const ghsa = advisoryIdOf(via);
      if (!ghsa) continue; // a string `via` is an indirection to another package's entry
      rows.push({ package: pkg, ghsa, severity: info.severity, title: via.title ?? '' });
    }
  }
  return rows;
}

/** Structural validation. A malformed allowlist is a failed gate, never a skipped one. */
export function validateAllowlist(allowlist) {
  const problems = [];
  const entries = allowlist?.entries;
  if (!Array.isArray(entries)) return ['allowlist.json: `entries` must be an array'];

  const seen = new Set();
  entries.forEach((entry, i) => {
    const where = `entries[${i}]${entry?.ghsa ? ` (${entry.ghsa})` : ''}`;
    for (const field of REQUIRED_FIELDS) {
      const value = entry?.[field];
      if (typeof value !== 'string' || value.trim() === '') {
        problems.push(`${where}: missing required field \`${field}\``);
      }
    }
    if (typeof entry?.ghsa === 'string') {
      if (!entry.ghsa.startsWith('GHSA-')) problems.push(`${where}: \`ghsa\` must be a GHSA id`);
      const key = `${entry.ghsa}::${entry.package}`;
      if (seen.has(key)) problems.push(`${where}: duplicate entry for ${entry.package}`);
      seen.add(key);
    }
    if (typeof entry?.link === 'string' && !entry.link.startsWith('https://')) {
      problems.push(`${where}: \`link\` must be an https URL`);
    }
    if (typeof entry?.expires === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
        problems.push(`${where}: \`expires\` must be YYYY-MM-DD, got "${entry.expires}"`);
      } else {
        // Round-trip rather than a bare Date.parse: some runtimes happily roll 2026-02-31
        // over into March, which would silently extend an exception by a day.
        const parsed = new Date(`${entry.expires}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== entry.expires) {
          problems.push(`${where}: \`expires\` is not a real date ("${entry.expires}")`);
        }
      }
    }
    if (typeof entry?.reason === 'string' && entry.reason.trim().length < 20) {
      // A one-word reason is how an allowlist stops being reviewable.
      problems.push(`${where}: \`reason\` must actually explain the exception`);
    }
  });
  return problems;
}

/** Whole-day distance from `now` to the entry's expiry. Negative means already expired. */
export function daysUntilExpiry(entry, now) {
  const at = Date.parse(`${entry.expires}T23:59:59Z`);
  return Math.floor((at - now.getTime()) / DAY_MS);
}

/**
 * Score an audit payload against the allowlist. Pure: no process, no clock, no npm.
 * Returns everything the CLI prints and everything the unit tests assert on.
 */
export function evaluateAudit({ audit, allowlist, now = new Date() }) {
  const malformed = validateAllowlist(allowlist);
  if (malformed.length) {
    return { ok: false, malformed, expired: [], unallowlisted: [], expiringSoon: [], stale: [], allowed: [] };
  }

  const entries = allowlist.entries;
  const byGhsa = new Map();
  for (const entry of entries) {
    if (!byGhsa.has(entry.ghsa)) byGhsa.set(entry.ghsa, []);
    byGhsa.get(entry.ghsa).push(entry);
  }

  const found = blockingAdvisories(audit);
  const foundIds = new Set(found.map((row) => row.ghsa));

  // Expiry is checked over the WHOLE allowlist, not only over entries that matched a
  // current finding. An entry nobody looked at is exactly the one that goes stale, and
  // the RoleOS failure was that going stale cost nothing.
  const expired = entries.filter((e) => daysUntilExpiry(e, now) < 0);
  const expiringSoon = entries.filter((e) => {
    const d = daysUntilExpiry(e, now);
    return d >= 0 && d <= EXPIRY_WARNING_DAYS;
  });

  const unallowlisted = [];
  const allowed = [];
  for (const row of found) {
    const match = (byGhsa.get(row.ghsa) ?? []).find((e) => e.package === row.package);
    if (match) allowed.push({ ...row, entry: match });
    else unallowlisted.push(row);
  }

  // Upstream fixed it, or the dependency went away. Warn, do not fail.
  const stale = entries.filter((e) => !foundIds.has(e.ghsa));

  return {
    ok: unallowlisted.length === 0 && expired.length === 0,
    malformed: [],
    expired,
    expiringSoon,
    unallowlisted,
    stale,
    allowed,
  };
}

/** `npm audit --omit=dev --json`. npm exits non-zero when findings exist; the JSON is still on stdout. */
export function runNpmAudit(cwd = resolve(HERE, '..', '..')) {
  try {
    return JSON.parse(
      execSync('npm audit --omit=dev --json', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    );
  } catch (err) {
    const out = err?.stdout;
    if (!out) throw new Error(`npm audit produced no output: ${err?.message ?? err}`);
    return JSON.parse(out);
  }
}

export function report(result, log = console) {
  const line = (s) => log.log(s);
  const err = (s) => log.error(s);

  if (result.malformed.length) {
    err('Dependency audit gate FAILED: the allowlist itself is malformed.');
    result.malformed.forEach((m) => err(`  - ${m}`));
    return;
  }

  if (result.expired.length) {
    err('Dependency audit gate FAILED: allowlist entries are past their expiry date.');
    err('  An accepted risk has a review date. This is that review, arriving on time.');
    result.expired.forEach((e) =>
      err(`  - ${e.ghsa} (${e.package}) expired ${e.expires}. Re-triage it, then re-date or remove the entry.`)
    );
  }

  if (result.unallowlisted.length) {
    err('Dependency audit gate FAILED: high/critical advisories in production dependencies with no allowlist entry.');
    [...new Set(result.unallowlisted.map((r) => `${r.severity}: ${r.package} (${r.ghsa}) ${r.title}`))].forEach((r) =>
      err(`  - ${r}`)
    );
    err('  Fix it, or add an entry to scripts/audit/allowlist.json with a reason, a link and an expiry date.');
  }

  result.stale.forEach((e) =>
    line(`  note: ${e.ghsa} (${e.package}) is allowlisted but no longer reported. Upstream fixed it: delete the entry.`)
  );
  result.expiringSoon.forEach((e) => line(`  note: ${e.ghsa} (${e.package}) expires ${e.expires}. Re-triage before then.`));

  if (result.ok) {
    const n = new Set(result.allowed.map((a) => a.ghsa)).size;
    line(
      `Dependency audit gate passed: 0 unallowlisted high/critical production advisories ` +
        `(${n} documented, dated, unexpired exception${n === 1 ? '' : 's'}).`
    );
  }
}

// --- CLI -------------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };
  const auditFile = flag('audit');
  const nowFlag = flag('now');

  const audit = auditFile ? JSON.parse(readFileSync(auditFile, 'utf8')) : runNpmAudit();
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const now = nowFlag ? new Date(`${nowFlag}T12:00:00Z`) : new Date();

  const result = evaluateAudit({ audit, allowlist, now });
  report(result);
  process.exit(result.ok ? 0 : 1);
}
