/**
 * Jev — System One decision client.
 *
 * Jev is a non-generative "System One" decision model. It does not write prose;
 * it answers typed questions with calibrated probabilities, and that is the
 * entire point of wiring it into gstack: every place the workflow would
 * otherwise spend LLM tokens *reasoning about a classification* becomes a cheap
 * calibrated call instead.
 *
 * ## Wire format (verified against the live endpoint, not inferred)
 *
 * System One is NOT an OpenAI chat endpoint. A POST to `<base>/v1/systemone`
 * takes:
 *
 *     { model, state, questions: { <key>: <question> } }
 *
 * and returns:
 *
 *     { model, answers: { <key>: { type, <value> } }, usage: { input_tokens, output_tokens } }
 *
 * A live `state: "ping"` probe against the OpenCode free route returned
 * `{"model":"jev-1.13-free","answers":{"ping":{"type":"noul","noul":0.6}},"usage":{...}}`,
 * which is what pinned the shape below. Sending an OpenAI `messages` array
 * instead yields HTTP 400 `api_usage_error: Invalid request`, so the two are not
 * interchangeable.
 *
 * ## Provider binding
 *
 * The backend is OpenCode (`https://opencode.ai/zen/v1/systemone`). Two tiers are
 * reachable on that one endpoint:
 *
 *   - `jev-1.13`      — the PAID tier. The default, chosen by the operator
 *     because the free tier rate-limits (HTTP 429 `FreeUsageLimitError`) hard
 *     enough to block a sprint stage from ever gating. Calls are billed to the
 *     OpenCode account behind `OPENCODE_API_KEY`.
 *   - `jev-1.13-free` — the free tier, still usable by setting `config.model`.
 *     It needs no credit but throttles, so a gate can be left undecided.
 *
 * `assertFreeProvider()` still restricts the HOST to OpenCode, so a config
 * mistake cannot route judgment calls to TypeSafe-direct or OpenRouter. It
 * deliberately does not choose the tier: tier is a model id on the same host, and
 * the operator owns the spend decision. Note the escalation routes in
 * `escalation.js` are a separate policy and remain free-first — authorising Jev
 * to spend does not silently authorise second opinions to.
 *
 * A rate-limited call is reported through `classifyJevFailure()` as
 * `kind: 'rate-limited'`, which callers must distinguish from a broken binding.
 *
 * @module gstack-dsh/jev
 */

/** OpenCode's System One endpoint. The paid and free tiers share it. */
export const DEFAULT_JEV_BASE_URL = 'https://opencode.ai/zen/v1/systemone';
/**
 * Default model: the PAID tier, so a gate is not left undecided by free-tier
 * throttling. Set `config.model` to `jev-1.13-free` to run on credit-free quota.
 */
export const DEFAULT_JEV_MODEL = 'jev-1.13';

/** The free-tier model id, kept so a caller can opt back into it by name. */
export const FREE_JEV_MODEL = 'jev-1.13-free';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

/**
 * The OpenCode host allowlist. Only OpenCode's zen systemone endpoint is
 * permitted; anything else is refused so a config mistake cannot quietly route
 * judgment calls to a different vendor (TypeSafe-direct, OpenRouter).
 *
 * This deliberately does NOT restrict the model id, and therefore does not
 * choose between OpenCode's paid and free tiers — both live on this host. The
 * tier is a spend decision owned by the operator, expressed as `config.model`.
 */
const FREE_PROVIDER_HOSTS = ['opencode.ai'];

/** Question shapes accepted by System One. */
export const QUESTION_TYPES = {
  /**
   * Calibrated scalar judgment in [0,1] — "how true / how notable is this?".
   * This is the workhorse type and the one every gstack gate uses. A `bool`
   * type does NOT exist: sending one returns HTTP 400 `api_usage_error`.
   */
  NOUL: 'noul',
  /**
   * Multiple choice across named criteria keys. Requires a `criteria` object
   * mapping option key -> description (NOT a bare options array, which is also
   * rejected). Returns a `choice` plus a `probabilities` map.
   */
  CHOICE: 'choice',
};

/**
 * Wrap evidence for System One's `state` field.
 *
 * `state` is not a status enum — the reference implementation passes the prompt
 * or task text (truncated), and the questions are judged against it. Putting the
 * evidence here rather than concatenating it into `instructions` is what keeps
 * an answer calibrated to observed facts instead of to the question's phrasing.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function toState(text, limit = 4000) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > limit ? value.slice(0, limit) : value;
}

/**
 * @typedef {object} JevUsage
 * @property {number} input_tokens
 * @property {number} output_tokens
 */

export class JevError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'JevError';
    this.status = options.status;
    this.body = options.body;
  }
}

