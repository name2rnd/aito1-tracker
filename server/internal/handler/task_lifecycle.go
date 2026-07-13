package handler

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type RunCorrelationRequest struct {
	EffectID          *string `json:"effect_id"`
	BindingGeneration *int32  `json:"binding_generation"`
	AgentRole         *string `json:"agent_role"`
}

func (h *Handler) runCorrelation(req RunCorrelationRequest) (*service.RunCorrelation, error) {
	if !h.cfg.AITO1RunCorrelation {
		return nil, nil
	}
	if req.EffectID == nil && req.BindingGeneration == nil && req.AgentRole == nil {
		return nil, nil
	}
	if req.EffectID == nil || req.BindingGeneration == nil || req.AgentRole == nil {
		return nil, fmt.Errorf("effect_id, binding_generation, and agent_role must be provided together")
	}
	correlation := service.RunCorrelation{
		EffectID:          strings.TrimSpace(*req.EffectID),
		BindingGeneration: *req.BindingGeneration,
		AgentRole:         strings.TrimSpace(*req.AgentRole),
	}
	if correlation.EffectID == "" || correlation.BindingGeneration < 1 || correlation.AgentRole == "" {
		return nil, fmt.Errorf("effect_id and agent_role must be non-empty and binding_generation must be positive")
	}
	return &correlation, nil
}

// RecoverOrphanedTasks is called by the daemon at startup for each runtime
// it owns. It atomically fails any dispatched/running tasks the server still
// believes belong to that runtime — those are the tasks the previous daemon
// process was running when it died — and triggers MaybeRetryFailedTask for
// each so the user sees a fresh attempt instead of a permanently stuck row.
//
// This is the targeted fix for "issue stuck at in_progress when daemon
// restarts mid-task": the runtime heartbeat sweeper takes up to 75s + the
// in-process task timeout (2.5h) to notice such tasks; the daemon itself
// knows the moment it comes back up, so we let it report orphan recovery.
func (h *Handler) RecoverOrphanedTasks(w http.ResponseWriter, r *http.Request) {
	runtimeID := chi.URLParam(r, "runtimeId")
	if _, ok := h.requireDaemonRuntimeAccess(w, r, runtimeID); !ok {
		return
	}

	rows, err := h.Queries.RecoverOrphanedTasksForRuntime(r.Context(), parseUUID(runtimeID))
	if err != nil {
		slog.Warn("recover-orphans failed", "runtime_id", runtimeID, "error", err)
		writeError(w, http.StatusInternalServerError, "recover orphans failed")
		return
	}

	// Funnel through the shared post-failure pipeline so we get the same
	// task:failed events, agent reconcile, issue rollback, and auto-retry
	// behaviour as the runtime sweeper. This was previously a fast-path
	// that bypassed those side effects, leaving the UI stale when no retry
	// was created (max_attempts exhausted, autopilot, non-retryable reason).
	retried := h.TaskService.HandleFailedTasks(r.Context(), rows)

	if len(rows) > 0 {
		slog.Info("recover-orphans completed",
			"runtime_id", runtimeID,
			"orphaned", len(rows),
			"retried", retried,
		)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"orphaned": len(rows),
		"retried":  retried,
	})
}

// PinTaskSession lets the daemon persist the agent's session_id and
// work_dir as soon as they're known — typically right after the agent
// emits its first system message — so a crash mid-run doesn't lose the
// resume pointer needed to continue the conversation on the next attempt.
type PinTaskSessionRequest struct {
	SessionID string `json:"session_id,omitempty"`
	WorkDir   string `json:"work_dir,omitempty"`
}

func (h *Handler) PinTaskSession(w http.ResponseWriter, r *http.Request) {
	taskID := chi.URLParam(r, "taskId")
	if _, ok := h.requireDaemonTaskAccess(w, r, taskID); !ok {
		return
	}

	var req PinTaskSessionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.SessionID == "" && req.WorkDir == "" {
		writeError(w, http.StatusBadRequest, "session_id or work_dir required")
		return
	}

	params := db.UpdateAgentTaskSessionParams{ID: parseUUID(taskID)}
	if req.SessionID != "" {
		params.SessionID = pgtype.Text{String: req.SessionID, Valid: true}
	}
	if req.WorkDir != "" {
		params.WorkDir = pgtype.Text{String: req.WorkDir, Valid: true}
	}
	if err := h.Queries.UpdateAgentTaskSession(r.Context(), params); err != nil {
		slog.Warn("pin-session failed", "task_id", taskID, "error", err)
		writeError(w, http.StatusInternalServerError, "pin session failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RerunIssue manually re-enqueues the issue's current agent assignment.
// Useful when an issue is stuck or the user wants to retry a failed run.
//
// AITO1-patch (AITO-322): accepts an optional JSON body
// {"force_fresh": false}. The default (no body / true) keeps the historical
// behaviour — a fresh agent session. force_fresh=false enqueues with resume
// semantics: the daemon's claim path serves the prior session via
// GetLastTaskSession (failed sessions included), so Brain can retry a
// crashed Reflector without throwing away its partial work.
func (h *Handler) RerunIssue(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, id)
	if !ok {
		return
	}

	forceFresh := true
	var correlationReq RunCorrelationRequest
	if r.Body != nil {
		var req struct {
			ForceFresh *bool `json:"force_fresh"`
			RunCorrelationRequest
		}
		// An empty or malformed body keeps the default — the endpoint
		// historically took no body at all.
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil && req.ForceFresh != nil {
			forceFresh = *req.ForceFresh
		}
		correlationReq = req.RunCorrelationRequest
	}

	correlation, err := h.runCorrelation(correlationReq)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var task *db.AgentTaskQueue
	if correlation != nil {
		task, err = h.TaskService.RerunIssueCorrelated(r.Context(), issue.ID, pgtype.UUID{}, forceFresh, *correlation)
	} else {
		task, err = h.TaskService.RerunIssue(r.Context(), issue.ID, pgtype.UUID{}, forceFresh)
	}
	if err != nil {
		slog.Warn("issue rerun failed", "issue_id", id, "error", err)
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, taskToResponse(*task))
}
