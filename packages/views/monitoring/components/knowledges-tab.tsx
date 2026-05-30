"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { knowledgesOptions } from "@multica/core/monitoring";
import type { KnowledgeRow } from "@multica/core/monitoring";
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
import { Markdown } from "../../common/markdown";
import { useT } from "../../i18n";
import {
  EmptyState,
  ErrorState,
  TabHeader,
  TableSkeleton,
  formatWhen,
} from "./tab-chrome";

// Knowledges — larger markdown digests (aito1_knowledges.schema_md) distilled
// from sources, newest first. No usage counter exists on the row, so the
// catalog is chronological. The body is long markdown, revealed on click.
export function KnowledgesTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(knowledgesOptions());
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
        title={t(($) => $.knowledges.title)}
        subtitle={t(($) => $.knowledges.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.knowledges.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.knowledges.col_title)}</TableHead>
                <TableHead className="w-20 text-right">
                  {t(($) => $.knowledges.col_sources)}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t(($) => $.knowledges.col_version)}
                </TableHead>
                <TableHead className="w-36">
                  {t(($) => $.knowledges.col_created)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((k) => (
                <KnowledgeTableRow
                  key={k.id}
                  k={k}
                  isOpen={expanded.has(k.id)}
                  onToggle={() => toggle(k.id)}
                  revisionLabel={t(($) => $.knowledges.revision)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function KnowledgeTableRow({
  k,
  isOpen,
  onToggle,
  revisionLabel,
}: {
  k: KnowledgeRow;
  isOpen: boolean;
  onToggle: () => void;
  revisionLabel: string;
}) {
  return (
    <>
      <TableRow
        className={cn("cursor-pointer", k.status === "archived" && "opacity-50")}
        onClick={onToggle}
      >
        {/* whitespace-normal overrides TableCell's default nowrap; max-w-0 +
            break-words wrap the title instead of overflowing right. */}
        <TableCell className="max-w-0 whitespace-normal align-top font-medium">
          <span className="flex items-start gap-1.5">
            {isOpen ? (
              <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 break-words">{k.name}</span>
          </span>
        </TableCell>
        <TableCell className="text-right align-top tabular-nums text-muted-foreground">
          {k.source_count}
        </TableCell>
        <TableCell className="text-right align-top tabular-nums text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            v{k.version}
            {k.is_revision && (
              <Badge variant="outline" className="text-[10px]">
                {revisionLabel}
              </Badge>
            )}
          </span>
        </TableCell>
        <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
          {formatWhen(k.created_at)}
        </TableCell>
      </TableRow>

      {isOpen && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={4} className="whitespace-normal bg-muted/30">
            <div className="max-w-3xl overflow-x-auto py-2 text-sm">
              <Markdown>{k.schema_md}</Markdown>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
