import { queryOptions } from "@tanstack/react-query";
import type {
  AdviceResponse,
  DiaryResponse,
  EpisodesResponse,
  FactQueriesResponse,
  FactsResponse,
  KnowledgesResponse,
  MaintenanceProposalDetail,
  MaintenanceResponse,
  MannersResponse,
  RulesResponse,
  TaskClassesResponse,
  TemplatesResponse,
} from "./types";

export type FactSource = "human" | "planner" | "executor" | "brain";
export type KnowledgeSort = "created" | "cited";

// Monitoring data comes from Brain (it owns the aito1_* tables), reached
// through a same-origin Next.js BFF proxy — NOT the Go ApiClient. The BFF
// gates on the multica session cookie and forwards to Brain server-side, so
// these are plain relative fetches.
//
// Base is /bff/ — NOT /api/ — because next.config rewrites all of /api/* to
// the Go backend, which would never reach our route handler.
const BFF_BASE = "/bff/monitoring";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BFF_BASE}${path}`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`monitoring ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const monitoringKeys = {
  all: ["monitoring"] as const,
  factQueries: (limit: number) =>
    ["monitoring", "fact-queries", limit] as const,
  classes: (limit: number) => ["monitoring", "classes", limit] as const,
  facts: (limit: number, source: FactSource | null) =>
    ["monitoring", "facts", limit, source] as const,
  rules: (limit: number) => ["monitoring", "rules", limit] as const,
  advice: (limit: number) => ["monitoring", "advice", limit] as const,
  manners: () => ["monitoring", "manners"] as const,
  templates: (limit: number) => ["monitoring", "templates", limit] as const,
  knowledges: (limit: number, skillOnly: boolean, sort: KnowledgeSort) =>
    ["monitoring", "knowledges", limit, skillOnly, sort] as const,
  diary: (limit: number) => ["monitoring", "diary", limit] as const,
  episodes: (limit: number) => ["monitoring", "episodes", limit] as const,
  maintenance: (limit: number) =>
    ["monitoring", "maintenance", limit] as const,
  maintenanceDetail: (id: string) =>
    ["monitoring", "maintenance", "detail", id] as const,
};

export function factQueriesOptions(limit = 100) {
  return queryOptions({
    queryKey: monitoringKeys.factQueries(limit),
    queryFn: () =>
      getJson<FactQueriesResponse>(`/fact-queries?limit=${limit}`),
    staleTime: 30_000,
  });
}

export function classesOptions(limit = 200) {
  return queryOptions({
    queryKey: monitoringKeys.classes(limit),
    queryFn: () => getJson<TaskClassesResponse>(`/classes?limit=${limit}`),
    staleTime: 30_000,
  });
}

export function factsOptions(limit = 200, source: FactSource | null = null) {
  const q = source ? `&source=${source}` : "";
  return queryOptions({
    queryKey: monitoringKeys.facts(limit, source),
    queryFn: () => getJson<FactsResponse>(`/facts?limit=${limit}${q}`),
    staleTime: 30_000,
  });
}

export function rulesOptions(limit = 200) {
  return queryOptions({
    queryKey: monitoringKeys.rules(limit),
    queryFn: () => getJson<RulesResponse>(`/rules?limit=${limit}`),
    staleTime: 30_000,
  });
}

export function adviceOptions(limit = 200) {
  return queryOptions({
    queryKey: monitoringKeys.advice(limit),
    queryFn: () => getJson<AdviceResponse>(`/advice?limit=${limit}`),
    staleTime: 30_000,
  });
}

// One unpaginated payload: the global-rule pool is small by construction and
// candidates are capped server-side (?candidates_limit, default 50).
export function mannersOptions() {
  return queryOptions({
    queryKey: monitoringKeys.manners(),
    queryFn: () => getJson<MannersResponse>(`/manners`),
    staleTime: 30_000,
  });
}

export function templatesOptions(limit = 200) {
  return queryOptions({
    queryKey: monitoringKeys.templates(limit),
    queryFn: () => getJson<TemplatesResponse>(`/templates?limit=${limit}`),
    staleTime: 30_000,
  });
}

// Human-driven delete (Monitoring → Templates). Hits the BFF DELETE route,
// which forwards to Brain. Callers invalidate monitoringKeys.templates onSuccess.
export async function deleteTemplate(id: string): Promise<void> {
  const res = await fetch(`${BFF_BASE}/templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`monitoring delete template → ${res.status}`);
  }
}

export function knowledgesOptions(
  limit = 200,
  skillOnly = false,
  sort: KnowledgeSort = "created",
) {
  const q = `${skillOnly ? "&skill_only=true" : ""}&sort=${sort}`;
  return queryOptions({
    queryKey: monitoringKeys.knowledges(limit, skillOnly, sort),
    queryFn: () =>
      getJson<KnowledgesResponse>(`/knowledges?limit=${limit}${q}`),
    staleTime: 30_000,
  });
}

export function diaryOptions(limit = 200) {
  return queryOptions({
    queryKey: monitoringKeys.diary(limit),
    queryFn: () => getJson<DiaryResponse>(`/diary?limit=${limit}`),
    staleTime: 30_000,
  });
}

export function episodesOptions(limit = 200) {
  return queryOptions({
    queryKey: monitoringKeys.episodes(limit),
    queryFn: () => getJson<EpisodesResponse>(`/episodes?limit=${limit}`),
    staleTime: 30_000,
  });
}

export function maintenanceOptions(limit = 50) {
  return queryOptions({
    queryKey: monitoringKeys.maintenance(limit),
    queryFn: () => getJson<MaintenanceResponse>(`/maintenance?limit=${limit}`),
    staleTime: 30_000,
  });
}

// Per-proposal ops + apply outcome. `enabled` lets the tab defer the fetch
// until a row is expanded.
export function maintenanceDetailOptions(id: string | null) {
  return queryOptions({
    queryKey: monitoringKeys.maintenanceDetail(id ?? ""),
    queryFn: () =>
      getJson<MaintenanceProposalDetail>(
        `/maintenance/${encodeURIComponent(id ?? "")}`,
      ),
    staleTime: 30_000,
    enabled: id !== null,
  });
}
