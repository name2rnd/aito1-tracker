/* eslint-disable i18next/no-literal-string */
"use client";

import { useQuery } from "@tanstack/react-query";
import {
  commitmentsOptions,
  decisionsOptions,
  goalOptions,
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
// mind held in Brain (aito1_pm_*): personal goal, awaited commitments, open
// decision log. Execution truth (PDLC milestones, tasks) lives in Yandex
// Tracker — not here. Single dogfood project for now (B2B Sales).
const PROJECT_ID = "6318c78d-4044-452c-99df-ca9db44d678c";

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleDateString("ru-RU");
}

function GoalSection() {
  const { data, isLoading, isError } = useQuery(goalOptions(PROJECT_ID));
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-base font-semibold">Личная цель проекта</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError || !data ? (
        <div className="text-sm text-muted-foreground">
          Цель не заведена.
        </div>
      ) : (
        <div className="rounded-lg border bg-background p-4">
          <div className="font-medium break-words">{data.goal_text}</div>
          <div className="mt-2 text-sm text-muted-foreground break-words">
            Качество Y: {data.criteria_y}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Срок Z: {fmtDate(data.deadline_z)}
          </div>
          <div className="mt-2">
            <Badge variant={data.status === "active" ? "secondary" : "outline"}>
              {data.status}
            </Badge>
          </div>
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

export function CognitivePmPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
        <h1 className="mb-4 text-sm font-semibold">
          Когнитивный PM — двойник проекта
        </h1>
        <GoalSection />
        <CommitmentsSection />
        <DecisionsSection />
      </div>
    </div>
  );
}
