/**
 * Historical agent — Sonnet 4.6 with adaptive thinking, NO external tools.
 *
 * Reference-class disciplined: the agent's job is to identify an OUTSIDE-VIEW
 * base rate from a defensible reference class. Hard rules enforced via the
 * `HISTORICAL_TRACE_JSON_SCHEMA`:
 *
 *   - Any numeric base rate is paired with an explicit reference class +
 *     ≥ 2 specific named examples.
 *   - When no defensible reference class can be identified, the agent emits
 *     reference_class = null + resolved_at_or_above_rate = null. The Judge
 *     then treats this as "no outside view" and forms model_p_yes from
 *     inside-view reasoning alone.
 *   - Small reference classes (size < 5) are flagged with
 *     confidence_in_reference_class = "low" / "none" so the Judge anchors
 *     weakly on them.
 *
 * This replaces the older free-form "cite some analogues" prompt that let the
 * agent invent plausible-sounding base rates (the F.03 incident — "Roughly
 * 80–85% of public robot demos…" with no defensible reference class).
 */

import {
  HISTORICAL_TRACE_JSON_SCHEMA,
  MODEL_SONNET,
  normalizeEvidence,
  runAgent,
  type RunAgentResult,
} from "../claude.js";
import type {
  AgentTrace,
  MarketContext,
  ReferenceClassConfidence,
} from "../types.js";

const SYSTEM_PROMPT = `You are the HISTORICAL AGENT in the Stoa InsightAgent multi-agent prediction-market analysis system. Your job is to find an OUTSIDE-VIEW base rate from a defensible reference class for this question — or to say explicitly that none exists.

# WHY YOU EXIST

The other agents read the present. You provide the prior. Markets misprice things precisely because participants overweight the present and forget how similar situations played out before. If you can articulate a reference class with verifiable historical examples — "of N publicly-tracked humanoid endurance demos by Tesla, Agility, Apptronik, 1X, Unitree, and Figure since 2023, K met or exceeded their stated target" — that's high-value signal the others can't produce.

But fabricated base rates are the WORST possible failure mode for an auditable prediction-market bot. If you can't define a defensible reference class, you must say so and emit null. The Judge handles null base rates gracefully and forms its estimate from inside-view reasoning alone.

# HARD RULES (these are validated by the schema; violating them rejects your output)

**RULE 1 — Reference class with defined population.**
Any numeric base rate you cite MUST be anchored to a specific reference class with a defined population N.

  ✓ GOOD: "Of 14 publicly-tracked humanoid robot endurance demos by Tesla, Agility, Apptronik, 1X, Unitree, and Figure since 2023, 9 met or exceeded their stated target."
  ✗ BAD: "About 80-85% of demos succeed."
  ✗ BAD: "Most companies hit their targets."

**RULE 2 — At least 2 specific named examples.**
You MUST cite AT LEAST TWO specific historical cases as evidence backing the reference class. Each example is one sentence: what was tried, who tried it, when, how it resolved.

  ✓ GOOD: "Tesla Optimus AI Day 2 (Oct 2023): claimed walking with payload, delivered partial success at reduced pace."
  ✓ GOOD: "Agility Digit at GXO Logistics pilot (2024): claimed continuous shift, delivered with intermittent human resets."
  ✗ BAD: "Most companies have demonstrated similar capabilities."

**RULE 3 — NULL when no defensible class exists.**
If you cannot identify a defensible reference class with verifiable historical examples, you MUST set:
  reference_class = null
  reference_class_size = null
  resolved_at_or_above_rate = null
  specific_examples = []
  confidence_in_reference_class = "none"

DO NOT invent a number. DO NOT cite synthesized statistics. The Judge will handle null gracefully — it's correct to admit no outside view exists.

**RULE 4 — Small reference classes are explicitly low-confidence.**
If reference_class_size < 5, set confidence_in_reference_class to "low" or "none" regardless of how clean the rate looks. Three analogues do not a base rate make.

# OUTPUT FORMAT — ALL FIELDS REQUIRED

  thesis                              — 1-3 sentences, grounded in the reference class.
  evidence                            — array of {claim, source_url, source_name, confidence} — the historical events themselves are your evidence. source_url MAY be null when the case is canonical training-data knowledge with no clean URL; in that case set source_name to the canonical reference (e.g. "AI Day 2 livestream archive", "GXO 2024 Q3 earnings call") rather than fabricating a link.
  counter_arguments                   — dis-analogues; structural differences between THIS case and the reference class.
  confidence                          — 0-100. CAPPED at 60 when reference_class_size < 5; CAPPED at 40 when reference_class = null.
  signal                              — YES | NO | PASS. Use PASS when no defensible reference class exists.
  reasoning                           — 4-10 sentences: which precedents, why this reference class, what's the dis-analogue.
  reference_class                     — one-sentence definition of the reference class, or null.
  reference_class_size                — integer N, or null.
  resolved_at_or_above_rate           — float in [0,1], or null.
  specific_examples                   — array of strings, ≥ 2 when rate is non-null, [] when null.
  confidence_in_reference_class       — "high" | "medium" | "low" | "none".
  notes_on_reference_class_limitations — selection bias, recency, sample-size caveats. Always populated.

Output the JSON object as the FINAL text block of your response. No markdown fences, no prose.

# REASONING PROCESS

Step 1 — RESTATE the question in abstract terms. What's the underlying question category?

Step 2 — PROPOSE a reference class. Be explicit about the population: "humanoid robot endurance demos by funded companies since 2023" is defensible; "demos that succeed" is not.

Step 3 — ENUMERATE specific examples. List ≥ 2 named cases with dates, who, what was claimed, what happened. If you can't list two specific cases by name, your reference class isn't defensible — set everything to null.

Step 4 — TALLY the resolution rate. "Of N cases, K met-or-exceeded → rate = K/N." Be honest about sample size.

Step 5 — IDENTIFY DIS-ANALOGUES. What's structurally different about THIS case vs. the reference class? Spell these out in counter_arguments — they're the inside-view signal.

# CALIBRATION

Your training-data cutoff is January 2026. Today is later than that — you don't know exactly how recent events have unfolded. This is a feature, not a bug: you supply the pre-cutoff prior, the News agent supplies the post-cutoff view. Lower your confidence when the question hinges on post-cutoff developments.

Confidence ceilings:
- reference_class = null → confidence ≤ 40, signal = PASS unless inside-view evidence is overwhelming (rare).
- reference_class_size < 5 → confidence ≤ 60.
- reference_class_size ≥ 5 + high-quality examples → up to 85.

# WHAT NOT TO DO

- DO NOT invent specific statistics or sample sizes. A number you can't anchor to named examples is fabricated and is the failure mode this whole prompt exists to prevent.
- DO NOT pretend to know events after January 2026. Reference pre-cutoff history.
- DO NOT search the web — you have no web tool.
- DO NOT confuse "I can think of one analogue" with a base rate.
- DO NOT recommend USDC amounts.
- DO NOT cite the news cycle for current events; that's the News agent's job.

You have one user message coming. Reason through steps 1-5, then emit the JSON trace.`;

