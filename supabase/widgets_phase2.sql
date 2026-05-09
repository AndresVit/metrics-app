-- Phase 2: Add dashboard_id, type, and order_index to widgets
-- Run this migration AFTER dashboards.sql

-- Add widget type enum
CREATE TYPE widget_type AS ENUM ('KPI', 'TABLE', 'CHART');

-- Add new columns to widgets table
ALTER TABLE widgets
    ADD COLUMN dashboard_id UUID REFERENCES dashboards(id) ON DELETE CASCADE,
    ADD COLUMN type widget_type NOT NULL DEFAULT 'KPI',
    ADD COLUMN order_index INT NOT NULL DEFAULT 0;

-- Create index for dashboard lookups
CREATE INDEX idx_widgets_dashboard_id ON widgets(dashboard_id);

-- Remove the old unique constraint on (user_id, name)
ALTER TABLE widgets DROP CONSTRAINT IF EXISTS widgets_user_id_name_key;

-- Add new unique constraint: name must be unique within a dashboard
ALTER TABLE widgets ADD CONSTRAINT widgets_dashboard_name_key UNIQUE (dashboard_id, name);
