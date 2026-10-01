/**
 * Second-opinion escalation policy.
 *
 * ## Why this is a separate layer, and why it is rationed
 *
 * When Jev returns a *low-confidence* answer on a decision that matters, the
 * right move is to consult a stronger generative model. The failure mode to
 * avoid is that escalation becomes the default: every uncertain call quietly
 * routes to an expensive model and the "sparse" property is lost within a day.
 *
 * So escalation here is gated twice:
 *   1. **Criticality** — only decisions marked critical are eligible at all.
 *   2. **A Jev confidence band** — escalation fires only in the ambiguous middle.
 *      A confidently-passed or confidently-failed decision needs no second
 *      opinion; it is already decided.
 * and then capped three ways:
 *   3. a per-decision budget, a per-stage budget, and a per-session budget.
 *
 * ## Provider order
 *
 * Free first, always: OpenCode free models, then OpenRouter free models. A paid
 * OpenRouter model is reachable only as a rate-limit/quality fallback, and only
 * when `allowPaidFallback` is explicitly on. This mirrors the required policy:
 * paid routes must never become the de-facto default.
 *
 * @module gstack-dsh/escalation
 */

/**
 * Escalation tiers, tried in order. `tier: 'free'` routes are always preferred.
 * Model ids are resolved from the DSH live model list at wiring time; the values
 * here are defaults, not a hardcoded contract.
 */
export const ESCALATION_TIERS = [
  {
    id: 'opencode-free',
    provider: 'opencode',
    tier: 'free',
    description: 'OpenCode free models — first choice for a second opinion.',
  },
  {
    id: 'openrouter-free',
    provider: 'openrouter',
    tier: 'free',
    description: 'OpenRouter free models — second choice when OpenCode is rate-limited.',
  },
  {
    id: 'openrouter-paid',
    provider: 'openrouter',
    tier: 'paid',
    description: 'OpenRouter paid — fallback ONLY, behind an explicit opt-in.',
  },
];

/** Default budget guardrails. Deliberately small; escalation must stay rare. */
export const DEFAULT_BUDGET = {
  /** Max escalations for a single decision. */
  perDecision: 1,
  /** Max escalations within one pipeline stage. */
  perStage: 2,
  /** Max escalations across the whole session. */
  perSession: 6,
  /** Paid fallbacks allowed across the whole session. */
  paidFallbacksPerSession: 1,
};

/**
 * How critical a decision is. Only `critical` decisions may escalate.
 */
export const CRITICALITY = {
  ROUTINE: 'routine',
  NOTABLE: 'notable',
  CRITICAL: 'critical',
};

/**
 * Decisions that are critical by nature — the ones where being wrong is
 * expensive and a second opinion earns its cost. Keyed by the gate/decision name
 * the caller uses.
 */
export const CRITICAL_DECISIONS = new Set([
  'architecture_sound',
  'production_bug_risk',
  'security_exposure',
  'data_loss_risk',
  'irreversible_action',
  'ship_readiness',
  'stage_plan_complete',
]);

/** Fresh escalation ledger. */
export function createEscalationState() {
  return {
    sessionCount: 0,
    paidFallbacks: 0,
    perStage: {},
    perDecision: {},
    log: [],
  };
}

/**
 * Decide whether a low-confidence result should escalate.
 *
 * @param {object} params
 * @param {string} params.decisionName - stable id for the decision.
 * @param {number|null} params.confidence - Jev's calibrated probability (0-1).
 * @param {number} [params.threshold] - confidence needed to stand alone.
 * @param {string} [params.criticality]
 * @param {string} [params.stage]
 * @param {object} [params.budget]
 * @param {object} [params.state] - escalation ledger (read-only here).
 * @returns {{escalate: boolean, reason: string, tier?: object}}
 */
