package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
)

// AITO-261: the daemon proves a task is alive through its regular calls —
// the 5-second GetTaskStatus poll and ReportTaskMessages batches. Both must
// refresh agent_task_queue.last_heartbeat_at (throttled) so FailStaleTasks
// can judge running tasks by silence instead of total runtime.

func setupHeartbeatTask(t *testing.T, heartbeat string) string {
	t.Helper()
	ctx := context.Background()

	var issueID string
	err := testPool.QueryRow(ctx, `
		INSERT INTO issue (workspace_id, title, status, priority, creator_id, creator_type)
		VALUES ($1, 'heartbeat-touch-test', 'in_progress', 'none', $2, 'member')
		RETURNING id
	`, testWorkspaceID, testUserID).Scan(&issueID)
	if err != nil {
		t.Fatalf("setup issue: %v", err)
	}

	var agentID, runtimeID string
	err = testPool.QueryRow(ctx,
		`SELECT a.id, a.runtime_id FROM agent a WHERE a.workspace_id = $1 LIMIT 1`,
		testWorkspaceID).Scan(&agentID, &runtimeID)
	if err != nil {
		t.Fatalf("setup agent: %v", err)
	}

	var taskID string
	err = testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, started_at, last_heartbeat_at)
		VALUES ($1, $2, $3, 'running', 0, now() - interval '1 hour', `+heartbeat+`)
		RETURNING id
	`, agentID, runtimeID, issueID).Scan(&taskID)
	if err != nil {
		t.Fatalf("setup task: %v", err)
	}

	t.Cleanup(func() {
		testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, taskID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issueID)
	})
	return taskID
}

func heartbeatAgeSecs(t *testing.T, taskID string) float64 {
	t.Helper()
	var age *float64
	err := testPool.QueryRow(context.Background(),
		`SELECT extract(epoch from now() - last_heartbeat_at) FROM agent_task_queue WHERE id = $1`,
		taskID).Scan(&age)
	if err != nil {
		t.Fatalf("read heartbeat: %v", err)
	}
	if age == nil {
		return -1 // NULL heartbeat
	}
	return *age
}

func callGetTaskStatus(t *testing.T, taskID string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/daemon/tasks/"+taskID+"/status", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("taskId", taskID)
	req = req.WithContext(context.WithValue(
		middleware.WithDaemonContext(req.Context(), testWorkspaceID, "heartbeat-test-daemon"),
		chi.RouteCtxKey, rctx))
	testHandler.GetTaskStatus(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GetTaskStatus: expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func callReportTaskMessages(t *testing.T, taskID string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newDaemonTokenRequest("POST", "/api/daemon/tasks/"+taskID+"/messages", map[string]any{
		"messages": []map[string]any{{"seq": 1, "type": "text", "content": "heartbeat test"}},
	}, testWorkspaceID, "heartbeat-test-daemon")
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("taskId", taskID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	testHandler.ReportTaskMessages(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("ReportTaskMessages: expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

// The status poll must refresh a NULL heartbeat.
func TestGetTaskStatusTouchesNullHeartbeat(t *testing.T) {
	taskID := setupHeartbeatTask(t, "NULL")

	callGetTaskStatus(t, taskID)

	if age := heartbeatAgeSecs(t, taskID); age < 0 || age > 5 {
		t.Fatalf("expected fresh heartbeat after status poll, got age %.0fs", age)
	}
}

// The status poll must refresh a stale heartbeat.
func TestGetTaskStatusTouchesStaleHeartbeat(t *testing.T) {
	taskID := setupHeartbeatTask(t, "now() - interval '10 minutes'")

	callGetTaskStatus(t, taskID)

	if age := heartbeatAgeSecs(t, taskID); age < 0 || age > 5 {
		t.Fatalf("expected fresh heartbeat after status poll, got age %.0fs", age)
	}
}

// A recent heartbeat is throttled — the poll must NOT rewrite it.
func TestGetTaskStatusThrottlesFreshHeartbeat(t *testing.T) {
	taskID := setupHeartbeatTask(t, "now() - interval '10 seconds'")

	callGetTaskStatus(t, taskID)

	if age := heartbeatAgeSecs(t, taskID); age < 5 {
		t.Fatalf("expected throttled heartbeat (~10s old), got age %.0fs", age)
	}
}

// Message batches refresh the heartbeat too.
func TestReportTaskMessagesTouchesStaleHeartbeat(t *testing.T) {
	taskID := setupHeartbeatTask(t, "now() - interval '10 minutes'")

	callReportTaskMessages(t, taskID)

	if age := heartbeatAgeSecs(t, taskID); age < 0 || age > 5 {
		t.Fatalf("expected fresh heartbeat after message batch, got age %.0fs", age)
	}
}
