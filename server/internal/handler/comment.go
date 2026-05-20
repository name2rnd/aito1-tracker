package handler

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/logger"
	"github.com/multica-ai/multica/server/internal/mention"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type CommentResponse struct {
	ID          string               `json:"id"`
	IssueID     string               `json:"issue_id"`
	AuthorType  string               `json:"author_type"`
	AuthorID    string               `json:"author_id"`
	Content     string               `json:"content"`
	Type        string               `json:"type"`
	ParentID    *string              `json:"parent_id"`
	CreatedAt   string               `json:"created_at"`
	UpdatedAt   string               `json:"updated_at"`
	Reactions   []ReactionResponse   `json:"reactions"`
	Attachments []AttachmentResponse `json:"attachments"`
}

func commentToResponse(c db.Comment, reactions []ReactionResponse, attachments []AttachmentResponse) CommentResponse {
	if reactions == nil {
		reactions = []ReactionResponse{}
	}
	if attachments == nil {
		attachments = []AttachmentResponse{}
	}
	return CommentResponse{
		ID:          uuidToString(c.ID),
		IssueID:     uuidToString(c.IssueID),
		AuthorType:  c.AuthorType,
		AuthorID:    uuidToString(c.AuthorID),
		Content:     c.Content,
		Type:        c.Type,
		ParentID:    uuidToPtr(c.ParentID),
		CreatedAt:   timestampToString(c.CreatedAt),
		UpdatedAt:   timestampToString(c.UpdatedAt),
		Reactions:   reactions,
		Attachments: attachments,
	}
}

