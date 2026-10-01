/**
 * Unit tests for the gstack-dsh decision layer.
 *
 * Jev is mocked at the network boundary (a fake `triage`) so these tests are
 * deterministic and free. The live endpoint is exercised separately by the
 * install-time verification probe (`npm test` here must not need a credential).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JevClient,
  JevError,
  assertFreeProvider,
  answerScalar,
  classifyJevFailure,
  readNoulAnswer,
  resolveJevApiKey,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  FREE_JEV_MODEL,
} from '../lib/jev.js';

import {
  STAGES,
  createPipelineState,
  describeStage,
  evaluateGate,
  advanceStage,
  scoreContextRelevance,
  serializePipelineState,
  deserializePipelineState,
} from '../lib/pipeline.js';

import {
  createEscalationState,
  shouldEscalate,
  selectEscalationRoute,
  pickEscalationModel,
  recordEscalation,
  escalationSummary,
  escalationModelEntries,
  ESCALATION_TIERS,
  DEFAULT_BUDGET,
  CRITICALITY,
} from '../lib/escalation.js';

import { dispatchEscalation, DISPATCH_CODES } from '../lib/escalation-dispatch.js';

/* --------------------------- Jev client --------------------------- */

test('assertFreeProvider refuses every non-OpenCode backend', () => {
  for (const url of [
    'https://api.typesafe.example/v1/systemone',
    'https://openrouter.ai/api/v1/systemone',
    'https://opencode.ai.evil.example/v1/systemone',
    'not-a-url',
  ]) {
    assert.throws(() => assertFreeProvider(url), JevError, `should refuse ${url}`);
  }
});

test('assertFreeProvider accepts either OpenCode tier on the one host', () => {
  // The guard restricts the host, not the tier: paid and free are both
  // opencode.ai, and the tier is an operator spend decision.
  assert.doesNotThrow(() => assertFreeProvider(DEFAULT_JEV_BASE_URL));
  assert.doesNotThrow(() => assertFreeProvider('https://opencode.ai/zen/v1/systemone'));
});

test('the default Jev model is the paid tier, with the free id still available', () => {
  assert.equal(DEFAULT_JEV_MODEL, 'jev-1.13');
  assert.equal(FREE_JEV_MODEL, 'jev-1.13-free');
  // A client built from defaults must send the paid model id, not the free one.
  assert.equal(new JevClient({ apiKey: 'k' }).model, 'jev-1.13');
});

test('a client can still opt back into the free tier by model id', () => {
  assert.equal(new JevClient({ apiKey: 'k', model: FREE_JEV_MODEL }).model, 'jev-1.13-free');
});

test('classifyJevFailure separates a waitable throttle from a fixable fault', () => {
  // A 429 needs waiting; telling someone to fix a working binding is the bug.
  const limited = classifyJevFailure({ status: 429, message: 'Jev HTTP 429: FreeUsageLimitError' });
  assert.equal(limited.kind, 'rate-limited');
  assert.equal(limited.retryable, true);

  // A `testConnection` result carries the same signal without being an Error.
  assert.equal(classifyJevFailure({ kind: 'rate-limited', status: 429 }).kind, 'rate-limited');

  assert.equal(classifyJevFailure({ status: 401 }).kind, 'auth');
  assert.equal(classifyJevFailure({ status: 401 }).retryable, false);
  assert.equal(classifyJevFailure({ status: 403 }).kind, 'auth');
  assert.equal(classifyJevFailure({ message: 'request timed out after 15000ms' }).kind, 'timeout');
  assert.equal(classifyJevFailure(new Error('fetch failed')).kind, 'unreachable');
  assert.equal(classifyJevFailure(new Error('fetch failed')).retryable, true);
  assert.equal(classifyJevFailure({ status: 400 }).kind, 'error');
  assert.equal(classifyJevFailure({ status: 400 }).retryable, false);
  assert.equal(classifyJevFailure({ status: 503 }).retryable, true);
});

