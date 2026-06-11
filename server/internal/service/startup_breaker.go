package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// AITO-275: startup-failure circuit breaker.
//
// When the agent provider cannot start a session at all (expired auth, API
// outage), every dispatched task dies in ~1s with zero tool calls. The
// daemon classifies those as agent_auth / api_unavailable (see
// internal/daemon/startup_failure.go); this gate reads that history and
// stops handing out further tasks while the streak is fresh, instead of
// letting autopilot cron and daemon restarts burn runs for hours.
//
// The breaker is stateless on purpose — daemon restarts are part of the
// cascade it protects against, so its state must live in the task history
// itself. After the cooldown the next claim goes through and acts as the
// health probe: if the provider is still down the task fails in seconds,
// refreshes the streak and re-closes the gate; if it recovered, the task
// completes and breaks the streak. Queued tasks are safe to hold back —
// they carry no timeout (unlike dispatched ones).

const (
	// startupBreakerThreshold is how many newest terminal tasks must ALL be
	// startup failures before the gate closes. The daemon's resume-fallback
	// can double-count a single incident, so 3 ≈ two real failures.
	startupBreakerThreshold = 3
	// startupBreakerCooldown is how long the gate stays closed after the
	// latest startup failure. Also the effective probe interval while the
	// provider stays down.
	startupBreakerCooldown = 5 * time.Minute
)

// isStartupFailureReason matches the failure_reason values written by the
// daemon's classifyStartupFailure (string literals duplicated by the same
// convention as GetLastTaskSession's exclusion list).
func isStartupFailureReason(reason string) bool {
	return reason == "agent_auth" || reason == "api_unavailable"
}

// startupBreakerVerdict reports whether rows (newest first) form an unbroken
// streak of startup failures fresh enough to keep the gate closed. Pure
// decision logic, unit-tested without a database.
func startupBreakerVerdict(rows []db.ListRecentTerminalTasksByRuntimeRow, now time.Time) bool {
	if len(rows) < startupBreakerThreshold {
		return false
	}
	for _, r := range rows {
		if r.Status != "failed" || !isStartupFailureReason(r.FailureReason.String) {
			return false
		}
	}
	newest := rows[0]
	if !newest.CompletedAt.Valid {
		return false
	}
	return now.Sub(newest.CompletedAt.Time) < startupBreakerCooldown
}

// StartupFailureBreakerOpen reports whether the runtime's claim gate should
// stay closed. Fails open: a history read error must never stall the queue.
// Package-level (not a TaskService method) so the autopilot scheduler can
// call it with bare queries.
func StartupFailureBreakerOpen(ctx context.Context, q *db.Queries, runtimeID pgtype.UUID) bool {
	rows, err := q.ListRecentTerminalTasksByRuntime(ctx, db.ListRecentTerminalTasksByRuntimeParams{
		RuntimeID: runtimeID,
		RowLimit:  startupBreakerThreshold,
	})
	if err != nil {
		slog.Warn("startup breaker: history read failed; failing open",
			"runtime_id", util.UUIDToString(runtimeID), "error", err)
		return false
	}
	open := startupBreakerVerdict(rows, time.Now())
	if open {
		slog.Warn("startup breaker open: holding back task claims",
			"runtime_id", util.UUIDToString(runtimeID),
			"cooldown", startupBreakerCooldown.String(),
		)
	}
	return open
}
