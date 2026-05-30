"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { factQueriesOptions } from "@multica/core/monitoring";
import type { FactQueryRow } from "@multica/core/monitoring";
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
import {
  EmptyState,
  ErrorState,
  TabHeader,
  TableSkeleton,
  formatWhen,
} from "./tab-chrome";

// Questions — the memory-query telemetry (aito1_fact_queries): what each agent
// searched memory for, which role asked, how many facts it surfaced, and (on
// click) the facts themselves. Queries that returned nothing are highlighted.
export function QuestionsTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(factQueriesOptions());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <TabHeader
        title={t(($) => $.questions.title)}
        subtitle={t(($) => $.questions.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.questions.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.questions.col_query)}</TableHead>
                <TableHead className="w-28">
                  {t(($) => $.questions.col_role)}
                </TableHead>
                <TableHead className="w-16 text-right">
                  {t(($) => $.questions.col_returned)}
                </TableHead>
                <TableHead className="w-36">
                  {t(($) => $.questions.col_when)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((q) => (
                <QueryRow
                  key={q.id}
                  q={q}
                  isOpen={expanded.has(q.id)}
                  onToggle={() => toggle(q.id)}
                  emptyLabel={t(($) => $.questions.no_facts)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function QueryRow({
  q,
  isOpen,
  onToggle,
  emptyLabel,
}: {
  q: FactQueryRow;
  isOpen: boolean;
  onToggle: () => void;
  emptyLabel: string;
}) {
  const zero = q.returned_count === 0;
  const canExpand = q.returned_facts.length > 0;

  return (
    <>
      <TableRow
        // Zero-fact queries surfaced nothing — flag them with a tinted row.
        className={cn(
          zero && "bg-destructive/5 hover:bg-destructive/10",
          canExpand && "cursor-pointer",
        )}
        onClick={canExpand ? onToggle : undefined}
      >
        {/* whitespace-normal overrides TableCell's default nowrap; max-w-0 +
            break-words make the query wrap instead of overflowing right. */}
        <TableCell className="max-w-0 whitespace-normal font-medium">
          <span className="flex items-start gap-1.5">
            {canExpand ? (
              isOpen ? (
                <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              )
            ) : (
              <span className="mt-0.5 inline-block size-3.5 shrink-0" />
            )}
            <span className="min-w-0 break-words">{q.query_text}</span>
          </span>
        </TableCell>
        <TableCell>
          {q.role ? (
            <Badge variant="outline">{q.role}</Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell className="text-right tabular-nums">
          {zero ? (
            <Badge variant="destructive">0</Badge>
          ) : (
            <span className="text-muted-foreground">{q.returned_count}</span>
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
          {formatWhen(q.created_at)}
        </TableCell>
      </TableRow>

      {isOpen && canExpand && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={4} className="whitespace-normal bg-muted/30">
            <ul className="space-y-1.5 py-1">
              {q.returned_facts.map((f) => (
                // Wrap long values (YT paths / sentences) instead of letting
                // the row blow out into an endless horizontal scroll.
                <li key={f.id} className="text-xs leading-relaxed">
                  <span className="font-mono font-medium text-foreground">
                    {f.alias ?? f.id.slice(0, 8)}
                  </span>
                  {f.value && (
                    <span className="ml-2 break-all text-muted-foreground">
                      {f.value}
                    </span>
                  )}
                </li>
              ))}
              {q.returned_facts.length === 0 && (
                <li className="text-xs text-muted-foreground">{emptyLabel}</li>
              )}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