test('a rate-limited gate defers without claiming the binding is broken', async () => {
  const jev = {
    triage: async () => {
      throw new JevError('Jev HTTP 429: FreeUsageLimitError', { status: 429 });
    },
  };
  const outcome = await evaluateGate({ jev }, createPipelineState({}), 'evidence', { threshold: 0.7 });

  assert.equal(outcome.decision, 'unavailable');
  assert.equal(outcome.confident, false);
  assert.equal(outcome.failure, 'rate-limited');
  assert.equal(outcome.retryable, true);
  // The message must send the reader to "wait", never to "repair the binding".
  assert.match(outcome.message, /RATE LIMITED/);
  assert.doesNotMatch(outcome.message, /Fix the Jev binding/);
});

test('a transport fault at the gate still tells the reader to fix the binding', async () => {
  const jev = {
    triage: async () => {
      throw new Error('fetch failed');
    },
  };
  const outcome = await evaluateGate({ jev }, createPipelineState({}), 'evidence', { threshold: 0.7 });

  assert.equal(outcome.decision, 'unavailable');
  assert.equal(outcome.failure, 'unreachable');
  assert.match(outcome.message, /Fix the Jev binding/);
});

test('readNoulAnswer is decided only outside the ambiguous band', () => {
  const yes = readNoulAnswer({ type: 'noul', noul: 0.95 }, 0.7);
  assert.equal(yes.decision, 'yes');
  assert.equal(yes.confident, true);

  const no = readNoulAnswer({ type: 'noul', noul: 0.02 }, 0.7);
  assert.equal(no.decision, 'no');
  assert.equal(no.confident, true);

  const unsure = readNoulAnswer({ type: 'noul', noul: 0.5 }, 0.7);
  assert.equal(unsure.decision, 'unsure');
  assert.equal(unsure.confident, false);
});

test('answerScalar reads the value named by the answer type', () => {
  assert.equal(answerScalar({ type: 'noul', noul: 0.6 }), 0.6);
  assert.equal(answerScalar({ type: 'noul', noul: 0.1 }), 0.1);
  assert.equal(answerScalar(undefined), null);
  assert.equal(answerScalar({ type: 'mc', mc: 'x' }), null);
});

test('resolveJevApiKey prefers the explicit override and ignores blanks', () => {
  assert.equal(resolveJevApiKey({ GSTACK_DSH_JEV_API_KEY: 'a', OPENCODE_API_KEY: 'b' }), 'a');
  assert.equal(resolveJevApiKey({ OPENCODE_API_KEY: 'b' }), 'b');
  assert.equal(resolveJevApiKey({ OPENCODE_API_KEY: '   ' }), undefined);
  assert.equal(resolveJevApiKey({}), undefined);
});

test('JevClient sends the System One payload shape, not an OpenAI chat body', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return { model: 'jev-1.13-free', answers: { q: { type: 'noul', noul: 0.9 } } };
      },
    };
  };
  try {
    const client = new JevClient({ apiKey: 'test-key' });
    const response = await client.triage({ q: { type: 'noul', instructions: 'is it so' } });

    assert.equal(calls.length, 1);
    // The payload carries whatever model the client resolved. Asserting the
    // constant rather than a literal keeps this test about the wire SHAPE, which
    // is its purpose, instead of pinning the tier as a side effect.
    assert.equal(calls[0].body.model, DEFAULT_JEV_MODEL);
    // With no explicit state, the question instructions become the state text —
    // System One always needs a non-empty `state` to judge against.
    assert.equal(calls[0].body.state, 'is it so');
    assert.ok(calls[0].body.questions.q);
    assert.equal(calls[0].body.questions.q.type, 'noul', 'bool is not a valid System One type');
    assert.equal(calls[0].body.messages, undefined, 'must not send an OpenAI messages array');
    assert.equal(response.answers.q.noul, 0.9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JevClient does not retry a 4xx client fault', async () => {
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 400, statusText: 'Bad Request', async text() { return 'api_usage_error'; } };
  };
  try {
    const client = new JevClient({ apiKey: 'k', retries: 3 });
    await assert.rejects(() => client.triage({ q: { type: 'noul', instructions: 'x' } }), JevError);
    assert.equal(attempts, 1, 'a 400 must not be retried');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JevClient refuses to construct against a paid provider', () => {
  assert.throws(() => new JevClient({ baseUrl: 'https://openrouter.ai/api/v1/systemone' }), JevError);
});

