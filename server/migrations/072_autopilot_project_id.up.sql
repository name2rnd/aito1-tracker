-- AITO1 task 07b (memory-design/impl/07b-phase-fork-autopilot-project.md):
-- create_issue-автопилоты штампуют созданный issue выбранным проектом, чтобы
-- регулярная работа (Curator/Prospector/Wanderer/Worker) попадала в нужный
-- проект, а не в project=NULL (где status='todo' занимает no-project dispatch-окно
-- и блокирует intake). dispatchCreateIssue берёт ap.project_id вместо хардкода NULL.
--
-- Это ВОЗВРАТ колонки: project_id был на autopilot в 042, снят 058
-- («никогда не был в UI»). Возвращаем вместе с UI-селектором. DDL — зеркало
-- 058_...down.sql. Идемпотентна (IF NOT EXISTS), project опционален (NULL для
-- существующих автопилотов и run_only).

ALTER TABLE autopilot
    ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES project(id) ON DELETE SET NULL;
