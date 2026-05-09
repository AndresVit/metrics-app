-- Migration: Add description and display_name columns for the Definitions Editor UI
-- Run this before using the /api/schema/definitions endpoints.

ALTER TABLE definitions ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE fields ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE fields ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
