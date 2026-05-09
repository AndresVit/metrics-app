-- Migration: Add search key support to entries table
--
-- Adds a search_key_value column for metrics that declare a @key field.
-- Enforces uniqueness per (user_id, definition_id, search_key_value) when set.
--
-- Run this after schema.sql.

-- Add search_key_value column (nullable - only set for metrics with a search key)
ALTER TABLE entries ADD COLUMN search_key_value TEXT;

-- Unique index: prevents duplicate search key values for the same metric + user.
-- Partial index (WHERE search_key_value IS NOT NULL) so entries without keys are unaffected.
CREATE UNIQUE INDEX idx_entries_search_key_unique
  ON entries (user_id, definition_id, search_key_value)
  WHERE search_key_value IS NOT NULL;

-- Lookup index: fast resolution of references by search key value
CREATE INDEX idx_entries_search_key_lookup
  ON entries (user_id, definition_id, search_key_value)
  WHERE search_key_value IS NOT NULL;
