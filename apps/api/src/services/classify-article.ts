// On-demand classifier for a persisted news article. Used by
// POST /api/news/:articleId/classify so the UI can show AI analysis
// for any headline (including Universe News tickers that the poller
// never enriches). Idempotent: if a classification exists, returns it
// without spending tokens.

import { getDb } from '../db/index.js';
import type { Classification } from './catalyst-rules.js';
import { classifyByRules, type ClassifierInput } from './catalyst-rules.js';
import { classifyByClaude } from './catalyst-claude.js';
import type { Classifier } from '../db/types.js';

export interface ArticleClassificationResult {
  impact_score: number;
  urgency: Classification['urgency'];
  direction: Classification['direction'];
  catalyst_type: string;
  materiality: Classification['materiality'];
  confidence: number;
  reason: string | null;
  risk_flags: string[];
  classifier: Classifier;
  cached: boolean;
}

function toResult(c: Classification, classifier: Classifier, cached: boolean): ArticleClassificationResult {
  return {
    impact_score: c.impact_score,
    urgency: c.urgency,
    direction: c.direction,
    catalyst_type: c.catalyst_type,
    materiality: c.materiality,
    confidence: c.confidence,
    reason: c.reason || null,
    risk_flags: c.risk_flags,
    classifier,
    cached,
  };
}

export async function getOrClassifyArticle(
  articleId: string,
): Promise<ArticleClassificationResult | null> {
  const db = getDb();

  // 1) cached?
  const existing = await db
    .selectFrom('news_classifications')
    .selectAll()
    .where('article_id', '=', articleId)
    .executeTakeFirst();
  if (existing && existing.classifier !== 'rules') {
    // Already refined by an LLM — trust it.
    return toResult(
      {
        impact_score: existing.impact_score,
        direction: existing.direction,
        urgency: existing.urgency,
        catalyst_type: existing.catalyst_type,
        materiality: existing.materiality,
        is_repeat: existing.is_repeat,
        confidence: Number(existing.confidence),
        reason: existing.reason ?? '',
        risk_flags: existing.risk_flags as unknown as string[],
      },
      existing.classifier,
      true,
    );
  }

  // 2) load article + a representative ticker for context
  const article = await db
    .selectFrom('news_articles')
    .select(['id', 'url', 'title', 'source'])
    .where('id', '=', articleId)
    .executeTakeFirst();
  if (!article) return null;

  const link = await db
    .selectFrom('news_ticker_links')
    .select('ticker')
    .where('article_id', '=', articleId)
    .executeTakeFirst();
  const ticker = link?.ticker ?? 'UNKNOWN';

  // 3) try to pull market context from the most recent screener row for this ticker
  const ctx = ticker !== 'UNKNOWN'
    ? await db
        .selectFrom('screener_results')
        .select(['change_pct', 'float_m', 'mcap_m', 'rel_volume', 'country'])
        .where('ticker', '=', ticker)
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst()
    : null;

  const input: ClassifierInput = {
    ticker,
    title: article.title,
    source: article.source,
    marketContext: ctx
      ? {
          change_pct: ctx.change_pct,
          float_m: ctx.float_m,
          mcap_m: ctx.mcap_m,
          rel_volume: ctx.rel_volume,
          country: ctx.country,
        }
      : null,
  };

  // 4) prefer the LLM (Claude Sonnet 4.6); fall back to rule-based on failure.
  const llm = await classifyByClaude(input);
  const result = llm ?? classifyByRules(input);
  const classifier: Classifier = llm ? 'anthropic_sonnet' : 'rules';

  // 5) upsert
  if (existing) {
    await db
      .updateTable('news_classifications')
      .set({
        impact_score: result.impact_score,
        direction: result.direction,
        urgency: result.urgency,
        catalyst_type: result.catalyst_type,
        materiality: result.materiality,
        confidence: result.confidence,
        reason: result.reason,
        risk_flags: JSON.stringify(result.risk_flags) as unknown as never,
        classifier,
        updated_at: new Date(),
      })
      .where('article_id', '=', articleId)
      .execute();
  } else {
    await db
      .insertInto('news_classifications')
      .values({
        article_id: articleId,
        impact_score: result.impact_score,
        direction: result.direction,
        urgency: result.urgency,
        catalyst_type: result.catalyst_type,
        materiality: result.materiality,
        confidence: result.confidence,
        reason: result.reason,
        risk_flags: JSON.stringify(result.risk_flags) as unknown as never,
        classifier,
      })
      .onConflict((oc) => oc.column('article_id').doNothing())
      .execute();
  }

  return toResult(result, classifier, false);
}
