TFG Project: web application for tracking customizable metrics and calculating daily KPIs. The goal is to allow each user to define their own schema (Definitions/Fields) and record Entries (metrics and attributes) via quick input. The system includes a formula language to compute derived fields and a deterministic pipeline to create and validate entries before persisting them.

Repository structure:
- docs/architecture.md: conceptual architecture, class model, and pipeline
- docs/db-schema.md: database schema (Postgres/Supabase)
- docs/formulas.md: formula language specification
- docs/decisions.md: design decisions and rationale
- docs/rules.md: project rules (to be followed strictly)
- progress.md: project status and next work items

Target stack: React + Supabase (PostgreSQL + Auth). Priority: development speed and architectural consistency.