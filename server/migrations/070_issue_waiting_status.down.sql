-- Revert the `waiting` status: any issue currently in `waiting` is moved back to
-- `backlog` first (else the narrower CHECK would reject it), then the constraint
-- is restored to the original 7-status set.
UPDATE issue SET status = 'backlog' WHERE status = 'waiting';

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_status_check;

ALTER TABLE issue
    ADD CONSTRAINT issue_status_check
    CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review',
                      'done', 'blocked', 'cancelled'));
