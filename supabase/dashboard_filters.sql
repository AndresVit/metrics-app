-- Dashboard global filters + entry tags
-- Run this migration in Supabase SQL Editor

-- ─────────────────────────────────────────────────────────────
-- 1. Add global_filters JSONB column to dashboards
-- ─────────────────────────────────────────────────────────────
-- Stores a DashboardGlobalFilter object (nullable = no filter active).
-- Shape: {
--   includeDefinitionCodes?: string[],
--   excludeDefinitionCodes?: string[],
--   subdivisionContains?: string,
--   subdivisionExcludes?: string,
--   weekdays?: number[],          -- 0=Sun…6=Sat, analytical (05:00 boundary)
--   tagFilters?: Array<{ key: string, value?: string }>
-- }

ALTER TABLE dashboards
  ADD COLUMN IF NOT EXISTS global_filters JSONB;

-- ─────────────────────────────────────────────────────────────
-- 2. Entry tags table
-- ─────────────────────────────────────────────────────────────
-- Stores arbitrary key/value tags on entries.
-- value is nullable — a tag can be a bare key with no value.
-- Primary key is (entry_id, key) so each entry can have at most one value
-- per key.

CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id  BIGINT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    key       TEXT   NOT NULL,
    value     TEXT,
    PRIMARY KEY (entry_id, key)
);

CREATE INDEX IF NOT EXISTS idx_entry_tags_entry_id ON entry_tags(entry_id);

-- RLS
ALTER TABLE entry_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own entry tags"
    ON entry_tags FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM entries
            WHERE entries.id = entry_tags.entry_id
              AND entries.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM entries
            WHERE entries.id = entry_tags.entry_id
              AND entries.user_id = auth.uid()
        )
    );
