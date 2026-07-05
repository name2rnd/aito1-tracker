"use client";

import { useQuery } from "@tanstack/react-query";
import { episodesOptions } from "@multica/core/monitoring";
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

// Episodes — closed tasks with their distilled lessons + E-credit
// (aito1_episodes, Phase 4/8). Closed first; the first executor bullet is
// previewed inline, the AIT-N ticket linked back.
export function EpisodesTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(episodesOptions());

  return (
    <div>
      <TabHeader
        title={t(($) => $.episodes.title)}
        subtitle={t(($) => $.episodes.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.episodes.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.episodes.col_episode)}</TableHead>
                <TableHead className="w-24">
                  {t(($) => $.episodes.col_outcome)}
                </TableHead>
                <TableHead className="w-24 text-right">
                  {t(($) => $.episodes.col_lessons)}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t(($) => $.episodes.col_cited)}
                </TableHead>
                <TableHead className="w-36">
                  {t(($) => $.episodes.col_closed)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="max-w-0 whitespace-normal align-top">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {e.issue_number !== null && (
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                          AIT-{e.issue_number}
                        </span>
                      )}
                      <span className="line-clamp-2 min-w-0 break-words text-sm font-medium">
                        {e.task_text ?? "—"}
                      </span>
                      {e.class_name && (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {e.class_name}
                        </Badge>
                      )}
                    </span>
                    {e.lesson_preview && (
                      <div className="mt-0.5 break-words text-xs text-muted-foreground">
                        {e.lesson_preview}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge
                      variant={e.outcome === "done" ? "default" : "outline"}
                    >
                      {e.outcome ?? "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums text-muted-foreground">
                    <span title={t(($) => $.episodes.lessons_hint)}>
                      {e.executor_lessons}/{e.planner_lessons}
                    </span>
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums text-muted-foreground">
                    {e.cited_count}
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                    {e.closed_at ? formatWhen(e.closed_at) : "—"}
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
