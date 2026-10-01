/**
 * The gstack sprint pipeline as a first-class state machine, with Jev-gated
 * stage transitions.
 *
 * ## Why this module exists
 *
 * gstack's canonical order
 * (`/office-hours → /plan-ceo-review → /plan-eng-review → /review → /ship →
 * /qa → /retro`) exists only as prose in its README and as ad-hoc
 * `benefits-from:` hints in individual templates. Nothing in the repository
 * encodes the order, so nothing can enforce it, resume it, or decide whether a
 * stage is actually finished. This module is that missing state.
 *
 * ## The gate
 *
 * Advancing a stage is a yes/no decision about whether the current stage's
 * completion criteria are satisfied. That is exactly the shape of a Jev
 * question, so it is asked as one — a calibrated probability rather than an LLM
 * narrating its own success. A stage advances only on a confident pass; a
 * confident fail sends corrective feedback back; an unsure answer escalates
 * (or, when escalation is exhausted, asks the human).
 *
 * @module gstack-dsh/pipeline
 */

import { QUESTION_TYPES, answerScalar, classifyJevFailure, readNoulAnswer, toState } from './jev.js';

/**
 * The seven sprint stages. `order` is authoritative — the canonical invocation
 * sequence in the task statement and the README.
 */
export const STAGES = [
  {
    id: 'think',
    label: 'Think',
    skills: ['gstack-office-hours'],
    /** What must be true before this stage's output is acceptable. */
    completionCriteria:
      'The problem, the target user, and the demand signal are stated explicitly, and at least one ' +
      'alternative framing of the problem was considered and rejected with a reason.',
  },
  {
    id: 'plan',
    label: 'Plan',
    skills: ['gstack-plan-ceo-review', 'gstack-plan-eng-review', 'gstack-plan-design-review', 'gstack-plan-devex-review'],
    completionCriteria:
      'The plan fixes the scope, names the architecture and data flow, lists edge cases and failure ' +
      'modes, and states which tests will prove it works. Open questions are either resolved or ' +
      'explicitly deferred with an owner.',
  },
  {
    id: 'build',
    label: 'Build',
    skills: ['gstack-spec', 'gstack-investigate', 'gstack-diagram', 'gstack-design-html'],
    completionCriteria:
      'The change is implemented in the working tree, the code path is reachable from a real entry ' +
      'point, and no step was reported as done without being executed.',
  },
  {
    id: 'review',
    label: 'Review',
    skills: ['gstack-review', 'gstack-design-review', 'gstack-cso'],
    completionCriteria:
      'The diff was read line by line for correctness, security, and unintended side effects; every ' +
      'finding is either fixed or explicitly accepted with a reason.',
  },
  {
    id: 'test',
    label: 'Test',
    skills: ['gstack-qa', 'gstack-qa-only', 'gstack-test-audit'],
    completionCriteria:
      'The behavior was actually exercised, the observed result is recorded, and any failure has a ' +
      'reproduction. Passing is claimed only from observed test output.',
  },
  {
    id: 'ship',
    label: 'Ship',
    skills: ['gstack-ship', 'gstack-land-and-deploy'],
    completionCriteria:
      'The branch is synced with its base, required tests pass, the change is committed with a ' +
      'message explaining why, and the PR or landing path is created.',
  },
  {
    id: 'reflect',
    label: 'Reflect',
    skills: ['gstack-retro', 'gstack-learn', 'gstack-context-save'],
    completionCriteria:
      'What shipped is recorded, what went wrong is named without blame, and at least one durable ' +
      'lesson or decision is written down for a future session.',
  },
];

/** Fast lookup by stage id. */
export const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]));

/** Terminal stage id. */
export const FINAL_STAGE_ID = STAGES[STAGES.length - 1].id;

/** Confidence threshold for a gate to count as decided rather than unsure. */
export const DEFAULT_GATE_THRESHOLD = 0.7;

/**
 * Create a fresh pipeline state for one run.
 *
 * @param {object} [options]
 * @param {string} [options.objective] - what the run is trying to achieve.
 * @param {string} [options.stageId] - starting stage (defaults to the first).
 * @returns {object} mutable pipeline state.
 */
export function createPipelineState(options = {}) {
  const stageId = options.stageId || STAGES[0].id;
  if (!STAGE_BY_ID.has(stageId)) {
    throw new Error(`Unknown pipeline stage '${stageId}'.`);
  }
  return {
    version: 1,
    objective: options.objective || '',
    stageId,
    history: [],
    gateAttempts: {},
    createdAt: new Date().toISOString(),
  };
}

/**
 * Describe where the run is and what the next gate will ask.
 *
 * @param {object} state - pipeline state.
 * @returns {object} a stable, model-readable summary.
 */