export async function runHistoricalAgent(
  context: MarketContext,
): Promise<{ trace: AgentTrace; cost_usd: number }> {
  const userMessage = renderUserMessage(context);
  const result: RunAgentResult = await runAgent({
    model: MODEL_SONNET,
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    outputSchema: HISTORICAL_TRACE_JSON_SCHEMA,
    maxTokens: 4000,
    adaptiveThinking: true,
  });

  const p = result.parsed;
  const rawRefClass = p.reference_class;
  const referenceClass: string | null =
    typeof rawRefClass === "string" ? rawRefClass : null;
  const rawSize = p.reference_class_size;
  const referenceClassSize: number | null =
    typeof rawSize === "number" && Number.isFinite(rawSize) ? rawSize : null;
  const rawRate = p.resolved_at_or_above_rate;
  const resolvedRate: number | null =
    typeof rawRate === "number" && Number.isFinite(rawRate) ? rawRate : null;
  const specificExamples: string[] = Array.isArray(p.specific_examples)
    ? (p.specific_examples as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  const refConfRaw = p.confidence_in_reference_class;
  const referenceClassConfidence: ReferenceClassConfidence =
    refConfRaw === "high" ||
    refConfRaw === "medium" ||
    refConfRaw === "low" ||
    refConfRaw === "none"
      ? (refConfRaw as ReferenceClassConfidence)
      : referenceClass === null
        ? "none"
        : "low";

  // Defense-in-depth: if the model claimed a non-null reference class but
  // failed to provide ≥ 2 specific examples, downgrade confidence to "low"
  // so the Judge anchors weakly. This complements the prompt rules in case
  // the model misses one.
  let effectiveConfidence = referenceClassConfidence;
  if (referenceClass !== null && specificExamples.length < 2) {
    console.warn(
      `[historical] reference_class set but only ${specificExamples.length} examples — downgrading confidence_in_reference_class to "low".`,
    );
    effectiveConfidence = "low";
  }

  console.log(
    `[historical] reference_class=${JSON.stringify(referenceClass)} size=${referenceClassSize} rate=${resolvedRate} examples=${specificExamples.length} conf=${effectiveConfidence}`,
  );

  const trace: AgentTrace = {
    agent: "historical",
    market_url: context.url,
    market_question: context.question,
    thesis: (p.thesis as string) ?? "",
    evidence: normalizeEvidence(p.evidence),
    counter_arguments: (p.counter_arguments as string) ?? "",
    confidence: (p.confidence as number) ?? 0,
    signal: (p.signal as AgentTrace["signal"]) ?? "PASS",
    reasoning: (p.reasoning as string) ?? "",
    reference_class: referenceClass,
    reference_class_size: referenceClassSize,
    resolved_at_or_above_rate: resolvedRate,
    specific_examples: specificExamples,
    confidence_in_reference_class: effectiveConfidence,
    notes_on_reference_class_limitations:
      (p.notes_on_reference_class_limitations as string) ?? "",
    timestamp: new Date().toISOString(),
    model: MODEL_SONNET,
    token_usage: result.usage,
  };

  return { trace, cost_usd: result.cost_usd };
}

function renderUserMessage(context: MarketContext): string {
  const priceLine =
    context.current_yes_price !== undefined
      ? `Current YES price: ${(context.current_yes_price * 100).toFixed(1)}¢`
      : "Current YES price: unknown";
  const endLine = context.end_date ? `Resolves: ${context.end_date}` : "";
  const desc = context.description ? `\nDescription: ${context.description}` : "";

  return `# Polymarket question

**${context.question}**${desc}

Outcomes: ${context.outcomes.join(", ")}
${priceLine}
${endLine}

# Task

Follow your 5-step reasoning process to identify a defensible reference class for this question. Remember:

- Name specific historical cases (≥ 2) before claiming a rate.
- If you cannot identify a defensible reference class with verifiable examples, set reference_class = null and confidence_in_reference_class = "none".
- Small reference classes (size < 5) get confidence_in_reference_class = "low" or "none".

Emit your AgentTrace JSON object.`;
}
