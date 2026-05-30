"use client";

import { AlertCircle } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../../i18n";

// Shared chrome for the Monitoring tabs — header, load/error/empty states, and
// a compact timestamp formatter. Keeps each tab a thin query → table mapping.

export function TabHeader({
  title,
  subtitle,
  count,
}: {
  title: string;
  subtitle?: string;
  count?: number;
}) {
  return (
    <div className="mb-4 flex items-baseline gap-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {count !== undefined && (
        <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
          {count}
        </span>
      )}
      {subtitle && (
        <p className="ml-1 text-xs text-muted-foreground">{subtitle}</p>
      )}
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-md" />
      ))}
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("monitoring");
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <AlertCircle className="h-6 w-6 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium">{t(($) => $.state.error_title)}</p>
        <p className="text-xs text-muted-foreground">
          {t(($) => $.state.error_body)}
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {t(($) => $.state.retry)}
      </Button>
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

// Compact absolute timestamp, e.g. "29 May 14:23". Agents run on the same
// machine as the viewer, so local time needs no zone label.
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
