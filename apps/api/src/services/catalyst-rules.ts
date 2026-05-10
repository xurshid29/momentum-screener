// Rule-based catalyst classifier — fast, deterministic, no I/O.
// Runs synchronously inside the poll cycle so the SSE payload always carries
// at least a baseline score. The OpenAI classifier overwrites this in the DB
// asynchronously (next cycle's payload picks up the refined score).

import type {
  CatalystDirection,
  CatalystUrgency,
  CatalystMateriality,
  NewsSource,
} from '../db/types.js';

export interface ClassifierInput {
  ticker: string;
  title: string;
  body?: string | null;
  source: NewsSource;
  marketContext?: {
    change_pct?: number | null;
    float_m?: number | null;
    mcap_m?: number | null;
    rel_volume?: number | null;
    country?: string | null;
  } | null;
}

export interface Classification {
  impact_score: number;          // 0..100
  direction: CatalystDirection;
  urgency: CatalystUrgency;
  catalyst_type: string;
  materiality: CatalystMateriality;
  is_repeat: boolean;
  confidence: number;            // 0..1
  reason: string;
  risk_flags: string[];
}

interface Pattern {
  re: RegExp;
  weight: number;                // additive points
  type?: string;                 // catalyst_type if this pattern dominates
  direction?: CatalystDirection;
  materiality?: CatalystMateriality;
}

// High-impact catalysts. Order matters loosely — first match drives type/direction.
const HIGH_IMPACT: Pattern[] = [
  { re: /\bFDA\s+(approv|accept|grant|clear)/i, weight: 45, type: 'fda_clinical', direction: 'bullish', materiality: 'high' },
  { re: /\bphase\s+(3|iii|2|ii)\s+(success|positive|met|completed|topline)/i, weight: 40, type: 'fda_clinical', direction: 'bullish', materiality: 'high' },
  { re: /\b(clinical\s+trial)\s+(success|positive|met)/i, weight: 35, type: 'fda_clinical', direction: 'bullish', materiality: 'high' },
  { re: /\b(merger|merges?|acquir(?:e|es|ed|ing|ition)|buyout|takeover|to\s+acquire|bought\s+by)\b/i, weight: 40, type: 'merger_acquisition', direction: 'bullish', materiality: 'high' },
  { re: /\bdefinitive\s+agreement\b/i, weight: 30, type: 'merger_acquisition', materiality: 'high' },
  { re: /\bawarded?\s+(a\s+)?contract|wins?\s+contract|secures?\s+contract/i, weight: 30, type: 'contract_order', direction: 'bullish', materiality: 'medium' },
  { re: /\bpartnership\s+with\s+/i, weight: 25, type: 'partnership', direction: 'bullish', materiality: 'medium' },
  { re: /\bearnings\s+beat|exceeds\s+estimates|raised?\s+guidance|raises?\s+(?:full[- ]?year|fy)/i, weight: 35, type: 'earnings_guidance', direction: 'bullish', materiality: 'high' },
  { re: /\banalyst\s+upgrade|raises?\s+price\s+target|raises?\s+pt\b/i, weight: 25, type: 'analyst_rating', direction: 'bullish', materiality: 'medium' },
  { re: /\bshort\s+squeeze/i, weight: 25, type: 'halt_resume', direction: 'bullish', materiality: 'medium' },
  { re: /\bhalt(?:ed|s)?(?:\s+pending)?(?:\s+news|\s+material|\s+for)/i, weight: 30, type: 'halt_resume', materiality: 'medium' },
  { re: /\bbankruptcy\s+(?:emerge|exit|resolved|plan\s+approved)/i, weight: 30, type: 'legal_regulatory', direction: 'bullish', materiality: 'high' },
];

// Bearish-direction catalysts (still important — high move potential, just down).
const BEARISH_IMPACT: Pattern[] = [
  { re: /\b(SEC|DOJ)\s+(investigation|probe|charges?)/i, weight: 35, type: 'legal_regulatory', direction: 'bearish', materiality: 'high' },
  { re: /\b(class\s+action|securities\s+fraud|sued\s+by)/i, weight: 25, type: 'legal_regulatory', direction: 'bearish', materiality: 'medium' },
  { re: /\bgoing\s+concern|delist(?:ing|ed)/i, weight: 35, type: 'legal_regulatory', direction: 'bearish', materiality: 'high' },
  { re: /\b(public\s+offering|registered\s+direct|secondary\s+offering|share\s+sale|dilution)/i, weight: 25, type: 'offering_dilution', direction: 'bearish', materiality: 'high' },
  { re: /\bearnings\s+miss|cuts?\s+guidance|withdraw(?:s|n)?\s+guidance/i, weight: 30, type: 'earnings_guidance', direction: 'bearish', materiality: 'high' },
];

