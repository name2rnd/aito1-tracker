package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
)

// authRequestWithAgent makes an authenticated request with X-Agent-ID header,
// causing the server to resolve the actor as an agent instead of a member.
func authRequestWithAgent(t *testing.T, method, path string, body any, agentID string) *http.Response {
	t.Helper()
	var bodyReader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		bodyReader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, testServer.URL+path, bodyReader)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("X-Workspace-ID", testWorkspaceID)
	req.Header.Set("X-Agent-ID", agentID)

	r, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	return r
}

// countPendingTasks returns the number of queued/dispatched tasks for an issue.
func countPendingTasks(t *testing.T, issueID string) int {
	t.Helper()
	var count int
	err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM agent_task_queue WHERE issue_id = $1 AND status IN ('queued', 'dispatched')`,
		issueID).Scan(&count)
	if err != nil {
		t.Fatalf("failed to count pending tasks: %v", err)
	}
	return count
}

// clearTasks deletes all tasks for an issue (cleanup between subtests).
func clearTasks(t *testing.T, issueID string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
	if err != nil {
		t.Fatalf("failed to clear tasks: %v", err)
	}
}

// getAgentID returns the ID of the first agent in the test workspace.
func getAgentID(t *testing.T) string {
	t.Helper()
	resp := authRequest(t, "GET", "/api/agents?workspace_id="+testWorkspaceID, nil)
	var agents []map[string]any
	readJSON(t, resp, &agents)
	if len(agents) == 0 {
		t.Fatal("no agents in test workspace")
	}
	return agents[0]["id"].(string)
}

// createSecondAgent creates a second agent in the test workspace and returns its ID.
// It reuses the same runtime as the first agent.
func createSecondAgent(t *testing.T) string {
	t.Helper()
	resp := authRequest(t, "GET", "/api/agents?workspace_id="+testWorkspaceID, nil)
	var agents []map[string]any
	readJSON(t, resp, &agents)
	if len(agents) == 0 {
		t.Fatal("no agents in test workspace")
	}
	runtimeID := agents[0]["runtime_id"].(string)

	resp = authRequest(t, "POST", "/api/agents?workspace_id="+testWorkspaceID, map[string]any{
		"name":       "Second Test Agent",
		"runtime_id": runtimeID,
		"visibility": "workspace",
	})
	if resp.StatusCode != 201 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("CreateAgent: expected 201, got %d: %s", resp.StatusCode, body)
	}
	var agent map[string]any
	readJSON(t, resp, &agent)
	id := agent["id"].(string)
	t.Cleanup(func() {
		authRequest(t, "POST", "/api/agents/"+id+"/archive?workspace_id="+testWorkspaceID, nil)
	})
	return id
}

// createIssueAssignedToAgent creates a todo issue assigned to the given agent.
func createIssueAssignedToAgent(t *testing.T, title, agentID string) string {
	t.Helper()
	resp := authRequest(t, "PUT", fmt.Sprintf("/api/issues/%s", createIssue(t, title)), map[string]any{
		"assignee_type": "agent",
		"assignee_id":   agentID,
	})
	var issue map[string]any
	readJSON(t, resp, &issue)
	return issue["id"].(string)
}

// createIssue creates a basic todo issue and returns its ID.
func createIssue(t *testing.T, title string) string {
	t.Helper()
	resp := authRequest(t, "POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":  title,
		"status": "todo",
	})
	if resp.StatusCode != 201 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("CreateIssue: expected 201, got %d: %s", resp.StatusCode, body)
	}
	var issue map[string]any
	readJSON(t, resp, &issue)
	return issue["id"].(string)
}

// postComment posts a comment as the test member. Patch 7: flat comments only,
// no parent_id parameter.
func postComment(t *testing.T, issueID, content string) string {
	t.Helper()
	body := map[string]any{
		"content": content,
		"type":    "comment",
	}
	resp := authRequest(t, "POST", "/api/issues/"+issueID+"/comments", body)
	if resp.StatusCode != 201 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("postComment: expected 201, got %d: %s", resp.StatusCode, b)
	}
	var comment map[string]any
	readJSON(t, resp, &comment)
	return comment["id"].(string)
}

// postCommentAsAgent posts a comment with the X-Agent-ID header. Patch 7: flat
// comments only.
func postCommentAsAgent(t *testing.T, issueID, content, agentID string) string {
	t.Helper()
	body := map[string]any{
		"content": content,
		"type":    "comment",
	}
	resp := authRequestWithAgent(t, "POST", "/api/issues/"+issueID+"/comments", body, agentID)
	if resp.StatusCode != 201 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("postCommentAsAgent: expected 201, got %d: %s", resp.StatusCode, b)
	}
	var comment map[string]any
	readJSON(t, resp, &comment)
	return comment["id"].(string)
}

// TestCommentTriggerOnComment tests on_comment trigger scenarios end-to-end
// for flat comments (Patch 7: reply mechanic removed). Verifies that the agent
// task queue is populated correctly based on author type and @mentions.
func TestCommentTriggerOnComment(t *testing.T) {
	agentID := getAgentID(t)
	issueID := createIssueAssignedToAgent(t, "Comment trigger integration test", agentID)
	t.Cleanup(func() {
		clearTasks(t, issueID)
		resp := authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
		resp.Body.Close()
	})

	t.Run("member comment without mentions triggers agent", func(t *testing.T) {
		clearTasks(t, issueID)
		postComment(t, issueID, "Please fix this bug")
		if n := countPendingTasks(t, issueID); n != 1 {
			t.Errorf("expected 1 pending task, got %d", n)
		}
	})

	t.Run("member comment mentioning only others suppresses trigger", func(t *testing.T) {
		clearTasks(t, issueID)
		// Mention a fake agent UUID that is not the assignee.
		content := "[@SomeoneElse](mention://agent/00000000-0000-0000-0000-000000000001) what do you think?"
		postComment(t, issueID, content)
		if n := countPendingTasks(t, issueID); n != 0 {
			t.Errorf("expected 0 pending tasks, got %d", n)
		}
	})

	t.Run("member comment mentioning assignee triggers agent", func(t *testing.T) {
		clearTasks(t, issueID)
		content := fmt.Sprintf("[@Agent](mention://agent/%s) fix this", agentID)
		postComment(t, issueID, content)
		if n := countPendingTasks(t, issueID); n != 1 {
			t.Errorf("expected 1 pending task, got %d", n)
		}
	})

	// Patch 7 invariant: agent-authored comments must never enqueue a task for
	// the assignee — otherwise the assignee would loop forever on its own
	// output. This is also the explicit guarantee Natasha asked for when we
	// dropped reply mechanics: «agent-комменты не триггерят сам себя».
	t.Run("agent comment on its own assigned issue does not trigger self", func(t *testing.T) {
		clearTasks(t, issueID)
		// Agent (assignee) posts a comment on its own issue.
		postCommentAsAgent(t, issueID, "Working on it.", agentID)
		if n := countPendingTasks(t, issueID); n != 0 {
			t.Errorf("expected 0 pending tasks (no self-trigger), got %d", n)
		}
	})

	t.Run("member comment after agent comment still triggers", func(t *testing.T) {
		clearTasks(t, issueID)
		// Agent posts first (e.g. a status update).
		postCommentAsAgent(t, issueID, "Initial analysis done.", agentID)
		// Member follows up — must trigger the agent.
		postComment(t, issueID, "Please continue with the second step")
		if n := countPendingTasks(t, issueID); n != 1 {
			t.Errorf("expected 1 pending task (member follow-up), got %d", n)
		}
	})
}

// TestCommentTriggerAtAllSuppression verifies that @all mentions do not
// trigger agent execution — @all is a broadcast, not a direct request.
func TestCommentTriggerAtAllSuppression(t *testing.T) {
	agentID := getAgentID(t)
	issueID := createIssueAssignedToAgent(t, "@all suppression test", agentID)
	t.Cleanup(func() {
		clearTasks(t, issueID)
		resp := authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
		resp.Body.Close()
	})

	t.Run("@all comment suppresses on_comment", func(t *testing.T) {
		clearTasks(t, issueID)
		postComment(t, issueID, "[@All](mention://all/all) heads up everyone")
		if n := countPendingTasks(t, issueID); n != 0 {
			t.Errorf("expected 0 pending tasks (@all should not trigger agent), got %d", n)
		}
	})
}

// TestCommentTriggerOnAssignNoStatusGate verifies that assigning an agent to
// a non-todo issue still triggers the agent (status gate was removed).
func TestCommentTriggerOnAssignNoStatusGate(t *testing.T) {
	agentID := getAgentID(t)

	// Create an in_progress issue.
	issueID := createIssue(t, "On-assign status gate test")
	resp := authRequest(t, "PUT", "/api/issues/"+issueID, map[string]any{
		"status": "in_progress",
	})
	resp.Body.Close()

	t.Cleanup(func() {
		clearTasks(t, issueID)
		resp := authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
		resp.Body.Close()
	})

	// Assign the agent — should trigger despite non-todo status.
	resp = authRequest(t, "PUT", "/api/issues/"+issueID, map[string]any{
		"assignee_type": "agent",
		"assignee_id":   agentID,
	})
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("assign agent: expected 200, got %d: %s", resp.StatusCode, body)
	}
	resp.Body.Close()

	if n := countPendingTasks(t, issueID); n != 1 {
		t.Errorf("expected 1 pending task after assigning to in_progress issue, got %d", n)
	}
}

// TestCommentTriggerOnMentionNoStatusGate verifies that @mentioning an agent
// on a done issue still triggers the agent (no status gate on on_mention).
func TestCommentTriggerOnMentionNoStatusGate(t *testing.T) {
	agentID := getAgentID(t)

	// Create a done issue (not assigned to agent).
	issueID := createIssue(t, "On-mention done issue test")
	resp := authRequest(t, "PUT", "/api/issues/"+issueID, map[string]any{
		"status": "done",
	})
	resp.Body.Close()

	t.Cleanup(func() {
		clearTasks(t, issueID)
		resp := authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
		resp.Body.Close()
	})

	// @mention the agent on a done issue — should still trigger.
	content := fmt.Sprintf("[@Agent](mention://agent/%s) found a problem here", agentID)
	postComment(t, issueID, content)

	if n := countPendingTasks(t, issueID); n != 1 {
		t.Errorf("expected 1 pending task after @mention on done issue, got %d", n)
	}
}

// TestCommentTriggerMultipleAgentMentions verifies that mentioning two distinct
// agents in the same comment enqueues a task for each of them. Without reply
// mechanics this is the canonical multi-agent broadcast path.
func TestCommentTriggerMultipleAgentMentions(t *testing.T) {
	agentA := getAgentID(t)
	agentB := createSecondAgent(t)

	issueID := createIssue(t, "Multi-agent mention test")
	t.Cleanup(func() {
		clearTasks(t, issueID)
		resp := authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
		resp.Body.Close()
	})

	content := fmt.Sprintf(
		"[@A](mention://agent/%s) and [@B](mention://agent/%s) please both look",
		agentA, agentB,
	)
	postComment(t, issueID, content)

	if n := countPendingTasks(t, issueID); n != 2 {
		t.Errorf("expected 2 pending tasks (one per mentioned agent), got %d", n)
	}
}

// TestDeleteCommentCancelsTriggeredTasks verifies that deleting a comment
// also cancels any active tasks that were triggered by it.
func TestDeleteCommentCancelsTriggeredTasks(t *testing.T) {
	agentID := getAgentID(t)
	issueID := createIssueAssignedToAgent(t, "Delete-comment cancels task test", agentID)
	t.Cleanup(func() {
		clearTasks(t, issueID)
		resp := authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
		resp.Body.Close()
	})

	t.Run("deleting trigger comment cancels its queued task", func(t *testing.T) {
		clearTasks(t, issueID)
		commentID := postComment(t, issueID, "Please fix this bug")
		if n := countPendingTasks(t, issueID); n != 1 {
			t.Fatalf("expected 1 pending task before delete, got %d", n)
		}

		resp := authRequest(t, "DELETE", "/api/comments/"+commentID, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("DeleteComment: expected 204, got %d", resp.StatusCode)
		}

		if n := countPendingTasks(t, issueID); n != 0 {
			t.Errorf("expected 0 pending tasks after deleting trigger comment, got %d", n)
		}
	})
}

// TestCommentTriggerCoalescing verifies that rapid-fire comments don't create
// duplicate tasks (coalescing dedup).
func TestCommentTriggerCoalescing(t *testing.T) {
	agentID := getAgentID(t)
	issueID := createIssueAssignedToAgent(t, "Coalescing test", agentID)
	t.Cleanup(func() {
		clearTasks(t, issueID)
		resp := authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
		resp.Body.Close()
	})

	// Post two comments rapidly — only 1 task should be created (coalescing).
	postComment(t, issueID, "First comment")
	postComment(t, issueID, "Second comment")

	if n := countPendingTasks(t, issueID); n != 1 {
		t.Errorf("expected 1 pending task (coalescing), got %d", n)
	}
}

// TestCommentTriggerMentionAssigneeDoneIssue verifies that @mentioning the
// assigned agent on a done issue still triggers execution.
func TestCommentTriggerMentionAssigneeDoneIssue(t *testing.T) {
	agentID := getAgentID(t)

	// Create an issue assigned to the agent, then mark it done.
	issueID := createIssueAssignedToAgent(t, "Mention-assignee-done test", agentID)
	clearTasks(t, issueID) // clear any tasks from assignment
	resp := authRequest(t, "PUT", "/api/issues/"+issueID, map[string]any{
		"status": "done",
	})
	resp.Body.Close()

	t.Cleanup(func() {
		clearTasks(t, issueID)
		resp := authRequest(t, "DELETE", "/api/issues/"+issueID, nil)
		resp.Body.Close()
	})

	// @mention the assigned agent on the done issue — should trigger.
	content := fmt.Sprintf("[@Agent](mention://agent/%s) reopen this please", agentID)
	postComment(t, issueID, content)

	if n := countPendingTasks(t, issueID); n != 1 {
		t.Errorf("expected 1 pending task after @mention of assignee on done issue, got %d", n)
	}
}
