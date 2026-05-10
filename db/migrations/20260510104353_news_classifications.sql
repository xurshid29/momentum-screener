-- migrate:up
create table news_classifications (
    article_id uuid primary key references news_articles(id) on delete cascade,
    impact_score integer not null check (impact_score between 0 and 100),
    direction text not null check (direction in ('bullish', 'bearish', 'mixed', 'neutral')),
    urgency text not null check (urgency in ('ignore', 'watch', 'strong', 'major')),
    catalyst_type text not null,
    materiality text not null check (materiality in ('high', 'medium', 'low', 'unknown')),
    is_repeat boolean not null default false,
    confidence numeric(4, 3) not null check (confidence between 0 and 1),
    reason text,
    risk_flags jsonb not null default '[]'::jsonb,
    classifier text not null check (classifier in ('rules', 'openai_nano', 'openai_mini', 'openai')),
    classified_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index news_classifications_score_idx on news_classifications (impact_score desc);

-- migrate:down
drop table if exists news_classifications;
