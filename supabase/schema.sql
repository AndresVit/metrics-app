CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE definitions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('metric', 'attribute')),
    code TEXT NOT NULL,
    display_name TEXT NOT NULL,
    category TEXT,
    parent_definition_id UUID REFERENCES definitions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, code)
);

CREATE INDEX idx_definitions_user_id ON definitions(user_id);
CREATE INDEX idx_definitions_user_id_type ON definitions(user_id, type);
CREATE INDEX idx_definitions_parent_definition_id ON definitions(parent_definition_id);

CREATE TABLE attribute_definitions (
    definition_id UUID PRIMARY KEY REFERENCES definitions(id) ON DELETE CASCADE,
    datatype TEXT NOT NULL CHECK (datatype IN ('int', 'float', 'string', 'bool', 'timestamp', 'hierarchyString'))
);

CREATE TABLE metric_definitions (
    definition_id UUID PRIMARY KEY REFERENCES definitions(id) ON DELETE CASCADE,
    primary_identifier_field_id UUID
);

CREATE TABLE fields (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    metric_definition_id UUID NOT NULL REFERENCES metric_definitions(definition_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    base_definition_id UUID NOT NULL REFERENCES definitions(id) ON DELETE RESTRICT,
    min_instances INTEGER NOT NULL DEFAULT 0,
    max_instances INTEGER,
    input_mode TEXT NOT NULL CHECK (input_mode IN ('input', 'formula')),
    formula TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (metric_definition_id, name)
);

CREATE INDEX idx_fields_user_id ON fields(user_id);
CREATE INDEX idx_fields_metric_definition_id ON fields(metric_definition_id);
CREATE INDEX idx_fields_base_definition_id ON fields(base_definition_id);

ALTER TABLE metric_definitions
    ADD CONSTRAINT fk_metric_definitions_primary_identifier_field
    FOREIGN KEY (primary_identifier_field_id) REFERENCES fields(id) ON DELETE SET NULL;

CREATE TABLE entries (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    definition_id UUID NOT NULL REFERENCES definitions(id) ON DELETE RESTRICT,
    parent_entry_id BIGINT REFERENCES entries(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    subdivision TEXT,
    comments TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_entries_user_id ON entries(user_id);
CREATE INDEX idx_entries_user_id_timestamp ON entries(user_id, timestamp);
CREATE INDEX idx_entries_user_id_definition_id ON entries(user_id, definition_id);
CREATE INDEX idx_entries_user_id_definition_id_timestamp ON entries(user_id, definition_id, timestamp);
CREATE INDEX idx_entries_parent_entry_id ON entries(parent_entry_id);
CREATE INDEX idx_entries_definition_id ON entries(definition_id);

CREATE TABLE metric_entries (
    entry_id BIGINT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE
);

CREATE TABLE attribute_entries (
    entry_id BIGINT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    field_id UUID NOT NULL REFERENCES fields(id) ON DELETE RESTRICT,
    value_int INTEGER,
    value_float DOUBLE PRECISION,
    value_string TEXT,
    value_bool BOOLEAN,
    value_timestamp TIMESTAMPTZ,
    value_hierarchy TEXT
);

CREATE INDEX idx_attribute_entries_field_id ON attribute_entries(field_id);

ALTER TABLE definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribute_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribute_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own definitions"
    ON definitions FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view attribute_definitions for their definitions"
    ON attribute_definitions FOR ALL
    USING (EXISTS (SELECT 1 FROM definitions WHERE definitions.id = attribute_definitions.definition_id AND definitions.user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM definitions WHERE definitions.id = attribute_definitions.definition_id AND definitions.user_id = auth.uid()));

CREATE POLICY "Users can view metric_definitions for their definitions"
    ON metric_definitions FOR ALL
    USING (EXISTS (SELECT 1 FROM definitions WHERE definitions.id = metric_definitions.definition_id AND definitions.user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM definitions WHERE definitions.id = metric_definitions.definition_id AND definitions.user_id = auth.uid()));

CREATE POLICY "Users can manage their own fields"
    ON fields FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage their own entries"
    ON entries FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view metric_entries for their entries"
    ON metric_entries FOR ALL
    USING (EXISTS (SELECT 1 FROM entries WHERE entries.id = metric_entries.entry_id AND entries.user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM entries WHERE entries.id = metric_entries.entry_id AND entries.user_id = auth.uid()));

CREATE POLICY "Users can view attribute_entries for their entries"
    ON attribute_entries FOR ALL
    USING (EXISTS (SELECT 1 FROM entries WHERE entries.id = attribute_entries.entry_id AND entries.user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM entries WHERE entries.id = attribute_entries.entry_id AND entries.user_id = auth.uid()));
