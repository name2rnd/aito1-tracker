"use client";

import { useQuery } from "@tanstack/react-query";
import { adviceOptions } from "@multica/core/monitoring";
import type { AdviceRow } from "@multica/core/monitoring";
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
  formatWhen,
  TabHeader,
  TableSkeleton,
} from "./tab-chrome";

function StatusBadge({ status }: { status: string }) {
  // active = promoted recommendation; tentative = candidate; archived = retired.
  const variant =
    status === "active"
      ? "secondary"
      : status === "archived"
        ? "outline"
        : "ghost";
  return <Badge variant={variant}>{status}</Badge>;
}

// Advice — the recommendations the permission gate forms for agents
// (the self-improving advice loop). row_type 'text' is a learned correction,
// 'redirect' points a deprecated executable at its contract. Already sorted
// server-side (active → tentative → archived, shown desc) — don't re-sort.
export function AdviceTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(adviceOptions());

  return (
    <div>
      <TabHeader
        title={t(($) => $.advice.title)}
        subtitle={t(($) => $.advice.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.advice.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-56">
                  {t(($) => $.advice.col_trigger)}
                </TableHead>
                <TableHead>{t(($) => $.advice.col_recommendation)}</TableHead>
                <TableHead className="w-24">
                  {t(($) => $.advice.col_status)}
                </TableHead>
                <TableHead className="w-24">
                  {t(($) => $.advice.col_source)}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t(($) => $.advice.col_shown)}
                </TableHead>
                <TableHead className="w-24 text-right">
                  {t(($) => $.advice.col_fixed)}
                </TableHead>
                <TableHead className="w-28">
                  {t(($) => $.advice.col_last_shown)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((a) => (
                <AdviceTableRow key={a.id} a={a} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function AdviceTableRow({ a }: { a: AdviceRow }) {
  const { t } = useT("monitoring");
  const isRedirect = a.row_type === "redirect";
  // fix rate = how often a surfaced piece of advice was acted on — a quality
  // signal distinct from raw shown count. Server may pre-compute fix_rate; fall
  // back to deriving it from the counts when null but there were shows.
  const rate =
    a.fix_rate !== null
      ? Math.round(a.fix_rate * 100)
      : a.shown_count > 0
        ? Math.round((a.fixed_count / a.shown_count) * 100)
        : null;

  return (
    <TableRow className={cn(a.status === "archived" && "opacity-50")}>
      <TableCell className="max-w-0 whitespace-normal align-top text-xs">
        <span className="mb-1 flex items-center gap-2">
          <Badge variant={isRedirect ? "destructive" : "secondary"}>
            {isRedirect
              ? t(($) => $.advice.type_redirect)
              : t(($) => $.advice.type_text)}
          </Badge>
        </span>
        <span className="break-words font-mono text-muted-foreground">
          {a.trigger_kind}: {a.trigger_value}
        </span>
      </TableCell>
      {/* whitespace-normal overrides TableCell's default nowrap; max-w-0 +
          break-words make the recommendation wrap instead of overflowing right. */}
      <TableCell className="max-w-0 whitespace-normal align-top">
        <div className="break-words text-sm">{a.recommendation}</div>
      </TableCell>
      <TableCell className="align-top">
        <StatusBadge status={a.status} />
      </TableCell>
      <TableCell className="align-top">
        <Badge variant="outline">{a.source}</Badge>
      </TableCell>
      <TableCell className="text-right align-top font-medium tabular-nums">
        {a.shown_count}
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        <div className="font-medium">{a.fixed_count}</div>
        {rate !== null && (
          <div className="text-[10px] text-muted-foreground">{rate}%</div>
        )}
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground">
        {a.last_shown_at ? (
          formatWhen(a.last_shown_at)
        ) : (
          <span className="text-muted-foreground/50">
            {t(($) => $.advice.never_shown)}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
