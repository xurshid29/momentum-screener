// OpenAI-backed catalyst classifier. Uses gpt-5.4-nano with Structured
// Outputs so the response is always valid JSON matching our schema.
// Called asynchronously from the poller after rule-based scoring; the
// refined verdict is written back to news_classifications and the
// per-URL cache so the next SSE cycle picks it up.

import OpenAI from 'openai';
import type { Classification, ClassifierInput } from './catalyst-rules.js';

const MODEL = 'gpt-5.4-nano';
const MAX_BODY_CHARS = 4000;

let client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (client) return client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  client = new OpenAI({ apiKey });
  return client;
}

const SYSTEM_PROMPT = `
You classify stock news for intraday momentum trading.

- Score the likely intraday catalyst strength from 0 to 100.
- Focus on whether the headline can attract immediate volume/attention.
- Penalize vague PR, small dollar amounts, repeated headlines, old news, and stocks already extended.
- Separate "news quality" from "market momentum" — a microcap can be flying on weak news.
- Be conservative when the body lacks material details.
- Do not recommend a trade.
`.trim();

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    impact_score: { type: 'integer', minimum: 0, maximum: 100 },
    direction: { type: 'string', enum: ['bullish', 'bearish', 'mixed', 'neutral'] },
    urgency: { type: 'string', enum: ['ignore', 'watch', 'strong', 'major'] },
    catalyst_type: {
      type: 'string',
      enum: [
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
      ],
    },
    materiality: { type: 'string', enum: ['high', 'medium', 'low', 'unknown'] },
    is_repeat: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' },
    risk_flags: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
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
        ],
      },
    },
  },
  required: [
    'impact_score',
    'direction',
    'urgency',
    'catalyst_type',
    'materiality',
    'is_repeat',
    'confidence',
    'reason',
    'risk_flags',
  ],
} as const;

function truncate(s: string | null | undefined, n: number): string | undefined {
  if (!s) return undefined;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export async function classifyByOpenAI(input: ClassifierInput): Promise<Classification | null> {
  const oai = getClient();
  if (!oai) return null;

  // Source intentionally omitted — same headline from finviz/yahoo/benzinga
  // should score the same. Including it nudges the model to weight credibility.
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
    const res = await oai.chat.completions.create({
      model: MODEL,
      // Deterministic — same headline must score the same every call.
      temperature: 0,
      seed: 1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'news_catalyst_classification',
          strict: true,
          schema: SCHEMA,
        },
      },
    });
    const content = res.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as Classification;
    return parsed;
  } catch (err) {
    console.error('[catalyst-openai] classification failed:', err);
    return null;
  }
}
