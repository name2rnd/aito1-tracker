// Cognitive-PM cockpit types — mirror Brain's /api/pm/* response shapes
// (brain/api/pm.py). Read-only surface for the project view.

// Чекпоинт — недельная декомпозиция ближайшей вехи Трекера (хранится у нас). Личной
// цели у двойника нет: цель = закрыть вехи в Трекере в срок. milestone_key — веха Трекера.
export interface Checkpoint {
  id: string;
  milestone_key: string;
  title: string;
  target_date: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Commitment {
  id: string;
  debtor: string;
  creditor: string;
  condition_text: string;
  deadline: string | null;
  state: string;
  valid_at: string;
  source_type: string;
  source_ref: string;
  trust: string;
}

// Machine-readable provenance решения (mvp.md §5.4): полный id источника + выдержка.
export interface InfoBasisRef {
  source_type: string; // tracker_comment | meeting_chunk | mail | fact | decision | mem | owner_comment
  ref: string; // полный id
  excerpt?: string;
}

// Отвергнутый вариант — против самооправдания в ревью (план §2 п.1).
export interface DecisionAlternative {
  option: string;
  why_rejected: string;
}

export interface Decision {
  id: string;
  contour: string;
  rationale: string;
  expected_artifact: string;
  expected_predicate: string;
  confidence: number | null;
  expected_by: string | null;
  match_key: string | null;
  decision_type: string | null;
  task_id: string | null; // трейс running-прогона PM (Brain autofill)
  info_basis_refs: InfoBasisRef[];
  alternatives: DecisionAlternative[];
  decided_at: string;
}

// Закрытое решение (GET /pm/decisions/{pid}/resolved) — витрина тренера:
// rationale → expected vs outcome → brier/severity/process_verdict (ResolvedDecisionOut).
export interface ResolvedDecision {
  id: string;
  contour: string;
  rationale: string;
  info_basis: string | null;
  expected_artifact: string;
  expected_predicate: string;
  confidence: number | null;
  outcome: string | null;
  outcome_kind: "correct" | "error" | "partial" | "unknown" | "no_response" | null;
  lesson_text: string | null;
  decision_type: string | null;
  task_id: string | null;
  info_basis_refs: InfoBasisRef[];
  alternatives: DecisionAlternative[];
  brier: number | null;
  severity: number | null;
  process_verdict: "sound" | "flawed" | null;
  resolved_by: "pm" | "cr" | "brain" | "owner" | null;
  decided_at: string;
  resolved_at: string | null;
}

// Урок CR (GET /pm/lessons/{pid}) — LessonOut.
export interface Lesson {
  id: string;
  lesson_text: string;
  cause: string | null;
  proposed_fix: string | null;
  status: "active" | "quarantined" | "retired";
  type: "directive" | "procedure_patch" | "case_note" | "preference";
  trigger_condition: string | null;
  scope_in: string[];
  scope_out: string[];
  check_predicate: string | null;
  source: "trainer_feedback" | "outcome_check" | "cr_inference";
  external_id: string | null;
  helpful_count: number;
  harmful_count: number;
  source_decision_id: string | null;
  approved_at: string | null;
  retired_at: string | null;
  created_at: string;
}

// Дельта-лог обучения урока (GET /pm/lesson-events/{lesson_id}) — LessonEventOut:
// какой урок, ЧТО изменил, КУДА встроено.
export interface LessonEvent {
  id: string;
  op: string; // add | approve | reject | embed | check | deprecate | supersede
  actor: "pm" | "cr" | "owner" | "brain";
  embedded_into: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

// Строка калибровочной кривой (GET /pm/calibration/{pid}) — CalibrationOut.
// bucket = width_bucket(confidence, 0, 100, 10): бакет N покрывает [(N-1)*10, N*10)%.
export interface CalibrationRow {
  decision_type: string | null; // NULL — исторические решения без типа
  bucket: number;
  n: number;
  hit_rate: number | null;
  brier: number | null;
}

// HITL: a task PM/CR put on the owner. Volatile triage (status / assignee /
// owner comments) is read live from multica by Brain — verdict is derived there.
export interface OwnerTaskComment {
  content: string;
  created_at: string | null;
}

export interface OwnerTaskTriage {
  decision_id: string | null; // source = PM decision …
  lesson_id: string | null; // … or CR lesson (exactly one set)
  kind: "action" | "milestone_close" | "project_update" | "replan"; // тип поручения
  issue_id: string;
  issue_key: string | null;
  title: string; // what PM/CR proposed (immutable)
  status: string;
  assignee_kind: "owner" | "agent" | "other" | "unassigned";
  verdict: "pending" | "approved" | "rejected" | "closed_by_owner";
  owner_comments: OwnerTaskComment[];
  created_at: string;
}
