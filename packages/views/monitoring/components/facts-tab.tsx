"use client";

import { useQuery } from "@tanstack/react-query";
import { factsOptions } from "@multica/core/monitoring";
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

// Facts — the system's long-term knowledge (aito1_facts), ranked by usage
// (reference_count + pull_count). Invalidated facts stay visible, dimmed.
export function FactsTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(factsOptions());

  return (
    <div>
      <TabHeader
        title={t(($) => $.facts.title)}
        subtitle={t(($) => $.facts.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.facts.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.facts.col_fact)}</TableHead>
                <TableHead className="w-24">
                  {t(($) => $.facts.col_source)}
                </TableHead>
                <TableHead className="w-28 text-right">
                  {t(($) => $.facts.col_uses)}
                </TableHead>
                <TableHead className="w-36">
                  {t(($) => $.facts.col_last)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((f) => (
                <TableRow key={f.id} className={cn(!f.active && "opacity-50")}>
                  {/* whitespace-normal overrides TableCell's default nowrap;
                      max-w-0 + break-* make alias/value wrap, not overflow. */}
                  <TableCell className="max-w-0 whitespace-normal align-top">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium break-all">
                        {f.alias}
                      </span>
                      {!f.active && (
                        <Badge variant="outline" className="shrink-0">
                          {t(($) => $.facts.invalid)}
                        </Badge>
                      )}
                    </span>
                    <div className="mt-0.5 break-words text-xs text-muted-foreground">
                      {f.value}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant="outline">{f.source}</Badge>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <div className="font-medium tabular-nums">{f.uses}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {t(($) => $.facts.uses_breakdown, {
                        ref: f.reference_count,
                        pull: f.pull_count,
                      })}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                    {f.last_used ? formatWhen(f.last_used) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
