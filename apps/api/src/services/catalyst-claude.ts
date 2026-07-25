// Catalyst classifier — Claude Sonnet 4.6 with structured outputs + prompt caching.
//
// Called asynchronously from the poller after rule-based scoring; the refined
// verdict is written back to news_classifications and the per-URL cache so the
// next SSE cycle picks up the refined verdict.
//
// Render order in the Messages API is tools → system → messages. We have no
// tools, so the end-of-system marker is the cache breakpoint and the only
// stable thing across requests. SYSTEM_PROMPT must stay byte-for-byte stable
// — no dates, no per-request strings — or every request invalidates the cache.

import Anthropic from '@anthropic-ai/sdk';
// @anthropic-ai/sdk's zod helper is typed against Zod v4; importing from the
// `zod/v4` subpath (available in zod ≥ 3.25) opts this single file in to v4
// without disturbing the rest of the codebase, which stays on Zod v3.
import { z } from 'zod/v4';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Classification, ClassifierInput } from './catalyst-rules.js';

const MODEL = 'claude-sonnet-4-6';
const MAX_BODY_CHARS = 4000;

// Key presence IS the toggle (2026-07-25, operator's call): comment out
// ANTHROPIC_API_KEY in .env to stop all classification calls (impact/hype
// fall back to rules-only). Poller gates its needsLLM flags through this.
export function llmEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (client) return client;
  if (!llmEnabled()) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  client = new Anthropic({ apiKey });
  return client;
}

