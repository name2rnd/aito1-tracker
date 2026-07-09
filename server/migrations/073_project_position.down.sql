DROP INDEX IF EXISTS idx_project_workspace_position;
ALTER TABLE project DROP CONSTRAINT IF EXISTS project_workspace_position_unique;
ALTER TABLE project DROP COLUMN IF EXISTS position;