test('testConnection reports a 429 as rate-limited, not as a broken binding', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    async text() {
      return '{"error":{"type":"FreeUsageLimitError"}}';
    },
  });
  try {
    const probe = await new JevClient({ apiKey: 'k', retries: 0 }).testConnection();
    assert.equal(probe.ok, false);
    // A 429 proves the request was authenticated and reached the provider, so
    // an install check must not read it as a broken binding.
    assert.equal(probe.kind, 'rate-limited');
    assert.equal(probe.status, 429);
    assert.ok(probe.error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('testConnection reports an auth fault as a plain error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    async text() {
      return 'invalid key';
    },
  });
  try {
    const probe = await new JevClient({ apiKey: 'bad', retries: 0 }).testConnection();
    assert.equal(probe.ok, false);
    assert.equal(probe.kind, 'error');
    assert.equal(probe.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('testConnection reports success with its resolved model', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { model: 'jev-1.13-free', answers: { ping: { type: 'noul', noul: 0.6 } } };
    },
  });
  try {
    const probe = await new JevClient({ apiKey: 'k' }).testConnection();
    assert.equal(probe.ok, true);
    assert.equal(probe.kind, 'ok');
    assert.equal(probe.status, 200);
    assert.equal(probe.model, 'jev-1.13-free');
    assert.equal(typeof probe.latencyMs, 'number');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ---------------------------- pipeline ---------------------------- */

test('the pipeline encodes the canonical seven-stage order', () => {
  assert.deepEqual(
    STAGES.map((s) => s.id),
    ['think', 'plan', 'build', 'review', 'test', 'ship', 'reflect']
  );
});

test('every stage carries completion criteria and at least one skill', () => {
  for (const stage of STAGES) {
    assert.ok(stage.completionCriteria.length > 40, `${stage.id} needs real criteria`);
    assert.ok(stage.skills.length > 0, `${stage.id} needs skills`);
  }
});

test('describeStage reports position and the next stage', () => {
  const state = createPipelineState();
  const described = describeStage(state);
  assert.equal(described.stage, 'think');
  assert.equal(described.nextStage, 'plan');
  assert.equal(described.total, 7);
  assert.equal(described.isFinal, false);

  state.stageId = 'reflect';
  assert.equal(describeStage(state).isFinal, true);
  assert.equal(describeStage(state).nextStage, null);
});

test('a confident Jev pass authorizes advancement', async () => {
  const jev = { triage: async () => ({ answers: { stage_think_complete: { type: 'noul', noul: 0.95 } } }) };
  const state = createPipelineState();
  const outcome = await evaluateGate({ jev }, state, 'evidence here');
  assert.equal(outcome.decision, 'yes');
  assert.equal(outcome.confident, true);
});

test('a confident Jev fail blocks advancement', async () => {
  const jev = { triage: async () => ({ answers: { stage_think_complete: { type: 'noul', noul: 0.05 } } }) };
  const state = createPipelineState();
  const outcome = await evaluateGate({ jev }, state, 'thin evidence');
  assert.equal(outcome.decision, 'no');
  assert.equal(outcome.confident, true);
});

test('an unreachable Jev never authorizes advancement', async () => {
  const jev = { triage: async () => { throw new Error('ECONNREFUSED'); } };
  const state = createPipelineState();
  const outcome = await evaluateGate({ jev }, state, 'evidence');
  assert.equal(outcome.decision, 'unavailable');
  assert.equal(outcome.confident, false);
  assert.match(outcome.message, /Refusing to advance/);
});

test('advanceStage records history and moves the run', () => {
  const state = createPipelineState();
  advanceStage(state, 'plan', { note: 'gate passed' });
  assert.equal(state.stageId, 'plan');
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].from, 'think');
  assert.equal(state.history[0].to, 'plan');
});

test('advanceStage rejects an unknown stage', () => {
  const state = createPipelineState();
  assert.throws(() => advanceStage(state, 'nope'));
});

test('context pruning keeps relevant fragments and collapses the rest', async () => {
  const jev = {
    triage: async (questions) => {
      const keys = Object.keys(questions);
      const answers = {};
      for (const key of keys) {
        // "keep" is relevant, "drop" is not.
        answers[key] = { type: 'noul', noul: key.includes('keep') ? 0.9 : 0.05 };
      }
      return { answers };
    },
  };
  const state = createPipelineState();
  const result = await scoreContextRelevance({ jev }, state, [
    { id: 'keep1', text: 'the architecture decision' },
    { id: 'drop1', text: 'an unrelated tangent' },
  ]);
  assert.deepEqual(result.keep.map((f) => f.id), ['keep1']);
  assert.deepEqual(result.collapse.map((f) => f.id), ['drop1']);
});

