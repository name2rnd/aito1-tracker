/* eslint-disable i18next/no-literal-string */
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { toast } from "sonner";
import {
  calibrationOptions,
  checkpointsOptions,
  commitmentsOptions,
  decisionsOptions,
  lessonEventsOptions,
  lessonsOptions,
  ownerTasksOptions,
  resolvedDecisionsOptions,
  useApproveLesson,
  useSetLessonStatus,
} from "@multica/core/cognitive-pm";
import type {
  CalibrationRow,
  DecisionAlternative,
  InfoBasisRef,
  Lesson,
  ResolvedDecision,
} from "@multica/core/cognitive-pm";
import type { AgentTask } from "@multica/core/types/agent";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
import { cn } from "@multica/ui/lib/utils";
import { TranscriptButton } from "../../common/task-transcript";

// Cockpit for the cognitive PM (digital twin). Window onto the twin's mind held
// in Brain (aito1_pm_*): weekly checkpoints (to Tracker milestones), owner-tasks
// + verdict, awaited commitments, open + resolved decision log, lessons with
// their learning delta-log, calibration curve. Read-only except the trainer's
// lesson gate (approve / retire — the only UI mutations, через BFF POST-allowlist).
// The twin has no personal goal — the goal is closing Tracker milestones on time.
// Execution truth (milestones, tasks) lives in Yandex Tracker, read-only.
// Single dogfood project. Цель витрины — разбор решения тренером за ≤5 минут
// (план junior-pm §8).
const PROJECT_ID = "6318c78d-4044-452c-99df-ca9db44d678c";

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? "—" : t.toLocaleDateString("ru-RU");
}

function fmtDateTime(d: string | null): string {
  if (!d) return "—";
  const t = new Date(d);
  return Number.isNaN(t.getTime())
    ? "—"
    : t.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
}

// Минимальный AgentTask для TranscriptButton (lazy-load трейса по task.id) —
// тот же приём, что syntheticTask на autopilot-detail-page.
function traceTask(taskId: string): AgentTask {
  return {
    id: taskId,
    agent_id: "",
    runtime_id: "",
    issue_id: "",
    status: "completed",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    created_at: "",
  };
}

// --- Чипы источников + отвергнутые варианты (общее для открытых и закрытых) ---

function shortRef(ref: string): string {
  return ref.length > 18 ? `${ref.slice(0, 8)}…${ref.slice(-4)}` : ref;
}

