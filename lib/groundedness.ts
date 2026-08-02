import Anthropic from '@anthropic-ai/sdk';
import type { Evidence } from './types';
import { logAttempts, withRetry } from './retry';

/**
 * Groundedness scoring for published narratives. EVALS.md §5.
 *
 * Safety (does the narrative name someone else?) is asserted deterministically by
 * `checkNarrative`. This module covers the *other* half — **accuracy**: does what the
 * narrative claims actually trace to the commit/PR evidence Pulse retrieved, or did the
 * model invent work that never happened?
 *
 * Two scorers live here:
 *   - `scoreGroundedness` — a pure, deterministic check (no network, no spend). It verifies
 *     the *checkable* claims in a narrative — PR numbers and file references — against the
 *     retrieved evidence. This is the CI backbone: it runs offline and its verdict is
 *     reproducible, exactly like the `checkNarrative` guard eval.
 *   - `judgeGroundedness` — the LLM judge scoped in EVALS.md §5. It reads the narrative
 *     against its evidence and returns a grounded/ungrounded verdict with a reason. It only
 *     runs when `ANTHROPIC_API_KEY` is set (it costs a model call), so the deterministic
 *     scorer is what guards CI while the judge adds richer coverage where a key exists.
 */

export type GroundednessResult = {
  /** True when every checkable claim traces to the evidence. */
  grounded: boolean;
  /** Human-readable reasons a claim failed to trace — empty when grounded. */
  ungroundedClaims: string[];
};

/** PR references written as `#40` or `PR 40`. */
const PR_REF = /(?:#|\bPR\s+)(\d+)/gi;
/** File-path-looking tokens: `lib/sense.ts`, `README.md`, `src/app/page.tsx`. */
const FILE_REF = /\b[\w.-]+(?:\/[\w.-]+)*\.[a-z]{1,5}\b/gi;

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/**
 * Deterministically score whether a narrative's checkable claims trace to the evidence.
 *
 * "Checkable" is deliberately narrow: a PR number the model wrote must be a PR Pulse
 * actually retrieved, and a file the model named must be a file that was actually touched
 * (or at least appear in the raw material). Free-form prose ("cracked the auth flow") is
 * unfalsifiable from evidence alone and is never flagged — the goal is to catch *invented
 * specifics*, not to second-guess phrasing. A missed nuance costs nothing; a fabricated PR
 * number published to 64 people is the failure this catches.
 */
export function scoreGroundedness(
  narrative: string,
  evidence: Evidence,
  material: string[] = []
): GroundednessResult {
  const ungroundedClaims: string[] = [];

  const knownPrs = new Set(evidence.prNumbers.map((n) => String(n)));
  for (const m of narrative.matchAll(PR_REF)) {
    const num = m[1];
    if (!knownPrs.has(num)) {
      ungroundedClaims.push(`PR #${num} is claimed but not in the retrieved evidence`);
    }
  }

  // A file token is grounded if it (by basename) matches a touched file, or appears verbatim
  // in the raw material (commit/PR text the model was handed). Anything else is invented.
  const knownFiles = new Set(evidence.files.map((f) => basename(f).toLowerCase()));
  const materialBlob = material.join('\n').toLowerCase();
  for (const m of narrative.matchAll(FILE_REF)) {
    const token = m[0];
    const base = basename(token).toLowerCase();
    const inFiles = knownFiles.has(base);
    const inMaterial = materialBlob.includes(token.toLowerCase());
    if (!inFiles && !inMaterial) {
      ungroundedClaims.push(`file "${token}" is named but was not touched or mentioned`);
    }
  }

  return { grounded: ungroundedClaims.length === 0, ungroundedClaims };
}

// ---------------------------------------------------------------------------
// LLM judge (EVALS.md §5). Runs only when a key is present; costs one model call.
// ---------------------------------------------------------------------------

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8';

const JUDGE_SYSTEM = `You are a strict fact-checker for an activity feed. You are given a one-sentence narrative about what a developer shipped, plus the evidence Pulse retrieved from GitHub (commit count, PR numbers, files touched, and the raw commit/PR text).

Decide whether every concrete, checkable claim in the narrative is supported by the evidence. A claim is UNGROUNDED if it names a PR, file, number, or piece of work that is absent from the evidence. General, unfalsifiable phrasing is fine — only flag invented specifics.

Reply with exactly one line of JSON and nothing else:
{"grounded": true|false, "reason": "<short reason>"}`;

export type JudgeVerdict = { grounded: boolean; reason: string };

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ??= new Anthropic();
  return client;
}

/** A compact evidence receipt for the judge prompt. Kept local so this module stays pure
 *  (no `./sense` import) and can be loaded directly by the eval harness under Node. */
function evidenceReceipt(evidence: Evidence): string {
  const parts = [`${evidence.commits} commit(s)`];
  if (evidence.prNumbers.length) parts.push(`PR(s) ${evidence.prNumbers.join(', ')}`);
  if (evidence.spanHours != null) parts.push(`over ~${evidence.spanHours}h`);
  return parts.join(', ');
}

export function buildJudgePrompt(
  narrative: string,
  evidence: Evidence,
  material: string[] = []
): string {
  return [
    `Narrative: ${narrative}`,
    '',
    `Evidence: ${evidenceReceipt(evidence)}`,
    `Files touched: ${evidence.files.slice(0, 20).join(', ') || '(none)'}`,
    '',
    '--- raw material (commit messages, PR titles, branch names) ---',
    material.map((l) => l.slice(0, 500)).join('\n'),
    '--- end material ---',
  ].join('\n');
}

/**
 * Ask the model to judge groundedness. Returns `null` when no key is configured (the caller
 * falls back to the deterministic scorer). Never throws — a judge failure is not a product
 * failure, and a broken judge must not fail an eval run for the wrong reason.
 */
export async function judgeGroundedness(
  narrative: string,
  evidence: Evidence,
  material: string[] = []
): Promise<JudgeVerdict | null> {
  const anthropic = getClient();
  if (!anthropic) return null;
  try {
    // The judge runs offline in an eval harness, not in a request, but it is the same provider
    // and the same transient failures. A retried blip here is one fewer eval row scored `null`
    // for a reason that has nothing to do with groundedness.
    const response = await withRetry(
      (signal) =>
        anthropic.messages.create(
          {
            model: MODEL,
            max_tokens: 200,
            system: JUDGE_SYSTEM,
            output_config: { effort: 'low' },
            messages: [{ role: 'user', content: buildJudgePrompt(narrative, evidence, material) }],
          },
          { signal }
        ),
      { onAttempt: logAttempts('groundedness-judge') }
    );
    if (response.stop_reason === 'refusal') return null;
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as JudgeVerdict;
    if (typeof parsed.grounded !== 'boolean') return null;
    return { grounded: parsed.grounded, reason: String(parsed.reason ?? '') };
  } catch {
    return null;
  }
}
