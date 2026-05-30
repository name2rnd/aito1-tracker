"use client";

import { useQuery } from "@tanstack/react-query";
import { classesOptions } from "@multica/core/monitoring";
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

function StatusBadge({ status }: { status: string }) {
  // active = live class the classifier can still assign; archived = decayed out.
  return (
    <Badge variant={status === "active" ? "secondary" : "outline"}>
      {status}
    </Badge>
  );
}

// Classes — every task class the system has learned (active + archived), with
// how many episodes resolved to each and when it last ran. Sorted by episode
// count (busiest first). The name/description column wraps — long descriptions
// flow onto multiple lines instead of an endless horizontal scroll.
export function ClassesTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(classesOptions());

  return (
    <div>
      <TabHeader
        title={t(($) => $.classes.title)}
        subtitle={t(($) => $.classes.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.classes.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.classes.col_name)}</TableHead>
                <TableHead className="w-24">
                  {t(($) => $.classes.col_status)}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t(($) => $.classes.col_episodes)}
                </TableHead>
                <TableHead className="w-36">
                  {t(($) => $.classes.col_last)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((c) => (
                <TableRow key={c.id}>
                  {/* TableCell ships whitespace-nowrap by default — override
                      with whitespace-normal, and max-w-0 forces the cell to
                      the table's leftover width so break-words wraps. */}
                  <TableCell className="max-w-0 whitespace-normal align-top">
                    <div className="font-medium break-words">{c.name}</div>
                    {c.description && (
                      <div className="mt-0.5 break-words text-xs text-muted-foreground">
                        {c.description}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums text-muted-foreground">
                    {c.episode_count}
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                    {c.last_episode_at ? formatWhen(c.last_episode_at) : "—"}
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