export function describeStage(state) {
  const stage = STAGE_BY_ID.get(state.stageId);
  if (!stage) throw new Error(`Corrupt pipeline state: unknown stage '${state.stageId}'.`);
  const index = STAGES.findIndex((candidate) => candidate.id === stage.id);
  const next = STAGES[index + 1];
  return {
    stage: stage.id,
    label: stage.label,
    index,
    total: STAGES.length,
    skills: stage.skills,
    completionCriteria: stage.completionCriteria,
    nextStage: next ? next.id : null,
    isFinal: !next,
  };
}

/**
 * Build the System One question that gates leaving the current stage.
 *
 * The question is anchored to the stage's own written completion criteria so the
 * decision rests on the criteria rather than on a vibe. The evidence rides in
 * `state` — System One's evidence channel — which is how Jev sees the work
 * without anyone spending tokens summarizing it.
 *
 * @param {object} state - pipeline state.
 * @param {string} evidence - digest of what the stage actually produced.
 * @returns {{key: string, question: object, stateText: string}}
 */
export function buildGateQuestion(state, evidence) {
  const stage = describeStage(state);
  return {
    key: `stage_${stage.stage}_complete`,
    question: {
      type: QUESTION_TYPES.NOUL,
      instructions:
        `Stage "${stage.label}" of a software sprint is complete. Completion means: ` +
        `${stage.completionCriteria} Score how completely the observed evidence ` +
        `satisfies those criteria, where a high score means clearly complete.`,
    },
    stateText: toState(
      `Completion criteria for stage "${stage.label}":\n${stage.completionCriteria}\n\n` +
        `Evidence observed from the run:\n${evidence || '(no evidence supplied)'}`
    ),
  };
}

/**
 * Ask Jev whether the current stage may advance.
 *
 * @param {object} deps
 * @param {{triage: Function}} deps.jev - a JevClient.
 * @param {object} state - pipeline state.
 * @param {string} evidence - digest of the stage output.
 * @param {object} [options]
 * @param {number} [options.threshold] - confidence threshold.
 * @returns {Promise<object>} the gate outcome.
 */
export async function evaluateGate({ jev }, state, evidence, options = {}) {
  const threshold = options.threshold ?? DEFAULT_GATE_THRESHOLD;
  const stage = describeStage(state);
  const { key, question, stateText } = buildGateQuestion(state, evidence);

  let response;
  try {
    response = await jev.triage({ [key]: question }, { state: stateText });
  } catch (error) {
    // A decision layer that is unreachable must not silently pass a gate. But it
    // must not misreport WHY either: a free-tier rate limit needs waiting, not a
    // binding repair, and telling someone to fix a working credential sends them
    // to the wrong problem entirely.
    const failure = classifyJevFailure(error);
    return {
      stage: stage.stage,
      decision: 'unavailable',
      confident: false,
      value: null,
      threshold,
      failure: failure.kind,
      retryable: failure.retryable,
      error: failure.detail,
      message:
        failure.kind === 'rate-limited'
          ? `Jev is RATE LIMITED while gating "${stage.label}" (free tier). The binding is ` +
            `fine and nothing needs repairing — the gate is deferred. Wait for the quota to ` +
            `reset and re-run the gate, or raise the operator's involvement for this call.`
          : `Jev was unreachable while gating "${stage.label}". Refusing to advance on an ` +
            `unverified completion claim. Fix the Jev binding, or re-run the stage gate.`,
    };
  }

  const answer = response?.answers?.[key];
  const { value, confident, decision } = readNoulAnswer(answer, threshold);
  const attempts = (state.gateAttempts[stage.stage] || 0) + 1;
  state.gateAttempts[stage.stage] = attempts;

  return {
    stage: stage.stage,
    decision,
    confident,
    value,
    threshold,
    attempts,
    nextStage: stage.nextStage,
    message: gateMessage(stage, decision, confident, value, threshold),
  };
}

/** Human/model-readable explanation of a gate outcome. */
function gateMessage(stage, decision, confident, value, threshold) {
  const pct = value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  if (!confident) {
    return (
      `Gate for "${stage.label}" is UNDECIDED (p=${pct}, need ` +
      `${(threshold * 100).toFixed(0)}% either way). Treat this as a signal that the ` +
      `completion evidence is thin: supply concrete evidence, or escalate for a second ` +
      `opinion if the call is architecturally significant.`
    );
  }
  if (decision === 'yes') {
    return `Gate for "${stage.label}" PASSED (p=${pct}). Advancing to "${stage.nextStage}".`;
  }
  return (
    `Gate for "${stage.label}" FAILED (p=${pct}). The stage is not complete against its own ` +
    `criteria. Address the gaps and re-gate; do not advance.`
  );
}

