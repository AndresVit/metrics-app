-- Remove search key from EST definition (project field should not be a key)
UPDATE metric_definitions md
SET primary_identifier_field_id = NULL
FROM definitions d
WHERE md.definition_id = d.id
  AND d.code = 'est';