function RefChip({ refItem }: { refItem: InfoBasisRef }) {
  const refStr = String(refItem.ref ?? "");
  const copy = () => {
    void navigator.clipboard.writeText(refStr).then(
      () => toast.success("ref скопирован"),
      () => toast.error("не удалось скопировать"),
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={refItem.excerpt || refStr}
      className="inline-flex max-w-full items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
    >
      <span className="shrink-0 font-medium">
        {String(refItem.source_type ?? "?")}
      </span>
      <span className="truncate font-mono">{shortRef(refStr)}</span>
      <Copy className="h-2.5 w-2.5 shrink-0 opacity-60" />
    </button>
  );
}

function DecisionEvidence({
  refs,
  alternatives,
}: {
  refs: InfoBasisRef[];
  alternatives: DecisionAlternative[];
}) {
  const hasRefs = refs.length > 0;
  const hasAlts = alternatives.length > 0;
  if (!hasRefs && !hasAlts) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {hasRefs && (
        <div className="flex flex-wrap gap-1">
          {refs.map((r, i) => (
            <RefChip key={`${String(r.ref)}-${i}`} refItem={r} />
          ))}
        </div>
      )}
      {hasAlts && (
        <div className="space-y-0.5">
          {alternatives.map((a, i) => (
            <div key={i} className="break-words text-xs text-muted-foreground">
              <span className="text-foreground/70">
                отвергнуто: {String(a.option ?? "")}
              </span>
              {a.why_rejected ? <> — {String(a.why_rejected)}</> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Вводный блок: «открыл — и сразу всё вспомнил» ---------------------------
// Компактная легенда слоёв + схема связей. Сворачиваемый, по умолчанию
// развёрнут; состояние — в localStorage (читается в useEffect, чтобы SSR-разметка
// не расходилась с клиентской).

const INTRO_LS_KEY = "aito1-pm-cockpit-intro-collapsed";

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const LEGEND: { title: string; target: string; text: string }[] = [
  {
    title: "Чекпоинты",
    target: "pm-checkpoints",
    text: "недельные мини-цели ближайшей вехи Трекера: месячный контур режет веху, суточный ведёт, недельный закрывает.",
  },
  {
    title: "Лог решений",
    target: "pm-decisions",
    text: "каждое решение PM записано до действия: обоснование, источники (чипы), отвергнутые альтернативы и фальсифицируемое ожидание (предикат + уверенность). Здесь висят открытые — их ожидание ещё не проверено.",
  },
  {
    title: "Закрытые решения",
    target: "pm-resolved",
    text: "ожидание сверено с реальностью (Трекер) или таймаутом: исход correct / partial / error / no_response. Твоя отмена поручения автоматически = error. Из исходов считаются Brier и калибровка.",
  },
  {
    title: "Поручения",
    target: "pm-owner-tasks",
    text: "задачи на тебе — единственный канал действий PM наружу; твои вердикты (сделала / поправила / отменила + комментарий) записываются и питают обучение.",
  },
  {
    title: "Обязательства",
    target: "pm-commitments",
    text: "параллельный реестр «кто → кому → что → к сроку» из решений и переписки; суточный контур следит, просрочка/нарушение — сигнал алгедоники в Telegram.",
  },
  {
    title: "Уроки",
    target: "pm-lessons",
    text: "субботний Cognitive Reflector разбирает закрытые решения и твои вердикты за неделю и извлекает уроки (рождаются в карантине). Кнопка «Одобрить» делает урок активным — PM читает его в начале каждого прогона. Таймлайн урока: что изменил, куда встроено, сработал ли.",
  },
  {
    title: "Калибровка",
    target: "pm-calibration",
    text: "сверка заявленной уверенности с фактической сбываемостью по типам решений («на 0.9 сбываешься в 0.5» = перекалиброван) — вход субботнего разбора.",
  },
];

// Узел схемы: с target — кликабельный (скроллит к секции), без — пунктирный
// контекстный (у слоя нет своей секции на странице).
function SchemeNode({ target, children }: { target?: string; children: ReactNode }) {
  if (!target) {
    return (
      <span className="rounded border border-dashed bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground">
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => scrollToSection(target)}
      className="rounded border bg-muted/40 px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-muted"
    >
      {children}
    </button>
  );
}

function SchemeArrow({ label }: { label?: string }) {
  return (
    <span className="text-[11px] text-muted-foreground">
      {label ? `— ${label} →` : "→"}
    </span>
  );
}

function SchemeRow({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">{children}</div>;
}

function IntroSection() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(INTRO_LS_KEY) === "1") setCollapsed(true);
    } catch {
      // localStorage недоступен (private mode) — остаёмся развёрнутыми.
    }
  }, []);
  const toggle = () => {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(INTRO_LS_KEY, next ? "1" : "0");
      } catch {
        // ок, просто не запомним.
      }
      return next;
    });
  };
  return (
    <section className="mb-8 rounded-lg border bg-muted/20 p-3">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-1.5 text-left text-sm font-semibold"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        )}
        Как читать эту страницу
      </button>
      {!collapsed && (
        <div className="mt-3 space-y-4">
          <div className="space-y-1.5">
            {LEGEND.map((item) => (
              <div
                key={item.target}
                className="break-words text-xs leading-relaxed text-muted-foreground"
              >
                <button
                  type="button"
                  onClick={() => scrollToSection(item.target)}
                  className="font-medium text-foreground hover:underline"
                >
                  {item.title}
                </button>
                {" — "}
                {item.text}
              </div>
            ))}
          </div>
          <div className="space-y-1.5 border-t pt-3">
            <SchemeRow>
              <SchemeNode>SENSE: встречи · почта · тикеты · комменты</SchemeNode>
              <SchemeArrow />
              <SchemeNode target="pm-decisions">РЕШЕНИЯ (журнал)</SchemeNode>
              <SchemeArrow />
              <SchemeNode target="pm-owner-tasks">ПОРУЧЕНИЯ тебе</SchemeNode>
              <SchemeArrow />
              <SchemeNode>твои вердикты</SchemeNode>
              <SchemeArrow />
              <span className="text-[11px] text-muted-foreground">в исходы решений</span>
            </SchemeRow>
            <SchemeRow>
              <SchemeNode target="pm-decisions">РЕШЕНИЯ</SchemeNode>
              <SchemeArrow label="проверка ожидания: Трекер / таймаут" />
              <SchemeNode target="pm-resolved">ЗАКРЫТЫЕ РЕШЕНИЯ</SchemeNode>
              <SchemeArrow />
              <SchemeNode target="pm-calibration">КАЛИБРОВКА (Brier)</SchemeNode>
            </SchemeRow>
            <SchemeRow>
              <SchemeNode target="pm-resolved">ЗАКРЫТЫЕ РЕШЕНИЯ</SchemeNode>
              <SchemeArrow />
              <SchemeNode>CR (суббота)</SchemeNode>
              <SchemeArrow />
              <SchemeNode target="pm-lessons">УРОКИ</SchemeNode>
              <span className="text-[11px] text-muted-foreground">
                : карантин → «Одобрить» → active → в поведение PM
              </span>
            </SchemeRow>
            <SchemeRow>
              <SchemeNode target="pm-commitments">ОБЯЗАТЕЛЬСТВА</SchemeNode>
              <SchemeArrow />
              <SchemeNode>АЛГЕДОНИКА</SchemeNode>
              <SchemeArrow />
              <SchemeNode>Telegram (раз в день)</SchemeNode>
            </SchemeRow>
          </div>
        </div>
      )}
    </section>
  );
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
    <section className="mb-8" id="pm-checkpoints">
      <h2 className="mb-3 text-base font-semibold">Чекпоинты недели (к вехам)</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : !data || data.length === 0 ? (
        <div className="text-sm text-muted-foreground">Чекпоинтов нет.</div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table className="table-fixed">
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
                  <TableCell className="align-top whitespace-normal">
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
    <section className="mb-8" id="pm-commitments">
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
          {/* table-fixed: авто-раскладка отдавала всю ширину колонке «Кто → кому»
              (без max-w-0), а «Что» (max-w-0) схлопывалась в вертикальный столбец
              по букве. Явные ширины: первая ~35%, «Что» — остаток. */}
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[35%]">Кто → кому</TableHead>
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
                  <TableCell className="align-top whitespace-normal">
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
    <section className="mb-8" id="pm-decisions">
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
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Контур</TableHead>
                <TableHead className="w-28">Записано</TableHead>
                <TableHead>Обоснование</TableHead>
                <TableHead>Ожидаемый результат</TableHead>
                <TableHead className="w-16 text-right">Увер.</TableHead>
                <TableHead className="w-10" />
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
                  <TableCell className="align-top whitespace-normal">
                    <div className="break-words text-sm">{d.rationale}</div>
                    <DecisionEvidence
                      refs={d.info_basis_refs ?? []}
                      alternatives={d.alternatives ?? []}
                    />
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
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
                  <TableCell className="align-top">
                    {d.task_id && (
                      <TranscriptButton
                        task={traceTask(d.task_id)}
                        agentName="PM"
                        title="Трейс прогона"
                      />
                    )}
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

// --- Закрытые решения: исход + честные метрики (Brier / severity / process) ---

const OUTCOME_LABEL: Record<string, string> = {
  correct: "верно",
  partial: "частично",
  error: "ошибка",
  no_response: "без ответа",
  unknown: "неизвестно",
};

// correct зелёный / partial жёлтый / error красный / no_response серый.
function OutcomeBadge({ kind }: { kind: ResolvedDecision["outcome_kind"] }) {
  const label = kind ? (OUTCOME_LABEL[kind] ?? kind) : "—";
  if (kind === "error") return <Badge variant="destructive">{label}</Badge>;
  if (kind === "no_response") return <Badge variant="secondary">{label}</Badge>;
  const cls =
    kind === "correct"
      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
      : kind === "partial"
        ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
        : undefined;
  return (
    <Badge variant="outline" className={cn(cls)}>
      {label}
    </Badge>
  );
}

function fmtNum(v: number | null, digits: number): string {
  return v == null ? "—" : Number(v).toFixed(digits);
}

function ResolvedDecisionCard({ d }: { d: ResolvedDecision }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <OutcomeBadge kind={d.outcome_kind} />
        <span className="text-xs text-muted-foreground">
          {d.contour}
          {d.decision_type ? ` · ${d.decision_type}` : ""}
        </span>
        <span className="text-xs text-muted-foreground">
          {fmtDate(d.decided_at)} → {fmtDate(d.resolved_at)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">Brier {fmtNum(d.brier, 2)}</span>
          <span className="tabular-nums">sev {d.severity ?? "—"}</span>
          <span>процесс: {d.process_verdict ?? "—"}</span>
          <span>закрыл: {d.resolved_by ?? "—"}</span>
          {d.task_id && (
            <TranscriptButton
              task={traceTask(d.task_id)}
              agentName="PM"
              title="Трейс прогона"
            />
          )}
        </span>
      </div>
      <div className="mt-2 break-words text-sm">{d.rationale}</div>
      <div className="mt-1.5 break-words text-sm">
        <span className="text-muted-foreground">Ожидал: </span>
        {d.expected_artifact}
        {d.confidence != null && (
          <span className="text-muted-foreground"> · увер. {d.confidence}</span>
        )}
      </div>
      <div className="break-words text-xs text-muted-foreground">
        {d.expected_predicate}
      </div>
      <div className="mt-1.5 break-words text-sm">
        <span className="text-muted-foreground">Исход: </span>
        {d.outcome ?? "—"}
      </div>
      <DecisionEvidence
        refs={d.info_basis_refs ?? []}
        alternatives={d.alternatives ?? []}
      />
    </div>
  );
}

function ResolvedDecisionsSection() {
  const { data, isLoading, isError } = useQuery(
    resolvedDecisionsOptions(PROJECT_ID),
  );
  return (
    <section className="mb-8" id="pm-resolved">
      <h2 className="mb-3 text-base font-semibold">Закрытые решения</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : !data || data.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          Закрытых решений нет.
        </div>
      ) : (
        <div className="space-y-3">
          {data.map((d) => (
            <ResolvedDecisionCard key={d.id} d={d} />
          ))}
        </div>
      )}
    </section>
  );
}

// --- Уроки: статус + формат урока + разворачиваемый дельта-лог обучения ---

const LESSON_STATUS_LABEL: Record<string, string> = {
  active: "active",
  quarantined: "quarantined",
  retired: "retired",
};

function LessonStatusBadge({ status }: { status: Lesson["status"] }) {
  const label = LESSON_STATUS_LABEL[status] ?? status;
  if (status === "active")
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
      >
        {label}
      </Badge>
    );
  if (status === "quarantined")
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 text-amber-600 dark:text-amber-400"
      >
        {label}
      </Badge>
    );
  return <Badge variant="secondary">{label}</Badge>;
}