test('context pruning keeps everything when Jev is unreachable', async () => {
  const jev = { triage: async () => { throw new Error('offline'); } };
  const state = createPipelineState();
  const fragments = [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }];
  const result = await scoreContextRelevance({ jev }, state, fragments);
  assert.equal(result.degraded, true);
  assert.equal(result.keep.length, 2, 'must not destroy context it could not rank');
});

test('pipeline state round-trips through JSON', () => {
  const state = createPipelineState({ objective: 'ship the port' });
  advanceStage(state, 'plan');
  const restored = deserializePipelineState(serializePipelineState(state));
  assert.equal(restored.stageId, 'plan');
  assert.equal(restored.objective, 'ship the port');
});

test('deserializePipelineState rejects corrupt state', () => {
  assert.throws(() => deserializePipelineState('{"stageId":"nope"}'));
  assert.throws(() => deserializePipelineState('{}'));
});

/* --------------------------- escalation --------------------------- */

test('a non-critical decision never escalates', () => {
  const verdict = shouldEscalate({ decisionName: 'naming', confidence: 0.5 });
  assert.equal(verdict.escalate, false);
});

test('a confident critical decision never escalates', () => {
  const verdict = shouldEscalate({
    decisionName: 'architecture_sound',
    confidence: 0.97,
    criticality: CRITICALITY.CRITICAL,
  });
  assert.equal(verdict.escalate, false);
  assert.match(verdict.reason, /confident/);
});

test('an ambiguous critical decision escalates', () => {
  const verdict = shouldEscalate({
    decisionName: 'architecture_sound',
    confidence: 0.5,
    criticality: CRITICALITY.CRITICAL,
  });
  assert.equal(verdict.escalate, true);
  assert.match(verdict.reason, /UNCERTAIN/);
});

test('the session budget caps escalation', () => {
  const state = createEscalationState();
  const budget = { ...DEFAULT_BUDGET, perSession: 2 };
  for (let i = 0; i < 2; i += 1) {
    recordEscalation(state, { decisionName: 'architecture_sound', stage: 'plan' });
  }
  const verdict = shouldEscalate({
    decisionName: 'architecture_sound',
    confidence: 0.5,
    criticality: CRITICALITY.CRITICAL,
    budget,
    state,
  });
  assert.equal(verdict.escalate, false);
  assert.equal(verdict.budgetExhausted, 'session');
});

test('the per-stage budget caps escalation before the session budget', () => {
  const state = createEscalationState();
  const budget = { ...DEFAULT_BUDGET, perStage: 1, perSession: 99 };
  recordEscalation(state, { decisionName: 'architecture_sound', stage: 'plan' });
  const verdict = shouldEscalate({
    decisionName: 'architecture_sound',
    confidence: 0.5,
    criticality: CRITICALITY.CRITICAL,
    stage: 'plan',
    budget,
    state,
  });
  assert.equal(verdict.escalate, false);
  assert.equal(verdict.budgetExhausted, 'stage');
});

test('free routes are preferred and paid is opt-in only', () => {
  const fresh = createEscalationState();
  assert.equal(selectEscalationRoute(fresh, DEFAULT_BUDGET).paid, false);

  const paidUsed = createEscalationState();
  paidUsed.paidFallbacks = DEFAULT_BUDGET.paidFallbacksPerSession;
  assert.equal(selectEscalationRoute(paidUsed, DEFAULT_BUDGET).paid, false);
});

test('escalationSummary reports usage against the cap', () => {
  const state = createEscalationState();
  recordEscalation(state, { decisionName: 'architecture_sound', stage: 'plan' });
  const summary = escalationSummary(state, DEFAULT_BUDGET);
  assert.equal(summary.used, 1);
  assert.equal(summary.remaining, DEFAULT_BUDGET.perSession - 1);
});

test('escalation model entries never mention the superseded v4-pro model', () => {
  const entries = escalationModelEntries([
    { id: 'some-model', provider: 'opencode' },
  ]);
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes('deepseek-v4-pro'), false);
  assert.ok(entries.some((entry) => entry.route === 'opencode-free'));
  assert.ok(entries.some((entry) => entry.route === 'openrouter-paid'));
});

