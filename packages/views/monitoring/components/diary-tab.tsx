"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Send } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { diaryOptions } from "@multica/core/monitoring";
import type { DiaryRow } from "@multica/core/monitoring";
import { cn } from "@multica/ui/lib/utils";
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

// Diary — the Wanderer's (Странник) free-form meditation notes
// (aito1_diary.body), newest first. Brain owns sorting. The body is long
// markdown, revealed on click, just like the knowledges tab.
export function DiaryTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(diaryOptions());
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
        title={t(($) => $.diary.title)}
        subtitle={t(($) => $.diary.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.diary.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.diary.col_title)}</TableHead>
                <TableHead className="w-24">
                  {t(($) => $.diary.col_kind)}
                </TableHead>
                <TableHead className="w-24 text-right">
                  {t(($) => $.diary.col_interestingness)}
                </TableHead>
                <TableHead className="w-16 text-center">
                  {t(($) => $.diary.col_shared)}
                </TableHead>
                <TableHead className="w-36">
                  {t(($) => $.diary.col_created)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((d) => (
                <DiaryTableRow
                  key={d.id}
                  d={d}
                  isOpen={expanded.has(d.id)}
                  onToggle={() => toggle(d.id)}
                  untitledLabel={t(($) => $.diary.untitled)}
                  sharedLabel={t(($) => $.diary.shared)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// Renders interestingness as 1..5 filled dots out of 5.
function Interestingness({ value }: { value: number }) {
  const filled = Math.max(0, Math.min(5, value));
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${filled}/5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "size-1.5 rounded-full",
            i < filled ? "bg-foreground/70" : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

function DiaryTableRow({
  d,
  isOpen,
  onToggle,
  untitledLabel,
  sharedLabel,
}: {
  d: DiaryRow;
  isOpen: boolean;
  onToggle: () => void;
  untitledLabel: string;
  sharedLabel: string;
}) {
  return (
    <>
      <TableRow className="cursor-pointer" onClick={onToggle}>
        {/* whitespace-normal overrides TableCell's default nowrap; max-w-0 +
            break-words wrap the title instead of overflowing right. */}
        <TableCell className="max-w-0 whitespace-normal align-top font-medium">
          <span className="flex items-start gap-1.5">
            {isOpen ? (
              <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 break-words">
              {d.title ?? (
                <span className="text-muted-foreground italic">
                  {untitledLabel}
                </span>
              )}
            </span>
          </span>
        </TableCell>
        <TableCell className="align-top text-xs text-muted-foreground">
          {d.kind}
        </TableCell>
        <TableCell className="text-right align-top">
          <Interestingness value={d.interestingness} />
        </TableCell>
        <TableCell className="text-center align-top">
          {d.shared_to_tg && (
            <Send
              className="inline-block size-3.5 text-muted-foreground"
              aria-label={sharedLabel}
            />
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
          {formatWhen(d.created_at)}
        </TableCell>
      </TableRow>

      {isOpen && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="whitespace-normal bg-muted/30">
            <div className="max-w-3xl overflow-x-auto py-2 text-sm">
              <Markdown>{d.body}</Markdown>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
