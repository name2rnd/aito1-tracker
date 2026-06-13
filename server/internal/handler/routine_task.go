package handler

// AITO1 pull-режим: HTTP-эндпоинты очереди заданий для агентов-на-рутинах.
// plans/planner-routine-experiment-2026-06-13.md. Brain пишет задания (enqueue,
// идемпотентно), Claude-Desktop-рутина их читает/claim'ит/закрывает, а Brain
// держит recovery (reclaim stale, complete-by-[PLAN], backlog watchdog).

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/logger"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	routineDefaultLeaseSecs   = 1200  // 20 мин — запас на самый долгий прогон Planner
	routineDefaultListLimit   = 20
	routineBacklogDefaultSecs = 14400 // 4ч — пропущенное окно рутины (2 прогона/день)
)

type RoutineTaskResponse struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspace_id"`
	AgentID     string          `json:"agent_id"`
	IssueID     string          `json:"issue_id"`
	Action      string          `json:"action"`
	Context     json.RawMessage `json:"context,omitempty"`
	Status      string          `json:"status"`
	Attempt     int32           `json:"attempt"`
	MaxAttempts int32           `json:"max_attempts"`
	CreatedAt   string          `json:"created_at"`
	ClaimedAt   string          `json:"claimed_at,omitempty"`
}

func toRoutineTaskResponse(t db.RoutineTaskQueue) RoutineTaskResponse {
	resp := RoutineTaskResponse{
		ID:          uuidToString(t.ID),
		WorkspaceID: uuidToString(t.WorkspaceID),
		AgentID:     uuidToString(t.AgentID),
		IssueID:     uuidToString(t.IssueID),
		Action:      t.Action,
		Status:      t.Status,
		Attempt:     t.Attempt,
		MaxAttempts: t.MaxAttempts,
		CreatedAt:   timestampToString(t.CreatedAt),
		ClaimedAt:   timestampToString(t.ClaimedAt),
	}
	if len(t.Context) > 0 {
		resp.Context = json.RawMessage(t.Context)
	}
	return resp
}

// --- Brain: enqueue (idempotent) ---

type EnqueueRoutineTaskRequest struct {
	AgentID     string          `json:"agent_id"`
	IssueID     string          `json:"issue_id"`
	Action      string          `json:"action"`
	Context     json.RawMessage `json:"context,omitempty"`
	MaxAttempts int32           `json:"max_attempts,omitempty"`
}

func (h *Handler) EnqueueRoutineTask(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	var req EnqueueRoutineTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Action == "" {
		writeError(w, http.StatusBadRequest, "action is required")
		return
	}
	agentID, ok := parseUUIDOrBadRequest(w, req.AgentID, "agent_id")
	if !ok {
		return
	}
	issueID, ok := parseUUIDOrBadRequest(w, req.IssueID, "issue_id")
	if !ok {
		return
	}
	wsID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}
	maxAttempts := req.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	var ctxBytes []byte
	if len(req.Context) > 0 {
		ctxBytes = req.Context
	}
	rows, err := h.Queries.EnqueueRoutineTask(r.Context(), db.EnqueueRoutineTaskParams{
		WorkspaceID: wsID,
		AgentID:     agentID,
		IssueID:     issueID,
		Action:      req.Action,
		Context:     ctxBytes,
		MaxAttempts: maxAttempts,
	})
	if err != nil {
		slog.Warn("enqueue routine task failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to enqueue routine task")
		return
	}
	// rows==0 → a live (pending|claimed) task for (agent, issue, action) already
	// exists; the ON CONFLICT DO NOTHING made this a no-op. Idempotent success.
	writeJSON(w, http.StatusOK, map[string]any{"created": rows > 0})
}

// --- Routine: list pending of a role ---

func (h *Handler) ListRoutineTasks(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	agentID, ok := parseUUIDOrBadRequest(w, r.URL.Query().Get("agent_id"), "agent_id")
	if !ok {
		return
	}
	limit := routineDefaultListLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	tasks, err := h.Queries.ListPendingRoutineTasks(r.Context(), db.ListPendingRoutineTasksParams{
		AgentID: agentID,
		Limit:   int32(limit),
	})
	if err != nil {
		slog.Warn("list routine tasks failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list routine tasks")
		return
	}
	out := make([]RoutineTaskResponse, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, toRoutineTaskResponse(t))
	}
	writeJSON(w, http.StatusOK, out)
}

// --- Routine: atomic CAS claim ---