/* ----------------------- escalation dispatch ----------------------- */

test('a free route picks the live free model and never a paid one', () => {
  const tier = ESCALATION_TIERS.find((t) => t.id === 'openrouter-free');
  const discovered = [
    { provider: 'openrouter', id: 'vendor/model-a' },
    { provider: 'openrouter', id: 'vendor/model-b:free' },
    { provider: 'openrouter', id: 'vendor/model-c:free' },
  ];
  // Live list order decides, so the pick is deterministic.
  assert.equal(pickEscalationModel(tier, discovered), 'vendor/model-b:free');
});

test('a free route with no free model dispatches nothing', () => {
  const tier = ESCALATION_TIERS.find((t) => t.id === 'opencode-free');
  assert.equal(pickEscalationModel(tier, [{ provider: 'opencode', id: 'some-paid-model' }]), null);
  assert.equal(pickEscalationModel(tier, []), null);
});

test('a paid route dispatches only under an explicit opt-in', () => {
  const tier = ESCALATION_TIERS.find((t) => t.id === 'openrouter-paid');
  const discovered = [{ provider: 'openrouter', id: 'vendor/paid-model' }];
  // No opt-in means unreachable, even when the model is right there.
  assert.equal(pickEscalationModel(tier, discovered), null);
  // An opt-in naming the model reaches it...
  assert.equal(pickEscalationModel(tier, discovered, 'vendor/paid-model'), 'vendor/paid-model');
  // ...but an opt-in naming something not in the live list does not.
  assert.equal(pickEscalationModel(tier, discovered, 'vendor/other'), null);
});

test('a paid route is never auto-discovered from a :free-looking id', () => {
  const tier = ESCALATION_TIERS.find((t) => t.id === 'openrouter-paid');
  assert.equal(pickEscalationModel(tier, [{ provider: 'openrouter', id: 'vendor/x:free' }]), null);
});

