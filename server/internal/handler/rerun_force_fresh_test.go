package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// AITO-322/AITO-275: POST /api/issues/{id}/rerun accepts an optional body
// {"force_fresh": false}. Default (no body) keeps the historical behaviour —
// a fresh session. force_fresh=false lets Brain retry a crashed Reflector
// with its prior session resumed (GetLastTaskSession serves failed sessions,
// so the partially-done reflection work is not thrown away).

func rerunFixture(t *testing.T) (issueID, agentID string) {
	t.Helper()
	ctx := context.Background()

	agentID = createHandlerTestAgent(t, "Rerun ForceFresh Agent", []byte(`{}`))

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":         "rerun force_fresh test",
		"status":        "in_progress",
		"assignee_type": "agent",
		"assignee_id":   agentID,
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var created IssueResponse
	json.NewDecoder(w.Body).Decode(&created)
	issueID = created.ID

	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		cleanupReq := newRequest("DELETE", "/api/issues/"+issueID, nil)
		cleanupReq = withURLParam(cleanupReq, "id", issueID)
		testHandler.DeleteIssue(httptest.NewRecorder(), cleanupReq)
	})
	return issueID, agentID
}

func rerunIssue(t *testing.T, issueID string, body any) AgentTaskResponse {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues/"+issueID+"/rerun", body)
	req = withURLParam(req, "id", issueID)
	testHandler.RerunIssue(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("RerunIssue: expected 202, got %d: %s", w.Code, w.Body.String())
	}
	var task AgentTaskResponse
	json.NewDecoder(w.Body).Decode(&task)
	return task
}

func taskForceFresh(t *testing.T, taskID string) bool {
	t.Helper()
	var ff bool
	if err := testPool.QueryRow(context.Background(),
		`SELECT force_fresh_session FROM agent_task_queue WHERE id = $1`, taskID).Scan(&ff); err != nil {
		t.Fatalf("read force_fresh_session: %v", err)
	}
	return ff
}

// No body — historical default, fresh session.
func TestRerunDefaultsToForceFresh(t *testing.T) {
	issueID, _ := rerunFixture(t)
	task := rerunIssue(t, issueID, nil)
	if !taskForceFresh(t, task.ID) {
		t.Fatal("rerun without body must enqueue force_fresh_session=true")
	}
}

// Explicit force_fresh=false — resume semantics.
func TestRerunForceFreshFalseResumesSession(t *testing.T) {
	issueID, _ := rerunFixture(t)
	task := rerunIssue(t, issueID, map[string]any{"force_fresh": false})
	if taskForceFresh(t, task.ID) {
		t.Fatal("rerun with force_fresh=false must enqueue force_fresh_session=false")
	}
}

// Explicit true behaves like the default.
func TestRerunForceFreshTrueExplicit(t *testing.T) {
	issueID, _ := rerunFixture(t)
	task := rerunIssue(t, issueID, map[string]any{"force_fresh": true})
	if !taskForceFresh(t, task.ID) {
		t.Fatal("rerun with force_fresh=true must enqueue force_fresh_session=true")
	}
}
