-- Dashboards table for organizing widgets
-- Run this migration in Supabase SQL Editor

CREATE TABLE dashboards (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

CREATE INDEX idx_dashboards_user_id ON dashboards(user_id);

-- Enable RLS
ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can manage their own dashboards
CREATE POLICY "Users can manage their own dashboards"
    ON dashboards FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
