package handler

import (
	"context"
	"testing"
)

// AITO-275: integration test for the startup-failure claim gate. Lives in
// the handler package for its DB fixture; exercises
// TaskService.ClaimTaskForRuntime directly.

func insertTerminalStartupFailure(t *testing.T, issueID, agentID, runtimeID, reason, completedAgo string) {
	t.Helper()
	var id string
	err := testPool.QueryRow(context.Background(), `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, started_at, completed_at, failure_reason, error)
		VALUES ($1, $2, $3, 'failed', 0, now() - ($4)::interval, now() - ($4)::interval, $5, 'startup failure fixture')
		RETURNING id
	`, agentID, runtimeID, issueID, completedAgo, reason).Scan(&id)
	if err != nil {
		t.Fatalf("insert failed task: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM agent_task_queue WHERE id = $1`, id)
	})
}

func breakerGateFixture(t *testing.T) (issueID, agentID, runtimeID, queuedTaskID string) {
	t.Helper()
	ctx := context.Background()

	agentID = createHandlerTestAgent(t, "Breaker Gate Agent", []byte(`{}`))
	if err := testPool.QueryRow(ctx, `SELECT runtime_id FROM agent WHERE id = $1`, agentID).Scan(&runtimeID); err != nil {
		t.Fatalf("get runtime: %v", err)
	}

	if err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_id, creator_type, assignee_type, assignee_id)
		VALUES ($1, 'breaker-gate-test', 'todo', 'none', $2, 'member', 'agent', $3)
		RETURNING id
	`, testWorkspaceID, testUserID, agentID).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
	})

	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority)
		VALUES ($1, $2, $3, 'queued', 0)
		RETURNING id
	`, agentID, runtimeID, issueID).Scan(&queuedTaskID); err != nil {
		t.Fatalf("create queued task: %v", err)
	}
	return issueID, agentID, runtimeID, queuedTaskID
}

// A fresh streak of startup failures must hold the queued task back.
func TestClaimGateClosedDuringStartupFailureStreak(t *testing.T) {
	issueID, agentID, runtimeID, queuedTaskID := breakerGateFixture(t)

	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "agent_auth", "3 minutes")
	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "agent_auth", "2 minutes")
	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "api_unavailable", "1 minute")

	task, err := testHandler.TaskService.ClaimTaskForRuntime(context.Background(), parseUUID(runtimeID))
	if err != nil {
		t.Fatalf("ClaimTaskForRuntime: %v", err)
	}
	if task != nil {
		t.Fatalf("expected no task while breaker is open, got %s", uuidToString(task.ID))
	}

	var status string
	testPool.QueryRow(context.Background(), `SELECT status FROM agent_task_queue WHERE id = $1`, queuedTaskID).Scan(&status)
	if status != "queued" {
		t.Fatalf("queued task must stay parked, got %q", status)
	}
}

// After the cooldown the gate reopens and the queued task goes out (probe).
func TestClaimGateReopensAfterCooldown(t *testing.T) {
	issueID, agentID, runtimeID, queuedTaskID := breakerGateFixture(t)

	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "agent_auth", "8 minutes")
	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "agent_auth", "7 minutes")
	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "agent_auth", "6 minutes")

	task, err := testHandler.TaskService.ClaimTaskForRuntime(context.Background(), parseUUID(runtimeID))
	if err != nil {
		t.Fatalf("ClaimTaskForRuntime: %v", err)
	}
	if task == nil {
		t.Fatal("expected the queued task once cooldown elapsed, got none")
	}
	if uuidToString(task.ID) != queuedTaskID {
		t.Fatalf("expected task %s, got %s", queuedTaskID, uuidToString(task.ID))
	}
}

// Ordinary failures (agent_error) must never close the gate.
func TestClaimGateIgnoresOrdinaryFailures(t *testing.T) {
	issueID, agentID, runtimeID, queuedTaskID := breakerGateFixture(t)

	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "agent_error", "3 minutes")
	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "agent_error", "2 minutes")
	insertTerminalStartupFailure(t, issueID, agentID, runtimeID, "agent_error", "1 minute")

	task, err := testHandler.TaskService.ClaimTaskForRuntime(context.Background(), parseUUID(runtimeID))
	if err != nil {
		t.Fatalf("ClaimTaskForRuntime: %v", err)
	}
	if task == nil {
		t.Fatal("expected the queued task to be claimable, got none")
	}
	if uuidToString(task.ID) != queuedTaskID {
		t.Fatalf("expected task %s, got %s", queuedTaskID, uuidToString(task.ID))
	}
}
