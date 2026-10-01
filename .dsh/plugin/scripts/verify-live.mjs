#!/usr/bin/env node
/**
 * Live verification probe for the gstack-dsh plugin.
 *
 * Proves four things that unit tests (which mock the network) deliberately do
 * not:
 *   1. the plugin's own `apply()` registers its tools without error,
 *   2. the Jev binding reaches OpenCode's System One endpoint for real, on the
 *      configured tier (the paid `jev-1.13` by default; set `config.model` to
 *      `jev-1.13-free` to probe the free tier instead),
 *   3. a `jev_decide` call and a pipeline gate both return calibrated answers
 *      through the plugin's real code path,
 *   4. `gstack_escalate` dispatches a second opinion end to end over the llm
 *      service, against a stub that never touches the network.
 *
 * Exits non-zero if a required check fails, so it is usable as an install check.
 * A rate-limited free tier is reported as a PASS on the binding with the
 * decision calls marked SKIP: see `classifyJevFailure` for why that is not a
 * broken binding. Pipeline state is written to a throwaway directory, never the
 * project's.
 *
 * Two things this deliberately does NOT prove: that a real provider returns good
 * second-opinion text (the stub stands in), and that the Harness's live route
 * names match this probe's own provider id. Both remain manual checks.
 *
 * Credential: resolved by `lib/jev.js` from `GSTACK_DSH_JEV_API_KEY` or
 * `OPENCODE_API_KEY`. This script never reads or prints a key itself.
 *
 * Usage:
 *   OPENCODE_API_KEY=... node scripts/verify-live.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

/** Minimal fake Cordis context: captures registrations instead of executing them. */
function createFakeContext() {
  const tools = [];
  const listeners = [];
  return {
    tools,
    listeners,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ctx: {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: {
        register(definition) {
          tools.push(definition);
        },
      },
      on(event, handler) {
        listeners.push({ event, handler });
        return () => {};
      },
      // The llm service as `gstack_escalate` uses it, including a stub
      // `prepareCall` so the escalation check exercises the FULL dispatch path
      // (route -> model -> prepareCall -> stream -> collect) rather than
      // stopping at route resolution. The stub never touches the network, so a
      // second opinion costs nothing and the probe stays an install check.
      // What it cannot prove is that a REAL provider produces good text; that
      // remains a manual check.
      llm: {
        listProviders: () => [{ id: 'opencode', name: 'OpenCode' }],
        async listModels() {
          // Escalation still prefers a `-free`-suffixed id — a separate policy
          // from the Jev decision layer's paid-by-default tier.
          return [{ provider: 'opencode', id: 'jev-1.13-free', name: 'Jev (free)' }];
        },
        async prepareCall({ provider, model }) {
          return {
            provider,
            model,
            async *stream() {
              yield { type: 'text-delta', index: 0, text: 'Stub second opinion: the claim looks ' };
              yield { type: 'text-delta', index: 0, text: 'sound, but the evidence is thin.' };
              yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 9 } };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      },
    },
  };
}

function toolByName(tools, name) {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`tool '${name}' was not registered`);
  return found;
}

const results = [];
/**
 * Record one probe result.
 *
 * A `required` result gates the exit code; an informational one is reported but
 * never fails the run. Informational is for checks whose failure would mean
 * "this optional path did not resolve here" rather than "the install is broken" —
 * conflating the two makes an install check cry wolf.
 *
 * `notRun` marks a check that could not execute at all (no answer to judge).
 * It is reported distinctly from a failure: an unrun check is missing coverage,
 * never a passing one.
 */
function record(label, ok, detail, { required = true, notRun = false } = {}) {
  results.push({ label, ok, detail, required, notRun });
  const tag = notRun ? 'SKIP' : ok ? 'PASS' : required ? 'FAIL' : 'INFO';
  console.log(`${tag}  ${label}`);
  if (detail !== undefined) console.log(`      ${detail}`);
}

const { ctx, tools, listeners } = createFakeContext();

// Persist pipeline state into a throwaway directory. Without this the probe
// would read and write the real project's `.dsh/gstack-pipeline.json`, so the
// result would depend on whatever a previous run left behind.
const probeStateDir = await mkdtemp(join(tmpdir(), 'gstack-verify-live-'));
const plugin = apply(ctx, { enabled: true, stateDir: probeStateDir });

record(
  'plugin registers its four decision tools',
  tools.length === 4,
  `registered: ${tools.map((t) => t.name).join(', ')}`
);

record(
  'plugin installs the pre-execution risk gate',
  listeners.some((l) => l.event === 'tools/pre-execute'),
  `listeners: ${listeners.map((l) => l.event).join(', ') || '(none)'}`
);