func (h *Handler) ListComments(w http.ResponseWriter, r *http.Request) {
	issueID := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, issueID)
	if !ok {
		return
	}

	// Parse optional pagination query params.
	q := r.URL.Query()
	var limit, offset int32
	var hasPagination bool
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid limit parameter")
			return
		}
		limit = int32(n)
		hasPagination = true
	}
	if v := q.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			writeError(w, http.StatusBadRequest, "invalid offset parameter")
			return
		}
		offset = int32(n)
		hasPagination = true
	}

	var sinceTime pgtype.Timestamptz
	if v := q.Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid since parameter; expected RFC3339 format")
			return
		}
		sinceTime = pgtype.Timestamptz{Time: t, Valid: true}
	}

	var comments []db.Comment
	var err error

	// When neither limit nor offset is specified, default to the most recent
	// 50 comments. The previous behavior returned every comment unbounded,
	// which let an agent or browser call accidentally pull thousands of rows
	// (see issue #1968). Callers that want everything must opt in with a
	// large explicit --limit; a 100-cap on the server side stays in place via
	// the timeline endpoint, but this endpoint is used by humans + the CLI
	// where the cap is the documented 50 default.
	if !hasPagination {
		limit = 50
		hasPagination = true
	}
	switch {
	case sinceTime.Valid:
		if limit == 0 {
			limit = 50
		}
		comments, err = h.Queries.ListCommentsSincePaginated(r.Context(), db.ListCommentsSincePaginatedParams{
			IssueID:     issue.ID,
			WorkspaceID: issue.WorkspaceID,
			CreatedAt:   sinceTime,
			Limit:       limit,
			Offset:      offset,
		})
	default:
		if limit == 0 {
			limit = 50
		}
		comments, err = h.Queries.ListCommentsPaginated(r.Context(), db.ListCommentsPaginatedParams{
			IssueID:     issue.ID,
			WorkspaceID: issue.WorkspaceID,
			Limit:       limit,
			Offset:      offset,
		})
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list comments")
		return
	}

	commentIDs := make([]pgtype.UUID, len(comments))
	for i, c := range comments {
		commentIDs[i] = c.ID
	}
	grouped := h.groupReactions(r, commentIDs)
	groupedAtt := h.groupAttachments(r, commentIDs)

	resp := make([]CommentResponse, len(comments))
	for i, c := range comments {
		cid := uuidToString(c.ID)
		resp[i] = commentToResponse(c, grouped[cid], groupedAtt[cid])
	}

	// Include total count in response header when paginating.
	if hasPagination {
		total, countErr := h.Queries.CountComments(r.Context(), db.CountCommentsParams{
			IssueID:     issue.ID,
			WorkspaceID: issue.WorkspaceID,
		})
		if countErr == nil {
			w.Header().Set("X-Total-Count", strconv.FormatInt(total, 10))
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

type CreateCommentRequest struct {
	Content       string   `json:"content"`
	Type          string   `json:"type"`
	ParentID      *string  `json:"parent_id"`
	AttachmentIDs []string `json:"attachment_ids"`
}

func (h *Handler) CreateComment(w http.ResponseWriter, r *http.Request) {
	issueID := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, issueID)
	if !ok {
		return
	}

	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	var req CreateCommentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	if req.Type == "" {
		req.Type = "comment"
	}

	// Patch 7 (drop reply mechanic): req.ParentID is intentionally ignored.
	// Field stays in the request struct for upstream API compatibility, but
	// new comments are always written flat (parent_id NULL in DB).

	attachmentIDs, ok := parseUUIDSliceOrBadRequest(w, req.AttachmentIDs, "attachment_ids")
	if !ok {
		return
	}

	// Determine author identity: agent (via X-Agent-ID header) or member.
	authorType, authorID := h.resolveActor(r, userID, uuidToString(issue.WorkspaceID))

	// Expand bare issue identifiers (e.g. MUL-117) into mention links.
	req.Content = mention.ExpandIssueIdentifiers(r.Context(), h.Queries, issue.WorkspaceID, req.Content)

	// NOTE: Comment content is stored as Markdown source. XSS is handled at the
	// rendering layer (rehype-sanitize) and at the editor layer
	// (@tiptap/markdown with html:false). Running an HTML sanitizer here would
	// entity-encode Markdown syntax characters (>, ", &, <) and corrupt the
	// source. See issue #1303 / discussion in MUL-1119, MUL-1125.

	comment, err := h.Queries.CreateComment(r.Context(), db.CreateCommentParams{
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		AuthorType:  authorType,
		AuthorID:    parseUUID(authorID),
		Content:     req.Content,
		Type:        req.Type,
		ParentID:    pgtype.UUID{}, // Patch 7: flat comments only, see patch.md
	})
	if err != nil {
		slog.Warn("create comment failed", append(logger.RequestAttrs(r), "error", err, "issue_id", issueID)...)
		writeError(w, http.StatusInternalServerError, "failed to create comment: "+err.Error())
		return
	}

	// Link uploaded attachments to this comment.
	if len(attachmentIDs) > 0 {
		h.linkAttachmentsByIDs(r.Context(), comment.ID, issue.ID, attachmentIDs)
	}

	// Fetch linked attachments so the response includes them.
	groupedAtt := h.groupAttachments(r, []pgtype.UUID{comment.ID})
	resp := commentToResponse(comment, nil, groupedAtt[uuidToString(comment.ID)])
	slog.Info("comment created", append(logger.RequestAttrs(r), "comment_id", uuidToString(comment.ID), "issue_id", issueID)...)
	h.publish(protocol.EventCommentCreated, uuidToString(issue.WorkspaceID), authorType, authorID, map[string]any{
		"comment":             resp,
		"issue_title":         issue.Title,
		"issue_assignee_type": textToPtr(issue.AssigneeType),
		"issue_assignee_id":   uuidToPtr(issue.AssigneeID),
		"issue_status":        issue.Status,
	})

	// If the issue is assigned to an agent with on_comment trigger, enqueue a new task.
	// Skip when the comment comes from the assigned agent itself to avoid loops
	// (handled by authorType == "member" check below).
	// Skip when the comment @mentions others but not the assignee agent —
	// the user is talking to someone else, not requesting work from the assignee.
	// Skip when the comment is from a service-account member (e.g. AITO1's
	// Teamlead writing audit comments after Brain reassigns the issue): such
	// comments are notifications, not requests for work, so they must not
	// double-trigger the agent that was just assigned.
	if authorType == "member" && h.shouldEnqueueOnComment(r.Context(), issue) &&
		!h.commentMentionsOthersButNotAssignee(comment.Content, issue) &&
		!h.isServiceAccountMember(r.Context(), uuidToString(issue.WorkspaceID), authorID) {
		if _, err := h.TaskService.EnqueueTaskForIssue(r.Context(), issue, comment.ID); err != nil {
			slog.Warn("enqueue agent task on comment failed", "issue_id", issueID, "error", err)
		}
	}

	// Trigger @mentioned agents: parse agent mentions and enqueue tasks for each.
	h.enqueueMentionedAgentTasks(r.Context(), issue, comment, authorType, authorID)

	writeJSON(w, http.StatusCreated, resp)
}

// isBrainDispatchedConfig reports whether an agent's runtime_config carries
// `brain_dispatched: true` — AITO1 pipeline agents (Planner/Executor/Reflector/
// Teamlead/Auditor) whose triggering is owned entirely by Brain's state machine.
// For them multica must NOT natively enqueue on_comment / @mention tasks, or
// Brain's routing races with multica's. Bad/empty config → false (fail open to
// normal behavior for non-AITO1 agents).
func isBrainDispatchedConfig(runtimeConfig []byte) bool {
	if len(runtimeConfig) == 0 {
		return false
	}
	var cfg map[string]any
	if err := json.Unmarshal(runtimeConfig, &cfg); err != nil {
		return false
	}
	v, ok := cfg["brain_dispatched"].(bool)
	return ok && v
}

// commentMentionsOthersButNotAssignee returns true if the comment @mentions
// anyone but does NOT @mention the issue's assignee agent. This is used to
// suppress the on_comment trigger when the user is directing their comment at
// someone else (e.g. sharing results with a colleague, asking another agent).
// @all is treated as a broadcast — it suppresses the trigger because the user
// is announcing to everyone, not specifically requesting work from the agent.
func (h *Handler) commentMentionsOthersButNotAssignee(content string, issue db.Issue) bool {
	mentions := util.ParseMentions(content)
	// Filter out issue mentions — they are cross-references, not @people.
	filtered := mentions[:0]
	for _, m := range mentions {
		if m.Type != "issue" {
			filtered = append(filtered, m)
		}
	}
	mentions = filtered
	if len(mentions) == 0 {
		return false // No mentions (or only issue refs) — normal on_comment behavior
	}
	// @all is a broadcast to all members — suppress agent trigger.
	if util.HasMentionAll(mentions) {
		return true
	}
	if !issue.AssigneeID.Valid {
		return true // No assignee — mentions target others
	}
	assigneeID := uuidToString(issue.AssigneeID)
	for _, m := range mentions {
		if m.ID == assigneeID {
			return false // Assignee is mentioned — allow trigger
		}
	}
	return true // Others mentioned but not assignee — suppress trigger
}

// isServiceAccountMember reports whether a member is flagged as a service
// account (member.is_service_account = true). Service-account members are
// typically integration accounts (e.g. AITO1's Teamlead) whose comments
// are status updates, not requests for agent work — so they must not
// trigger on_comment-tasks even when posted on agent-assigned issues.
//
// Looked up by (workspace_id, user_id) — `userID` matches what
// `resolveActor` returns for member-typed authors (it returns the user's
// id, not the membership row id). Querying by `member.id` would always
// miss, silently making the whole check a no-op.
//
// Errors (member not found, DB hiccup) default to FALSE: failing closed
// here would silently disable Human comments on every transient DB
// failure, which is a much worse UX than letting an extra agent task
// slip through.
func (h *Handler) isServiceAccountMember(ctx context.Context, workspaceID, userID string) bool {
	ws := parseUUID(workspaceID)
	uid := parseUUID(userID)
	if !ws.Valid || !uid.Valid {
		return false
	}
	isSvc, err := h.Queries.IsMemberServiceAccount(ctx, db.IsMemberServiceAccountParams{
		WorkspaceID: ws,
		UserID:      uid,
	})
	if err != nil {
		return false
	}
	return isSvc
}

// enqueueMentionedAgentTasks parses @agent mentions from comment content and
// enqueues a task for each mentioned agent. Skips self-mentions, agents with
// on_mention trigger disabled, and private agents mentioned by non-owner
// members (only the agent owner or workspace admin/owner can mention a private
// agent).
// Note: no status gate here — @mention is an explicit action and should work
// even on done/cancelled issues (the agent can reopen the issue if needed).
func (h *Handler) enqueueMentionedAgentTasks(ctx context.Context, issue db.Issue, comment db.Comment, authorType, authorID string) {
	wsID := uuidToString(issue.WorkspaceID)
	mentions := util.ParseMentions(comment.Content)
	for _, m := range mentions {
		if m.Type != "agent" {
			continue
		}
		// Prevent self-trigger: skip if the comment author is this agent.
		if authorType == "agent" && authorID == m.ID {
			continue
		}
		agentUUID := parseUUID(m.ID)
		// Load the agent to check visibility, archive status, and trigger config.
		agent, err := h.Queries.GetAgent(ctx, agentUUID)
		if err != nil || !agent.RuntimeID.Valid || agent.ArchivedAt.Valid {
			continue
		}
		// AITO1: Brain is the sole dispatcher for pipeline agents — they must
		// never be native-enqueued (on @mention or on_comment). All routing and
		// agent handoff goes through Brain's state machine (assign + rerun).
		if isBrainDispatchedConfig(agent.RuntimeConfig) {
			continue
		}
		// Private agents can only be mentioned by the agent owner or workspace admin/owner.
		if agent.Visibility == "private" && authorType == "member" {
			isOwner := uuidToString(agent.OwnerID) == authorID
			if !isOwner {
				member, err := h.getWorkspaceMember(ctx, authorID, wsID)
				if err != nil || !roleAllowed(member.Role, "owner", "admin") {
					continue
				}
			}
		}
		// Dedup: skip if this agent already has a pending task for this issue.
		hasPending, err := h.Queries.HasPendingTaskForIssueAndAgent(ctx, db.HasPendingTaskForIssueAndAgentParams{
			IssueID: issue.ID,
			AgentID: agentUUID,
		})
		if err != nil || hasPending {
			continue
		}
		// Always use the current comment as the trigger so the agent reads the
		// actual reply that mentioned it, not the thread root.
		if _, err := h.TaskService.EnqueueTaskForMention(ctx, issue, agentUUID, comment.ID); err != nil {
			slog.Warn("enqueue mention agent task failed", "issue_id", uuidToString(issue.ID), "agent_id", m.ID, "error", err)
		}
	}
}

func (h *Handler) UpdateComment(w http.ResponseWriter, r *http.Request) {
	commentId := chi.URLParam(r, "commentId")

	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	commentUUID, ok := parseUUIDOrBadRequest(w, commentId, "comment id")
	if !ok {
		return
	}

	// Load comment scoped to current workspace.
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	existing, err := h.Queries.GetCommentInWorkspace(r.Context(), db.GetCommentInWorkspaceParams{
		ID:          commentUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}

	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	isAuthor := existing.AuthorType == actorType && uuidToString(existing.AuthorID) == actorID
	isAdmin := roleAllowed(member.Role, "owner", "admin")
	if !isAuthor && !isAdmin {
		writeError(w, http.StatusForbidden, "only comment author or admin can edit")
		return
	}

	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}

	// NOTE: See CreateComment — Markdown is sanitized at render/edit time, not here.

	comment, err := h.Queries.UpdateComment(r.Context(), db.UpdateCommentParams{
		ID:      commentUUID,
		Content: req.Content,
	})
	if err != nil {
		slog.Warn("update comment failed", append(logger.RequestAttrs(r), "error", err, "comment_id", commentId)...)
		writeError(w, http.StatusInternalServerError, "failed to update comment")
		return
	}

	// Fetch reactions and attachments for the updated comment.
	grouped := h.groupReactions(r, []pgtype.UUID{comment.ID})
	groupedAtt := h.groupAttachments(r, []pgtype.UUID{comment.ID})
	cid := uuidToString(comment.ID)
	resp := commentToResponse(comment, grouped[cid], groupedAtt[cid])
	slog.Info("comment updated", append(logger.RequestAttrs(r), "comment_id", commentId)...)
	h.publish(protocol.EventCommentUpdated, workspaceID, actorType, actorID, map[string]any{"comment": resp})
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) DeleteComment(w http.ResponseWriter, r *http.Request) {
	commentId := chi.URLParam(r, "commentId")

	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	commentUUID, ok := parseUUIDOrBadRequest(w, commentId, "comment id")
	if !ok {
		return
	}

	// Load comment scoped to current workspace.
	workspaceID := h.resolveWorkspaceID(r)
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	comment, err := h.Queries.GetCommentInWorkspace(r.Context(), db.GetCommentInWorkspaceParams{
		ID:          commentUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "comment not found")
		return
	}

	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}

	actorType, actorID := h.resolveActor(r, userID, workspaceID)
	isAuthor := comment.AuthorType == actorType && uuidToString(comment.AuthorID) == actorID
	isAdmin := roleAllowed(member.Role, "owner", "admin")
	if !isAuthor && !isAdmin {
		writeError(w, http.StatusForbidden, "only comment author or admin can delete")
		return
	}

	// Collect attachment URLs before CASCADE delete removes them.
	attachmentURLs, _ := h.Queries.ListAttachmentURLsByCommentID(r.Context(), comment.ID)

	// Cancel any active tasks triggered by this comment so the agent does not
	// run with the now-deleted content already embedded in its prompt. Must
	// run before DeleteComment because the FK ON DELETE SET NULL would
	// otherwise nullify trigger_comment_id and orphan those tasks in queued.
	if err := h.TaskService.CancelTasksByTriggerComment(r.Context(), comment.ID); err != nil {
		slog.Warn("cancel tasks for deleted trigger comment failed", append(logger.RequestAttrs(r), "error", err, "comment_id", commentId)...)
	}

	if err := h.Queries.DeleteComment(r.Context(), comment.ID); err != nil {
		slog.Warn("delete comment failed", append(logger.RequestAttrs(r), "error", err, "comment_id", commentId)...)
		writeError(w, http.StatusInternalServerError, "failed to delete comment")
		return
	}

	h.deleteS3Objects(r.Context(), attachmentURLs)
	slog.Info("comment deleted", append(logger.RequestAttrs(r), "comment_id", commentId, "issue_id", uuidToString(comment.IssueID))...)
	h.publish(protocol.EventCommentDeleted, workspaceID, actorType, actorID, map[string]any{
		"comment_id": uuidToString(comment.ID),
		"issue_id":   uuidToString(comment.IssueID),
	})
	w.WriteHeader(http.StatusNoContent)
}
