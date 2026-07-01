/* eslint-disable i18next/no-literal-string */
"use client";

import { useQuery } from "@tanstack/react-query";
import {
  checkpointsOptions,
  commitmentsOptions,
  decisionsOptions,
  ownerTasksOptions,
} from "@multica/core/cognitive-pm";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";

// Cockpit for the cognitive PM (digital twin). Read-only window onto the twin's
// mind held in Brain (aito1_pm_*): weekly checkpoints (to Tracker milestones),
// owner-tasks + verdict, awaited commitments, open decision log. The twin has no
// personal goal — the goal is closing Tracker milestones on time. Execution truth
// (milestones, tasks) lives in Yandex Tracker, read-only. Single dogfood project.
const PROJECT_ID = "6318c78d-4044-452c-99df-ca9db44d678c";

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleDateString("ru-RU");
}

// Цель двойника = закрыть вехи Трекера в срок (личной цели нет). Вехи живут в
// Трекере (артефакт); здесь — НАША недельная декомпозиция ближайшей вехи (чекпоинты).
const CHECKPOINT_STATUS_LABEL: Record<string, string> = {
  pending: "в работе",
  achieved: "достигнут",
  replanned: "перепланирован",
  missed: "просрочен",
};

function CheckpointsSection() {
  const { data, isLoading, isError } = useQuery(checkpointsOptions(PROJECT_ID));
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-base font-semibold">Чекпоинты недели (к вехам)</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : !data || data.length === 0 ? (
        <div className="text-sm text-muted-foreground">Чекпоинтов нет.</div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Миницель недели</TableHead>
                <TableHead className="w-28">Веха</TableHead>
                <TableHead className="w-28">Срок</TableHead>
                <TableHead className="w-32">Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="max-w-0 align-top whitespace-normal">
                    <div className="break-words text-sm">{c.title}</div>
                  </TableCell>
                  <TableCell className="align-top text-xs text-muted-foreground">
                    {c.milestone_key}
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap text-xs text-muted-foreground">
                    {fmtDate(c.target_date)}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant={c.status === "pending" ? "secondary" : "outline"}>
                      {CHECKPOINT_STATUS_LABEL[c.status] ?? c.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function CommitmentsSection() {
  const { data, isLoading, isError } = useQuery(commitmentsOptions(PROJECT_ID));
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-base font-semibold">Ожидаемые обязательства</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : !data || data.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          Открытых обязательств нет.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Кто → кому</TableHead>
                <TableHead>Что</TableHead>
                <TableHead className="w-28">Срок</TableHead>
                <TableHead className="w-24">Статус</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="align-top text-sm whitespace-normal break-words">
                    {c.debtor} → {c.creditor}
                  </TableCell>
                  <TableCell className="max-w-0 align-top whitespace-normal">
                    <div className="break-words text-sm">{c.condition_text}</div>
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap text-xs text-muted-foreground">
                    {fmtDate(c.deadline)}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant="outline">{c.state}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function DecisionsSection() {
  const { data, isLoading, isError } = useQuery(decisionsOptions(PROJECT_ID));
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-base font-semibold">Лог решений (открытые)</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : !data || data.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          Открытых решений нет.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Контур</TableHead>
                <TableHead className="w-28">Записано</TableHead>
                <TableHead>Обоснование</TableHead>
                <TableHead>Ожидаемый результат</TableHead>
                <TableHead className="w-16 text-right">Увер.</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="align-top text-xs text-muted-foreground">
                    {d.contour}
                  </TableCell>
                  <TableCell className="align-top whitespace-nowrap text-xs text-muted-foreground">
                    {fmtDate(d.decided_at)}
                  </TableCell>
                  <TableCell className="max-w-0 align-top whitespace-normal">
                    <div className="break-words text-sm">{d.rationale}</div>
                  </TableCell>
                  <TableCell className="max-w-0 align-top whitespace-normal">
                    <div className="break-words text-sm">
                      {d.expected_artifact}
                    </div>
                    <div className="mt-0.5 break-words text-xs text-muted-foreground">
                      {d.expected_predicate}
                    </div>
                  </TableCell>
                  <TableCell className="align-top text-right tabular-nums text-sm">
                    {d.confidence ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

// HITL loop: tasks PM/CR put on the owner, with the owner's verdict derived live
// from multica (approved = reassigned to an agent/queue; rejected = cancelled).
// This is the digest replacement — the owner's triage IS the learning signal.
const VERDICT_LABEL: Record<string, string> = {
  pending: "на тебе",
  approved: "у агента",
  rejected: "отменена",
  closed_by_owner: "закрыта сама",
};

const KIND_LABEL: Record<string, string> = {
  action: "действие",
  milestone_close: "закрыть веху",
  project_update: "обновить проект",
  replan: "перепланировать",
};

function verdictVariant(v: string): "secondary" | "outline" | "destructive" {
  if (v === "rejected") return "destructive";
  if (v === "pending") return "secondary";
  return "outline";
}

function OwnerTasksSection() {
  const { data, isLoading, isError } = useQuery(ownerTasksOptions(PROJECT_ID));
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-base font-semibold">Задачи на тебе + твой вердикт</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : !data || data.length === 0 ? (
        <div className="text-sm text-muted-foreground">Поставленных задач нет.</div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">Кто</TableHead>
                <TableHead>Задача</TableHead>
                <TableHead>Твои комментарии</TableHead>
                <TableHead className="w-28">Вердикт</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((t) => (
                <TableRow key={t.issue_id}>
                  <TableCell className="align-top text-xs text-muted-foreground">
                    {t.lesson_id ? "CR" : "PM"}
                  </TableCell>
                  <TableCell className="max-w-0 align-top whitespace-normal">
                    <div className="break-words text-sm">{t.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {KIND_LABEL[t.kind] ?? t.kind}
                      {t.issue_key ? ` · ${t.issue_key}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-0 align-top whitespace-normal">
                    {t.owner_comments.length === 0 ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      t.owner_comments.map((c, i) => (
                        <div
                          key={`${t.issue_id}-${i}`}
                          className="mb-1 break-words text-sm"
                        >
                          {c.content}
                        </div>
                      ))
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant={verdictVariant(t.verdict)}>
                      {VERDICT_LABEL[t.verdict] ?? t.verdict}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

export function CognitivePmPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
        <h1 className="mb-4 text-sm font-semibold">
          Когнитивный PM — двойник проекта
        </h1>
        <CheckpointsSection />
        <OwnerTasksSection />
        <CommitmentsSection />
        <DecisionsSection />
      </div>
    </div>
  );
}
