"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  maintenanceDetailOptions,
  maintenanceOptions,
} from "@multica/core/monitoring";
import type {
  DeliverySummary,
  LayerHealth,
  MaintenanceProposalRow,
} from "@multica/core/monitoring";
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

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  applied: "default",
  proposed: "secondary",
  rejected: "outline",
  stale: "outline",
};

// curator_op_<x> → short label key + colour. null decision = not yet applied.
const DECISION: Record<string, { key: "applied" | "skipped" | "already" | "failed"; variant: BadgeVariant }> = {
  curator_op_applied: { key: "applied", variant: "default" },
  curator_op_skipped_stale: { key: "skipped", variant: "outline" },
  curator_op_already_applied: { key: "already", variant: "secondary" },
  curator_op_failed: { key: "failed", variant: "destructive" },
};

// Maintenance — Curator loop observability (Phase 8): layer health + 7-day
// recall-delivery summary + the proposals ledger, each expandable to its ops
// with per-op apply outcome.
export function MaintenanceTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(maintenanceOptions());

  return (
    <div>
      <TabHeader
        title={t(($) => $.maintenance.title)}
        subtitle={t(($) => $.maintenance.subtitle)}
        count={data?.total}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data ? (
        <EmptyState message={t(($) => $.maintenance.empty)} />
      ) : (
        <div className="space-y-4">
          <HealthBar health={data.health} />
          <DeliveryBlock delivery={data.delivery} />
          {data.items.length === 0 ? (
            <EmptyState message={t(($) => $.maintenance.empty)} />
          ) : (
            <div className="overflow-hidden rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t(($) => $.maintenance.col_proposal)}</TableHead>
                    <TableHead className="w-24">
                      {t(($) => $.maintenance.col_status)}
                    </TableHead>
                    <TableHead>{t(($) => $.maintenance.col_ops)}</TableHead>
                    <TableHead className="w-36">
                      {t(($) => $.maintenance.col_created)}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((p) => (
                    <ProposalRow key={p.id} p={p} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HealthBar({ health }: { health: LayerHealth }) {
  const { t } = useT("monitoring");
  const cells: [string, number][] = [
    [t(($) => $.maintenance.health_facts), health.facts_active],
    [t(($) => $.maintenance.health_knowledges), health.knowledges_active],
    [t(($) => $.maintenance.health_procedural), health.procedural_total],
  ];
  return (
    <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/30 px-4 py-3">
      {cells.map(([label, n]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <span className="text-lg font-semibold tabular-nums">{n}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  );
}

function DeliveryBlock({ delivery }: { delivery: DeliverySummary }) {
  const { t } = useT("monitoring");
  if (!delivery.available) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
        {t(($) => $.maintenance.delivery_title)} — {delivery.note}
      </div>
    );
  }
  const phases = Object.entries(delivery.by_phase);
  const dropped = Object.entries(delivery.dropped).filter(([, n]) => n > 0);
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 px-4 py-3">
      <div className="text-xs font-medium text-muted-foreground">
        {t(($) => $.maintenance.delivery_title)}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span>
          <span className="font-semibold tabular-nums">{delivery.count}</span>{" "}
          {t(($) => $.maintenance.delivery_recalls)}
        </span>
        <span className="text-muted-foreground">
          {t(($) => $.maintenance.delivery_median)}: {delivery.median_digest_size}
          {" / "}
          {delivery.median_machine_size} B
        </span>
      </div>
      {phases.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {phases.map(([phase, n]) => (
            <Badge key={phase} variant="outline" className="text-[10px]">
              {phase} ×{n}
            </Badge>
          ))}
        </div>
      )}
      {dropped.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {t(($) => $.maintenance.delivery_dropped)}:
          </span>
          {dropped.map(([section, n]) => (
            <Badge key={section} variant="outline" className="text-[10px]">
              {section} {n}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalRow({ p }: { p: MaintenanceProposalRow }) {
  const { t } = useT("monitoring");
  const [open, setOpen] = useState(false);
  const kinds = Object.entries(p.ops_by_kind);
  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <TableCell className="align-top font-medium">
          <span className="flex items-center gap-1.5">
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {p.issue_number !== null ? (
              <span className="font-mono text-xs">AIT-{p.issue_number}</span>
            ) : (
              <span className="font-mono text-xs text-muted-foreground">
                {p.id.slice(0, 8)}
              </span>
            )}
          </span>
        </TableCell>
        <TableCell className="align-top">
          <Badge variant={STATUS_VARIANT[p.status] ?? "outline"}>
            {p.status}
          </Badge>
        </TableCell>
        <TableCell className="align-top">
          <span className="flex flex-wrap items-center gap-1">
            <span className="tabular-nums text-muted-foreground">
              {p.ops_total}
            </span>
            {kinds.map(([kind, n]) => (
              <Badge key={kind} variant="outline" className="text-[10px]">
                {kind} ×{n}
              </Badge>
            ))}
            {p.golden_ops > 0 && (
              <Badge className="text-[10px]">
                {t(($) => $.maintenance.golden_ops, { count: p.golden_ops })}
              </Badge>
            )}
          </span>
        </TableCell>
        <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
          {formatWhen(p.created_at)}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={4} className="bg-muted/30">
            <ProposalDetail id={p.id} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ProposalDetail({ id }: { id: string }) {
  const { t } = useT("monitoring");
  const { data, isLoading, isError } = useQuery(maintenanceDetailOptions(id));
  if (isLoading) return <TableSkeleton rows={3} />;
  if (isError || !data)
    return (
      <p className="py-2 text-xs text-muted-foreground">
        {t(($) => $.state.error_body)}
      </p>
    );
  const reviewed = data.reviewed_untouched;
  const lensCounts = Object.entries(data.lens_counts);
  return (
    <div className="space-y-3 py-2 text-sm">
      <ol className="space-y-2">
        {data.ops.map((op) => {
          const d = op.decision ? DECISION[op.decision] : null;
          return (
            <li key={op.index} className="rounded-md border bg-background p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  {op.kind}
                </Badge>
                {op.lens && (
                  <span className="text-[10px] text-muted-foreground">
                    {op.lens}
                  </span>
                )}
                {op.target && (
                  <span className="font-mono text-xs break-all">{op.target}</span>
                )}
                {d && (
                  <Badge variant={d.variant} className="ml-auto text-[10px]">
                    {t(($) => $.maintenance.decision[d.key])}
                  </Badge>
                )}
              </div>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {op.rationale}
              </p>
              {op.refs.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {op.refs.map((r) => (
                    <span
                      key={r}
                      className="font-mono text-[10px] text-muted-foreground"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {reviewed.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground">
            {t(($) => $.maintenance.reviewed_title)}
          </div>
          <ul className="mt-1 space-y-1">
            {reviewed.map((r) => (
              <li key={`${r.kind}-${r.id}`} className="text-xs text-muted-foreground">
                <span className="font-mono">
                  {r.kind === "fact" ? "F" : "K"}-{r.id.slice(0, 8)}
                </span>{" "}
                <span className="opacity-70">({r.lens})</span> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {lensCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">
            {t(($) => $.maintenance.lens_counts)}:
          </span>
          {lensCounts.map(([lens, n]) => (
            <Badge key={lens} variant="outline" className="text-[10px]">
              {lens} {n}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