// Noisy/low-quality patterns — penalize.
const LOW_QUALITY: Pattern[] = [
  { re: /\bconference\s+(presentation|participation|attend)/i, weight: -20, type: 'generic_pr', materiality: 'low' },
  { re: /\bCEO\s+(interview|to\s+speak|appear)/i, weight: -20, type: 'generic_pr', materiality: 'low' },
  { re: /\boption(s)?\s+(whale|alert|activity|flow)/i, weight: -25, type: 'market_recap', materiality: 'low' },
  { re: /\btop\s+(stocks|gainers|movers|losers)\s+(moving|today|this)/i, weight: -25, type: 'market_recap', materiality: 'low' },
  { re: /\b(market\s+wrap|midday\s+movers|after[- ]?hours\s+movers)/i, weight: -25, type: 'market_recap', materiality: 'low' },
  { re: /^why\s+is\s+\w+\s+stock\s+(up|down|moving|surging|tanking)/i, weight: -20, type: 'market_recap', materiality: 'low' },
  { re: /\bjoin(s)?\s+russell\b/i, weight: -10, type: 'generic_pr', materiality: 'low' },
];

const ALL_PATTERNS = [...HIGH_IMPACT, ...BEARISH_IMPACT, ...LOW_QUALITY];

// Detect a dollar amount in the title and convert to millions.
// Returns null when nothing parsable is found.
function parseDollarMillions(text: string): number | null {
  const m = text.match(/\$\s*([\d.,]+)\s*(billion|million|b\b|m\b)/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(num)) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('b')) return num * 1000;
  return num; // already in millions
}

function urgencyFromScore(score: number): CatalystUrgency {
  if (score >= 75) return 'major';
  if (score >= 50) return 'strong';
  if (score >= 20) return 'watch';
  return 'ignore';
}

export function classifyByRules(input: ClassifierInput): Classification {
  const text = `${input.title} ${input.body ?? ''}`;

  let score = 30; // baseline — assume modest news interest
  let direction: CatalystDirection = 'neutral';
  let materiality: CatalystMateriality = 'unknown';
  let catalystType = 'other';
  const reasons: string[] = [];
  const flags = new Set<string>();
  let matched = 0;

  for (const p of ALL_PATTERNS) {
    if (!p.re.test(text)) continue;
    matched++;
    score += p.weight;
    if (p.type && catalystType === 'other') catalystType = p.type;
    if (p.direction && direction === 'neutral') direction = p.direction;
    if (p.materiality && materiality === 'unknown') materiality = p.materiality;
    reasons.push(p.weight > 0 ? `+${p.weight} ${p.type ?? 'match'}` : `${p.weight} ${p.type ?? 'penalty'}`);
  }

  // Dollar-amount sizing — boost when the deal/contract/buyback dollar size is
  // material relative to the company's market cap.
  const dollarsM = parseDollarMillions(text);
  const mcapM = input.marketContext?.mcap_m ?? null;
  if (dollarsM != null) {
    if (dollarsM >= 100) {
      score += 8;
      reasons.push(`+8 large $ amount`);
    } else if (dollarsM < 1) {
      score -= 10;
      reasons.push(`-10 trivial $ amount`);
      flags.add('weak_materiality');
    }
    if (mcapM && mcapM > 0) {
      const pct = (dollarsM / mcapM) * 100;
      if (pct >= 20) {
        score += 10;
        reasons.push(`+10 deal ≥20% mcap`);
      }
    }
  }

  // Risk flags from market context.
  const ctx = input.marketContext;
  if (ctx) {
    if ((ctx.change_pct ?? 0) >= 50) flags.add('already_extended');
    if (ctx.mcap_m != null && ctx.mcap_m < 50) flags.add('microcap');
    if (ctx.float_m != null && ctx.float_m < 5) flags.add('low_float_volatility');
    const country = (ctx.country ?? '').toLowerCase();
    if ((country.includes('china') || country.includes('hong kong')) && (ctx.mcap_m ?? 0) < 200) {
      flags.add('china_microcap_risk');
    }
  }
  if (/\b(offering|dilution|registered\s+direct)/i.test(text)) flags.add('dilution_risk');
  if (input.title.length < 30 && !input.body) flags.add('vague_pr');

  // Confidence — more matches → more confident in the verdict.
  let confidence = 0.4;
  if (matched >= 1) confidence = 0.6;
  if (matched >= 2) confidence = 0.7;

  // Clamp.
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    impact_score: score,
    direction,
    urgency: urgencyFromScore(score),
    catalyst_type: catalystType,
    materiality,
    is_repeat: false,
    confidence,
    reason: reasons.length > 0 ? reasons.join('; ') : 'no strong signal',
    risk_flags: [...flags],
  };
}
