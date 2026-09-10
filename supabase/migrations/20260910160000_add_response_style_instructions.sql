-- Free-text field for incremental style/formatting instructions the admin
-- tunes while testing in the Playground (e.g. "respostas de no máximo 2
-- frases", "sempre termine com uma pergunta"). Kept separate from
-- global_never_rules, which is specifically for hard prohibitions, so the
-- two concerns (what to never do vs. how to phrase things) don't get
-- mixed into one free-text box.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS response_style_instructions text;
