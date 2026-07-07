import { queryOptions } from "@tanstack/react-query";
import type {
  CalibrationRow,
  Checkpoint,
  Commitment,
  Decision,
  Lesson,
  LessonEvent,
  OwnerTaskTriage,
  PmProject,
  ResolvedDecision,
} from "./types";

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
  projects: () => ["cognitive-pm", "projects"] as const,
  checkpoints: (pid: string) => ["cognitive-pm", "checkpoints", pid] as const,
  commitments: (pid: string) => ["cognitive-pm", "commitments", pid] as const,
  decisions: (pid: string) => ["cognitive-pm", "decisions", pid] as const,
  resolvedDecisions: (pid: string) =>
    ["cognitive-pm", "resolved-decisions", pid] as const,
  lessons: (pid: string) => ["cognitive-pm", "lessons", pid] as const,
  lessonEvents: (lessonId: string) =>
    ["cognitive-pm", "lesson-events", lessonId] as const,
  calibration: (pid: string) => ["cognitive-pm", "calibration", pid] as const,
  ownerTasks: (pid: string) => ["cognitive-pm", "owner-tasks", pid] as const,
};

export function pmProjectsOptions() {
  return queryOptions({
    queryKey: cognitivePmKeys.projects(),
    queryFn: () => getJson<PmProject[]>("/projects"),
    staleTime: 30_000,
  });
}

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

// Закрытые решения — витрина тренера (§8 плана junior-pm): исход + Brier/severity.
export function resolvedDecisionsOptions(pid: string) {
  return queryOptions({
    queryKey: cognitivePmKeys.resolvedDecisions(pid),
    queryFn: () => getJson<ResolvedDecision[]>(`/decisions/${pid}/resolved`),
    staleTime: 30_000,
  });
}

export function lessonsOptions(pid: string) {
  return queryOptions({
    queryKey: cognitivePmKeys.lessons(pid),
    queryFn: () => getJson<Lesson[]>(`/lessons/${pid}`),
    staleTime: 30_000,
  });
}

// Таймлайн обучения одного урока (add → approve → embed → check → deprecate).
// Дёргается лениво — только когда карточка урока развёрнута.
export function lessonEventsOptions(lessonId: string) {
  return queryOptions({
    queryKey: cognitivePmKeys.lessonEvents(lessonId),
    queryFn: () => getJson<LessonEvent[]>(`/lesson-events/${lessonId}`),
    staleTime: 30_000,
  });
}

export function calibrationOptions(pid: string) {
  return queryOptions({
    queryKey: cognitivePmKeys.calibration(pid),
    queryFn: () => getJson<CalibrationRow[]>(`/calibration/${pid}`),
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