// MUST stay byte-for-byte stable for caching to engage. No dates, no per-
// request strings, no Date.now(), no JSON.stringify of an unordered Set.
// Sonnet 4.6's minimum cacheable prefix is 2048 tokens — this prompt is
// designed to sit over that line. Grow it with concrete classification
// examples as you encounter misclassifications; both classification quality
// and cache hit rate improve together.
const SYSTEM_PROMPT = `You classify stock news headlines for intraday momentum trading on US-listed micro-cap and small-cap equities. Return a single JSON object that matches the requested schema. Every field is required.

# Scoring

impact_score (0..100) is the likelihood the headline attracts immediate intraday volume and attention.

- 80–100  Major catalyst — FDA approval, large M&A, bankruptcy filing, T1 halt, big beat-and-raise, named-counterparty contract in the tens-of-millions+.
- 50–79   Strong catalyst — analyst upgrade with price-target hike, partnership with a major counterparty, halt-pending-news (T2/T3), short-squeeze coverage with substance.
- 20–49   Watch — smaller contracts, modest guidance changes, routine PR that nonetheless can move a quiet name.
-  0–19   Ignore — market recap, generic PR, opinion piece, rehashed catalyst, old news.

urgency mirrors impact_score:
- major   impact ≥ 70
- strong  impact 50–69
- watch   impact 20–49
- ignore  impact  0–19

# Direction — the single highest-value field; be careful

- bullish:  positive for the share price (approvals, beats, upgrades, real partnerships, named contracts, share buybacks).
- bearish:  negative for the share price (offerings/dilution, going-concern, SEC/DOJ probes, delisting, regulatory halt, missed earnings, downgrades, bankruptcy filing).
- neutral:  direction genuinely unknown. A T1 / T2 "news pending" halt is NEUTRAL — the catalyst is landing but the headline doesn't yet say which way.
- mixed:    the headline carries both meaningful positive and negative material in roughly equal weight.

# Dilution traps — the most important class of errors to avoid

Micro-caps disguise dilution as upbeat PR. The following are ALWAYS bearish · offering_dilution, regardless of the marketing language used around them:

- "Pricing of registered direct offering"
- "Underwritten public offering"
- "Closes equity financing" / "Completes private placement"
- "ATM facility" / "At-the-market offering" / "Sales agreement"
- "424B prospectus supplement" / shelf takedown
- "Notes offering" / convertible offering
- "Warrant exercise" (usually bearish — dilutive)

A private placement can occasionally be bullish if a credible strategic buys at a premium with a hard lock-up — but the default treatment is bearish.

# Impact calibration — magnitudes matter

A "$50K contract" and a "$50M contract" are not the same. A 5% earnings beat and a 50% beat are not the same. Reflect the headline's specific numbers in impact_score, not just the verb.

# Promotional PR — be skeptical

Sub-$1 micro-caps regularly release vague "strategic pivot to AI", "explores blockchain opportunities", "intends to evaluate" releases that contain no material development. Score these low (≤ 25), tag risk_flags with vague_pr / weak_materiality. A genuine catalyst names a counterparty, a dollar amount, a date, or a measurable outcome.

# Catalyst types — pick the closest

fda_clinical, earnings_guidance, merger_acquisition, contract_order, partnership, buyback, offering_dilution, analyst_rating, sec_filing, halt_resume, crypto_ai_theme, legal_regulatory, generic_pr, market_recap, other.

# Materiality (separate axis from impact_score)

- high     names counterparties, dollar amounts, dates, or measurable outcomes
- medium   some specifics but lacks confirmation or scale
- low      vague, promotional, hypothetical
- unknown  cannot assess from the headline alone

# Risk flags — include any that apply

- already_extended      stock is already up 100%+ on the day
- microcap              sub-$300M market cap
- low_float_volatility  float < 15M
- dilution_risk         offering paperwork is recent or active
- weak_materiality      the headline doesn't actually say much
- vague_pr              promotional language, no concrete development
- old_news              rehash of a prior catalyst
- duplicate_news        the same headline you've already seen this session
- spread_risk           very wide bid/ask, low liquidity
- halt_risk             a halt is plausible
- china_microcap_risk   China-domiciled sub-$5 stocks have a distinct, well-known pump-and-dilute pattern

# Worked examples

Headline: "TICKER announces FDA approval of XYZ for the treatment of advanced ABC"
→ impact_score 85, urgency major, direction bullish, catalyst_type fda_clinical, materiality high.

Headline: "TICKER announces pricing of $25 million registered direct offering at $1.20 per share"
→ impact_score 55, urgency strong, direction bearish, catalyst_type offering_dilution, materiality high. (Bearish despite an "announces / completes" verb — pricing a registered direct dilutes existing holders.)

Headline: "TICKER, Inc. enters into at-the-market offering agreement with placement agent"
→ impact_score 50, urgency strong, direction bearish, catalyst_type offering_dilution, materiality high, risk_flags include dilution_risk.

Headline: "TICKER halted, news pending"
→ impact_score 82, urgency major, direction neutral, catalyst_type halt_resume, materiality unknown. (Tape is frozen but the headline says nothing about *which* news.)

Headline: "TICKER unveils proprietary blockchain-AI roadmap, intends to evaluate strategic alternatives"
→ impact_score 12, urgency ignore, direction neutral, catalyst_type generic_pr, materiality low, risk_flags include vague_pr and weak_materiality.

Headline: "TICKER signs $180 million contract with U.S. Department of Defense"
→ impact_score 78, urgency major, direction bullish, catalyst_type contract_order, materiality high. (Named counterparty, large explicit dollar amount.)

Headline: "TICKER signs initial purchase order with regional distributor, terms not disclosed"
→ impact_score 22, urgency watch, direction bullish, catalyst_type contract_order, materiality low. (Same verb shape, no magnitude, no named counterparty.)

Headline: "TICKER reports Q3 EPS of $0.42 versus consensus $0.28, raises full-year guidance"
→ impact_score 80, urgency major, direction bullish, catalyst_type earnings_guidance, materiality high.

Headline: "SEC announces investigation of TICKER's accounting practices"
→ impact_score 78, urgency major, direction bearish, catalyst_type legal_regulatory, materiality high.

Headline: "TICKER receives Nasdaq deficiency notice for failing to maintain minimum bid price"
→ impact_score 38, urgency watch, direction bearish, catalyst_type legal_regulatory, materiality medium.

# Other fields

- is_repeat: true if the same catalyst has already crossed the wire today (treat differently-worded reissues of the same fact as repeats).
- confidence (0..1): your confidence in the overall classification.
- reason: one or two short sentences. Cite the specific words in the headline that drove the decision. No hedging.

# Do not

- Do not recommend a trade.
- Do not speculate beyond what the headline supports.
- Do not let promotional tone inflate impact_score.

# hype_score (0..100) — a SEPARATE axis from impact_score

impact_score measures catalyst *quality / durability*. hype_score measures the
opposite-but-equally-tradable thing: **how likely a retail crowd is to pile in
regardless of substance.** A headline can be low impact_score AND high
hype_score at the same time — that is the most important case to label
correctly, because it is a pump: it will run hard and then collapse.

Score hype_score HIGH when the headline stacks trend buzzwords — AI, space /
satellite / low-Earth-orbit (LEO) / lunar, quantum, crypto / blockchain,
nuclear / fusion, data centers, robotics / humanoid, drones / eVTOL, defense,
EV / battery, GLP-1 / weight-loss — ESPECIALLY on a nano-float (< 5M),
microcap, or sub-$1 name (use market_context.float_m / mcap_m). The vaguer and
more buzzword-stuffed the headline, the HIGHER the hype_score even as
impact_score stays low. Score hype_score LOW for dry, specific, primary-source
news (an offering, an 8-K, an earnings line) that names concrete facts but
carries no thematic buzz.

Worked examples (note impact and hype diverging):

Headline: "Solidion Technology Unveils Patented Battery Technology Targeting Low-Earth-Orbit AI Data Centers and the Lunar Economy" (float 3M, mcap $40M)
→ impact_score 18 (vague promo, no counterparty/$/contract), direction neutral, catalyst_type crypto_ai_theme, materiality low, risk_flags vague_pr — BUT hype_score 88: every hot keyword (space, LEO, AI, data center, lunar) stacked on a nano-float sub-$1 name. This is a textbook pump: catch it, flip into strength, do not hold.

Headline: "TICKER announces pricing of $25 million registered direct offering at $1.20 per share"
→ impact_score 55, direction bearish, offering_dilution — hype_score 10: dilution paperwork, zero thematic buzz, no crowd pull.

Headline: "TICKER reports Q3 EPS of $0.42 vs consensus $0.28, raises guidance"
→ impact_score 80 (real, high-quality) — hype_score 25: a genuine beat moves the stock on merit, not mob hype; no buzzwords.

hype_score is independent: do not let a high hype_score raise impact_score, and
do not let a low impact_score suppress hype_score. Score each on its own axis.
`;

