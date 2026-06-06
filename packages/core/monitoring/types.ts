// Monitoring observability surface. Mirrors the Brain response models in
// brain/api/monitoring.py (aito1-tracker fork ⟷ aito1-brain), reached via the
// same-origin BFF proxy at /api/monitoring/*.

export interface ReturnedFact {
  id: string;
  alias: string | null;
  value: string | null;
}

export interface FactQueryRow {
  id: string;
  query_text: string;
  role: string | null;
  issue_id: string | null;
  /** len(returned_fact_ids) — how many facts this query surfaced. */
  returned_count: number;
  /** the surfaced facts, resolved to id/alias/value (expand-on-click). */
  returned_facts: ReturnedFact[];
  /** non-null when the agent then on-demand-pulled a specific fact. */
  pulled_fact_id: string | null;
  created_at: string;
}

export interface FactQueriesResponse {
  total: number;
  items: FactQueryRow[];
}

export interface TaskClassRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  last_episode_at: string | null;
  episode_count: number;
}

export interface TaskClassesResponse {
  total: number;
  items: TaskClassRow[];
}

export interface FactRow {
  id: string;
  alias: string;
  value: string;
  source: string;
  reference_count: number;
  pull_count: number;
  /** reference_count + pull_count — how often the fact was used. */
  uses: number;
  active: boolean;
  last_used: string | null;
  created_at: string;
}

export interface FactsResponse {
  total: number;
  items: FactRow[];
}

export interface RuleRow {
  id: string;
  agent_name: string;
  kind: string;
  status: string;
  content_text: string | null;
  trigger: string | null;
  antipattern: string | null;
  why_bad: string | null;
  do_instead: string | null;
  applicability_hint: string | null;
  class_id: string | null;
  class_name: string | null;
  /** times surfaced in recall. */
  applied_count: number;
  /** times the episode that used it got 👍. */
  approved_count: number;
  decay_score: number;
  last_confirmed_at: string | null;
  added_at: string;
}

export interface RulesResponse {
  total: number;
  items: RuleRow[];
}

export interface TemplateRow {
  id: string;
  class_id: string | null;
  class_name: string | null;
  /** the markdown skeleton with {placeholder} slots. */
  content_md: string;
  status: string;
  /** times cited in a plan. */
  applied_count: number;
  /** times the citing episode closed done (AITO-268). */
  approved_count: number;
  /** exemplar episode the skeleton was generalized from. */
  source_episode_id: string | null;
  source_issue_id: string | null;
  /** episode on whose reflection the template was created. */
  reflection_episode_id: string | null;
  reflection_issue_id: string | null;
  created_at: string;
  last_used_at: string | null;
  last_confirmed_at: string | null;
}

export interface TemplatesResponse {
  total: number;
  items: TemplateRow[];
}

export interface KnowledgeRow {
  id: string;
  name: string;
  /** markdown body distilled from sources. */
  schema_md: string;
  source_count: number;
  version: number;
  status: string;
  is_revision: boolean;
  created_at: string;
  updated_at: string;
}

export interface KnowledgesResponse {
  total: number;
  items: KnowledgeRow[];
}

export interface DiaryRow {
  id: string;
  session_id: string | null;
  kind: string;
  title: string | null;
  /** free-form note body (markdown), revealed on click. */
  body: string;
  threads: unknown[];
  /** 1..5 — how interesting the Wanderer found the moment. */
  interestingness: number;
  shared_to_tg: boolean;
  created_at: string;
}

export interface DiaryResponse {
  total: number;
  items: DiaryRow[];
}
