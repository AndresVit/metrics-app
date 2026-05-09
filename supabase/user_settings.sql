-- User settings: per-user UI/display configuration.
-- Run this migration in the Supabase SQL Editor.
--
-- time_tags JSONB shape:
--   [
--     { "letter": "t", "name": "Productive", "description": "Focused work", "color": "#b8e6c8", "position": 0 },
--     ...   (1-6 entries; letters are single a-z)
--   ]
--
-- category_colors JSONB shape:
--   { "productive": "#b8e6c8", "maintenance": "#fde68a", ... }
--   Keys are top-level category strings; sub-paths (e.g. "productive/uni") inherit at render time.

CREATE TABLE IF NOT EXISTS user_settings (
    user_id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    time_tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
    category_colors  JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own settings"
    ON user_settings FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