/**
 * Reject any route that is not OpenCode's System One endpoint.
 *
 * Enforces the HOST, not the tier: `jev-1.13` (paid) and `jev-1.13-free` both
 * pass, because they are the same endpoint and the tier is an operator spend
 * decision (`config.model`). What this prevents is a misconfiguration routing
 * judgment calls to a different vendor.
 *
 * @param {string} baseUrl - endpoint to validate.
 * @throws {JevError} when the host is not OpenCode.
 */
export function assertFreeProvider(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new JevError(`Jev base URL is not a valid URL: ${baseUrl}`);
  }
  const allowed = FREE_PROVIDER_HOSTS.some(
    (candidate) => host === candidate || host.endsWith(`.${candidate}`)
  );
  if (!allowed) {
    throw new JevError(
      `Jev refuses non-OpenCode provider '${host}'. The backend must be OpenCode's ` +
        `System One endpoint (${DEFAULT_JEV_BASE_URL}); either tier on it is accepted. ` +
        `TypeSafe-direct and OpenRouter are out of scope.`
    );
  }
}

/** Sleep helper for retry backoff. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify a Jev failure so callers can tell a fixable fault from a waitable one.
 *
 * This matters because the two need opposite responses from whoever reads the
 * message. A rate limit on the free tier needs no repair — the binding is fine
 * and the only correct action is to wait or raise the operator's involvement. A
 * transport or auth fault needs an actual fix. Reporting both as "Jev was
 * unreachable, fix the binding" sends someone to debug a credential that works,
 * which is exactly the failure this session spent several rounds untangling.
 *
 * Accepts either a thrown error or a `testConnection()` result, since both carry
 * the same signal.
 *
 * @param {unknown} failure - a thrown error, or a `{kind, status, error}` result.
 * @returns {{kind: 'rate-limited'|'auth'|'timeout'|'unreachable'|'error',
 *   status: number|null, retryable: boolean, detail: string}}
 */
export function classifyJevFailure(failure) {
  const status = typeof failure?.status === 'number' ? failure.status : null;
  const fromKind = typeof failure?.kind === 'string' ? failure.kind : null;
  const detail =
    (typeof failure?.message === 'string' && failure.message) ||
    (typeof failure?.error === 'string' && failure.error) ||
    String(failure ?? 'unknown Jev failure');

  if (status === 429 || fromKind === 'rate-limited') {
    return { kind: 'rate-limited', status: status ?? 429, retryable: true, detail };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', status, retryable: false, detail };
  }
  if (status === 408 || status === 504 || /\btimeout|timed out|aborted\b/i.test(detail)) {
    return { kind: 'timeout', status, retryable: true, detail };
  }
  if (status === null) {
    return { kind: 'unreachable', status: null, retryable: true, detail };
  }
  return { kind: 'error', status, retryable: status >= 500, detail };
}

/**
 * Resolve the OpenCode API key.
 *
 * Deliberately NOT read from this package's source: a credential committed into
 * a git-tracked plugin would leak into the repository. Order:
 *   1. `GSTACK_DSH_JEV_API_KEY`  (project- or session-scoped override)
 *   2. `OPENCODE_API_KEY`        (the convention the DSH profile already uses)
 *
 * @param {Record<string,string|undefined>} [env] - injectable env for tests.
 * @returns {string|undefined} the key, or undefined when unconfigured.
 */
export function resolveJevApiKey(env = globalThis.process?.env ?? {}) {
  const key = env.GSTACK_DSH_JEV_API_KEY || env.OPENCODE_API_KEY;
  return key && key.trim() !== '' ? key.trim() : undefined;
}

/**
 * Client for the System One decision endpoint.
 *
 * One instance is shared per session; it is stateless apart from config, so it
 * is safe to reuse across concurrent calls.
 */
export class JevClient {
  /**
   * @param {object} [config]
   * @param {string} [config.baseUrl] - endpoint; must remain an allowed free host.
   * @param {string} [config.model] - Jev model id.
   * @param {string} [config.apiKey] - credential; falls back to the env chain.
   * @param {number} [config.timeoutMs] - per-request timeout.
   * @param {number} [config.retries] - retry attempts after the first failure.
   * @param {boolean} [config.enabled] - master switch; disabled clients refuse calls.
   * @param {(msg: string) => void} [config.log] - warning sink.
   */
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || DEFAULT_JEV_BASE_URL;
    this.model = config.model || DEFAULT_JEV_MODEL;
    this.apiKey = config.apiKey || resolveJevApiKey();
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.enabled = config.enabled !== false;
    this.log = config.log || (() => {});
    this.usage = { calls: 0, input_tokens: 0, output_tokens: 0 };

