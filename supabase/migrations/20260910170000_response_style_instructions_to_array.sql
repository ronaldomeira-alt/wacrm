-- Turn ai_configs.response_style_instructions from a single free-text blob
-- into a text[] of individual instructions.
--
-- The blob model made "I changed my mind" instructions accumulate as
-- contradicting lines with no way to remove just one without leaving the
-- Playground and hand-editing raw text in the Comportamento tab. Modeling
-- each instruction as its own array element lets the UI render one
-- removable chip per instruction, so undoing/replacing one is a single
-- click in the same place you're testing.

ALTER TABLE ai_configs ADD COLUMN response_style_instructions_new text[];

UPDATE ai_configs
SET response_style_instructions_new = (
  SELECT array_agg(trim(leading '- ' from trim(both from line)))
  FROM unnest(string_to_array(response_style_instructions, E'\n')) AS line
  WHERE trim(both from line) <> ''
)
WHERE response_style_instructions IS NOT NULL
  AND trim(both from response_style_instructions) <> '';

ALTER TABLE ai_configs DROP COLUMN response_style_instructions;
ALTER TABLE ai_configs RENAME COLUMN response_style_instructions_new TO response_style_instructions;
