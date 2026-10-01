/**
 * Second-opinion dispatch — the transport half of the escalation layer.
 *
 * `escalation.js` owns the *policy*: whether a decision is eligible at all, which
 * route it takes, and how the budget is spent. This module owns the *call*: it
 * turns an already-chosen route into one streaming model request through the DSH
 * `llm` service and returns what the model actually said plus what it cost.
 *
 * ## Why `llm` and not an agent
 *
 * A second opinion is one request and one answer. `agentLoop.create` would spin
 * up an entire nested agent — a different, heavier thing that also reads as
 * delegation. `ctx.llm.prepareCall()` is the exact-fit primitive: it validates
 * the route against the adapter's declared model capability and binds one
 * registration across the call, then streams.
 *
 * ## Failing loudly rather than silently
 *
 * Every failure mode here returns a structured `{ ok: false, code }` instead of
 * throwing or degrading to a plausible-looking answer. A second opinion that
 * could not be obtained must never be indistinguishable from one that agreed.
 *
 * @module gstack-dsh/escalation-dispatch
 */

/** Chunk-collection ceiling. A second opinion is a short verdict, not an essay. */
const MAX_MESSAGE_CHARS = 20000;
const MAX_REASONING_CHARS = 8000;

/** Bound the request: one question needs an answer, not a runaway continuation. */
const MAX_TOKENS = 1600;

/** Dispatch failures, as stable codes the caller can branch on. */
export const DISPATCH_CODES = {
  UNAVAILABLE: 'dispatch_unavailable',
  NO_MODEL: 'no_eligible_model',
  FAILED: 'dispatch_failed',
  ABORTED: 'dispatch_aborted',
};

/** Accumulate the assistant visible text from one stream, bounded. */
function collectChunks(chunks) {
  let text = '';
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 };
  let finish = null;
  const toolCalls = [];

  for (const chunk of chunks) {
    switch (chunk?.type) {
      case 'text-delta':
        if (text.length < MAX_MESSAGE_CHARS) text += chunk.text;
        break;
      case 'tool-call-delta':
        if (!toolCalls.includes(chunk.name)) toolCalls.push(chunk.name);
        break;
      case 'usage':
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.inputTokens ?? usage.inputTokens;
          usage.outputTokens = chunk.usage.outputTokens ?? usage.outputTokens;
          usage.totalTokens = chunk.usage.totalTokens ?? usage.totalTokens;
          usage.cacheReadTokens = chunk.usage.cacheReadTokens ?? usage.cacheReadTokens;
        }
        break;
      case 'finish':
        finish = chunk.reason ?? null;
        break;
      default:
        break;
    }
  }

  return { text: text.slice(0, MAX_MESSAGE_CHARS), usage, finish, toolCalls };
}

/** What the reviewer is asked. Deliberately narrow: break the tie, name the risk. */
function buildMessages({ summary, decisionName, confidence }) {
  const confidenceLine =
    typeof confidence === 'number'
      ? `Jev's calibrated confidence on this decision was ${confidence.toFixed(3)}, which sits in the ambiguous band, so it abstained rather than deciding.`
      : `Jev returned no confidence reading for this decision, which is itself the ambiguous case.`;

  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `You are a second opinion on a single software-engineering decision. ` +
            `Another reviewer has already looked at this and is uncertain.\n\n` +
            `Decision: ${decisionName}\n` +
            `${confidenceLine}\n\n` +
            `What is at stake:\n${summary}\n\n` +
            `Answer directly and briefly. Lead with your verdict, then the reasoning that ` +
            `would change a reader's mind. Say plainly if you think the concern is unfounded. ` +
            `Do not defer to the other reviewer and do not restate the question.`,
        },
      ],
    },
  ];
}

/**
 * Dispatch one second opinion.
 *
 * @param {object} deps
 * @param {object} deps.llm - the DSH `llm` service (`ctx.llm`).
 * @param {object} deps.request - `{ route, model, decisionName, summary, confidence }`.
 * @param {AbortSignal} [deps.signal] - caller cancellation.
 * @returns {Promise<object>} `{ ok: true, text, usage, ... }` or `{ ok: false, code, error }`.
 */
export async function dispatchEscalation({ llm, request, signal }) {
  if (!llm || typeof llm.prepareCall !== 'function') {
    return {
      ok: false,
      code: DISPATCH_CODES.UNAVAILABLE,
      error: 'the DSH llm service is not mounted, so a second opinion cannot be requested',
    };
  }

  const { route, model, decisionName, summary, confidence } = request;
  if (!route?.provider || !model) {
    return {
      ok: false,
      code: DISPATCH_CODES.NO_MODEL,
      error: `no eligible model is available on the '${route?.provider ?? 'unknown'}' route`,
    };
  }

  const startedAt = Date.now();
  try {
    // prepareCall validates the route against the adapter's real capability and
    // binds ONE registration across capability lookup and dispatch, so an HMR
    // swap cannot pair one adapter's answer with another's.
    const prepared = await llm.prepareCall(
      { provider: route.provider, model, maxTokens: MAX_TOKENS },
      signal
    );

    const chunks = [];
    for await (const chunk of prepared.stream(
      {
        provider: route.provider,
        model,
        messages: buildMessages({ summary, decisionName, confidence }),
        maxTokens: MAX_TOKENS,
        signal,
      }
    )) {
      chunks.push(chunk);
    }

    const { text, usage, finish, toolCalls } = collectChunks(chunks);
    const elapsedMs = Date.now() - startedAt;

    // An aborted or errored finish is a failure even though chunks arrived: a
    // truncated answer presented as a complete one would be worse than none.
    if (finish && (finish.kind === 'aborted' || finish.kind === 'error')) {
      return {
        ok: false,
        code: finish.kind === 'aborted' ? DISPATCH_CODES.ABORTED : DISPATCH_CODES.FAILED,
        error: finish.failure?.message || `the provider finished with '${finish.kind}'`,
        provider: route.provider,
        model,
        usage,
        elapsedMs,
        partialText: text,
      };
    }

    if (text.trim().length === 0) {
      return {
        ok: false,
        code: DISPATCH_CODES.FAILED,
        error: 'the second opinion returned no text',
        provider: route.provider,
        model,
        usage,
        finish,
        elapsedMs,
      };
    }

    return {
      ok: true,
      text: text.trim(),
      provider: route.provider,
      model,
      usage,
      finish,
      toolCalls,
      elapsedMs,
    };
  } catch (error) {
    // Specific, branchable failures. `LlmError` carries a stable `.code`; a
    // caller-cancelled call surfaces as an abort rather than a provider fault.
    const aborted = error?.name === 'AbortError' || signal?.aborted === true;
    return {
      ok: false,
      code: aborted ? DISPATCH_CODES.ABORTED : DISPATCH_CODES.FAILED,
      error: error?.message || String(error),
      providerErrorCode: error?.code ?? null,
      provider: route?.provider,
      model,
      elapsedMs: Date.now() - startedAt,
    };
  }
}