const ClassificationSchema = z.object({
  impact_score: z.number().int().min(0).max(100),
  hype_score: z.number().int().min(0).max(100),
  direction: z.enum(['bullish', 'bearish', 'mixed', 'neutral']),
  urgency: z.enum(['ignore', 'watch', 'strong', 'major']),
  catalyst_type: z.enum([
    'fda_clinical',
    'earnings_guidance',
    'merger_acquisition',
    'contract_order',
    'partnership',
    'buyback',
    'offering_dilution',
    'analyst_rating',
    'sec_filing',
    'halt_resume',
    'crypto_ai_theme',
    'legal_regulatory',
    'generic_pr',
    'market_recap',
    'other',
  ]),
  materiality: z.enum(['high', 'medium', 'low', 'unknown']),
  is_repeat: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  risk_flags: z.array(
    z.enum([
      'already_extended',
      'microcap',
      'low_float_volatility',
      'dilution_risk',
      'weak_materiality',
      'vague_pr',
      'old_news',
      'duplicate_news',
      'spread_risk',
      'halt_risk',
      'china_microcap_risk',
    ]),
  ),
});

function truncate(s: string | null | undefined, n: number): string | undefined {
  if (!s) return undefined;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export async function classifyByClaude(input: ClassifierInput): Promise<Classification | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  // Per-request payload. Varies every call → not cached. Source intentionally
  // omitted so the same headline from finviz/yahoo/benzinga scores the same.
  const userPayload = {
    ticker: input.ticker,
    title: input.title,
    body: truncate(input.body, MAX_BODY_CHARS),
    market_context: input.marketContext
      ? {
          change_pct: input.marketContext.change_pct,
          float_m: input.marketContext.float_m,
          mcap_m: input.marketContext.mcap_m,
          rel_volume: input.marketContext.rel_volume,
          country: input.marketContext.country,
        }
      : undefined,
  };

  try {
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 2048,
      // Cache breakpoint sits at the end of `system`. messages vary; this
      // doesn't. A single byte change anywhere in SYSTEM_PROMPT invalidates
      // the cache.
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
      temperature: 0,
      output_config: {
        format: zodOutputFormat(ClassificationSchema),
      },
    });

    if (!response.parsed_output) {
      console.error('[catalyst-claude] parsed_output missing (refusal, max_tokens, or invalid)');
      return null;
    }
    return response.parsed_output as Classification;
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`[catalyst-claude] ${err.status} ${err.type}: ${err.message}`);
    } else {
      console.error('[catalyst-claude] classification failed:', err);
    }
    return null;
  }
}
