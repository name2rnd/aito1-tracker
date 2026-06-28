import { queryOptions } from "@tanstack/react-query";
import type { Checkpoint, Commitment, Decision, OwnerTaskTriage } from "./types";

// Cognitive-PM cockpit data comes from Brain (it owns the aito1_pm_* tables),
// reached through a same-origin Next.js BFF proxy at /bff/pm — NOT /api/ (which
// next.config rewrites wholesale to the Go backend). Mirrors the Monitoring
// section's pattern. Read-only.
const BFF_BASE = "/bff/pm";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BFF_BASE}${path}`, {
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`pm ${path} → ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const cognitivePmKeys = {
  all: ["cognitive-pm"] as const,
  checkpoints: (pid: string) => ["cognitive-pm", "checkpoints", pid] as const,
  commitments: (pid: string) => ["cognitive-pm", "commitments", pid] as const,
  decisions: (pid: string) => ["cognitive-pm", "decisions", pid] as const,
  ownerTasks: (pid: string) => ["cognitive-pm", "owner-tasks", pid] as const,
};

// Чекпоинты — недельная декомпозиция вехи (наши). Личной цели у двойника нет.
export function checkpointsOptions(pid: string) {
  return queryOptions({
    queryKey: cognitivePmKeys.checkpoints(pid),
    queryFn: () => getJson<Checkpoint[]>(`/checkpoints/${pid}`),
    staleTime: 30_000,
  });
}

export function commitmentsOptions(pid: string) {
  return queryOptions({
    queryKey: cognitivePmKeys.commitments(pid),
    queryFn: () => getJson<Commitment[]>(`/commitments/${pid}`),
    staleTime: 30_000,
  });
}

export function decisionsOptions(pid: string) {
  return queryOptions({
    queryKey: cognitivePmKeys.decisions(pid),
    queryFn: () => getJson<Decision[]>(`/decisions/${pid}`),
    staleTime: 30_000,
  });
}

export function ownerTasksOptions(pid: string) {
  return queryOptions({
    queryKey: cognitivePmKeys.ownerTasks(pid),
    queryFn: () => getJson<OwnerTaskTriage[]>(`/owner-tasks/${pid}`),
    staleTime: 30_000,
  });
}
