"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import {
  templatesOptions,
  deleteTemplate,
  monitoringKeys,
} from "@multica/core/monitoring";
import type { TemplateRow } from "@multica/core/monitoring";
import { cn } from "@multica/ui/lib/utils";
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
import { Markdown } from "../../common/markdown";
import { useT } from "../../i18n";
import { EmptyState, ErrorState, TabHeader, TableSkeleton } from "./tab-chrome";

const COL_COUNT = 6;

function StatusBadge({ status }: { status: string }) {
  // active = promoted (≥3 applied + ≥70% approved); needs_review = quality dip;
  // tentative = candidate; archived = decayed / probe-failed.
  const variant =
    status === "active"
      ? "secondary"
      : status === "archived"
        ? "outline"
        : status === "needs_review"
          ? "destructive"
          : "ghost";
  return <Badge variant={variant}>{status}</Badge>;
}

function shortEpisode(id: string | null): string | null {
  return id ? `E-${id.slice(0, 8)}` : null;
}

// Templates — the reusable plan skeletons (aito1_plan_templates) the system
// generalizes from successful episodes. Shows provenance (which episodes it
// was born from) and usage (applied/approved). Click a row to expand the full
// content_md (rendered markdown); trash icon deletes (Human-only).
export function TemplatesTab() {
  const { t } = useT("monitoring");
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery(templatesOptions());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      setConfirmId(null);
      void queryClient.invalidateQueries({ queryKey: monitoringKeys.all });
    },
  });

  return (
    <div>
      <TabHeader
        title={t(($) => $.templates.title)}
        subtitle={t(($) => $.templates.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState message={t(($) => $.templates.empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.templates.col_template)}</TableHead>
                <TableHead className="w-44">
                  {t(($) => $.templates.col_source)}
                </TableHead>
                <TableHead className="w-24">
                  {t(($) => $.templates.col_status)}
                </TableHead>
                <TableHead className="w-20 text-right">
                  {t(($) => $.templates.col_applied)}
                </TableHead>
                <TableHead className="w-24 text-right">
                  {t(($) => $.templates.col_approved)}
                </TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((tpl) => (
                <TemplateTableRow
                  key={tpl.id}
                  tpl={tpl}
                  isOpen={expanded.has(tpl.id)}
                  onToggle={() => toggle(tpl.id)}
                  onDelete={() => setConfirmId(tpl.id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog
        open={!!confirmId}
        onOpenChange={(open) => {
          if (!open) setConfirmId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.templates.delete_dialog.title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.templates.delete_dialog.description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t(($) => $.templates.delete_dialog.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => {
                if (confirmId) remove.mutate(confirmId);
              }}
            >
              {t(($) => $.templates.delete_dialog.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TemplateTableRow({
  tpl,
  isOpen,
  onToggle,
  onDelete,
}: {
  tpl: TemplateRow;
  isOpen: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useT("monitoring");
  const rate =
    tpl.applied_count > 0
      ? Math.round((tpl.approved_count / tpl.applied_count) * 100)
      : null;
  const source = shortEpisode(tpl.source_episode_id);
  const reflection = shortEpisode(tpl.reflection_episode_id);

  return (
    <>
      <TableRow
        className={cn("cursor-pointer", tpl.status === "archived" && "opacity-50")}
        onClick={onToggle}
      >
        <TableCell className="max-w-0 whitespace-normal align-top">
          <span className="flex items-start gap-1.5">
            {isOpen ? (
              <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 break-words font-mono text-xs text-muted-foreground">
              {tpl.class_name ?? t(($) => $.templates.no_class)}
            </span>
          </span>
        </TableCell>
        <TableCell className="align-top text-xs">
          {source ? (
            <div className="break-words font-mono">
              <span className="text-muted-foreground/70">
                {t(($) => $.templates.from)}{" "}
              </span>
              {source}
            </div>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          )}
          {reflection && reflection !== source && (
            <div className="break-words font-mono text-muted-foreground/70">
              {t(($) => $.templates.reflected)} {reflection}
            </div>
          )}
        </TableCell>
        <TableCell className="align-top">
          <StatusBadge status={tpl.status} />
        </TableCell>
        <TableCell className="text-right align-top font-medium tabular-nums">
          {tpl.applied_count}
        </TableCell>
        <TableCell className="text-right align-top tabular-nums">
          <div className="font-medium">{tpl.approved_count}</div>
          {rate !== null && (
            <div className="text-[10px] text-muted-foreground">{rate}%</div>
          )}
        </TableCell>
        <TableCell className="align-top">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            aria-label={t(($) => $.templates.delete)}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </TableCell>
      </TableRow>

      {isOpen && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={COL_COUNT} className="whitespace-normal bg-muted/30">
            <div className="max-w-3xl overflow-x-auto py-2 text-sm">
              <Markdown>{tpl.content_md}</Markdown>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
