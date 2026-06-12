"use client";

import { useQuery } from "@tanstack/react-query";
import { mannersOptions } from "@multica/core/monitoring";
import type {
  MannerCandidateRow,
  MannerRuleRow,
  MannersEngagement,
} from "@multica/core/monitoring";
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
  // active = promoted convention; tentative = newborn; archived = demoted.
  const variant =
    status === "active"
      ? "secondary"
      : status === "archived"
        ? "outline"
        : "ghost";
  return <Badge variant={variant}>{status}</Badge>;
}

// Manners — workshop conventions (global rules, class_id IS NULL) served by
// recall as the always-in-context "so we do it here" block, plus the
// convention-miner candidate pool and knowledge-loop engagement counters.
// Single GET /api/manners payload; server orders rules active → tentative →
// archived, approved desc — don't re-sort.
export function MannersTab() {
  const { t } = useT("monitoring");
  const { data, isLoading, isError, refetch } = useQuery(mannersOptions());

  return (
    <div>
      <TabHeader
        title={t(($) => $.manners.title)}
        subtitle={t(($) => $.manners.subtitle)}
        count={data?.rules.length}
      />
      {isLoading ? (
        <TableSkeleton />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : !data ? (
        <EmptyState message={t(($) => $.manners.empty)} />
      ) : (
        <div className="space-y-6">
          <EngagementCards engagement={data.engagement} />

          {data.rules.length === 0 ? (
            <EmptyState message={t(($) => $.manners.empty)} />
          ) : (
            <div className="overflow-hidden rounded-lg border bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t(($) => $.manners.col_rule)}</TableHead>
                    <TableHead className="w-24">
                      {t(($) => $.manners.col_agent)}
                    </TableHead>
                    <TableHead className="w-24">
                      {t(($) => $.manners.col_status)}
                    </TableHead>
                    <TableHead className="w-20 text-right">
                      {t(($) => $.manners.col_applied)}
                    </TableHead>
                    <TableHead className="w-24 text-right">
                      {t(($) => $.manners.col_approved)}
                    </TableHead>
                    <TableHead className="w-24">
                      {t(($) => $.manners.col_born)}
                    </TableHead>
                    <TableHead className="w-28">
                      {t(($) => $.manners.col_added)}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rules.map((r) => (
                    <MannerRuleTableRow key={r.short_id} r={r} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <CandidatesBlock candidates={data.candidates} />
        </div>
      )}
    </div>
  );
}

// Knowledge-loop engagement, 7-day window: how often agents ask the memory
// how-to (and how often it whiffs — gap signal), and how often they pull
// facts on demand. Zero calls with live conventions = silent bypass.
function EngagementCards({ engagement }: { engagement: MannersEngagement }) {
  const { t } = useT("monitoring");
  const cards: { label: string; value: number; muted?: boolean }[] = [
    {
      label: t(($) => $.manners.engagement_howto_calls),
      value: engagement.howto_calls_7d,
    },
    {
      label: t(($) => $.manners.engagement_howto_misses),
      value: engagement.howto_misses_7d,
      muted: engagement.howto_misses_7d === 0,
    },
    {
      label: t(($) => $.manners.engagement_pull_serves),
      value: engagement.pull_serves_7d,
    },
  ];
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        {t(($) => $.manners.engagement_title)}
      </h3>
      <div className="grid grid-cols-3 gap-3">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-lg border bg-background px-4 py-3"
          >
            <div
              className={cn(
                "text-2xl font-semibold tabular-nums",
                c.muted && "text-muted-foreground/60",
              )}
            >
              {c.value}
            </div>
            <div className="break-words text-xs text-muted-foreground">
              {c.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MannerRuleTableRow({ r }: { r: MannerRuleRow }) {
  return (
    <TableRow className={cn(r.status === "archived" && "opacity-50")}>
      {/* whitespace-normal overrides TableCell's default nowrap; max-w-0 +
          break-words make long convention texts wrap, never h-scroll. */}
      <TableCell className="max-w-0 whitespace-normal align-top">
        <div className="break-words text-sm">
          {r.kind === "negative" && (
            <Badge variant="destructive" className="mb-1 mr-2">
              {r.kind}
            </Badge>
          )}
          {r.content}
        </div>
        <div className="mt-1 break-words font-mono text-xs text-muted-foreground">
          {r.short_id}
          {r.applicability_hint ? ` · ${r.applicability_hint}` : ""}
        </div>
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground">
        {r.agent_name}
      </TableCell>
      <TableCell className="align-top">
        <StatusBadge status={r.status} />
      </TableCell>
      <TableCell className="text-right align-top tabular-nums">
        {r.applied_count}
      </TableCell>
      <TableCell className="text-right align-top font-medium tabular-nums">
        {r.approved_count}
      </TableCell>
      <TableCell className="align-top">
        <Badge variant="outline">{r.created_by}</Badge>
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground">
        {formatWhen(r.added_at)}
      </TableCell>
    </TableRow>
  );
}

// The convention miner's pending pool: facts cited from enough distinct task
// classes to look like workshop conventions. Read-only mirror of the exact
// selection the next hourly miner pass will see — viewing creates no rules.
function CandidatesBlock({ candidates }: { candidates: MannerCandidateRow[] }) {
  const { t } = useT("monitoring");
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">
        {t(($) => $.manners.candidates_title)}
      </h3>
      {candidates.length === 0 ? (
        <EmptyState message={t(($) => $.manners.candidates_empty)} />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t(($) => $.manners.col_fact)}</TableHead>
                <TableHead className="w-28 text-right">
                  {t(($) => $.manners.col_references)}
                </TableHead>
                <TableHead className="w-28 text-right">
                  {t(($) => $.manners.col_classes)}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((c) => (
                <TableRow key={c.fact_short_id}>
                  <TableCell className="max-w-0 whitespace-normal align-top">
                    <div className="break-words text-sm">{c.alias}</div>
                    <div className="break-words font-mono text-xs text-muted-foreground">
                      {c.fact_short_id}
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">
                    {c.reference_count}
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">
                    {c.distinct_classes}
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
