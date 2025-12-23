Status: initial (repository and base documentation created).

## Progress

### Completed
- `docs/` structure created: architecture.md, db-schema.md, formulas.md, decisions.md
- Architecture and domain model frozen
- Formula language (MVP) defined
- Tag model finalized (tags implemented as Fields)
- Supabase database schema finalized
- Documentation updated to reflect final decisions

### In progress
- TypeScript domain models

### Next steps
- Implement Entry creation pipeline (populateFromSubdivision, convertToInstances, applyFormulas, validateCardinalities)
- Implement formula engine (MVP limitations)
- Expose minimal API layer
- Build initial React UI
