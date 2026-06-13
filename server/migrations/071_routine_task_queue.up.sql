-- AITO1 pull-режим (plans/planner-routine-experiment-2026-06-13.md): очередь
-- заданий для агентов-на-рутинах (Claude Desktop под подпиской) вместо push
-- через agent_task_queue (daemon + API). Brain пишет сюда задание «исполни роль
-- X на issue Y»; рутина по cron читает pending, claim'ит (CAS + lease), исполняет
-- роль, постит [PLAN] и закрывает. Отдельная таблица — НЕ смешивать с daemon-push
-- agent_task_queue (её claim'ит daemon).
--
-- Идемпотентна (IF NOT EXISTS) — безопасно re-run.

CREATE TABLE IF NOT EXISTS routine_task_queue (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id     UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    agent_id         UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    issue_id         UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    action           TEXT NOT NULL,                       -- 'plan'
    context          JSONB,                               -- {"case":"fresh|replan|prereq|blocked_answer|grant_replan|resume"}
    status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
    attempt          INT NOT NULL DEFAULT 0,
    max_attempts     INT NOT NULL DEFAULT 3,
    lease_expires_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ
);

-- Dedup: at most one LIVE (pending|claimed) task per (agent, issue, action).
-- Restores the dedup push got for free from the assignee-diff gate; lets Brain's
-- INSERT ... ON CONFLICT DO NOTHING be a no-op against recovery-sweep / catch-up
-- / WS-doubling re-enqueues. A done/failed task does not block a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS routine_task_queue_live
    ON routine_task_queue (agent_id, issue_id, action)
    WHERE status IN ('pending', 'claimed');

-- Claim-candidate scan: pending tasks of a role, FIFO by created_at.
CREATE INDEX IF NOT EXISTS routine_task_queue_claim_scan
    ON routine_task_queue (agent_id, status, created_at);

-- Reclaim scan: claimed tasks whose lease expired (crashed worker).
CREATE INDEX IF NOT EXISTS routine_task_queue_reclaim_scan
    ON routine_task_queue (lease_expires_at)
    WHERE status = 'claimed';
