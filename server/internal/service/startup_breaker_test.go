package service

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func breakerRow(status, reason string, completedAgo time.Duration, now time.Time) db.ListRecentTerminalTasksByRuntimeRow {
	return db.ListRecentTerminalTasksByRuntimeRow{
		Status:        status,
		FailureReason: pgtype.Text{String: reason, Valid: reason != ""},
		CompletedAt:   pgtype.Timestamptz{Time: now.Add(-completedAgo), Valid: true},
	}
}

func TestStartupBreakerVerdict(t *testing.T) {
	now := time.Now()

	cases := []struct {
		name string
		rows []db.ListRecentTerminalTasksByRuntimeRow
		want bool
	}{
		{
			name: "fresh unbroken auth streak closes the gate",
			rows: []db.ListRecentTerminalTasksByRuntimeRow{
				breakerRow("failed", "agent_auth", 1*time.Minute, now),
				breakerRow("failed", "agent_auth", 2*time.Minute, now),
				breakerRow("failed", "agent_auth", 3*time.Minute, now),
			},
			want: true,
		},
		{
			name: "mixed auth and api failures still close the gate",
			rows: []db.ListRecentTerminalTasksByRuntimeRow{
				breakerRow("failed", "api_unavailable", 1*time.Minute, now),
				breakerRow("failed", "agent_auth", 2*time.Minute, now),
				breakerRow("failed", "api_unavailable", 3*time.Minute, now),
			},
			want: true,
		},
		{
			name: "a completed task breaks the streak",
			rows: []db.ListRecentTerminalTasksByRuntimeRow{
				breakerRow("failed", "agent_auth", 1*time.Minute, now),
				breakerRow("completed", "", 2*time.Minute, now),
				breakerRow("failed", "agent_auth", 3*time.Minute, now),
			},
			want: false,
		},
		{
			name: "ordinary agent_error failures do not open the breaker",
			rows: []db.ListRecentTerminalTasksByRuntimeRow{
				breakerRow("failed", "agent_error", 1*time.Minute, now),
				breakerRow("failed", "agent_error", 2*time.Minute, now),
				breakerRow("failed", "agent_error", 3*time.Minute, now),
			},
			want: false,
		},
		{
			name: "stale streak past the cooldown reopens the gate (probe)",
			rows: []db.ListRecentTerminalTasksByRuntimeRow{
				breakerRow("failed", "agent_auth", 6*time.Minute, now),
				breakerRow("failed", "agent_auth", 7*time.Minute, now),
				breakerRow("failed", "agent_auth", 8*time.Minute, now),
			},
			want: false,
		},
		{
			name: "too little history stays open",
			rows: []db.ListRecentTerminalTasksByRuntimeRow{
				breakerRow("failed", "agent_auth", 1*time.Minute, now),
				breakerRow("failed", "agent_auth", 2*time.Minute, now),
			},
			want: false,
		},
		{
			name: "no history stays open",
			rows: nil,
			want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := startupBreakerVerdict(tc.rows, now); got != tc.want {
				t.Fatalf("verdict = %v, want %v", got, tc.want)
			}
		})
	}
}