const probe = await plugin.probe();
// A 429 from the free tier is a PASS for the binding: the request was built,
// authenticated, and reached the provider, which is exactly what this check
// exists to prove. Only an auth/URL/transport fault means the binding is broken.
const rateLimited = probe.kind === 'rate-limited';
record(
  'Jev binding reaches OpenCode System One',
  probe.ok === true || rateLimited,
  probe.ok === true
    ? `model=${probe.model} latency=${probe.latencyMs}ms`
    : rateLimited
      ? `HTTP ${probe.status} from the provider: binding is live, the free tier is throttling. ` +
        'Decision calls are skipped; re-run later for a full pass.'
      : `error: ${probe.error}`
);

// The live decision calls need an actual answer, so they cannot run while the
// free tier is throttling. Report them as not-run rather than as passing.
if (!probe.ok) {
  record(
    'live decision calls (jev_decide, gate, route, escalate)',
    false,
    rateLimited
      ? 'not run: the free tier is rate-limiting, so no answer could be judged'
      : 'not run: the Jev binding did not answer',
    { required: false, notRun: true }
  );
}

if (probe.ok) {
  try {
    const decide = toolByName(tools, 'jev_decide');
    const decision = await decide.execute({
      question:
        'Does this repository define a declarative host-config system for AI coding agents?',
      type: 'bool',
      evidence:
        'The repo has hosts/*.ts files built by a defineHost() factory, a hosts/index.ts ' +
        'registry exporting ALL_HOST_CONFIGS, and a scripts/host-config.ts interface.',
    });
    record(
      'jev_decide returns a calibrated answer',
      typeof decision.value === 'number',
      `p=${decision.value} decision=${decision.decision} confident=${decision.confident}`
    );

    const pipelineTool = toolByName(tools, 'gstack_pipeline');
    const status = await pipelineTool.execute({ action: 'status' });
    // The probe owns a fresh state directory, so this is a fresh run; assert
    // the full seven-stage order rather than only that a stage exists.
    record(
      'gstack_pipeline reports stage state',
      status.pipeline?.stage === 'think' && status.pipeline?.total === 7,
      `stage=${status.pipeline?.stage} (${status.pipeline?.index + 1}/${status.pipeline?.total}) ` +
        `persistence=${status.persistence?.restored}`
    );

    const gate = await pipelineTool.execute({
      action: 'gate',
      evidence:
        'Investigated the repo: it defines a typed host config per agent, a registry, a ' +
        'generator consuming them, and validation. Three alternative framings were ' +
        'considered and rejected.',
    });
    record(
      'pipeline gate returns a Jev-gated decision',
      typeof gate.decision === 'string' && gate.mayAdvance !== undefined,
      `decision=${gate.decision} p=${gate.value} mayAdvance=${gate.mayAdvance}`
    );

    const routing = toolByName(tools, 'gstack_route_skill');
    const route = await routing.execute({
      taskState:
        'A plan exists and is about to be implemented; architecture and data flow are unverified.',
      candidates: ['gstack-plan-eng-review', 'gstack-qa', 'gstack-retro'],
    });
    record(
      'gstack_route_skill returns a routing choice',
      route.answer !== undefined,
      `answer=${JSON.stringify(route.answer)}`
    );

    // Exercises the full second-opinion path against the stub `llm` above:
    // route selection -> live model resolution -> prepareCall -> stream ->
    // chunk collection -> ration accounting. No network, no spend.
    //
    // Kept informational because the provider id here is this probe's own, not
    // the Harness's live route names, so a miss means "not resolvable in this
    // probe" rather than "the install is broken". Its errors are contained so
    // they cannot fail the required checks.
    try {
      const escalate = toolByName(tools, 'gstack_escalate');
      const second = await escalate.execute({
        decisionName: 'production_bug_risk',
        confidence: 0.5,
        criticality: 'critical',
        summary: 'host configs are validated by one registry and consumed by one generator',
      });
      record(
        'gstack_escalate dispatches a second opinion over the llm service',
        second.escalate === true && second.dispatched === true && typeof second.opinion === 'string',
        `model=${second.model} paid=${second.paid} dispatched=${second.dispatched} ` +
          `opinion=${JSON.stringify((second.opinion || '').slice(0, 48))} ` +
          `used=${second.budget?.used} code=${second.dispatchCode ?? 'none'} error=${second.error ?? 'none'}`,
        { required: false }
      );
    } catch (error) {
      record(
        'gstack_escalate resolves a free route from the llm registry',
        false,
        error?.message || String(error),
        { required: false }
      );
    }
  } catch (error) {
    record('live decision calls', false, error?.message || String(error));
  }
}

await rm(probeStateDir, { recursive: true, force: true });

const failed = results.filter((r) => r.required && !r.ok);
const passed = results.filter((r) => r.ok).length;
const skipped = results.filter((r) => r.notRun).length;
console.log(
  `\n${passed}/${results.length - skipped} live checks passed` +
    (skipped ? ` (${skipped} not run)` : '')
);
process.exit(failed.length === 0 ? 0 : 1);
