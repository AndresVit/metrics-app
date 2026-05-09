-- Remove v1 widget schema artifacts.
-- All widgets are now v2; dsl_version and widget_type columns are no longer used.

ALTER TABLE widgets DROP COLUMN IF EXISTS dsl_version;
ALTER TABLE widgets DROP COLUMN IF EXISTS type;

-- Drop the enum type (safe once the column referencing it is gone)
DROP TYPE IF EXISTS widget_type;
