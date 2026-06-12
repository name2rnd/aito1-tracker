import { queryOptions } from "@tanstack/react-query";
import type {
  AdviceResponse,
  DiaryResponse,
  FactQueriesResponse,
  FactsResponse,
  KnowledgesResponse,
  MannersResponse,
  RulesResponse,
  TaskClassesResponse,
  TemplatesResponse,
} from "./types";

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
  facts: (limit: number) => ["monitoring", "facts", limit] as const,
  rules: (limit: number) => ["monitoring", "rules", limit] as const,
  advice: (limit: number) => ["monitoring", "advice", limit] as const,
  manners: () => ["monitoring", "manners"] as const,
  templates: (limit: number) => ["monitoring", "templates", limit] as const,
  knowledges: (limit: number) => ["monitoring", "knowledges", limit] as const,
  diary: (limit: number) => ["monitoring", "diary", limit] as const,
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

export function factsOptions(limit = 200) {
  return queryOptions({
    queryKey: monitoringKeys.facts(limit),
    queryFn: () => getJson<FactsResponse>(`/facts?limit=${limit}`),
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

export function knowledgesOptions(limit = 200) {
  return queryOptions({
    queryKey: monitoringKeys.knowledges(limit),
    queryFn: () => getJson<KnowledgesResponse>(`/knowledges?limit=${limit}`),
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
