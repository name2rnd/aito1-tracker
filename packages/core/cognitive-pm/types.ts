// Cognitive-PM cockpit types — mirror Brain's /api/pm/* response shapes
// (brain/api/pm.py). Read-only surface for the project view.

export interface Goal {
  id: string;
  project_id: string;
  goal_text: string;
  criteria_y: string;
  deadline_z: string;
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
