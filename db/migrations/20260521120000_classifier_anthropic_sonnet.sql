-- migrate:up

-- Allow 'anthropic_sonnet' as a classifier — the catalyst classifier moved
-- off OpenAI to Anthropic Claude Sonnet 4.6 (see services/catalyst-claude.ts).
-- The OpenAI values stay valid so historical rows remain queryable.
alter table news_classifications
    drop constraint news_classifications_classifier_check;

alter table news_classifications
    add constraint news_classifications_classifier_check
    check (classifier in ('rules', 'openai_nano', 'openai_mini', 'openai', 'anthropic_sonnet'));

-- migrate:down
alter table news_classifications
    drop constraint news_classifications_classifier_check;

alter table news_classifications
    add constraint news_classifications_classifier_check
    check (classifier in ('rules', 'openai_nano', 'openai_mini', 'openai'));
