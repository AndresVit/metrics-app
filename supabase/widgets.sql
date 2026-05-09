-- Widgets table for persisting widget definitions
-- Run this migration in Supabase SQL Editor

CREATE TABLE widgets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    dsl TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

CREATE INDEX idx_widgets_user_id ON widgets(user_id);

-- Enable RLS
ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can manage their own widgets
CREATE POLICY "Users can manage their own widgets"
    ON widgets FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- For MVP/development: Allow service role full access
-- (This is handled automatically by Supabase service role key)
