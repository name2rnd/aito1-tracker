package handler

import (
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Helper to build a pgtype.UUID from a string.
func testUUID(s string) pgtype.UUID {
	return parseUUID(s)
}

// Helper to build a pgtype.Text.
func testText(s string) pgtype.Text {
	return pgtype.Text{String: s, Valid: true}
}

const (
	agentAssigneeID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	otherAgentID    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	memberID        = "cccccccc-cccc-cccc-cccc-cccccccccccc"
)

func issueWithAgentAssignee() db.Issue {
	return db.Issue{
		AssigneeType: testText("agent"),
		AssigneeID:   testUUID(agentAssigneeID),
	}
}

func issueNoAssignee() db.Issue {
	return db.Issue{}
}

// -------------------------------------------------------------------
// commentMentionsOthersButNotAssignee — sole on_comment guard after Patch 7
// (drop reply mechanic: isReplyToMemberThread + shouldInheritParentMentions
// were removed since flat comments cannot have parents).
// -------------------------------------------------------------------

func TestCommentMentionsOthersButNotAssignee(t *testing.T) {
	h := &Handler{} // nil handler — method doesn't use h

	issue := issueWithAgentAssignee()

	tests := []struct {
		name    string
		content string
		want    bool
	}{
		{
			name:    "no mentions → allow trigger",
			content: "just a plain comment",
			want:    false,
		},
		{
			name:    "mentions assignee → allow trigger",
			content: fmt.Sprintf("[@Agent](mention://agent/%s) please fix", agentAssigneeID),
			want:    false,
		},
		{
			name:    "mentions other agent only → suppress",
			content: fmt.Sprintf("[@Other](mention://agent/%s) what do you think?", otherAgentID),
			want:    true,
		},
		{
			name:    "mentions other member only → suppress",
			content: fmt.Sprintf("[@Bob](mention://member/%s) take a look", memberID),
			want:    true,
		},
		{
			name:    "mentions both assignee and other → allow trigger",
			content: fmt.Sprintf("[@Agent](mention://agent/%s) and [@Other](mention://agent/%s)", agentAssigneeID, otherAgentID),
			want:    false,
		},
		{
			name:    "@all mention → suppress (broadcast, not directed at agent)",
			content: "[@All](mention://all/all) heads up everyone",
			want:    true,
		},
		{
			name:    "@all with assignee mention → suppress (@all takes precedence)",
			content: fmt.Sprintf("[@All](mention://all/all) [@Agent](mention://agent/%s) fyi", agentAssigneeID),
			want:    true,
		},
		{
			name:    "issue mention only → allow trigger (cross-reference, not @person)",
			content: "[PAN-1](mention://issue/44c266e7-f6dd-4be3-9140-5ac40233f79c) is related",
			want:    false,
		},
		{
			name:    "issue mention + other agent → suppress (agent mention matters)",
			content: fmt.Sprintf("[PAN-1](mention://issue/44c266e7-f6dd-4be3-9140-5ac40233f79c) cc [@Other](mention://agent/%s)", otherAgentID),
			want:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := h.commentMentionsOthersButNotAssignee(tt.content, issue)
			if got != tt.want {
				t.Errorf("commentMentionsOthersButNotAssignee() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCommentMentionsOthersButNotAssignee_NoAssignee(t *testing.T) {
	h := &Handler{}
	issue := issueNoAssignee()

	// Any mention on an unassigned issue → suppress
	content := fmt.Sprintf("[@Agent](mention://agent/%s) help", otherAgentID)
	if got := h.commentMentionsOthersButNotAssignee(content, issue); !got {
		t.Errorf("expected true for mentions on unassigned issue, got false")
	}
}
