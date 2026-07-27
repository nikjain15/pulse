import type { ModelRef } from '@conduit/client';
import { CONDUIT_MODEL } from './client';

/**
 * Difficulty-based model routing for the generative Ask-Pulse answer path.
 *
 * Ask-Pulse used to PIN one model (`CONDUIT_MODEL`, the reasoning tier) for every turn, so the
 * vendored multi-provider router was present but never exercised. This module turns that pin into
 * a real cascade: the bulk of asks run on a CHEAP tier and only genuinely hard asks ESCALATE to the
 * reasoning tier. The decision is a pure function of signals available at each model turn, so it is
 * deterministic and unit-testable, and it feeds `client.infer({ pinModel })` per turn, which means
 * every call still flows through the existing metering (`lib/usage`) and reporting (`report-usage`).
 *
 * Non-breaking: routing only chooses WHICH model id `resolve` targets. With no API key the path is
 * never reached, and every produced answer still passes through `checkNarrative` before display.
 */

/** The two tiers Ask-Pulse routes across. */
export type AskTier = 'cheap' | 'reasoning';

/**
 * Cheap tier: Haiku 4.5, the default for the bulk of asks. `claude-haiku-4-5` is the valid id and
 * (per the sampling contract in `client.ts`) the newest model that accepts sampling params.
 */
export const ASK_CHEAP_MODEL: ModelRef = { provider: 'anthropic', model: 'claude-haiku-4-5' };

/**
 * Reasoning tier: the model Ask-Pulse used to pin for everything (`CONDUIT_MODEL`, default
 * `claude-opus-4-8`). Reserved now for hard asks, so hard-ask quality is unchanged from before.
 */
export const ASK_REASONING_MODEL: ModelRef = { provider: 'anthropic', model: CONDUIT_MODEL };

/** Return the model id for a tier. */
export function tierModel(tier: AskTier): ModelRef {
  return tier === 'reasoning' ? ASK_REASONING_MODEL : ASK_CHEAP_MODEL;
}

/* ── Difficulty thresholds (tuned to keep simple asks cheap) ─────────────────── */

/**
 * A multi-step loop escalates once it has already taken this many model turns (0-based). A simple
 * ask is one tool round then a final answer (turns 0 and 1), which stays cheap; an ask that keeps
 * gathering past that is treated as genuinely hard and moved to the reasoning tier.
 */
export const ESCALATE_AT_STEP = 2;
/** A long ask (word count) is treated as complex. */
export const LONG_ASK_WORDS = 40;
/** A long ask (character count) is treated as complex. */
export const LONG_ASK_CHARS = 280;
/** Several questions in one utterance is treated as complex. */
export const MULTI_QUESTION = 2;

export interface DifficultyInput {
  /** The user's utterance (the loop goal). */
  utterance: string;
  /** 0-based index of the current model turn in the bounded loop. */
  stepIndex: number;
  /** True once a cheap first-pass answer failed the confidence check (forces escalation). */
  lowConfidence?: boolean;
}

/** The decomposed signals behind a difficulty decision (exposed for tests + reporting). */
export interface DifficultySignal {
  words: number;
  chars: number;
  questions: number;
  stepIndex: number;
  lowConfidence: boolean;
}

/** Decompose an utterance + loop position into the raw difficulty signals. */
export function difficultySignal(input: DifficultyInput): DifficultySignal {
  const utterance = input.utterance ?? '';
  const words = utterance.trim() === '' ? 0 : utterance.trim().split(/\s+/).length;
  return {
    words,
    chars: utterance.length,
    questions: (utterance.match(/\?/g) ?? []).length,
    stepIndex: input.stepIndex,
    lowConfidence: input.lowConfidence ?? false,
  };
}

/**
 * The core routing predicate: is this ask hard enough to spend the reasoning tier on? True when the
 * loop is already multi-step, the utterance is long/complex, or a cheap first pass came back
 * low-confidence. Everything else stays on the cheap tier.
 */
export function isHardAsk(s: DifficultySignal): boolean {
  return (
    s.lowConfidence ||
    s.stepIndex >= ESCALATE_AT_STEP ||
    s.words >= LONG_ASK_WORDS ||
    s.chars >= LONG_ASK_CHARS ||
    s.questions >= MULTI_QUESTION
  );
}

/** Pick the tier for a given ask + loop position. */
export function difficultyTier(input: DifficultyInput): AskTier {
  return isHardAsk(difficultySignal(input)) ? 'reasoning' : 'cheap';
}

/**
 * Hedging phrases that mark a first-pass answer as low-confidence. A cheap-tier answer that hedges
 * is the signal to escalate the whole ask to the reasoning tier and try once more.
 */
const HEDGE_PHRASES = [
  "i'm not sure",
  'i am not sure',
  'not sure',
  "i don't know",
  'i do not know',
  'not certain',
  'cannot tell',
  "can't tell",
  'unclear',
  'no idea',
  'unable to determine',
  'hard to say',
];

/** True when an answer reads as low-confidence (hedged or empty). */
export function looksLowConfidence(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  if (a === '') return true;
  return HEDGE_PHRASES.some((h) => a.includes(h));
}
