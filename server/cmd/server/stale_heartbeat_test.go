package main

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// AITO-261: FailStaleTasks must judge running tasks by silence
// (COALESCE(last_heartbeat_at, started_at)), not by total runtime. A
// long-running agent that keeps heartbeating is alive; one whose daemon
// stopped touching the row is stale regardless of when it started.

func insertRunningTaskWithHeartbeat(t *testing.T, heartbeat string) (string, string, string) {
	t.Helper()
	ctx := context.Background()

	issueID, agentID, _ := func() (string, string, string) {
		// Reuse the sweeper fixture for the issue/agent, then create our own
		// task with a controlled heartbeat — the fixture's task shapes are
		// fixed.
		return setupSweeperTestFixture(t, "dispatched")
	}()
	// Drop the fixture's dispatched task; this test only needs the issue.
	testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issueID)

	var runtimeID string
	if err := testPool.QueryRow(ctx, `SELECT runtime_id FROM agent WHERE id = $1`, agentID).Scan(&runtimeID); err != nil {
		t.Fatalf("failed to get runtime: %v", err)
	}

	var taskID string
	query := `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, dispatched_at, started_at, last_heartbeat_at)
		VALUES ($1, $2, $3, 'running', 0, now() - interval '3 hours', now() - interval '3 hours', ` + heartbeat + `)
		RETURNING id`
	if err := testPool.QueryRow(ctx, query, agentID, runtimeID, issueID).Scan(&taskID); err != nil {
		t.Fatalf("failed to create task: %v", err)
	}

	t.Cleanup(func() { cleanupSweeperFixture(t, issueID, agentID) })
	return issueID, agentID, taskID
}

func failStale(t *testing.T) map[[16]byte]bool {
	t.Helper()
	queries := db.New(testPool)
	failed, err := queries.FailStaleTasks(context.Background(), db.FailStaleTasksParams{
		DispatchTimeoutSecs: 300.0,
		RunningTimeoutSecs:  9000.0,
	})
	if err != nil {
		t.Fatalf("FailStaleTasks: %v", err)
	}
	ids := make(map[[16]byte]bool, len(failed))
	for _, f := range failed {
		ids[f.ID.Bytes] = true
	}
	return ids
}

func taskUUID(taskID string) pgtype.UUID {
	return pgtype.UUID{Bytes: parseUUIDBytes(taskID), Valid: true}
}

// A 3-hour-old running task with a fresh heartbeat is alive — must survive.
func TestFailStaleTasksKeepsRunningTaskWithFreshHeartbeat(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	_, _, taskID := insertRunningTaskWithHeartbeat(t, "now()")

	if failStale(t)[parseUUIDBytes(taskID)] {
		t.Fatal("task with fresh heartbeat was failed by the sweeper")
	}
	var status string
	testPool.QueryRow(context.Background(), `SELECT status FROM agent_task_queue WHERE id = $1`, taskID).Scan(&status)
	if status != "running" {
		t.Fatalf("expected running, got %q", status)
	}
}

// A running task whose heartbeat went silent past the threshold is stale.
func TestFailStaleTasksFailsRunningTaskWithStaleHeartbeat(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	_, _, taskID := insertRunningTaskWithHeartbeat(t, "now() - interval '3 hours'")

	if !failStale(t)[parseUUIDBytes(taskID)] {
		t.Fatal("task with stale heartbeat was not failed by the sweeper")
	}
}

// NULL heartbeat falls back to started_at — pre-heartbeat rows keep the old
// behaviour.
func TestFailStaleTasksNullHeartbeatFallsBackToStartedAt(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	_, _, taskID := insertRunningTaskWithHeartbeat(t, "NULL")

	if !failStale(t)[parseUUIDBytes(taskID)] {
		t.Fatal("task with NULL heartbeat and stale started_at was not failed")
	}
}

// TouchTaskHeartbeat refreshes active rows and must not write into terminal
// ones.
func TestTouchTaskHeartbeatOnlyTouchesActiveTasks(t *testing.T) {
	if testPool == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	queries := db.New(testPool)

	_, _, taskID := insertRunningTaskWithHeartbeat(t, "now() - interval '3 hours'")

	if err := queries.TouchTaskHeartbeat(ctx, taskUUID(taskID)); err != nil {
		t.Fatalf("TouchTaskHeartbeat: %v", err)
	}
	var ageSecs float64
	testPool.QueryRow(ctx, `SELECT extract(epoch from now() - last_heartbeat_at) FROM agent_task_queue WHERE id = $1`, taskID).Scan(&ageSecs)
	if ageSecs > 5 {
		t.Fatalf("heartbeat not refreshed on running task: age %.0fs", ageSecs)
	}

	// Terminal row: heartbeat must stay untouched.
	testPool.Exec(ctx, `UPDATE agent_task_queue SET status = 'completed', completed_at = now(), last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, taskID)
	if err := queries.TouchTaskHeartbeat(ctx, taskUUID(taskID)); err != nil {
		t.Fatalf("TouchTaskHeartbeat on terminal: %v", err)
	}
	testPool.QueryRow(ctx, `SELECT extract(epoch from now() - last_heartbeat_at) FROM agent_task_queue WHERE id = $1`, taskID).Scan(&ageSecs)
	if ageSecs < 3000 {
		t.Fatalf("heartbeat was overwritten on a terminal task: age %.0fs", ageSecs)
	}
}
