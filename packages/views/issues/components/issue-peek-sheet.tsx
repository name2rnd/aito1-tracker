"use client";

import { Sheet, SheetContent } from "@multica/ui/components/ui/sheet";
import { useIssuePeekStore } from "@multica/core/issues/stores/peek-store";
import { IssueDetail } from "./issue-detail";

/**
 * Overlay peek sidebar. Clicking an issue in a list or board opens the full
 * IssueDetail in a right-side Sheet instead of navigating away, so you can
 * click through a batch — read, comment, change status — without losing your
 * place. The properties panel inside IssueDetail is collapsed by default to
 * keep the peek narrow; it can be re-opened with the header toggle.
 *
 * Mounted once in the dashboard layout — a single global store drives it, so
 * every list/board surface reuses the same panel. Closes on Esc / backdrop.
 */
export function IssuePeekSheet() {
  const openId = useIssuePeekStore((s) => s.openId);
  const close = useIssuePeekStore((s) => s.close);

  return (
    <Sheet open={!!openId} onOpenChange={(open) => !open && close()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0"
        // Inline width beats the Sheet's default `sm:max-w-sm` cap deterministically
        // (twMerge won't dedupe it — the base class carries a `data-[side=right]:` variant).
        style={{ width: "62vw", minWidth: "560px", maxWidth: "1040px" }}
      >
        {openId && (
          <IssueDetail
            key={openId}
            issueId={openId}
            defaultSidebarOpen={false}
            layoutId="multica_issue_peek_layout"
            onDone={close}
            onDelete={close}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
