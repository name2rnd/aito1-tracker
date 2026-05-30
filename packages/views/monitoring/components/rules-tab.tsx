"use client";

import { useQuery } from "@tanstack/react-query";
import { rulesOptions } from "@multica/core/monitoring";
import type { RuleRow } from "@multica/core/monitoring";
import { cn } from "@multica/ui/lib/utils";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multica/ui/components/ui/table";
import { useT } from "../../i18n";
import { EmptyState, ErrorState, TabHeader, TableSkeleton } from "./tab-chrome";

function StatusBadge({ status }: { status: string }) {
  // active = promoted (≥3 applied + ≥70% approved); tentative = candidate;
  // archived = decayed out.
  const variant =
    status === "active"
      ? "secondary"
      : status === "archived"
        ? "outline"
        : "ghost";
  return <Badge variant={variant}>{status}</Badge>;
}

// Rules — the learned do/don't guidance (aito1_rules). Grouped active-first,
// then by applied_count ↓. positive rules show content_text; negative show the
// antipattern → "instead" alternative. Approval rate hints at quality.
export function RulesTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(rulesOptions());

  return (
    <div>
      <TabHeader
        title={t(($) => $.rules.title)}
        subtitle={t(($) => $.rules.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.rules.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.rules.col_rule)}</TableHead>
                <TableHead className="w-24">
                  {t(($) => $.rules.col_agent)}
                </TableHead>
                <TableHead className="w-44">
                  {t(($) => $.rules.col_class)}
                </TableHead>
                <TableHead className="w-24">
                  {t(($) => $.rules.col_status)}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t(($) => $.rules.col_applied)}
                </TableHead>
                <TableHead className="w-24 text-right">
                  {t(($) => $.rules.col_approved)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((r) => (
                <RuleTableRow key={r.id} r={r} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function RuleTableRow({ r }: { r: RuleRow }) {
  const { t } = useT("monitoring");
  const isNegative = r.kind === "negative";
  // approval rate = how often a surfaced rule's episode got 👍 — a quality
  // signal distinct from raw frequency.
  const rate =
    r.applied_count > 0
      ? Math.round((r.approved_count / r.applied_count) * 100)
      : null;

  return (
    <TableRow className={cn(r.status === "archived" && "opacity-50")}>
      {/* whitespace-normal overrides TableCell's default nowrap; max-w-0 +
          break-words make the rule body wrap instead of overflowing right. */}
      <TableCell className="max-w-0 whitespace-normal align-top">
        <span className="mb-1 flex items-center gap-2">
          <Badge variant={isNegative ? "destructive" : "secondary"}>
            {isNegative
              ? t(($) => $.rules.kind_negative)
              : t(($) => $.rules.kind_positive)}
          </Badge>
        </span>
        {isNegative ? (
          <div className="space-y-0.5">
            <div className="break-words text-sm line-through decoration-destructive/40">
              {r.antipattern}
            </div>
            {r.do_instead && (
              <div className="break-words text-sm">
                <span className="text-muted-foreground">
                  {t(($) => $.rules.dont_instead)}:{" "}
                </span>
                {r.do_instead}
              </div>
            )}
            {r.why_bad && (
              <div className="break-words text-xs text-muted-foreground">
                {r.why_bad}
              </div>
            )}
          </div>
        ) : (
          <div className="break-words text-sm">{r.content_text}</div>
        )}
        {r.applicability_hint && (
          <div className="mt-0.5 break-words text-xs text-muted-foreground/70">
            {r.applicability_hint}
          </div>
        )}
      </TableCell>
      <TableCell className="align-top">
        <Badge variant="outline">{r.agent_name}</Badge>
      </TableCell>
      <TableCell className="max-w-0 whitespace-normal align-top text-xs">
        {r.class_name ? (
          <span className="break-words font-mono text-muted-foreground">
            {r.class_name}
          </span>
        ) : (
          <span className="text-muted-foreground/50">
            {t(($) => $.rules.no_class)}
          </span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <StatusBadge status={r.status} />
      </TableCell>
      <TableCell className="text-right align-top font-medium tabular-nums">
        {r.applied_count}
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        <div className="font-medium">{r.approved_count}</div>
        {rate !== null && (
          <div className="text-[10px] text-muted-foreground">{rate}%</div>
        )}
      </TableCell>
    </TableRow>
  );
}