export function shouldEscalate({
  decisionName,
  confidence,
  threshold = 0.7,
  criticality = CRITICALITY.ROUTINE,
  stage = 'unknown',
  budget = DEFAULT_BUDGET,
  state = createEscalationState(),
}) {
  const isCritical =
    criticality === CRITICALITY.CRITICAL || CRITICAL_DECISIONS.has(decisionName);

  if (!isCritical) {
    return {
      escalate: false,
      reason: `'${decisionName}' is not a critical decision; a second opinion is not warranted.`,
    };
  }

  // Enforce the per-decision cap. The module header promises three caps, and
  // `recordEscalation` increments this counter while `escalationSummary` reports
  // it, but nothing read it — so one decision could escalate on every call until
  // only the per-stage cap happened to stop it. It is passed into `finish` so
  // the session/stage precedence those checks already establish is preserved.
  if (confidence === null || confidence === undefined) {
    // No confidence reading is not the same as low confidence: escalate, because
    // an unreadable decision is exactly the ambiguous case.
    return finish(
      { escalate: true, reason: `No Jev confidence was available for '${decisionName}'.` },
      stage,
      budget,
      state,
      decisionName
    );
  }

  // Already decided in either direction: a second opinion changes nothing.
  if (confidence >= threshold || confidence <= 1 - threshold) {
    return {
      escalate: false,
      reason:
        `Jev is confident on '${decisionName}' (p=${confidence.toFixed(3)}); no second ` +
        `opinion needed.`,
    };
  }

  return finish(
    {
      escalate: true,
      reason:
        `Jev is UNCERTAIN on '${decisionName}' (p=${confidence.toFixed(3)}, ambiguous band ` +
        `${(1 - threshold).toFixed(2)}–${threshold.toFixed(2)}); consulting a second opinion.`,
    },
    stage,
    budget,
    state,
    decisionName
  );
}

/** Apply budget caps to a would-escalate decision. */
function finish(outcome, stage, budget, state, decisionName) {
  const sessionUsed = state.sessionCount || 0;
  if (sessionUsed >= budget.perSession) {
    return {
      escalate: false,
      reason:
        `Escalation budget exhausted for this session (${sessionUsed}/${budget.perSession}). ` +
        `Surfacing the uncertainty to the operator instead of spending more.`,
      budgetExhausted: 'session',
    };
  }

  const stageUsed = state.perStage?.[stage] || 0;
  if (stageUsed >= budget.perStage) {
    return {
      escalate: false,
      reason:
        `Escalation budget exhausted for stage '${stage}' (${stageUsed}/${budget.perStage}).`,
      budgetExhausted: 'stage',
    };
  }

  // The third documented cap. Checked last so the session and stage caps keep
  // the precedence their tests pin; this one binds only when they do not.
  const decisionUsed = Number(state.perDecision?.[decisionName] || 0);
  if (decisionName && decisionUsed >= budget.perDecision) {
    return {
      escalate: false,
      reason:
        `Escalation budget exhausted for decision '${decisionName}' ` +
        `(${decisionUsed}/${budget.perDecision}).`,
      budgetExhausted: 'decision',
    };
  }

  return { ...outcome, budgetExhausted: null };
}

/**
 * Choose the escalation route for a decision, honoring free-before-paid.
 *
 * @param {object} state - escalation ledger.
 * @param {object} [budget]
 * @returns {{tier: object, paid: boolean}}
 */
export function selectEscalationRoute(state, budget = DEFAULT_BUDGET) {
  const paidUsed = state.paidFallbacks || 0;
  const paidAllowed = paidUsed < budget.paidFallbacksPerSession;

  for (const tier of ESCALATION_TIERS) {
    if (tier.tier === 'paid' && !paidAllowed) continue;
    return { tier, paid: tier.tier === 'paid' };
  }
  // Everything paid is exhausted; fall back to the cheapest free route.
  return { tier: ESCALATION_TIERS[0], paid: false };
}

/**
 * Record a completed escalation against the ledger.
 *
 * @param {object} state - escalation ledger (mutated).
 * @param {object} params
 * @param {string} params.decisionName
 * @param {string} [params.stage]
 * @param {boolean} [params.paid]
 * @param {object} [params.tier]
 * @param {string} [params.outcome]
 */
