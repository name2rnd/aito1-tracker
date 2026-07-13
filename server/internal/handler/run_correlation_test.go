package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRunCorrelationFeatureFlagDefaultsToLegacyBehavior(t *testing.T) {
	effectID := "effect-disabled"
	role := "planner"
	generation := int32(1)
	h := &Handler{cfg: Config{}}
	correlation, err := h.runCorrelation(RunCorrelationRequest{
		EffectID:          &effectID,
		BindingGeneration: &generation,
		AgentRole:         &role,
	})
	if err != nil || correlation != nil {
		t.Fatalf("disabled flag must ignore correlation fields: correlation=%+v err=%v", correlation, err)
	}
}

func TestListTasksByIssueReturnsRunCorrelation(t *testing.T) {
	agentID := createHandlerTestAgent(t, "Correlation List Agent", []byte(`{}`))
	ctx := context.Background()

	var issueID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (
			workspace_id, title, status, priority, creator_type, creator_id,
			assignee_type, assignee_id
		)
		VALUES ($1, 'correlation list', 'todo', 'medium', 'member', $2, 'agent', $3)
		RETURNING id
	`, testWorkspaceID, testUserID, agentID).Scan(&issueID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { testPool.Exec(context.Background(), `DELETE FROM issue WHERE id=$1`, issueID) })

	if _, err := testPool.Exec(ctx, `
		INSERT INTO agent_task_queue (
			agent_id, runtime_id, issue_id, status, priority,
			effect_id, binding_generation, agent_role
		)
		VALUES ($1, $2, $3, 'queued', 0, 'effect-list-fields', 12, 'reflect')
	`, agentID, handlerTestRuntimeID(t), issueID); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	req := newRequest(http.MethodGet, "/api/issues/"+issueID+"/task-runs", nil)
	req = withURLParam(req, "id", issueID)
	testHandler.ListTasksByIssue(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ListTasksByIssue: got %d: %s", w.Code, w.Body.String())
	}
	var runs []AgentTaskResponse
	if err := json.NewDecoder(w.Body).Decode(&runs); err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("runs = %d, want 1", len(runs))
	}
	if runs[0].EffectID == nil || *runs[0].EffectID != "effect-list-fields" ||
		runs[0].BindingGeneration == nil || *runs[0].BindingGeneration != 12 ||
		runs[0].AgentRole == nil || *runs[0].AgentRole != "reflect" {
		t.Fatalf("correlation fields missing from task-runs response: %+v", runs[0])
	}
}
