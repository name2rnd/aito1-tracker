import { describe, expect, it } from "vitest";
import type { Issue, Project } from "@multica/core/types";
import {
  NO_PROJECT_LANE_ID,
  buildProjectSwimlanes,
  renumberProjectPositions,
} from "./board-swimlanes";

function issue(id: string, status: Issue["status"], projectId: string | null, position: number): Issue {
  return {
    id,
    identifier: id,
    workspace_id: "ws-1",
    title: id,
    description: null,
    status,
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    position,
    due_date: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    number: 1,
    project_id: projectId,
    labels: [],
  };
}

function project(id: string, title: string, position: number): Project {
  return {
    id,
    workspace_id: "ws-1",
    title,
    description: null,
    icon: null,
    status: "planned",
    priority: "none",
    lead_type: null,
    lead_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    issue_count: 0,
    done_count: 0,
    position,
    resource_count: 0,
  };
}

describe("board swimlanes", () => {
  it("orders project lanes by project position and keeps no-project lane last", () => {
    const lanes = buildProjectSwimlanes(
      [
        issue("i-1", "todo", "p-2", 20),
        issue("i-2", "todo", "p-1", 10),
        issue("i-3", "todo", null, 30),
      ],
      [project("p-1", "Later", 20), project("p-2", "First", 10)],
      ["todo", "done"],
      "position",
      "asc",
    );

    expect(lanes.map((lane) => lane.id)).toEqual([
      "project:p-2",
      "project:p-1",
      NO_PROJECT_LANE_ID,
    ]);
    expect(lanes[0]!.columns.todo).toEqual(["i-1"]);
    expect(lanes[1]!.columns.todo).toEqual(["i-2"]);
    expect(lanes[2]!.columns.todo).toEqual(["i-3"]);
  });

  it("renumbers reordered projects with stable unique integer positions", () => {
    expect(renumberProjectPositions(["p-3", "p-1", "p-2"])).toEqual([
      { id: "p-3", position: 1 },
      { id: "p-1", position: 2 },
      { id: "p-2", position: 3 },
    ]);
  });
});
