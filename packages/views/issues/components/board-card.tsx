"use client";

import { useCallback, useMemo, memo } from "react";
import { AppLink } from "../../navigation";
import { CornerDownRight, Loader2 } from "lucide-react";
import { useSortable, defaultAnimateLayoutChanges } from "@dnd-kit/sortable";
import type { AnimateLayoutChanges } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import type { Issue, UpdateIssueRequest } from "@multica/core/types";
import { useQuery } from "@tanstack/react-query";
import { ActorAvatar } from "../../common/actor-avatar";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import { useWorkspacePaths } from "@multica/core/paths";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { agentTaskSnapshotOptions } from "@multica/core/agents/queries";
import { ProjectIcon } from "../../projects/components/project-icon";
import { AssigneePicker } from "./pickers";
import { useViewStore } from "@multica/core/issues/stores/view-store-context";
import { ProgressRing } from "./progress-ring";
import type { ChildProgress } from "./list-row";
import { IssueActionsContextMenu } from "../actions";
import { LabelChip } from "../../labels/label-chip";
import { useT } from "../../i18n";

// AITO1-patch (Патч 41): статусы таска, означающие «агент работает над задачей
// прямо сейчас» — тот же active-набор, что у in-issue баннера AgentLiveCard.
const ACTIVE_TASK_STATUSES = new Set(["queued", "dispatched", "running"]);

/** Stops event from bubbling to Link/drag handlers */
function PickerWrapper({ children }: { children: React.ReactNode }) {
  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  return (
    <div onClick={stop} onMouseDown={stop} onPointerDown={stop}>
      {children}
    </div>
  );
}

export const BoardCardContent = memo(function BoardCardContent({
  issue,
  editable = false,
  childProgress,
}: {
  issue: Issue;
  editable?: boolean;
  childProgress?: ChildProgress;
}) {
  const { t } = useT("issues");
  const storeProperties = useViewStore((s) => s.cardProperties);
  const wsId = useWorkspaceId();
  const { data: projects = [] } = useQuery({
    ...projectListOptions(wsId),
    enabled: storeProperties.project && !!issue.project_id,
  });
  const project = issue.project_id ? projects.find((p) => p.id === issue.project_id) : undefined;
  const labels = issue.labels ?? [];

  // AITO1-patch (Патч 41): есть ли у агента активный таск на ЭТОЙ задаче прямо
  // сейчас. Из общего workspace-снапшота тасков (WS-инвалидируется → live), один
  // fetch на всю доску — React Query дедуплицирует по одинаковому queryKey.
  const { data: taskSnapshot } = useQuery(agentTaskSnapshotOptions(wsId));
  const hasActiveAgent = useMemo(
    () =>
      (taskSnapshot ?? []).some(
        (task) => task.issue_id === issue.id && ACTIVE_TASK_STATUSES.has(task.status),
      ),
    [taskSnapshot, issue.id],
  );

  const updateIssueMutation = useUpdateIssue();
  const handleUpdate = useCallback(
    (updates: Partial<UpdateIssueRequest>) => {
      updateIssueMutation.mutate(
        { id: issue.id, ...updates },
        { onError: () => toast.error(t(($) => $.card.update_failed)) },
      );
    },
    [issue.id, updateIssueMutation, t],
  );

  const showAssignee = storeProperties.assignee && issue.assignee_type && issue.assignee_id;
  const showProject = storeProperties.project && project;
  const showChildProgress = storeProperties.childProgress && childProgress;
  const showLabels = storeProperties.labels && labels.length > 0;

  return (
    <div className="rounded-lg border-[0.5px] border-border bg-card py-3 px-2.5 shadow-[0_3px_6px_-2px_rgba(0,0,0,0.02),0_1px_1px_0_rgba(0,0,0,0.04)] transition-colors group-hover/card:border-accent group-hover/card:bg-accent group-data-[popup-open]/card:border-accent group-data-[popup-open]/card:bg-accent">
      {/* Линия 1: номер задачи + прогресс подзадач справа от номера, агент справа */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {issue.parent_issue_id && (
            <CornerDownRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-label="Подзадача"
            />
          )}
          <p className="text-xs text-muted-foreground">{issue.identifier}</p>
          {showChildProgress && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5">
              <ProgressRing done={childProgress!.done} total={childProgress!.total} size={14} />
              <span className="text-[11px] text-muted-foreground tabular-nums font-medium">
                {childProgress!.done}/{childProgress!.total}
              </span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* AITO1-patch (Патч 41): live-индикатор активной работы агента —
              слева от иконки assignee. Тот же spinner (text-info), что у in-issue
              баннера «агент работает». */}
          {hasActiveAgent && (
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin text-info"
              aria-label="Агент работает над задачей"
            />
          )}
          {showAssignee &&
            (editable ? (
              <PickerWrapper>
                <AssigneePicker
                  assigneeType={issue.assignee_type}
                  assigneeId={issue.assignee_id}
                  onUpdate={handleUpdate}
                  trigger={
                    <ActorAvatar
                      actorType={issue.assignee_type!}
                      actorId={issue.assignee_id!}
                      size={28}
                      enableHoverCard
                    />
                  }
                />
              </PickerWrapper>
            ) : (
              <ActorAvatar
                actorType={issue.assignee_type!}
                actorId={issue.assignee_id!}
                size={28}
                enableHoverCard
              />
            ))}
        </div>
      </div>

      {/* Линия 2: текст задачи */}
      <p className="mt-1.5 text-sm font-medium leading-snug line-clamp-5">
        {issue.title}
      </p>

      {/* Линия 3: проект полностью (wrap, без обрезки) */}
      {showProject && (
        <span className="mt-2 inline-flex items-start gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <ProjectIcon project={project} size="sm" className="mt-0.5 shrink-0" />
          <span className="break-words text-left">{project!.title}</span>
        </span>
      )}

      {/* Линия 4: лейблы (chip'ы с переносом) */}
      {showLabels && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {labels.map((label) => (
            <LabelChip key={label.id} label={label} />
          ))}
        </div>
      )}
    </div>
  );
});

const animateLayoutChanges: AnimateLayoutChanges = (args) => {
  const { isSorting, wasDragging } = args;
  if (isSorting || wasDragging) return false;
  return defaultAnimateLayoutChanges(args);
};

export const DraggableBoardCard = memo(function DraggableBoardCard({ issue, childProgress }: { issue: Issue; childProgress?: ChildProgress }) {
  const p = useWorkspacePaths();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: issue.id,
    data: { type: "issue", status: issue.status, projectId: issue.project_id },
    animateLayoutChanges,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <IssueActionsContextMenu issue={issue}>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className={`group/card ${isDragging ? "opacity-30" : ""}`}
      >
        <AppLink
          href={p.issueDetail(issue.identifier)}
          className={`group block transition-colors ${isDragging ? "pointer-events-none" : ""}`}
        >
          <BoardCardContent issue={issue} editable childProgress={childProgress} />
        </AppLink>
      </div>
    </IssueActionsContextMenu>
  );
});
