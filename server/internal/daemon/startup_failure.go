package daemon

import "regexp"

// AITO-275: a task that fails before its agent makes a single tool call is
// almost never a problem with the task — it's the provider refusing to start
// the session: expired auth, API outage, exhausted quota. Without
// classification these fail as generic "agent_error" and the external
// generators (autopilot cron, daemon restarts, human reruns) keep burning
// runs for hours. The failure_reason set here feeds the server-side claim
// gate (see service.StartupFailureBreakerOpen) and Brain's Telegram alert.
//
// These reasons are intentionally NOT added to GetLastTaskSession's
// exclusion list: an auth failure does not poison the session, so a rerun
// after auth is restored must still resume prior work.
const (
	FailureReasonAgentAuth      = "agent_auth"
	FailureReasonAPIUnavailable = "api_unavailable"
)

// Markers confirmed against prod agent_task_queue.error and the daemon log
// (claude backend). Matching is provider-agnostic on agent.Result.Error so
// other backends with similar phrasing benefit too.
var (
	agentAuthRe = regexp.MustCompile(
		`(?i)not logged in|invalid api key|please run /login|organization has disabled`)
	apiUnavailableRe = regexp.MustCompile(
		`(?i)api error: 5\d\d|api error: request rejected \(429\)|unable to connect to api|connectionrefused|unexpected server error`)
)

// classifyStartupFailure returns a failure_reason for a failed run that
// never reached its first tool call, or "" when the error is not a known
// startup-failure signature. The tools==0 guard is the main anti-false-
// positive: once the agent has worked, its error text may legitimately
// quote an API error.
func classifyStartupFailure(errText string, tools int32) string {
	if tools > 0 || errText == "" {
		return ""
	}
	if agentAuthRe.MatchString(errText) {
		return FailureReasonAgentAuth
	}
	if apiUnavailableRe.MatchString(errText) {
		return FailureReasonAPIUnavailable
	}
	return ""
}
