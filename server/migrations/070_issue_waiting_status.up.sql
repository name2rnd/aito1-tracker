-- Add the 8th issue status `waiting`: a parent issue parked while its subtasks
-- run, and a manual-pause state. Not counted in Manager's WIP window and never
-- enqueues an agent (server shouldEnqueueAgentTask). plans/subtask-system-2026-06-02.md.
--
-- The original CHECK from 001_init is an inline column constraint whose name is
-- Postgres-generated (typically issue_status_check). Resolve it dynamically so
-- this migration is robust to the actual name, then re-add a named constraint
-- that includes `waiting`. Idempotent: drops whatever status CHECK exists, adds
-- the canonical one.
DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
      FROM pg_constraint
     WHERE conrelid = 'issue'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%backlog%';
    IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE issue DROP CONSTRAINT %I', cname);
    END IF;
END $$;

ALTER TABLE issue
    ADD CONSTRAINT issue_status_check
    CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review',
                      'done', 'blocked', 'cancelled', 'waiting'));
