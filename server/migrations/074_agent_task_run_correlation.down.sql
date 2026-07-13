DROP INDEX IF EXISTS idx_agent_task_queue_effect_id;

ALTER TABLE agent_task_queue
    DROP COLUMN IF EXISTS agent_role,
    DROP COLUMN IF EXISTS binding_generation,
    DROP COLUMN IF EXISTS effect_id;
