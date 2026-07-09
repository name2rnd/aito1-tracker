ALTER TABLE project ADD COLUMN position INTEGER;

WITH ranked AS (
    SELECT
        id,
        row_number() OVER (PARTITION BY workspace_id ORDER BY created_at ASC, id ASC)::integer AS position
    FROM project
)
UPDATE project
SET position = ranked.position
FROM ranked
WHERE project.id = ranked.id;

ALTER TABLE project ALTER COLUMN position SET NOT NULL;

ALTER TABLE project
    ADD CONSTRAINT project_workspace_position_unique
    UNIQUE (workspace_id, position)
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_project_workspace_position ON project(workspace_id, position);
