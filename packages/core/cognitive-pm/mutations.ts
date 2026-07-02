import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cognitivePmKeys } from "./queries";

// Гейт тренера (план junior-pm §3 «Кокпит» п.3, одобрено владельцем): единственные
// мутации кокпита — approve и retire/quarantine урока. Идут через тот же BFF
// (POST-allowlist ровно на lesson/{id}/approve и lesson/{id}/status); всё
// остальное в кокпите остаётся read-only.
const BFF_BASE = "/bff/pm";

async function postJson(path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${BFF_BASE}${path}`, {
    method: "POST",
    headers:
      body === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`pm ${path} → ${res.status}`);
  }
}

// 👍 владельца: урок quarantined → active (Brain пишет lesson_events
// op='approve' + op='embed'). Без body — контракт brain/api/pm.py.
export function useApproveLesson(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lessonId: string) => postJson(`/lesson/${lessonId}/approve`),
    onSettled: (_data, _err, lessonId) => {
      void qc.invalidateQueries({ queryKey: cognitivePmKeys.lessons(pid) });
      void qc.invalidateQueries({
        queryKey: cognitivePmKeys.lessonEvents(lessonId),
      });
    },
  });
}

// retire → tombstone (строка живёт, op='deprecate'); quarantined — обратно в
// карантин (op='reject'). active — только через approve (гейт владельца).
export function useSetLessonStatus(pid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      lessonId,
      status,
    }: {
      lessonId: string;
      status: "retired" | "quarantined";
    }) => postJson(`/lesson/${lessonId}/status`, { status, actor: "owner" }),
    onSettled: (_data, _err, vars) => {
      void qc.invalidateQueries({ queryKey: cognitivePmKeys.lessons(pid) });
      void qc.invalidateQueries({
        queryKey: cognitivePmKeys.lessonEvents(vars.lessonId),
      });
    },
  });
}