func (h *Handler) ClaimRoutineTask(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return
	}
	leaseSecs := routineDefaultLeaseSecs
	if v := r.URL.Query().Get("lease_secs"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			leaseSecs = n
		}
	}
	task, err := h.Queries.ClaimRoutineTask(r.Context(), db.ClaimRoutineTaskParams{
		ID:        id,
		LeaseSecs: int32(leaseSecs),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Lost the CAS: another run already claimed it, or it is no longer pending.
		writeError(w, http.StatusConflict, "task is not claimable")
		return
	}
	if err != nil {
		slog.Warn("claim routine task failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to claim routine task")
		return
	}
	writeJSON(w, http.StatusOK, toRoutineTaskResponse(task))
}

// --- Routine: mark own task done/failed ---

type UpdateRoutineTaskRequest struct {
	Status string `json:"status"`
}

func (h *Handler) UpdateRoutineTask(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return
	}
	var req UpdateRoutineTaskRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Status != "done" && req.Status != "failed" {
		writeError(w, http.StatusBadRequest, "status must be done or failed")
		return
	}
	if err := h.Queries.SetRoutineTaskStatus(r.Context(), db.SetRoutineTaskStatusParams{
		ID:     id,
		Status: req.Status,
	}); err != nil {
		slog.Warn("update routine task failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to update routine task")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Brain: close by the fact of [PLAN] (issue-keyed) ---

type CompleteByIssueRequest struct {
	AgentID string `json:"agent_id"`
	IssueID string `json:"issue_id"`
	Action  string `json:"action"`
}

func (h *Handler) CompleteRoutineTaskByIssue(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	var req CompleteByIssueRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	agentID, ok := parseUUIDOrBadRequest(w, req.AgentID, "agent_id")
	if !ok {
		return
	}
	issueID, ok := parseUUIDOrBadRequest(w, req.IssueID, "issue_id")
	if !ok {
		return
	}
	if req.Action == "" {
		writeError(w, http.StatusBadRequest, "action is required")
		return
	}
	rows, err := h.Queries.CompleteRoutineTaskByIssue(r.Context(), db.CompleteRoutineTaskByIssueParams{
		AgentID: agentID,
		IssueID: issueID,
		Action:  req.Action,
	})
	if err != nil {
		slog.Warn("complete routine task by issue failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to complete routine task")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"completed": rows})
}

// --- Brain: reclaim stale claimed (invariant 5 second channel) ---

type ReclaimedRoutineTask struct {
	ID          string `json:"id"`
	IssueID     string `json:"issue_id"`
	AgentID     string `json:"agent_id"`
	Action      string `json:"action"`
	Status      string `json:"status"` // pending (retry) | failed (dead-letter)
	Attempt     int32  `json:"attempt"`
	MaxAttempts int32  `json:"max_attempts"`
}

func (h *Handler) ReclaimRoutineTasks(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	rows, err := h.Queries.ReclaimStaleRoutineTasks(r.Context())
	if err != nil {
		slog.Warn("reclaim routine tasks failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to reclaim routine tasks")
		return
	}
	out := make([]ReclaimedRoutineTask, 0, len(rows))
	for _, t := range rows {
		out = append(out, ReclaimedRoutineTask{
			ID:          uuidToString(t.ID),
			IssueID:     uuidToString(t.IssueID),
			AgentID:     uuidToString(t.AgentID),
			Action:      t.Action,
			Status:      t.Status,
			Attempt:     t.Attempt,
			MaxAttempts: t.MaxAttempts,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"reclaimed": out})
}

// --- Brain: backlog watchdog ---

func (h *Handler) RoutineBacklogCount(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	olderThan := routineBacklogDefaultSecs
	if v := r.URL.Query().Get("older_than_secs"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			olderThan = n
		}
	}
	count, err := h.Queries.CountStalePendingRoutineTasks(r.Context(), int32(olderThan))
	if err != nil {
		slog.Warn("routine backlog count failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to count routine backlog")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stale_pending": count})
}

// --- Brain: list live tasks of a role (rollback drain) ---

func (h *Handler) ListLiveRoutineTasks(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireUserID(w, r); !ok {
		return
	}
	agentID, ok := parseUUIDOrBadRequest(w, r.URL.Query().Get("agent_id"), "agent_id")
	if !ok {
		return
	}
	tasks, err := h.Queries.ListLiveRoutineTasks(r.Context(), agentID)
	if err != nil {
		slog.Warn("list live routine tasks failed", append(logger.RequestAttrs(r), "error", err)...)
		writeError(w, http.StatusInternalServerError, "failed to list live routine tasks")
		return
	}
	out := make([]RoutineTaskResponse, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, toRoutineTaskResponse(t))
	}
	writeJSON(w, http.StatusOK, out)
}
