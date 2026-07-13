package main

import (
	"context"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/realtime"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func correlatedTaskService() (*service.TaskService, *db.Queries) {
	queries := db.New(testPool)
	hub := realtime.NewHub()
	go hub.Run()
	return service.NewTaskService(queries, testPool, hub, events.New()), queries
}

func TestCorrelatedCreateReturnsExistingTerminalRun(t *testing.T) {
	if testPool == nil {
		t.Skip("no database connection")
	}
	issueID, _, _ := setupRerunTestFixture(t)
	t.Cleanup(func() { cleanupRerunFixture(t, issueID) })

	ctx := context.Background()
	svc, queries := correlatedTaskService()
	issue, err := queries.GetIssue(ctx, util.MustParseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	correlation := service.RunCorrelation{EffectID: "effect-sequential-" + issueID, BindingGeneration: 4, AgentRole: "executor"}

	first, err := svc.EnqueueTaskForIssueCorrelated(ctx, issue, correlation)
	if err != nil {
		t.Fatalf("first correlated create: %v", err)
	}
	if _, err := testPool.Exec(ctx, `UPDATE agent_task_queue SET status='completed', completed_at=now() WHERE id=$1`, first.ID); err != nil {
		t.Fatal(err)
	}
	second, err := svc.EnqueueTaskForIssueCorrelated(ctx, issue, correlation)
	if err != nil {
		t.Fatalf("duplicate correlated create: %v", err)
	}
	if first.ID != second.ID || second.Status != "completed" {
		t.Fatalf("duplicate returned %+v; want existing completed row %v", second, first.ID)
	}

	var count int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM agent_task_queue WHERE effect_id=$1`, correlation.EffectID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("correlated rows = %d, want 1", count)
	}
	changed := correlation
	changed.BindingGeneration++
	if _, err := svc.EnqueueTaskForIssueCorrelated(ctx, issue, changed); err == nil {
		t.Fatal("same effect_id with different correlation metadata must be rejected")
	}
}

func TestConcurrentCorrelatedCreateProducesOneRun(t *testing.T) {
	if testPool == nil {
		t.Skip("no database connection")
	}
	issueID, _, _ := setupRerunTestFixture(t)
	t.Cleanup(func() { cleanupRerunFixture(t, issueID) })

	ctx := context.Background()
	svc, queries := correlatedTaskService()
	issue, err := queries.GetIssue(ctx, util.MustParseUUID(issueID))
	if err != nil {
		t.Fatal(err)
	}
	correlation := service.RunCorrelation{EffectID: "effect-concurrent-" + issueID, BindingGeneration: 7, AgentRole: "planner"}

	const callers = 8
	start := make(chan struct{})
	ids := make(chan string, callers)
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			task, createErr := svc.EnqueueTaskForIssueCorrelated(ctx, issue, correlation)
			if createErr != nil {
				errs <- createErr
				return
			}
			ids <- util.UUIDToString(task.ID)
		}()
	}
	close(start)
	wg.Wait()
	close(ids)
	close(errs)
	for createErr := range errs {
		t.Fatalf("concurrent correlated create: %v", createErr)
	}

	var firstID string
	for id := range ids {
		if firstID == "" {
			firstID = id
		}
		if id != firstID {
			t.Fatalf("returned different task ids: %s and %s", firstID, id)
		}
	}
	var count int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM agent_task_queue WHERE effect_id=$1`, correlation.EffectID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("correlated rows = %d, want 1", count)
	}
}

func TestConcurrentCorrelatedRerunDoesNotCancelWinningRun(t *testing.T) {
	if testPool == nil {
		t.Skip("no database connection")
	}
	issueID, _, _ := setupRerunTestFixture(t)
	t.Cleanup(func() { cleanupRerunFixture(t, issueID) })

	ctx := context.Background()
	svc, _ := correlatedTaskService()
	correlation := service.RunCorrelation{EffectID: "effect-rerun-" + issueID, BindingGeneration: 8, AgentRole: "reflect"}

	const callers = 6
	start := make(chan struct{})
	ids := make(chan string, callers)
	errs := make(chan error, callers)
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			task, rerunErr := svc.RerunIssueCorrelated(ctx, util.MustParseUUID(issueID), pgtype.UUID{}, false, correlation)
			if rerunErr != nil {
				errs <- rerunErr
				return
			}
			ids <- util.UUIDToString(task.ID)
		}()
	}
	close(start)
	wg.Wait()
	close(ids)
	close(errs)
	for rerunErr := range errs {
		t.Fatalf("concurrent correlated rerun: %v", rerunErr)
	}

	var firstID string
	for id := range ids {
		if firstID == "" {
			firstID = id
		}
		if id != firstID {
			t.Fatalf("returned different rerun ids: %s and %s", firstID, id)
		}
	}
	var count int
	var status string
	if err := testPool.QueryRow(ctx, `SELECT count(*), min(status) FROM agent_task_queue WHERE effect_id=$1`, correlation.EffectID).Scan(&count, &status); err != nil {
		t.Fatal(err)
	}
	if count != 1 || status != "queued" {
		t.Fatalf("correlated rerun rows=%d status=%q, want one queued winner", count, status)
	}
}