    // Fail fast on a misconfigured provider rather than at the first decision.
    assertFreeProvider(this.baseUrl);
  }

  /** @returns {string} the resolved systemone URL. */
  get endpoint() {
    return this.baseUrl.replace(/\/+$/, '');
  }

  /**
   * Ask Jev one or more typed questions.
   *
   * @param {Record<string, object>} questions - System One question definitions.
   * @param {object} [options]
   * @param {string} [options.state] - the free text the questions are judged
   *   against (evidence / task text). Defaults to the concatenated question
   *   instructions, which is the only safe fallback.
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries]
   * @returns {Promise<{answers: Record<string, object>, usage?: JevUsage, model?: string}>}
   */
  async triage(questions, options = {}) {
    if (!this.enabled) {
      throw new JevError('Jev is disabled in this configuration.');
    }
    if (!questions || Object.keys(questions).length === 0) {
      throw new JevError('Jev triage requires at least one question.');
    }

    const payload = {
      model: this.model,
      // `state` is the free text the questions are judged against. Defaulting it
      // to the question instructions keeps a call meaningful when no separate
      // evidence is supplied.
      state: toState(options.state || Object.values(questions).map((q) => q.instructions).join('\n\n')),
      questions,
    };

    const response = await this.#request(payload, options);
    if (response?.usage) {
      this.usage.calls += 1;
      this.usage.input_tokens += Number(response.usage.input_tokens) || 0;
      this.usage.output_tokens += Number(response.usage.output_tokens) || 0;
    }
    return response;
  }

  /**
   * Cheap liveness probe. Also the canonical proof that the binding works.
   *
   * A 429 is reported as `kind: 'rate-limited'`, which is NOT a binding
   * failure: the request reached the provider and was authenticated, and the
   * free tier is simply throttling. Callers that gate an install check should
   * treat it as a pass with a retry note, not as a broken binding. A 401/403
   * means the credential is wrong, and anything without a status never reached
   * the provider at all.
   *
   * @returns {Promise<{ok: boolean, kind: 'ok'|'rate-limited'|'error', status: number|null,
   *   model?: string, latencyMs: number, error?: string}>}
   */
  async testConnection() {
    const startedAt = Date.now();
    try {
      const response = await this.triage(
        { ping: { type: QUESTION_TYPES.NOUL, instructions: 'ping' } },
        { state: 'ping', timeoutMs: 8000, retries: 1 }
      );
      return {
        ok: true,
        kind: 'ok',
        status: 200,
        model: response?.model || this.model,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : null;
      return {
        ok: false,
        kind: status === 429 ? 'rate-limited' : 'error',
        status,
        latencyMs: Date.now() - startedAt,
        error: error?.message || String(error),
      };
    }
  }

  /**
   * POST the payload with timeout + retry.
   *
   * @private
   * @param {object} payload
   * @param {object} options
   * @returns {Promise<object>}
   */
  async #request(payload, options = {}) {
    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const maxRetries = options.retries ?? this.retries;
    if (!this.apiKey) {
      throw new JevError(
        'No Jev credential. Set OPENCODE_API_KEY (or GSTACK_DSH_JEV_API_KEY) for the ' +
          'OpenCode free Jev route.'
      );
    }

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          // 4xx is a caller/config fault: retrying cannot help.
          if (response.status >= 400 && response.status < 500) {
            throw new JevError(
              `Jev HTTP ${response.status}: ${body || response.statusText}`,
              { status: response.status, body }
            );
          }
          throw new JevError(`Jev HTTP ${response.status}: ${body || response.statusText}`, {
            status: response.status,
            body,
          });
        }
        return await response.json();
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        const isClientFault = error instanceof JevError && error.status >= 400 && error.status < 500;
        if (isClientFault || attempt >= maxRetries) break;
        await sleep(250 * (attempt + 1));
      }
    }
    throw lastError;
  }
}

/**
 * Extract the calibrated scalar from one System One answer.
 *
 * System One answers are `{ type, <type>: value }`. Callers almost always want
 * the single number, so this normalizes without hiding a missing answer.
 *
 * @param {object|undefined} answer
 * @returns {number|null} the scalar, or null when absent.
 */
export function answerScalar(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const candidate = answer[answer.type];
  return typeof candidate === 'number' ? candidate : null;
}

/**
 * Interpret a `noul` answer as a gated decision.
 *
 * A `noul` answer is a calibrated scalar meaning "how true / how notable is
 * this" on [0,1]. It is turned into a decision the same way a calibrated
 * probability would be: confident high means yes, confident low means no, and
 * anything in the ambiguous middle is explicitly `unsure` so a caller never
 * mistakes an uncertain reading for a verdict.
 *
 * @param {object|undefined} answer
 * @param {number} threshold - distance from 0 or 1 needed to count as decided.
 * @returns {{value: number|null, confident: boolean, decision: 'yes'|'no'|'unsure'}}
 */
export function readNoulAnswer(answer, threshold) {
  const value = answerScalar(answer);
  if (value === null) return { value: null, confident: false, decision: 'unsure' };
  if (value >= threshold) return { value, confident: true, decision: 'yes' };
  if (value <= 1 - threshold) return { value, confident: true, decision: 'no' };
  return { value, confident: false, decision: 'unsure' };
}