/**
 * Record an accepted transition and move the run forward.
 *
 * @param {object} state - pipeline state (mutated).
 * @param {string} toStageId - destination stage id.
 * @param {object} [meta] - gate outcome or notes to persist.
 * @returns {object} the previous stage descriptor.
 */
export function advanceStage(state, toStageId, meta = {}) {
  const from = describeStage(state);
  const target = STAGE_BY_ID.get(toStageId);
  if (!target) throw new Error(`Unknown pipeline stage '${toStageId}'.`);

  state.history.push({
    from: from.stage,
    to: toStageId,
    at: new Date().toISOString(),
    gate: meta.gate ?? null,
    note: meta.note ?? null,
  });
  state.stageId = toStageId;
  return from;
}

/**
 * Rank historical fragments by relevance to the upcoming stage.
 *
 * This is the context-pruning judgment point. gstack's default compaction drops
 * history on a FIFO or lossy-summary basis; asking Jev for a calibrated
 * relevance score per fragment lets irrelevant material collapse (and stay
 * recallable) while genuinely load-bearing context survives.
 *
 * Scoring is batched into ONE Jev call per fragment because System One answers
 * many typed questions in a single request — the cost is one round trip, not one
 * per fragment.
 *
 * @param {object} deps
 * @param {{triage: Function}} deps.jev
 * @param {object} state - pipeline state.
 * @param {Array<{id: string, text: string}>} fragments - candidate history.
 * @param {object} [options]
 * @param {number} [options.keepThreshold] - minimum relevance to keep.
 * @param {number} [options.maxKeep] - hard cap on retained fragments.
 * @returns {Promise<{keep: object[], collapse: object[], scores: object}>}
 */
export async function scoreContextRelevance({ jev }, state, fragments, options = {}) {
  const keepThreshold = options.keepThreshold ?? 0.5;
  const maxKeep = options.maxKeep ?? 12;
  if (!Array.isArray(fragments) || fragments.length === 0) {
    return { keep: [], collapse: [], scores: {} };
  }

  const stage = describeStage(state);
  const questions = {};
  for (const fragment of fragments) {
    questions[`rel_${fragment.id}`] = {
      type: QUESTION_TYPES.NOUL,
      instructions:
        `The next sprint stage is "${stage.label}", which must satisfy: ` +
        `${stage.completionCriteria} Fragment "${fragment.id}" of the earlier context is ` +
        `listed in the state text. Score how relevant THAT fragment is to carrying the ` +
        `upcoming work forward, where a high score means clearly relevant.`,
    };
  }

  // One request for every fragment: System One accepts many typed questions per
  // call, and the fragments travel together in the single `state` field. This is
  // the whole cost of pruning — one round trip, not one per fragment.
  const stateText = toState(
    `Completion criteria for the upcoming stage "${stage.label}":\n` +
      `${stage.completionCriteria}\n\n` +
      `Earlier context fragments:\n` +
      fragments.map((f) => `[${f.id}] ${f.text}`).join('\n\n')
  );

  let response;
  try {
    response = await jev.triage(questions, { state: stateText });
  } catch (error) {
    // On failure keep everything rather than destroying context we cannot rank.
    return {
      keep: fragments,
      collapse: [],
      scores: {},
      degraded: true,
      error: error?.message || String(error),
    };
  }

  const scored = fragments.map((fragment) => ({
    ...fragment,
    score: answerScalar(response?.answers?.[`rel_${fragment.id}`]) ?? null,
  }));

  // A null score means Jev gave no answer for that fragment: keep it. Dropping
  // context on a missing answer is the failure mode this whole mechanism exists
  // to avoid.
  const withScores = scored.filter((f) => typeof f.score === 'number');
  const ranked = withScores.sort((a, b) => b.score - a.score);
  const keep = ranked.filter((f) => f.score >= keepThreshold).slice(0, maxKeep);
  const collapse = scored.filter((f) => !keep.includes(f));

  return {
    keep,
    collapse,
    scores: Object.fromEntries(scored.map((f) => [f.id, f.score])),
    degraded: false,
  };
}

/**
 * Persist/restore pipeline state as a small JSON artifact.
 *
 * Kept as plain object <-> JSON so the caller owns the storage location; the
 * plugin stores it under the project's `.dsh/` tree.
 *
 * @param {object} state
 * @returns {string} serialized state.
 */
export function serializePipelineState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * @param {string} text - serialized pipeline state.
 * @returns {object} parsed state.
 */
export function deserializePipelineState(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !STAGE_BY_ID.has(parsed.stageId)) {
    throw new Error('Invalid pipeline state: missing or unknown stageId.');
  }
  return parsed;
}
