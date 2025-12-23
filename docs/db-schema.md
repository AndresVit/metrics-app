# Database Schema

PostgreSQL via Supabase. Each user owns their own schema (definitions and fields) and their own data (entries).

## users
Managed by Supabase Auth.

Fields:
- id: UUID (primary key)
- email: TEXT
- other auth-related fields

## definitions
Stores all definitions (metrics and attributes).

Fields:
- id: TEXT (primary key)
- user_id: UUID (foreign key → users.id)
- type: TEXT (metric | attribute)
- code: TEXT
- display_name: TEXT
- category: TEXT (HierarchyString)
- parent_definition_id: TEXT (nullable, FK → definitions.id)

Constraints:
- (user_id, code) UNIQUE

## attribute_definitions
Extends definitions when type = attribute.

Fields:
- definition_id: TEXT (primary key, FK → definitions.id)
- datatype: TEXT (int | float | string | bool | timestamp | hierarchyString)

## metric_definitions
Extends definitions when type = metric.

Fields:
- definition_id: TEXT (primary key, FK → definitions.id)
- primary_identifier_field_id: TEXT (FK → fields.id, nullable until fields are created)

The primary identifier field must have input_mode = input, datatype = string or int, and cardinality exactly 1.

## fields
Represents fields inside a MetricDefinition.

Fields:
- id: TEXT (primary key)
- user_id: UUID (FK → users.id)
- metric_definition_id: TEXT (FK → metric_definitions.definition_id)
- name: TEXT
- base_definition_id: TEXT (FK → definitions.id)
- min_instances: INTEGER
- max_instances: INTEGER (nullable; NULL means unlimited)
- input_mode: TEXT (input | formula)
- formula: TEXT (nullable)

Constraints:
- (metric_definition_id, name) UNIQUE
- user_id must match metric_definition.user_id and base_definition.user_id

## entries
Base table for all data instances.

Fields:
- id: BIGSERIAL (primary key)
- user_id: UUID (FK → users.id)
- definition_id: TEXT (FK → definitions.id)
- parent_entry_id: BIGINT (nullable, FK → entries.id)
- timestamp: TIMESTAMP
- subdivision: TEXT (HierarchyString)
- comments: TEXT

Constraints:
- entry.user_id must match definition.user_id

## metric_entries
Specialization of entries for metric instances.

Fields:
- entry_id: BIGINT (primary key, FK → entries.id)

## attribute_entries
Specialization of entries for attribute values.

Fields:
- entry_id: BIGINT (primary key, FK → entries.id)
- field_id: TEXT NOT NULL (FK → fields.id)

Typed value columns (only one is used per row):
- value_int: INTEGER (nullable)
- value_float: FLOAT (nullable)
- value_string: TEXT (nullable)
- value_bool: BOOLEAN (nullable)
- value_timestamp: TIMESTAMP (nullable)
- value_hierarchy: TEXT (nullable)

Constraints:
- attribute_entries.field_id.user_id = entries.user_id

## Recommended Indexes
- entries(user_id, timestamp)
- entries(user_id, definition_id, timestamp)
- definitions(user_id, type)
- fields(metric_definition_id)
- attribute_entries(field_id)