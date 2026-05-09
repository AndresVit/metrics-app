-- Widget v2: add 'V2' value to widget_type enum
-- This replaces the placeholder 'KPI' type used for v2 widgets.
-- Run after widgets_phase2.sql and widgets_v2.sql.

ALTER TYPE widget_type ADD VALUE IF NOT EXISTS 'V2';

-- Back-fill existing v2 widgets that were stored with type='KPI' as placeholder
UPDATE widgets
SET type = 'V2'
WHERE dsl_version = 'v2' AND type = 'KPI';
