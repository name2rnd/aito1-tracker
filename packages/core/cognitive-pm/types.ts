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

export interface Decision {
  id: string;
  contour: string;
  rationale: string;
  expected_artifact: string;
  expected_predicate: string;
  confidence: number | null;
  expected_by: string | null;
  match_key: string | null;
  decided_at: string;
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