const LESSON_TYPE_LABEL: Record<string, string> = {
  directive: "директива",
  procedure_patch: "патч процедуры",
  case_note: "кейс",
  preference: "предпочтение",
};

// detail кратко: компактный JSON, обрезанный до вменяемой строки.
function detailBrief(detail: Record<string, unknown>): string | null {
  if (!detail || Object.keys(detail).length === 0) return null;
  const s = JSON.stringify(detail);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

// Таймлайн «какой урок, что изменил, куда встроено»: op → actor →
// embedded_into → detail → дата (журнал aito1_pm_lesson_events).
function LessonTimeline({ lessonId }: { lessonId: string }) {
  const { data, isLoading, isError } = useQuery(lessonEventsOptions(lessonId));
  if (isLoading)
    return <div className="text-xs text-muted-foreground">Загрузка…</div>;
  if (isError)
    return <div className="text-xs text-destructive">Ошибка загрузки.</div>;
  if (!data || data.length === 0)
    return <div className="text-xs text-muted-foreground">Событий нет.</div>;
  return (
    <div className="space-y-1">
      {data.map((ev) => (
        <div
          key={ev.id}
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
        >
          <span className="w-16 shrink-0 font-medium">{ev.op}</span>
          <span className="w-10 shrink-0 text-muted-foreground">{ev.actor}</span>
          {ev.embedded_into && (
            <span className="break-all font-mono text-muted-foreground">
              → {ev.embedded_into}
            </span>
          )}
          {detailBrief(ev.detail) && (
            <span className="min-w-0 break-all text-muted-foreground">
              {detailBrief(ev.detail)}
            </span>
          )}
          <span className="ml-auto whitespace-nowrap text-muted-foreground">
            {fmtDateTime(ev.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
}

function LessonCard({ lesson }: { lesson: Lesson }) {
  const [expanded, setExpanded] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const approve = useApproveLesson(PROJECT_ID);
  const setStatus = useSetLessonStatus(PROJECT_ID);
  const mutating = approve.isPending || setStatus.isPending;
  const scopeIn = lesson.scope_in ?? [];
  const scopeOut = lesson.scope_out ?? [];

  // Гейт тренера: approve — один клик (ритуал субботнего разбора, без лишних
  // подтверждений); retire — с confirm-диалогом (tombstone, но решение весомое).
  const handleApprove = () => {
    approve.mutate(lesson.id, {
      onSuccess: () => toast.success("Урок одобрен — active"),
      onError: () => toast.error("Не удалось одобрить урок"),
    });
  };
  const handleRetire = () => {
    setRetireOpen(false);
    setStatus.mutate(
      { lessonId: lesson.id, status: "retired" },
      {
        onSuccess: () => toast.success("Урок отправлен в retired"),
        onError: () => toast.error("Не удалось изменить статус урока"),
      },
    );
  };

  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <LessonStatusBadge status={lesson.status} />
        <span className="text-xs text-muted-foreground">
          {LESSON_TYPE_LABEL[lesson.type] ?? lesson.type}
        </span>
        {lesson.external_id && (
          <span
            title={lesson.external_id}
            className="font-mono text-[11px] text-muted-foreground"
          >
            {shortRef(lesson.external_id)}
          </span>
        )}
        <span
          className="text-xs text-muted-foreground tabular-nums"
          title="счётчики efficacy: помог / навредил"
        >
          помог {lesson.helpful_count} · вредил {lesson.harmful_count}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {lesson.status === "quarantined" && (
            <Button
              variant="outline"
              size="sm"
              disabled={mutating}
              onClick={handleApprove}
              className="h-6 border-emerald-500/40 px-2 text-xs text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
            >
              Одобрить
            </Button>
          )}
          {lesson.status !== "retired" && (
            <Button
              variant="outline"
              size="sm"
              disabled={mutating}
              onClick={() => setRetireOpen(true)}
              className="h-6 px-2 text-xs text-muted-foreground"
            >
              В retired
            </Button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            таймлайн
          </button>
        </span>
      </div>
      <AlertDialog
        open={retireOpen}
        onOpenChange={(v) => {
          if (!mutating) setRetireOpen(v);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отправить урок в retired?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              Урок перестанет читаться контурами. Строка останется в журнале
              (tombstone, не удаление); ключ external_id освободится для новой
              версии урока.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutating}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRetire}
              disabled={mutating}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              В retired
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="mt-2 break-words text-sm">{lesson.lesson_text}</div>
      {lesson.trigger_condition && (
        <div className="mt-1 break-words text-xs text-muted-foreground">
          Когда: {lesson.trigger_condition}
        </div>
      )}
      {(scopeIn.length > 0 || scopeOut.length > 0) && (
        <div className="mt-0.5 break-words text-xs text-muted-foreground">
          Scope: в {scopeIn.length > 0 ? scopeIn.map(String).join(", ") : "—"}
          {" · "}вне {scopeOut.length > 0 ? scopeOut.map(String).join(", ") : "—"}
        </div>
      )}
      {expanded && (
        <div className="mt-2 border-t pt-2">
          <LessonTimeline lessonId={lesson.id} />
        </div>
      )}
    </div>
  );
}

function LessonsSection() {
  const { data, isLoading, isError } = useQuery(lessonsOptions(PROJECT_ID));
  return (
    <section className="mb-8" id="pm-lessons">
      <h2 className="mb-3 text-base font-semibold">Уроки</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : !data || data.length === 0 ? (
        <div className="text-sm text-muted-foreground">Уроков нет.</div>
      ) : (
        <div className="space-y-3">
          {data.map((l) => (
            <LessonCard key={l.id} lesson={l} />
          ))}
        </div>
      )}
    </section>
  );
}

// --- Калибровка: заявленная уверенность × фактическая частота × Brier ---

// bucket = width_bucket(confidence, 0, 100, 10): бакет N = [(N-1)*10, N*10)%.
function bucketLabel(bucket: number): string {
  return `${(bucket - 1) * 10}–${bucket * 10}%`;
}

const NO_TYPE = "без типа";

function CalibrationSection() {
  const { data, isLoading, isError } = useQuery(calibrationOptions(PROJECT_ID));
  const groups = new Map<string, CalibrationRow[]>();
  for (const row of data ?? []) {
    const key = row.decision_type ?? NO_TYPE;
    const rows = groups.get(key);
    if (rows) rows.push(row);
    else groups.set(key, [row]);
  }
  // Именованные типы по алфавиту, «без типа» — в конце.
  const keys = [...groups.keys()].sort((a, b) =>
    a === NO_TYPE ? 1 : b === NO_TYPE ? -1 : a.localeCompare(b),
  );
  return (
    <section className="mb-8" id="pm-calibration">
      <h2 className="mb-3 text-base font-semibold">Калибровка</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : keys.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          Закрытых решений с уверенностью ещё нет.
        </div>
      ) : (
        <div className="space-y-4">
          {keys.map((key) => (
            <div key={key}>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                {key}
              </div>
              <div className="overflow-hidden rounded-lg border bg-background">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">Уверенность</TableHead>
                      <TableHead className="w-16 text-right">n</TableHead>
                      <TableHead className="w-24 text-right">hit rate</TableHead>
                      <TableHead className="w-24 text-right">Brier</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(groups.get(key) ?? [])
                      .slice()
                      .sort((a, b) => a.bucket - b.bucket)
                      .map((row) => (
                        <TableRow key={`${key}-${row.bucket}`}>
                          <TableCell className="text-sm tabular-nums">
                            {bucketLabel(row.bucket)}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {row.n}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {fmtNum(row.hit_rate, 3)}
                          </TableCell>
                          <TableCell className="text-right text-sm tabular-nums">
                            {fmtNum(row.brier, 4)}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))}
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
    <section className="mb-8" id="pm-owner-tasks">
      <h2 className="mb-3 text-base font-semibold">Задачи на тебе + твой вердикт</h2>
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Загрузка…</div>
      ) : isError ? (
        <div className="text-sm text-destructive">Ошибка загрузки.</div>
      ) : !data || data.length === 0 ? (
        <div className="text-sm text-muted-foreground">Поставленных задач нет.</div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table className="table-fixed">
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
                  <TableCell className="align-top whitespace-normal">
                    <div className="break-words text-sm">{t.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {KIND_LABEL[t.kind] ?? t.kind}
                      {t.issue_key ? ` · ${t.issue_key}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
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
        <IntroSection />
        <CheckpointsSection />
        <OwnerTasksSection />
        <CommitmentsSection />
        <DecisionsSection />
        <ResolvedDecisionsSection />
        <LessonsSection />
        <CalibrationSection />
      </div>
    </div>
  );
}
