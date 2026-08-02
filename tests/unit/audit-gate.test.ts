import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The gate is a plain .mjs script, deliberately dependency-free so CI can run it with bare node.
import { ALLOWLIST_PATH, blockingAdvisories, daysUntilExpiry, evaluateAudit, validateAllowlist } from '../../scripts/audit/gate.mjs';

/**
 * The dependency-audit gate (SH10) is itself a safety control, so it gets tests.
 *
 * The one behaviour worth proving is the one RoleOS's version got wrong: an allowlist
 * entry past its expiry date must FAIL the build. RoleOS wrote "review 2026-08" into a
 * free-text reason, nothing read it, and the exceptions became permanent. Here the date
 * is load-bearing, and this file is what stops that regressing.
 */

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));

const entry = (over: Record<string, string> = {}) => ({
  ghsa: 'GHSA-aaaa-bbbb-cccc',
  package: 'left-pad',
  severity: 'high',
  reason: 'No upstream fix exists and the code path is unreachable from anything shipped.',
  link: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  expires: '2099-01-01',
  ...over,
});

const auditWith = (rows: { pkg: string; severity: string; ghsa: string }[]) => ({
  vulnerabilities: Object.fromEntries(
    rows.map((r) => [
      r.pkg,
      { severity: r.severity, via: [{ url: `https://github.com/advisories/${r.ghsa}`, title: 'x' }] },
    ])
  ),
});

const NOW = new Date('2026-08-02T12:00:00Z');

