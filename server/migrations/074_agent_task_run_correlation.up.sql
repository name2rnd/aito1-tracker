-- Stable Brain effect correlation for daemon task runs. Legacy and non-AITO1
-- rows keep all three columns NULL, so the existing queue behavior is unchanged.

ALTER TABLE agent_task_queue
    ADD COLUMN IF NOT EXISTS effect_id TEXT,
    ADD COLUMN IF NOT EXISTS binding_generation INTEGER,
    ADD COLUMN IF NOT EXISTS agent_role TEXT;

-- effect_id is the primary key of Brain's durable FSM effect. Making it the
-- global correlation key rejects a replay that tries to change generation or
-- role instead of treating the mismatched tuple as a different run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_task_queue_effect_id
    ON agent_task_queue (effect_id)
    WHERE effect_id IS NOT NULL;
