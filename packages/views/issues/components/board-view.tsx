"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  pointerWithin,
  closestCenter,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, GripVertical, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import type { Issue, IssueStatus } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { useLoadMoreByStatus } from "@multica/core/issues/mutations";
import type { MyIssuesFilter } from "@multica/core/issues/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { useReorderProjects } from "@multica/core/projects/mutations";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@multica/ui/components/ui/dropdown-menu";
import { useViewStoreApi, useViewStore } from "@multica/core/issues/stores/view-store-context";
import {
  NO_PROJECT_LANE_ID,
  boardColumnId,
  buildProjectSwimlanes,
  reorderProjectPositions,
  type BoardSwimlane,
} from "../utils/board-swimlanes";
import { StatusIcon } from "./status-icon";
import { BoardColumn } from "./board-column";
import { BoardCardContent } from "./board-card";
import { InfiniteScrollSentinel } from "./infinite-scroll-sentinel";
import type { ChildProgress } from "./list-row";
import { ProjectIcon } from "../../projects/components/project-icon";
import { useT } from "../../i18n";

type LaneColumns = Record<string, Record<IssueStatus, string[]>>;
type IssueContainer = { laneId: string; status: IssueStatus };
type SortableAttributes = ReturnType<typeof useSortable>["attributes"];
type SortableListeners = ReturnType<typeof useSortable>["listeners"];

function buildLaneColumns(lanes: BoardSwimlane[]): LaneColumns {
  const columns: LaneColumns = {};
  for (const lane of lanes) columns[lane.id] = lane.columns;
  return columns;
}

function createKanbanCollision(
  columnIds: Set<string>,
  projectLaneIds: Set<string>,
): CollisionDetection {
  return (args) => {
    const activeType = args.active.data.current?.type;
    if (activeType === "project-lane") {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) =>
          projectLaneIds.has(container.id as string),
        ),
      });
    }

    const issueContainers = args.droppableContainers.filter(
      (container) => !projectLaneIds.has(container.id as string),
    );
    const pointer = pointerWithin({ ...args, droppableContainers: issueContainers });
    if (pointer.length > 0) {
      // Prefer card collisions over column collisions so that
      // dragging down within a column finds the target card
      // instead of the column droppable.
      const cards = pointer.filter((c) => !columnIds.has(c.id as string));
      if (cards.length > 0) return cards;
    }
    // Fallback: closestCenter finds the nearest card even when
    // the pointer is in a gap between cards (common when dragging down).
    return closestCenter({ ...args, droppableContainers: issueContainers });
  };
}

/** Compute a float position for `activeId` based on its neighbors in `ids`. */
function computePosition(ids: string[], activeId: string, issueMap: Map<string, Issue>): number {
  const idx = ids.indexOf(activeId);
  if (idx === -1) return 0;
  const getPos = (id: string) => issueMap.get(id)?.position ?? 0;
  if (ids.length === 1) return issueMap.get(activeId)?.position ?? 0;
  if (idx === 0) return getPos(ids[1]!) - 1;
  if (idx === ids.length - 1) return getPos(ids[idx - 1]!) + 1;
  return (getPos(ids[idx - 1]!) + getPos(ids[idx + 1]!)) / 2;
}

/** Find which lane/status column contains a given ID (issue or column droppable). */
function findContainer(
  columns: LaneColumns,
  id: string,
  visibleStatuses: IssueStatus[],
): IssueContainer | null {
  for (const [laneId, laneColumns] of Object.entries(columns)) {
    for (const status of visibleStatuses) {
      if (boardColumnId(laneId, status) === id) return { laneId, status };
      if (laneColumns[status]?.includes(id)) return { laneId, status };
    }
  }
  return null;
}

const EMPTY_PROGRESS_MAP = new Map<string, ChildProgress>();

