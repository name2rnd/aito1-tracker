import type { Issue, IssueStatus, Project } from "@multica/core/types";
import type { SortField, SortDirection } from "@multica/core/issues/stores/view-store";
import { sortIssues } from "./sort";

export const NO_PROJECT_LANE_ID = "project:none";
export const PROJECT_LANE_PREFIX = "project:";

// Terminal statuses do not count as active work: a project whose issues are all
// done/cancelled is hidden from the board (no empty lanes cluttering the view).
const TERMINAL_STATUSES: IssueStatus[] = ["done", "cancelled"];

function activeIssueCount(issues: Issue[]): number {
  return issues.filter((issue) => !TERMINAL_STATUSES.includes(issue.status)).length;
}

export interface BoardSwimlane {
  id: string;
  projectId: string | null;
  project: Project | null;
  columns: Record<IssueStatus, string[]>;
  issueCount: number;
}

function emptyColumns(visibleStatuses: IssueStatus[]): Record<IssueStatus, string[]> {
  const columns = {} as Record<IssueStatus, string[]>;
  for (const status of visibleStatuses) columns[status] = [];
  return columns;
}

export function projectLaneId(projectId: string): string {
  return `${PROJECT_LANE_PREFIX}${projectId}`;
}

export function boardColumnId(laneId: string, status: IssueStatus): string {
  return `${laneId}/${status}`;
}

export function sortProjectsByPosition(projects: Project[]): Project[] {
  return [...projects].sort(
    (a, b) =>
      a.position - b.position ||
      a.created_at.localeCompare(b.created_at) ||
      a.title.localeCompare(b.title),
  );
}

export function buildProjectSwimlanes(
  issues: Issue[],
  projects: Project[],
  visibleStatuses: IssueStatus[],
  sortBy: SortField,
  sortDirection: SortDirection,
  scopedProjectId?: string,
): BoardSwimlane[] {
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const issuesByProject = new Map<string, Issue[]>();
  const noProjectIssues: Issue[] = [];

  for (const issue of issues) {
    if (issue.project_id) {
      const group = issuesByProject.get(issue.project_id) ?? [];
      group.push(issue);
      issuesByProject.set(issue.project_id, group);
    } else {
      noProjectIssues.push(issue);
    }
  }

  const projectIds = scopedProjectId
    ? [scopedProjectId]
    : sortProjectsByPosition(projects).map((project) => project.id);

  const lanes: BoardSwimlane[] = [];
  // A scoped board (single project) always shows its lane, even when empty;
  // the multi-project board hides lanes with no active work.
  const allowEmptyLanes = Boolean(scopedProjectId);
  const pushProjectLane = (projectId: string) => {
    const laneIssues = issuesByProject.get(projectId) ?? [];
    const activeCount = activeIssueCount(laneIssues);
    if (!allowEmptyLanes && activeCount === 0) return;
    const columns = emptyColumns(visibleStatuses);
    for (const status of visibleStatuses) {
      columns[status] = sortIssues(
        laneIssues.filter((issue) => issue.status === status),
        sortBy,
        sortDirection,
      ).map((issue) => issue.id);
    }
    lanes.push({
      id: projectLaneId(projectId),
      projectId,
      project: projectMap.get(projectId) ?? null,
      columns,
      issueCount: activeCount,
    });
  };

  for (const projectId of projectIds) pushProjectLane(projectId);

  if (!scopedProjectId) {
    const knownProjectIds = new Set(projectIds);
    const unknownProjectIds = [...issuesByProject.keys()]
      .filter((projectId) => !knownProjectIds.has(projectId))
      .sort();
    for (const projectId of unknownProjectIds) pushProjectLane(projectId);

    if (activeIssueCount(noProjectIssues) > 0) {
      const columns = emptyColumns(visibleStatuses);
      for (const status of visibleStatuses) {
        columns[status] = sortIssues(
          noProjectIssues.filter((issue) => issue.status === status),
          sortBy,
          sortDirection,
        ).map((issue) => issue.id);
      }
      lanes.push({
        id: NO_PROJECT_LANE_ID,
        projectId: null,
        project: null,
        columns,
        issueCount: activeIssueCount(noProjectIssues),
      });
    }
  }

  return lanes;
}

export function renumberProjectPositions(projectIds: string[]): { id: string; position: number }[] {
  return projectIds.map((id, index) => ({ id, position: index + 1 }));
}
