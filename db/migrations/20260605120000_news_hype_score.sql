-- migrate:up
-- hype_score (0..100): crowd / pump-potential of a headline — "how likely is
-- retail to pile in regardless of substance" — a SEPARATE axis from
-- impact_score (which measures durable-catalyst quality). The STI case (06-04→
-- 05, +700%) motivated this: a buzzword-stuffed (AI / space / LEO data-center)
-- patent-count PR scored LOW on impact_score *correctly* (no named counterparty
-- / $ / contract — it's low-quality promo) yet was a phenomenal momentum
-- catalyst. Low quality + high hype = "catch the pump, flip into strength,
-- don't hold". Nullable: old rows + the SEC/halt deterministic paths leave it
-- null.
alter table news_classifications add column hype_score integer check (hype_score between 0 and 100);

-- migrate:down
alter table news_classifications drop column hype_score;