export function BoardView({
  issues,
  visibleStatuses,
  hiddenStatuses,
  onMoveIssue,
  childProgressMap = EMPTY_PROGRESS_MAP,
  myIssuesScope,
  myIssuesFilter,
  projectId,
}: {
  issues: Issue[];
  visibleStatuses: IssueStatus[];
  hiddenStatuses: IssueStatus[];
  onMoveIssue: (
    issueId: string,
    newStatus: IssueStatus,
    newPosition?: number
  ) => void;
  childProgressMap?: Map<string, ChildProgress>;
  /** When set, per-status load-more targets the scoped cache instead of the workspace one. */
  myIssuesScope?: string;
  myIssuesFilter?: MyIssuesFilter;
  /** When set, the per-column "+" pre-fills the project on the create form. */
  projectId?: string;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const sortBy = useViewStore((s) => s.sortBy);
  const sortDirection = useViewStore((s) => s.sortDirection);
  const myIssuesOpts = myIssuesScope
    ? { scope: myIssuesScope, filter: myIssuesFilter ?? {} }
    : undefined;
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const reorderProjects = useReorderProjects();

  const lanes = useMemo(
    () =>
      buildProjectSwimlanes(
        issues,
        projects,
        visibleStatuses,
        sortBy,
        sortDirection,
        projectId,
      ),
    [issues, projects, visibleStatuses, sortBy, sortDirection, projectId],
  );
  const projectLaneIds = useMemo(
    () => lanes.filter((lane) => lane.project).map((lane) => lane.id),
    [lanes],
  );
  const columnIds = useMemo(() => {
    const ids = new Set<string>();
    for (const lane of lanes) {
      for (const status of visibleStatuses) ids.add(boardColumnId(lane.id, status));
    }
    return ids;
  }, [lanes, visibleStatuses]);
  const kanbanCollision = useMemo(
    () => createKanbanCollision(columnIds, new Set(projectLaneIds)),
    [columnIds, projectLaneIds],
  );

  // --- Drag state ---
  const [activeIssue, setActiveIssue] = useState<Issue | null>(null);
  const [activeProjectLane, setActiveProjectLane] = useState<BoardSwimlane | null>(null);
  const isDraggingRef = useRef(false);

  // --- Local columns state ---
  // Between drags: follows TQ via useEffect.
  // During drag: local-only, driven by onDragOver/onDragEnd.
  const [columns, setColumns] = useState<LaneColumns>(() => buildLaneColumns(lanes));
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  useEffect(() => {
    if (!isDraggingRef.current) {
      setColumns(buildLaneColumns(lanes));
    }
  }, [lanes]);

  // After a cross-column move, lock for one animation frame so dnd-kit's
  // collision detection can stabilize before processing the next move.
  // Without this, collision oscillates: A→B→A→B… until React bails out.
  const recentlyMovedRef = useRef(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      recentlyMovedRef.current = false;
    });
    return () => cancelAnimationFrame(id);
  }, [columns]);

  // --- Issue map ---
  // Frozen during drag so BoardColumn/DraggableBoardCard props stay
  // referentially stable even if a TQ refetch lands mid-drag.
  const issueMap = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const issueMapRef = useRef(issueMap);
  if (!isDraggingRef.current) {
    issueMapRef.current = issueMap;
  }

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeType = event.active.data.current?.type;
      if (activeType === "project-lane") {
        setActiveProjectLane(lanes.find((lane) => lane.id === event.active.id) ?? null);
        return;
      }

      const issue = issueMapRef.current.get(event.active.id as string) ?? null;
      if (!issue) return;
      isDraggingRef.current = true;
      setActiveIssue(issue);
    },
    [lanes],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over || recentlyMovedRef.current) return;

      const activeId = active.id as string;
      const overId = over.id as string;
      if (active.data.current?.type === "project-lane") return;

      setColumns((prev) => {
        const activeCol = findContainer(prev, activeId, visibleStatuses);
        const overCol = findContainer(prev, overId, visibleStatuses);
        if (
          !activeCol ||
          !overCol ||
          activeCol.laneId !== overCol.laneId ||
          activeCol.status === overCol.status
        ) {
          return prev;
        }

        recentlyMovedRef.current = true;
        const laneColumns = prev[activeCol.laneId]!;
        const oldIds = laneColumns[activeCol.status]!.filter((id) => id !== activeId);
        const newIds = [...laneColumns[overCol.status]!];
        const overIndex = newIds.indexOf(overId);
        const insertIndex = overIndex >= 0 ? overIndex : newIds.length;
        newIds.splice(insertIndex, 0, activeId);
        return {
          ...prev,
          [activeCol.laneId]: {
            ...laneColumns,
            [activeCol.status]: oldIds,
            [overCol.status]: newIds,
          },
        };
      });
    },
    [visibleStatuses],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeType = active.data.current?.type;
      if (activeType === "project-lane") {
        setActiveProjectLane(null);
        if (!over) return;

        const oldIndex = projectLaneIds.indexOf(active.id as string);
        const newIndex = projectLaneIds.indexOf(over.id as string);
        if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

        const reorderedLaneIds = arrayMove(projectLaneIds, oldIndex, newIndex);
        const positionById = new Map(
          lanes
            .filter((lane) => lane.project)
            .map((lane) => [lane.projectId as string, lane.project!.position]),
        );
        const updates = reorderProjectPositions(
          reorderedLaneIds.map((laneId) => laneId.replace(/^project:/, "")),
          positionById,
        );
        reorderProjects.mutate(updates, {
          onError: () => toast.error(t(($) => $.board.reorder_projects_failed)),
        });
        return;
      }

      isDraggingRef.current = false;
      setActiveIssue(null);

      const resetColumns = () => setColumns(buildLaneColumns(lanes));

      if (!over) {
        resetColumns();
        return;
      }

      const activeId = active.id as string;
      const overId = over.id as string;

      const cols = columnsRef.current;
      const activeCol = findContainer(cols, activeId, visibleStatuses);
      const overCol = findContainer(cols, overId, visibleStatuses);
      if (!activeCol || !overCol || activeCol.laneId !== overCol.laneId) {
        resetColumns();
        return;
      }

      // Same-column reorder
      let finalColumns = cols;
      if (activeCol.status === overCol.status) {
        const laneColumns = cols[activeCol.laneId]!;
        const ids = laneColumns[activeCol.status]!;
        const oldIndex = ids.indexOf(activeId);
        const newIndex = ids.indexOf(overId);
        if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
          const reordered = arrayMove(ids, oldIndex, newIndex);
          finalColumns = {
            ...cols,
            [activeCol.laneId]: { ...laneColumns, [activeCol.status]: reordered },
          };
          setColumns(finalColumns);
        }
      }

      const finalCol = findContainer(finalColumns, activeId, visibleStatuses);
      if (!finalCol) {
        resetColumns();
        return;
      }

      const map = issueMapRef.current;
      const finalIds = finalColumns[finalCol.laneId]![finalCol.status]!;
      const newPosition = computePosition(finalIds, activeId, map);
      const currentIssue = map.get(activeId);

      if (
        currentIssue &&
        currentIssue.status === finalCol.status &&
        currentIssue.position === newPosition
      ) {
        return;
      }

      onMoveIssue(activeId, finalCol.status, newPosition);
    },
    [lanes, visibleStatuses, onMoveIssue, projectLaneIds, reorderProjects, t],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={kanbanCollision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-1 min-h-0 overflow-auto p-4">
        <SortableContext items={projectLaneIds} strategy={verticalListSortingStrategy}>
          <div className="flex min-w-max flex-col gap-5">
            {lanes.map((lane, laneIndex) => (
              <ProjectSwimlane
                key={lane.id}
                lane={lane}
                issueColumns={columns[lane.id] ?? lane.columns}
                visibleStatuses={visibleStatuses}
                issueMap={issueMapRef.current}
                childProgressMap={childProgressMap}
                myIssuesOpts={myIssuesOpts}
                showLoadMoreFooter={laneIndex === lanes.length - 1}
                showHiddenColumns={laneIndex === 0 && hiddenStatuses.length > 0}
                hiddenStatuses={hiddenStatuses}
                projectId={lane.projectId ?? projectId}
              />
            ))}
          </div>
        </SortableContext>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeIssue ? (
          <div className="w-[196px] rotate-2 scale-105 cursor-grabbing opacity-90 shadow-lg shadow-black/10">
            <BoardCardContent issue={activeIssue} childProgress={childProgressMap.get(activeIssue.id)} />
          </div>
        ) : activeProjectLane ? (
          <ProjectLaneHeader lane={activeProjectLane} overlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ProjectSwimlane({
  lane,
  issueColumns,
  visibleStatuses,
  issueMap,
  childProgressMap,
  myIssuesOpts,
  showLoadMoreFooter,
  showHiddenColumns,
  hiddenStatuses,
  projectId,
}: {
  lane: BoardSwimlane;
  issueColumns: Record<IssueStatus, string[]>;
  visibleStatuses: IssueStatus[];
  issueMap: Map<string, Issue>;
  childProgressMap?: Map<string, ChildProgress>;
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
  showLoadMoreFooter: boolean;
  showHiddenColumns: boolean;
  hiddenStatuses: IssueStatus[];
  projectId?: string | null;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: lane.id,
    data: { type: "project-lane", projectId: lane.projectId },
    disabled: !lane.project,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <section
      ref={setNodeRef}
      style={style}
      className={`flex flex-col ${isDragging ? "opacity-50" : ""}`}
    >
      <ProjectLaneHeader
        lane={lane}
        attributes={attributes}
        listeners={listeners}
      />
      <div className="flex gap-4">
        {visibleStatuses.map((status) => (
          <BoardLaneColumn
            key={status}
            laneId={lane.id}
            status={status}
            issueIds={issueColumns[status] ?? []}
            issueMap={issueMap}
            childProgressMap={childProgressMap}
            myIssuesOpts={myIssuesOpts}
            projectId={projectId ?? undefined}
            showLoadMoreFooter={showLoadMoreFooter}
          />
        ))}
        {showHiddenColumns && (
          <HiddenColumnsPanel
            hiddenStatuses={hiddenStatuses}
            myIssuesOpts={myIssuesOpts}
          />
        )}
      </div>
    </section>
  );
}

function ProjectLaneHeader({
  lane,
  attributes,
  listeners,
  overlay = false,
}: {
  lane: BoardSwimlane;
  attributes?: SortableAttributes;
  listeners?: SortableListeners;
  overlay?: boolean;
}) {
  const { t } = useT("issues");
  const title = lane.project
    ? lane.project.title
    : lane.id === NO_PROJECT_LANE_ID
      ? t(($) => $.board.no_project_lane)
      : t(($) => $.board.unknown_project_lane);

  return (
    <div
      className={`mb-2 flex h-8 items-center justify-between rounded-lg px-1.5 ${
        overlay ? "w-[320px] border bg-card shadow-lg" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {lane.project ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-6 w-6 shrink-0 cursor-grab rounded-md text-muted-foreground active:cursor-grabbing"
            aria-label={t(($) => $.board.drag_project_handle)}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="size-3.5" />
          </Button>
        ) : (
          <span className="h-6 w-6 shrink-0" />
        )}
        {lane.project ? (
          <ProjectIcon project={lane.project} size="sm" className="shrink-0" />
        ) : null}
        <span className="truncate text-sm font-semibold">{title}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {lane.issueCount}
        </span>
      </div>
    </div>
  );
}

function BoardLaneColumn({
  laneId,
  status,
  issueIds,
  issueMap,
  childProgressMap,
  myIssuesOpts,
  projectId,
  showLoadMoreFooter,
}: {
  laneId: string;
  status: IssueStatus;
  issueIds: string[];
  issueMap: Map<string, Issue>;
  childProgressMap?: Map<string, ChildProgress>;
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
  projectId?: string;
  showLoadMoreFooter: boolean;
}) {
  const columnId = boardColumnId(laneId, status);
  const footer = showLoadMoreFooter ? (
    <StatusLoadMoreFooter status={status} myIssuesOpts={myIssuesOpts} />
  ) : undefined;
  return (
    <BoardColumn
      status={status}
      columnId={columnId}
      issueIds={issueIds}
      issueMap={issueMap}
      childProgressMap={childProgressMap}
      totalCount={issueIds.length}
      projectId={projectId}
      footer={footer}
    />
  );
}

function StatusLoadMoreFooter({
  status,
  myIssuesOpts,
}: {
  status: IssueStatus;
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
}) {
  const { loadMore, hasMore, isLoading } = useLoadMoreByStatus(
    status,
    myIssuesOpts,
  );
  return hasMore ? (
    <InfiniteScrollSentinel onVisible={loadMore} loading={isLoading} />
  ) : null;
}

function HiddenColumnsPanel({
  hiddenStatuses,
  myIssuesOpts,
}: {
  hiddenStatuses: IssueStatus[];
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
}) {
  const { t } = useT("issues");
  return (
    <div className="flex w-[240px] shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="text-sm font-medium text-muted-foreground">
          {t(($) => $.board.hidden_columns_label)}
        </span>
      </div>
      <div className="flex-1 space-y-0.5">
        {hiddenStatuses.map((status) => (
          <HiddenColumnRow
            key={status}
            status={status}
            myIssuesOpts={myIssuesOpts}
          />
        ))}
      </div>
    </div>
  );
}

function HiddenColumnRow({
  status,
  myIssuesOpts,
}: {
  status: IssueStatus;
  myIssuesOpts?: { scope: string; filter: MyIssuesFilter };
}) {
  const { t } = useT("issues");
  const viewStoreApi = useViewStoreApi();
  const { total } = useLoadMoreByStatus(status, myIssuesOpts);
  return (
    <div className="flex items-center justify-between rounded-lg px-2.5 py-2 hover:bg-muted/50">
      <div className="flex items-center gap-2">
        <StatusIcon status={status} className="h-3.5 w-3.5" />
        <span className="text-sm">{t(($) => $.status[status])}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{total}</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full text-muted-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => viewStoreApi.getState().showStatus(status)}
            >
              <Eye className="size-3.5" />
              {t(($) => $.board.show_column)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
