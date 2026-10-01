# 06 — Token-Efficiency Estimate

**Compared stacks**

- **A — Naive Flash-only port.** Flash does the skill routing, the output
  verification, the routing/verification judgment, and context management by
  reasoning in prose. No decision layer. Escalation is either absent or manual.
- **B — Flash + OpenCode-free Jev + sparse second opinion** (what this port
  builds). Flash generates; Jev decides; a second opinion is consulted only on a
  low-confidence critical call, behind a budget cap.

Both stacks send the same skill bodies, so skill text is **excluded** from the
comparison — it is identical in A and B and would only dilute the signal. What
differs is the cost of *judgment* and the cost of *carried context*.

---

## Measured base facts

| Fact | Value | Source |
|---|---|---|
| Rendered catalog | 57 skills, 50,374 lines, ~797K tokens | `gen:skill-docs --host dsh` report |
| Largest single skill | `gstack-ship`, 202,509 bytes | `wc -c` |
| Discovered frontmatter (always-on surface) | 35,711 bytes across 57 files | `grep` over `.dsh/skills` |
| **Jev cost: `noul` judgment** | **289 in / 20 out tokens** | live probe, observed |
| **Jev cost: `choice` classification** | **308 in / 31 out tokens** | live probe, observed |
| Jev cost: 4-question risk batch | ~600–900 in / ~80 out | live probe, observed |
| Second-opinion escalation budget | ≤ 6/session, ≤ 1 paid/session | `escalation.js` `DEFAULT_BUDGET` |

The decisive measured number is the shape of Jev's output: **20–31 tokens**. Jev
returns a calibrated number, not an argument. Any generative model asked the same
question returns a verdict *plus the reasoning for it*, and reasoning is where the
tokens go.

---

## Where Jev offloads judgment

| # | Judgment point | Stack A (Flash-only) | Stack B (Jev) | Saving mechanism |
|---|---|---|---|---|
| 1 | **Skill routing** — which skill next? | Flash reasons over skill descriptions in context, ~600–1,500 reasoning out + ~80 out | 308 in / 31 out `choice` | Jev reads only the task state + `criteria` map, not the whole catalog prose |
| 2 | **Tool-call risk** — risk/irreversibility/injection/fit | Flash deliberates per risky call, then writes its caveat, ~250–700 reasoning out | ~150 in / ~20 out shared batch | One batch per call; output is 4 numbers, not 4 paragraphs |
| 3 | **Output verification** — did the stage meet its criteria? | Flash narrates a self-assessment, ~400–1,200 out; self-assessment is also *uncalibrated* | 289 in / 20 out | Same information, 20× less output — and it is a probability, not a claim |
| 4 | **Context pruning** — what carries forward? | FIFO/summary compaction; dropped material is lost | 289 in / 20 out per batched prune | See the compounding effect below |

Note the second benefit at points 3 and 4, which the token estimate alone
undersells: A's verification is *the author grading its own work*, and A's
pruning is *lossy*. B's verification is calibrated and its collapsed fragments
stay recallable (`scoreContextRelevance` returns `collapse`, not a delete).

---

## Scenario arithmetic

Assumptions are stated so they can be challenged. A mid-sized sprint:

| Decision volume | Count |
|---|---|
| Stage transitions gated | 7 |
| Skill routing calls | 7 |
| Output verifications | 7 |
| Gated tool calls (non-exempt) | 80 |
| History-prune checkpoints | 6 |

### 1. Routing + verification (21 decisions)

- **A:** 21 × ~900 reasoning + ~400 out ≈ **27,300 output tokens**, plus the
  catalog prose those judgments must read.
- **B:** 21 × ~31 out ≈ **650 output tokens**. Input side: 21 × ~308 ≈ 6,468 in.

### 2. Tool-call risk gate (80 calls)

- **A:** 80 × ~400 deliberated output ≈ **32,000 output tokens** (and, in
  practice, this is the gate most ports skip entirely — which is exactly how
  `rm -rf` and force-pushes get executed).
- **B:** 80 × (~150 in / ~20 out) ≈ **1,600 output tokens**.

### 3. Second opinion — the mechanism that must stay sparse

The point of gating escalation behind Jev's confidence is that the expensive
model is reached *only in the ambiguous band*. On a calibrated reading, roughly
one decision in five is ambiguous; the other four are confidently yes or no.

- **A (ungated):** if a second opinion were consulted on every judgment, cost is
  unbounded and the "sparse" property is lost by lunchtime.
- **B:** 7 critical decisions × ~20% ambiguous ≈ **~1–2 escalations**, hard-capped
  at 6/session with at most 1 paid. Everything else is settled by a 20-token
  Jev answer.

### 4. Context pruning — where the real multiplier lives

This is the largest effect and the easiest to miss, because it is not a per-call
saving but a reduction in *how much is re-sent on every subsequent request*.

- **A:** History grows monotonically. By the Ship stage the model is re-reading
  material the Think stage produced, on every request.
- **B:** At each of 6 checkpoints, irrelevant fragments collapse. If ~35–45% of
  accumulated history is irrelevant to the next stage (a conservative reading for
  a sprint that changes direction after CEO review), each collapse removes that
  fraction **from every remaining request**.

Order-of-magnitude: collapsing ~30K tokens of irrelevant history at checkpoint 2
removes ~30K from each of the ~20 remaining requests ≈ **600K tokens avoided** —
one to two orders of magnitude larger than the per-decision savings, and it is
the difference between a sprint that fits a context window and one that does not.

---

## Summary comparison

| Component | A: Flash-only | B: Flash + Jev + sparse 2nd opinion |
|---|---|---|
| Routing + verification output | ~27,300 | ~650 |
| Risk-gate output | ~32,000 (if done at all) | ~1,600 |
| Jev input (new cost B pays) | 0 | ~13,000 |
| Second opinions | unbounded / manual | ≤ 6, typical 1–2 |
| Carried context | grows unbounded | pruned ~35–45% per stage boundary |
| **Net** | — | **~80–90% less output tokens at the judgment points; large secondary reduction in re-sent context** |

## Honest caveats

- The per-decision reasoning figures for stack A are **estimates**, not
  measurements: they describe tokens a generative model spends explaining a
  judgment. The Jev figures (289/20, 308/31, 258/20) **are measured** against the
  live endpoint.
- Jev is a *separate billing/rate-limit surface* (OpenCode free). It is not
  free of rate limits, only free of charge — which is why the port degrades to
  "do not advance / allow the call" rather than failing when Jev is unreachable.
- **B is not unconditionally better.** Jev answers a *fixed question shape*; it
  cannot discover that the question was wrong. Every place this port uses Jev is
  a classification the workflow already knew it needed to make. Generation —
  writing the plan, the code, the retro — stays with Flash.
- The pruning estimate assumes collapsed fragments are genuinely irrelevant. Jev
  scores relevance but does not verify correctness, so a mis-scored fragment is
  recallable rather than lost — that is a design mitigation, not a proof.