describe('audit gate: what blocks a merge', () => {
  it('passes a clean audit with an empty allowlist', () => {
    const result = evaluateAudit({ audit: { vulnerabilities: {} }, allowlist: { entries: [] }, now: NOW });
    expect(result.ok).toBe(true);
  });

  it('fails on a high advisory with no allowlist entry', () => {
    const audit = auditWith([{ pkg: 'left-pad', severity: 'high', ghsa: 'GHSA-aaaa-bbbb-cccc' }]);
    const result = evaluateAudit({ audit, allowlist: { entries: [] }, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.unallowlisted).toHaveLength(1);
    expect(result.unallowlisted[0]).toMatchObject({ package: 'left-pad', ghsa: 'GHSA-aaaa-bbbb-cccc' });
  });

  it('fails on a critical advisory too', () => {
    const audit = auditWith([{ pkg: 'left-pad', severity: 'critical', ghsa: 'GHSA-aaaa-bbbb-cccc' }]);
    expect(evaluateAudit({ audit, allowlist: { entries: [] }, now: NOW }).ok).toBe(false);
  });

  it('ignores moderate and low findings', () => {
    const audit = auditWith([
      { pkg: 'left-pad', severity: 'moderate', ghsa: 'GHSA-aaaa-bbbb-cccc' },
      { pkg: 'right-pad', severity: 'low', ghsa: 'GHSA-dddd-eeee-ffff' },
    ]);
    expect(blockingAdvisories(audit)).toHaveLength(0);
    expect(evaluateAudit({ audit, allowlist: { entries: [] }, now: NOW }).ok).toBe(true);
  });

  it('allows a high advisory that has a live allowlist entry for that exact package', () => {
    const audit = auditWith([{ pkg: 'left-pad', severity: 'high', ghsa: 'GHSA-aaaa-bbbb-cccc' }]);
    const result = evaluateAudit({ audit, allowlist: { entries: [entry()] }, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.allowed).toHaveLength(1);
  });

  it('does not let an entry for one package cover the same advisory in another', () => {
    // npm reports the same GHSA under every package that pulls it in. An exception was
    // argued for one package's reachability; it does not transfer.
    const audit = auditWith([{ pkg: 'other-pkg', severity: 'high', ghsa: 'GHSA-aaaa-bbbb-cccc' }]);
    const result = evaluateAudit({ audit, allowlist: { entries: [entry()] }, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.unallowlisted[0].package).toBe('other-pkg');
  });
});

describe('audit gate: expiry is enforced, not decorative', () => {
  it('FAILS when an allowlist entry is past its expiry, even though the advisory is allowlisted', () => {
    const audit = auditWith([{ pkg: 'left-pad', severity: 'high', ghsa: 'GHSA-aaaa-bbbb-cccc' }]);
    const result = evaluateAudit({ audit, allowlist: { entries: [entry({ expires: '2026-08-01' })] }, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.expired).toHaveLength(1);
    expect(result.unallowlisted).toHaveLength(0); // it matched; it is the DATE that failed
  });

  it('FAILS on an expired entry even when the advisory itself is long gone', () => {
    // The RoleOS failure exactly: nobody looks at an entry whose finding disappeared, so
    // that is the entry most likely to rot. Expiry is checked over the whole allowlist.
    const result = evaluateAudit({
      audit: { vulnerabilities: {} },
      allowlist: { entries: [entry({ expires: '2026-01-01' })] },
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.expired).toHaveLength(1);
  });

  it('passes on the expiry day itself and fails the day after', () => {
    const al = { entries: [entry({ expires: '2026-08-02' })] };
    expect(evaluateAudit({ audit: { vulnerabilities: {} }, allowlist: al, now: NOW }).ok).toBe(true);
    const tomorrow = new Date('2026-08-03T00:30:00Z');
    expect(evaluateAudit({ audit: { vulnerabilities: {} }, allowlist: al, now: tomorrow }).ok).toBe(false);
  });

  it('warns, without failing, when an entry is close to expiry', () => {
    const result = evaluateAudit({
      audit: { vulnerabilities: {} },
      allowlist: { entries: [entry({ expires: '2026-08-10' })] },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.expiringSoon).toHaveLength(1);
  });

  it('warns, without failing, when upstream fixed a finding and the entry is now stale', () => {
    const result = evaluateAudit({ audit: { vulnerabilities: {} }, allowlist: { entries: [entry()] }, now: NOW });
    expect(result.ok).toBe(true);
    expect(result.stale).toHaveLength(1);
  });

  it('counts whole days to expiry', () => {
    expect(daysUntilExpiry({ expires: '2026-08-02' }, NOW)).toBe(0);
    expect(daysUntilExpiry({ expires: '2026-08-01' }, NOW)).toBeLessThan(0);
  });
});

describe('audit gate: a malformed allowlist fails the build', () => {
  it('rejects a missing required field', () => {
    const broken = { ...entry() } as Record<string, unknown>;
    delete broken.link;
    expect(validateAllowlist({ entries: [broken] })).toContainEqual(expect.stringContaining('`link`'));
    expect(evaluateAudit({ audit: { vulnerabilities: {} }, allowlist: { entries: [broken] }, now: NOW }).ok).toBe(false);
  });

  it('rejects an unparseable or wrongly formatted expiry', () => {
    expect(validateAllowlist({ entries: [entry({ expires: 'soon' })] })).toContainEqual(
      expect.stringContaining('YYYY-MM-DD')
    );
    expect(validateAllowlist({ entries: [entry({ expires: '2026-02-31' })] }).length).toBeGreaterThan(0);
  });

  it('rejects a non-https link and a reason too thin to review', () => {
    expect(validateAllowlist({ entries: [entry({ link: 'http://example.com' })] }).length).toBeGreaterThan(0);
    expect(validateAllowlist({ entries: [entry({ reason: 'later' })] })).toContainEqual(
      expect.stringContaining('explain')
    );
  });

  it('rejects duplicate entries for the same advisory and package', () => {
    expect(validateAllowlist({ entries: [entry(), entry()] })).toContainEqual(expect.stringContaining('duplicate'));
  });
});

describe('the allowlist this repo actually ships', () => {
  it('is structurally valid', () => {
    expect(validateAllowlist(allowlist)).toEqual([]);
  });

  it('has no entry that is already expired', () => {
    // If this fails on your branch, it is not a flake. Re-triage the finding.
    const expired = allowlist.entries.filter((e: { expires: string }) => daysUntilExpiry(e, new Date()) < 0);
    expect(expired.map((e: { ghsa: string }) => e.ghsa)).toEqual([]);
  });

  it('keeps every exception short-dated rather than open-ended', () => {
    // A year-long exception is a decision to stop looking. Six months is the ceiling.
    for (const e of allowlist.entries) {
      expect(daysUntilExpiry(e, new Date())).toBeLessThanOrEqual(185);
    }
  });
});
