# Project Rules (Claude Code)

These rules are mandatory for all implementation work in this repository.

## 1. Source of Truth
- The official specification is in `docs/*.md` (architecture, db-schema, formulas, decisions, rules).
- Do not redesign the data model or DSL.
- If something is unclear or missing, ask before implementing assumptions.

## 2. No Invention
- Do not invent new tables, new concepts, or new pipeline steps unless explicitly requested.
- Prefer minimal, consistent solutions aligned with the docs.

## 3. MVP-First
- Implement the MVP scope only.
- If a feature is listed as "Extension" in `docs/formulas.md` or other docs, do not implement it unless explicitly requested.

## 4. Small, Testable Increments
- Work in small tasks (30–90 minutes of work).
- Each task must include:
	- objective
	- acceptance criteria
	- files changed
	- how to test locally

## 5. Keep the Repo Updated
- After any implemented feature, update `progress.md`:
	- what was implemented
	- what remains
	- next steps

## 6. Consistency Constraints
- User scoping must be enforced:
	- definitions, fields, entries are user-owned
	- foreign keys must not mix users
- Do not bypass these constraints “for convenience”.

## 7. Supabase Constraints
- Use Supabase Auth for user identity.
- Use Row Level Security (RLS) early (even basic).
- Do not expose service-role keys in the frontend.

## 8. Coding Style
- Keep code simple, readable, and documented.
- Avoid unnecessary dependencies.
- Prefer explicitness over cleverness.

---
End of rules.