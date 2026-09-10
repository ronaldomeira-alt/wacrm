-- Second level of response-style instructions: per-property, on top of the
-- global list already in ai_configs.response_style_instructions.
--
-- Same array-of-instructions shape as ai_configs (one instruction per
-- element, individually addressable), stored alongside subjective_knowledge
-- on property_ai_contexts so it follows the same isolation and save path as
-- the rest of a property's AI context.

ALTER TABLE property_ai_contexts
  ADD COLUMN IF NOT EXISTS response_style_instructions text[];
