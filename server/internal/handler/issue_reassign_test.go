package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Helpers for the reassign-scope tests (AITO-323). A reassign must cancel
// only the previous assignee's tasks: tasks belonging to third agents on the
// same issue (@-mention, parallel work) have to survive.

func createIssueAssignedTo(t *testing.T, assigneeType, assigneeID string) string {
	t.Helper()

	w := httptest.NewRecorder()
	body := map[string]any{
		"title":  "Reassign scope test",
		"status": "in_progress",
	}
	if assigneeType != "" {
		body["assignee_type"] = assigneeType
		body["assignee_id"] = assigneeID
	}
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, body)
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var created IssueResponse
	json.NewDecoder(w.Body).Decode(&created)

	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, created.ID)
		cleanupReq := newRequest("DELETE", "/api/issues/"+created.ID, nil)
		cleanupReq = withURLParam(cleanupReq, "id", created.ID)
		testHandler.DeleteIssue(httptest.NewRecorder(), cleanupReq)
	})

	return created.ID
}

func insertRunningTask(t *testing.T, issueID, agentID string) string {
	t.Helper()

	var taskID string
	err := testPool.QueryRow(context.Background(),
		`INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, started_at)
		 VALUES ($1, $2, $3, 'running', 0, now())
		 RETURNING id`, agentID, handlerTestRuntimeID(t), issueID,
	).Scan(&taskID)
	if err != nil {
		t.Fatalf("failed to insert running task: %v", err)
	}
	return taskID
}

func taskStatus(t *testing.T, taskID string) string {
	t.Helper()

	var status string
	if err := testPool.QueryRow(context.Background(),
		`SELECT status FROM agent_task_queue WHERE id = $1`, taskID,
	).Scan(&status); err != nil {
		t.Fatalf("failed to read task status: %v", err)
	}
	return status
}

// TestReassignCancelsOnlyPrevAssigneeTasks: issue assigned to agent A with a
// running task; agent B also has a running task on the same issue. Reassign
// A→C must cancel A's task and leave B's untouched.
func TestReassignCancelsOnlyPrevAssigneeTasks(t *testing.T) {
	agentA := createHandlerTestAgent(t, "Reassign Prev Agent", []byte(`{}`))
	agentB := createHandlerTestAgent(t, "Reassign Bystander Agent", []byte(`{}`))
	agentC := createHandlerTestAgent(t, "Reassign Next Agent", []byte(`{}`))

	issueID := createIssueAssignedTo(t, "agent", agentA)
	taskA := insertRunningTask(t, issueID, agentA)
	taskB := insertRunningTask(t, issueID, agentB)

	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"assignee_type": "agent",
		"assignee_id":   agentC,
	})
	req = withURLParam(req, "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if got := taskStatus(t, taskA); got != "cancelled" {
		t.Errorf("prev assignee task: expected cancelled, got %q", got)
	}
	if got := taskStatus(t, taskB); got != "running" {
		t.Errorf("bystander task: expected running, got %q", got)
	}
}

// TestReassignFromMemberKeepsAgentTasks: when the previous assignee is a
// member (no agent tasks of their own), reassigning must not cancel anything.
func TestReassignFromMemberKeepsAgentTasks(t *testing.T) {
	agentA := createHandlerTestAgent(t, "Reassign Member Next Agent", []byte(`{}`))
	agentB := createHandlerTestAgent(t, "Reassign Member Bystander", []byte(`{}`))

	issueID := createIssueAssignedTo(t, "member", testUserID)
	taskB := insertRunningTask(t, issueID, agentB)

	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"assignee_type": "agent",
		"assignee_id":   agentA,
	})
	req = withURLParam(req, "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if got := taskStatus(t, taskB); got != "running" {
		t.Errorf("bystander task: expected running, got %q", got)
	}
}

// TestCancelStatusCancelsAllTasks: flipping the issue to `cancelled` is a
// user-initiated terminal action and must still cancel every agent's tasks
// (the unconditional path is intentional there).
func TestCancelStatusCancelsAllTasks(t *testing.T) {
	agentA := createHandlerTestAgent(t, "Cancel Status Agent A", []byte(`{}`))
	agentB := createHandlerTestAgent(t, "Cancel Status Agent B", []byte(`{}`))

	issueID := createIssueAssignedTo(t, "agent", agentA)
	taskA := insertRunningTask(t, issueID, agentA)
	taskB := insertRunningTask(t, issueID, agentB)

	w := httptest.NewRecorder()
	req := newRequest("PUT", "/api/issues/"+issueID, map[string]any{
		"status": "cancelled",
	})
	req = withURLParam(req, "id", issueID)
	testHandler.UpdateIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("UpdateIssue: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if got := taskStatus(t, taskA); got != "cancelled" {
		t.Errorf("task A: expected cancelled, got %q", got)
	}
	if got := taskStatus(t, taskB); got != "cancelled" {
		t.Errorf("task B: expected cancelled, got %q", got)
	}
}

// TestBatchReassignCancelsOnlyPrevAssigneeTasks: same scope rule on the
// batch-update path (the second copy of the assigneeChanged block).
func TestBatchReassignCancelsOnlyPrevAssigneeTasks(t *testing.T) {
	agentA := createHandlerTestAgent(t, "Batch Reassign Prev", []byte(`{}`))
	agentB := createHandlerTestAgent(t, "Batch Reassign Bystander", []byte(`{}`))
	agentC := createHandlerTestAgent(t, "Batch Reassign Next", []byte(`{}`))

	issueID := createIssueAssignedTo(t, "agent", agentA)
	taskA := insertRunningTask(t, issueID, agentA)
	taskB := insertRunningTask(t, issueID, agentB)

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues/batch-update", map[string]any{
		"issue_ids": []string{issueID},
		"updates": map[string]any{
			"assignee_type": "agent",
			"assignee_id":   agentC,
		},
	})
	testHandler.BatchUpdateIssues(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("BatchUpdateIssues: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	if got := taskStatus(t, taskA); got != "cancelled" {
		t.Errorf("prev assignee task: expected cancelled, got %q", got)
	}
	if got := taskStatus(t, taskB); got != "running" {
		t.Errorf("bystander task: expected running, got %q", got)
	}
}