test('dispatch reports unavailable rather than inventing an opinion', async () => {
  const result = await dispatchEscalation({
    llm: null,
    request: { route: { provider: 'opencode' }, model: 'm', decisionName: 'd', summary: 's' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, DISPATCH_CODES.UNAVAILABLE);
});

test('dispatch refuses a route with no eligible model', async () => {
  const result = await dispatchEscalation({
    llm: { prepareCall: async () => ({}) },
    request: { route: { provider: 'opencode' }, model: null, decisionName: 'd', summary: 's' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, DISPATCH_CODES.NO_MODEL);
});

test('dispatch returns the real second opinion and its usage', async () => {
  const seen = {};
  const llm = {
    async prepareCall(config) {
      seen.config = config;
      return {
        async *stream(options) {
          seen.options = options;
          yield { type: 'text-delta', index: 0, text: 'Ship it: ' };
          yield { type: 'text-delta', index: 0, text: 'the guard is already there.' };
          yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    },
  };

  const result = await dispatchEscalation({
    llm,
    request: {
      route: { provider: 'opencode', tier: 'free' },
      model: 'vendor/model:free',
      decisionName: 'production_bug_risk',
      summary: 'a mutex protects the write path',
      confidence: 0.55,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Ship it: the guard is already there.');
  assert.equal(result.model, 'vendor/model:free');
  assert.equal(result.usage.outputTokens, 7);
  // The route is honored per call, not by overriding the session default.
  assert.equal(seen.config.provider, 'opencode');
  assert.equal(seen.config.model, 'vendor/model:free');
  assert.equal(seen.options.model, 'vendor/model:free');
  // The question actually carries the decision and the stakes.
  const prompt = seen.options.messages[0].content[0].text;
  assert.ok(prompt.includes('production_bug_risk'));
  assert.ok(prompt.includes('a mutex protects the write path'));
  assert.ok(prompt.includes('0.550'));
});

test('a provider error finish is a failure, not a partial verdict', async () => {
  const llm = {
    async prepareCall() {
      return {
        async *stream() {
          yield { type: 'text-delta', index: 0, text: 'half an ans' };
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 502' } } };
        },
      };
    },
  };
  const result = await dispatchEscalation({
    llm,
    request: { route: { provider: 'opencode' }, model: 'm', decisionName: 'd', summary: 's' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, DISPATCH_CODES.FAILED);
  assert.equal(result.error, 'upstream 502');
  assert.equal(result.partialText, 'half an ans');
});

test('a thrown provider error is contained and reported', async () => {
  const llm = {
    async prepareCall() {
      throw new Error('ECONNREFUSED');
    },
  };
  const result = await dispatchEscalation({
    llm,
    request: { route: { provider: 'opencode' }, model: 'm', decisionName: 'd', summary: 's' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, DISPATCH_CODES.FAILED);
  assert.ok(result.error.includes('ECONNREFUSED'));
});

test('the tool dispatches a live model and records the real outcome', async () => {
  const { apply } = await import('../lib/index.js');

  const registered = [];
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    logger: { info: () => {} },
    // apply() also installs the tools/pre-execute risk gate, so the fake
    // context has to carry the hook surface even though this test only
    // exercises the escalation tool.
    on: () => () => {},
    llm: {
      async prepareCall() {
        return {
          async *stream() {
            yield { type: 'text-delta', index: 0, text: 'Looks safe to me.' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    },
  };

  const plugin = apply(ctx, {
    log: () => {},
    escalation: { discovered: [{ provider: 'opencode', id: 'live-model:free' }] },
  });

  const tool = registered.find((t) => t.name === 'gstack_escalate');
  assert.ok(tool, 'gstack_escalate should be registered');

  const result = await tool.execute({
    decisionName: 'production_bug_risk',
    confidence: 0.55,
    criticality: 'critical',
    summary: 'a mutex protects the write path',
  });

  assert.equal(result.escalate, true);
  assert.equal(result.dispatched, true, 'a real dispatch should be reported as dispatched');
  assert.equal(result.model, 'live-model:free');
  assert.equal(result.opinion, 'Looks safe to me.');
  // The ration is spent only because the call actually completed.
  assert.equal(plugin.escalationSummary().used, 1);
  assert.equal(plugin.escalationSummary().paidUsed, 0);
});

test('a route with no live model does not spend the escalation ration', async () => {
  const { apply } = await import('../lib/index.js');

  const registered = [];
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    logger: { info: () => {} },
    on: () => () => {},
    llm: { async prepareCall() { throw new Error('should not be called'); } },
  };

  // No discovered models, so no free route can resolve a model id.
  const plugin = apply(ctx, { log: () => {} });
  const tool = registered.find((t) => t.name === 'gstack_escalate');

  const result = await tool.execute({
    decisionName: 'production_bug_risk',
    confidence: 0.55,
    criticality: 'critical',
    summary: 'x',
  });

  assert.equal(result.escalate, true);
  assert.equal(result.dispatched, false);
  assert.ok(result.error.includes('no eligible model'));
  // Nothing was sent, so nothing is billed against the session ration.
  assert.equal(plugin.escalationSummary().used, 0);
});

/* --------------------- live model discovery ---------------------- */

test('discoverModels reads the DSH registry across every provider', async () => {
  const { discoverModels } = await import('../lib/index.js');

  const llm = {
    listProviders: () => [
      { id: 'opencode', name: 'OpenCode' },
      { id: 'openrouter', name: 'OpenRouter' },
    ],
    async listModels(provider) {
      return provider === 'opencode'
        ? [{ provider, id: 'jev-1.13-free', name: 'Jev' }]
        : [
            { provider, id: 'anthropic/claude-fable-5', name: 'Fable' },
            { provider, id: 'openai/gpt-latest:free', name: 'Free GPT' },
          ];
    },
  };

  assert.deepEqual(await discoverModels(llm), [
    { provider: 'opencode', id: 'jev-1.13-free' },
    { provider: 'openrouter', id: 'anthropic/claude-fable-5' },
    { provider: 'openrouter', id: 'openai/gpt-latest:free' },
  ]);
});

test('discoverModels degrades to an empty list when the registry is unavailable', async () => {
  const { discoverModels } = await import('../lib/index.js');

  assert.deepEqual(await discoverModels(undefined), []);
  assert.deepEqual(await discoverModels({}), []);
  assert.deepEqual(await discoverModels({ listProviders: () => { throw new Error('no service'); } }), []);
  // A provider whose own listing throws must not hide its siblings.
  const partial = await discoverModels({
    listProviders: () => [{ id: 'broken' }, { id: 'working' }],
    async listModels(provider) {
      if (provider === 'broken') throw new Error('route down');
      return [{ provider, id: 'only-model:free' }];
    },
  });
  assert.deepEqual(partial, [{ provider: 'working', id: 'only-model:free' }]);
});

test('the tool discovers the live registry itself when no list is configured', async () => {
  const { apply } = await import('../lib/index.js');

  const registered = [];
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    logger: { info: () => {} },
    on: () => () => {},
    llm: {
      listProviders: () => [{ id: 'opencode', name: 'OpenCode' }],
      async listModels() {
        return [{ provider: 'opencode', id: 'gpt-live:free', name: 'Live' }];
      },
      async prepareCall() {
        return {
          async *stream() {
            yield { type: 'text-delta', index: 0, text: 'Discovered model answer.' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    },
  };

  // No `escalation.discovered`: the plugin must read the registry itself.
  const plugin = apply(ctx, { log: () => {} });
  const tool = registered.find((t) => t.name === 'gstack_escalate');

  const result = await tool.execute({
    decisionName: 'production_bug_risk',
    confidence: 0.5,
    criticality: 'critical',
    summary: 'x',
  });

  assert.equal(result.dispatched, true, 'the live registry should supply a model');
  assert.equal(result.model, 'gpt-live:free');
  assert.equal(result.opinion, 'Discovered model answer.');
  assert.equal(plugin.escalationSummary().used, 1);
});

// ─── Risk-gate safety modes ─────────────────────────────────────────────────
// Jev is consulted on every gated call in every mode. The mode decides only what
// happens to an AMBIGUOUS verdict, so these pin the policy directly rather than
// depending on how a mocked Jev happens to score a call.
test('gateVerdict: a confident danger is denied in every mode', async () => {
  const { gateVerdict } = await import('../lib/index.js');
  const danger = { deny: true, ask: true, reason: 'risk + irreversible' };
  for (const mode of ['off', 'careful', 'guard']) {
    assert.equal(gateVerdict(danger, mode), 'deny');
  }
});

test('gateVerdict: the ambiguous band blocks only in an explicit safety mode', async () => {
  const { gateVerdict } = await import('../lib/index.js');
  const ambiguous = { deny: false, ask: true, reason: 'elevated risk' };
  // Default: recorded, not blocked — uncertainty must not stop automation.
  assert.equal(gateVerdict(ambiguous, 'off'), 'observe');
  assert.equal(gateVerdict(ambiguous), 'observe');
  assert.equal(gateVerdict(ambiguous, 'careful'), 'block');
  assert.equal(gateVerdict(ambiguous, 'guard'), 'block');
});

test('gateVerdict: a clean call is allowed in every mode', async () => {
  const { gateVerdict } = await import('../lib/index.js');
  const clean = { deny: false, ask: false, reason: '' };
  for (const mode of ['off', 'careful', 'guard']) {
    assert.equal(gateVerdict(clean, mode), 'allow');
  }
});

test('readCareMode: absent, malformed, unknown, and expired markers all mean off', async () => {
  const { readCareMode, CARE_MODE_TTL_MS } = await import('../lib/index.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-care-'));
  const file = path.join(dir, 'careful.json');
  const now = Date.parse('2026-10-01T12:00:00Z');

  // Absent: never escalate strictness because a file is missing.
  assert.equal(readCareMode(now, file).mode, 'off');

  // Malformed JSON in a safety marker must fail open, not throw.
  fs.writeFileSync(file, '{not json');
  assert.equal(readCareMode(now, file).mode, 'off');

  // Unknown mode names are not silently promoted.
  fs.writeFileSync(file, JSON.stringify({ mode: 'yolo', since: '2026-10-01T11:00:00Z' }));
  assert.equal(readCareMode(now, file).mode, 'off');

  // Active marker.
  fs.writeFileSync(file, JSON.stringify({ mode: 'careful', since: '2026-10-01T11:00:00Z' }));
  assert.equal(readCareMode(now, file).mode, 'careful');

  // Expired marker: a stale session's strictness must not outlive it.
  const stale = new Date(now - CARE_MODE_TTL_MS - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ mode: 'guard', since: stale }));
  assert.equal(readCareMode(now, file).mode, 'off');

  fs.rmSync(dir, { recursive: true, force: true });
});
