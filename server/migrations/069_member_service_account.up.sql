-- Service-account flag on member: when true, this member's comments do NOT
-- trigger on_comment-tasks for the issue's agent-assignee. Used by Brain's
-- Teamlead member to post `✅ Auto-approved` after assign(Executor) without
-- causing a duplicate Executor-task.
--
-- Idempotent (IF NOT EXISTS) — safe to re-run on existing installations.

ALTER TABLE member
    ADD COLUMN IF NOT EXISTS is_service_account BOOLEAN NOT NULL DEFAULT FALSE;
