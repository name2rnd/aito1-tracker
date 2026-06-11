package daemon

import "testing"

// AITO-275: real error strings observed in prod agent_task_queue.error and
// the daemon log. The classifier must catch all of them with tools == 0 and
// none of them once the agent has made at least one tool call.
func TestClassifyStartupFailureMarkers(t *testing.T) {
	cases := []struct {
		name   string
		errMsg string
		want   string
	}{
		{"claude not logged in", "Not logged in · Please run /login", FailureReasonAgentAuth},
		{"invalid api key", "Invalid API key", FailureReasonAgentAuth},
		{"subscription disabled", "Your organization has disabled Claude subscription access", FailureReasonAgentAuth},
		{"529 overloaded", "API Error: 529 Overloaded", FailureReasonAPIUnavailable},
		{"500", "API Error: 500 Internal server error", FailureReasonAPIUnavailable},
		{"429 quota", "API Error: Request rejected (429) Quota exceeded", FailureReasonAPIUnavailable},
		{"connection refused", "Unable to connect to API (ConnectionRefused)", FailureReasonAPIUnavailable},
		{"unexpected server error", "Unexpected server error.", FailureReasonAPIUnavailable},
		{"exit wrapper around auth", "claude exited with error: exit status 1 [stderr] Not logged in", FailureReasonAgentAuth},
		{"plain crash is not classified", "claude exited with error: signal: killed", ""},
		{"task-level error is not classified", "tool Bash failed: command not found", ""},
		{"empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyStartupFailure(tc.errMsg, 0)
			if got != tc.want {
				t.Fatalf("classifyStartupFailure(%q, 0) = %q, want %q", tc.errMsg, got, tc.want)
			}
		})
	}
}

// Once the agent has made tool calls, the run died mid-task — the error text
// may even quote an API error (e.g. an agent report) and must not be
// classified as a startup failure.
func TestClassifyStartupFailureRequiresZeroTools(t *testing.T) {
	if got := classifyStartupFailure("API Error: 529 Overloaded", 7); got != "" {
		t.Fatalf("expected no classification with tools>0, got %q", got)
	}
	if got := classifyStartupFailure("Not logged in · Please run /login", 1); got != "" {
		t.Fatalf("expected no classification with tools>0, got %q", got)
	}
}
