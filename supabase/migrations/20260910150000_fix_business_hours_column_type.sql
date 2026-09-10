-- Fix type mismatch on ai_configs.business_hours_start/end.
--
-- Migration 085_property_ai_context.sql added these as `integer` (hour of
-- day, e.g. 8), but every consumer — the config API route, the AiConfig
-- TypeScript type, business-hours.ts (`startHour.split(':')`), and the
-- settings form (`<input type="time">`) — reads/writes them as "HH:MM"
-- strings. Writing a string into the integer column fails outright, and
-- reading an integer back into code that expects a string throws a
-- TypeError in getBusinessHoursContext() for any account with these fields
-- already set. Converting to text aligns the column with every caller
-- instead of the other way around, since 3 of 4 call sites already assume
-- a string.

ALTER TABLE ai_configs
  ALTER COLUMN business_hours_start TYPE text USING lpad(business_hours_start::text, 2, '0') || ':00',
  ALTER COLUMN business_hours_end TYPE text USING lpad(business_hours_end::text, 2, '0') || ':00';

ALTER TABLE ai_configs ALTER COLUMN business_hours_start SET DEFAULT '08:00';
ALTER TABLE ai_configs ALTER COLUMN business_hours_end SET DEFAULT '18:00';
