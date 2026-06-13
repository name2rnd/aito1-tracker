-- AITO1 pull-режим: очередь заданий для агентов-на-рутинах.
-- plans/planner-routine-experiment-2026-06-13.md.

-- name: EnqueueRoutineTask :execrows
-- Idempotent enqueue: the partial-unique index (agent_id, issue_id, action)
-- WHERE status IN ('pending','claimed') makes a re-enqueue from recovery-sweep /
-- catch-up / WS-doubling a no-op (0 rows). 1 row = newly queued.
INSERT INTO routine_task_queue (workspace_id, agent_id, issue_id, action, context, max_attempts)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (agent_id, issue_id, action) WHERE status IN ('pending', 'claimed')
DO NOTHING;

-- name: ListPendingRoutineTasks :many
-- A role's pending tasks, FIFO by created_at. The routine GETs this, then
-- claims each (CAS) up to its batch size.
SELECT * FROM routine_task_queue
WHERE agent_id = $1 AND status = 'pending'
ORDER BY created_at
LIMIT $2;

-- name: GetRoutineTask :one
SELECT * FROM routine_task_queue WHERE id = $1;

-- name: ClaimRoutineTask :one
-- Atomic compare-and-swap claim: only a still-`pending` row flips to `claimed`.
-- Two concurrent claims of the same task → exactly one RETURNs a row, the other
-- gets no rows (handler responds 409). Sets a lease so a crashed worker's task
-- can be reclaimed; bumps attempt for the dead-letter cap.
UPDATE routine_task_queue
SET status = 'claimed',
    claimed_at = now(),
    lease_expires_at = now() + make_interval(secs => @lease_secs::int),
    attempt = attempt + 1
WHERE id = @id AND status = 'pending'
RETURNING *;

-- name: SetRoutineTaskStatus :exec
-- Routine marks its own task done/failed by id.
UPDATE routine_task_queue
SET status = @status, completed_at = now()
WHERE id = @id;

-- name: CompleteRoutineTaskByIssue :execrows
-- Brain closes the task by the fact of the [PLAN] comment (it observes the
-- marker), so a routine crash AFTER posting [PLAN] but BEFORE its own mark-done
-- leaves no live task to re-execute.
UPDATE routine_task_queue
SET status = 'done', completed_at = now()
WHERE agent_id = $1 AND issue_id = $2 AND action = $3
  AND status IN ('pending', 'claimed');

-- name: ReclaimStaleRoutineTasks :many
-- Second channel (invariant 5) for the pull queue: a claimed task whose lease
-- expired (worker crashed before [PLAN]) is returned to pending for retry, or
-- moved to failed once attempts are exhausted (dead-letter → Brain alerts).
UPDATE routine_task_queue
SET status = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'pending' END,
    lease_expires_at = NULL,
    claimed_at = CASE WHEN attempt >= max_attempts THEN claimed_at ELSE NULL END,
    completed_at = CASE WHEN attempt >= max_attempts THEN now() ELSE NULL END
WHERE status = 'claimed' AND lease_expires_at < now()
RETURNING id, issue_id, agent_id, action, status, attempt, max_attempts;

-- name: CountStalePendingRoutineTasks :one
-- Watchdog: pending tasks older than a threshold (a missed routine window).
SELECT count(*)::int FROM routine_task_queue
WHERE status = 'pending'
  AND created_at < now() - make_interval(secs => @older_than_secs::int);

-- name: ListLiveRoutineTasks :many
-- Rollback drain: every live (pending|claimed) task of a role, to re-trigger via
-- push when pull_mode is turned off.
SELECT * FROM routine_task_queue
WHERE agent_id = $1 AND status IN ('pending', 'claimed')
ORDER BY created_at;
