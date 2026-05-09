-- Widget v2: add dsl_version column
-- The DSL is the source of truth; this column makes the version explicit
-- so routing code never needs to parse the DSL.
--
-- Values:
--   'v1' — legacy uppercase DSL (WIDGET "name" TYPE ...)
--   'v2' — new lowercase DSL    (widget "name" { ... })

ALTER TABLE widgets
  ADD COLUMN IF NOT EXISTS dsl_version TEXT NOT NULL DEFAULT 'v1';

-- Back-fill existing widgets that look like v2 DSL
UPDATE widgets
SET dsl_version = 'v2'
WHERE dsl ~* '^widget\s+"[^"]+"\s*\{';