export function recordEscalation(state, { decisionName, stage = 'unknown', paid = false, tier, outcome = 'completed' }) {
  state.sessionCount += 1;
  state.perStage[stage] = (state.perStage[stage] || 0) + 1;
  state.perDecision[decisionName] = (state.perDecision[decisionName] || 0) + 1;
  if (paid) state.paidFallbacks += 1;
  state.log.push({
    decisionName,
    stage,
    tier: tier?.id ?? null,
    paid,
    outcome,
    at: new Date().toISOString(),
  });
}

/**
 * Summarize the ledger for reporting.
 *
 * @param {object} state
 * @param {object} [budget]
 * @returns {object}
 */
export function escalationSummary(state, budget = DEFAULT_BUDGET) {
  return {
    used: state.sessionCount,
    budget: budget.perSession,
    remaining: Math.max(0, budget.perSession - state.sessionCount),
    paidUsed: state.paidFallbacks,
    paidBudget: budget.paidFallbacksPerSession,
    byStage: { ...state.perStage },
    decisions: { ...state.perDecision },
  };
}

/**
 * Build the DSH model-selector entries for the escalation routes.
 *
 * Returned as data rather than written directly so the install step owns the
 * profile patch, and so the same list can be shown to the operator before it is
 * applied. Note there is deliberately NO `deepseek-v4-pro` entry anywhere: it is
 * superseded and must not appear in routing tables.
 *
 * @param {Array<{id: string, name?: string}>} [discovered] - models discovered from DSH's live list.
 * @returns {Array<object>}
 */
export function escalationModelEntries(discovered = []) {
  const fromDiscovery = discovered.map((model) => ({
    id: model.id,
    // Keep the provider: the routes below filter on it. Dropping it here made
    // every `models` array silently empty.
    provider: model.provider,
    name: model.name || model.id,
    source: 'dsh-live-model-list',
  }));
  return [
    {
      route: 'opencode-free',
      provider: 'opencode',
      purpose: 'second-opinion (free, preferred)',
      models: fromDiscovery.filter((m) => m.provider === 'opencode'),
    },
    {
      route: 'openrouter-free',
      provider: 'openrouter',
      purpose: 'second-opinion (free fallback)',
      models: fromDiscovery.filter((m) => m.provider === 'openrouter'),
    },
    {
      route: 'openrouter-paid',
      provider: 'openrouter',
      purpose: 'second-opinion (paid, explicit opt-in only)',
      models: [],
    },
  ];
}

/**
 * Pick the exact live model id to dispatch a tier's second opinion through.
 *
 * `LlmModelInfo` carries no pricing field, so "free" is **not** derivable from
 * the API — it can only be read off the route's own naming. `:free` is the
 * OpenRouter convention and is the only signal trusted here; anything else is
 * treated as not-free and therefore unreachable without an explicit override.
 * That is deliberate: silently spending money because a suffix was absent would
 * break the free-first guarantee this layer exists to hold.
 *
 * @param {object} tier - a route from ESCALATION_TIERS.
 * @param {Array<{provider: string, id: string}>} discovered - DSH's live model list.
 * @param {string} [override] - operator-supplied model id; only honored for a paid route.
 * @returns {string|null} the model id, or null when nothing is eligible.
 */
export function pickEscalationModel(tier, discovered = [], override) {
  if (!tier) return null;

  const owned = (Array.isArray(discovered) ? discovered : []).filter(
    (model) => model && model.provider === tier.provider && typeof model.id === 'string'
  );

  if (tier.tier === 'paid') {
    // A paid route is never auto-selected. It dispatches only on an explicit
    // opt-in that names the model, so the cost is always a stated choice.
    if (typeof override !== 'string' || override.length === 0) return null;
    return owned.some((model) => model.id === override) ? override : null;
  }

  // Deterministic first match: the live list order is the adapter's order.
  const free = owned.find((model) => /(?:^|[-:])free$/i.test(model.id));
  return free ? free.id : null;
}
