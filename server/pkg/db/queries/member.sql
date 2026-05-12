-- name: ListMembers :many
SELECT * FROM member
WHERE workspace_id = $1
ORDER BY created_at ASC;

-- name: GetMember :one
SELECT * FROM member
WHERE id = $1;

-- name: GetMemberByUserAndWorkspace :one
SELECT * FROM member
WHERE user_id = $1 AND workspace_id = $2;

-- name: CreateMember :one
INSERT INTO member (workspace_id, user_id, role)
VALUES ($1, $2, $3)
RETURNING *;

-- name: UpdateMemberRole :one
UPDATE member SET role = $2
WHERE id = $1
RETURNING *;

-- name: DeleteMember :exec
DELETE FROM member WHERE id = $1;

-- name: ListMembersWithUser :many
SELECT m.id, m.workspace_id, m.user_id, m.role, m.created_at,
       u.name as user_name, u.email as user_email, u.avatar_url as user_avatar_url
FROM member m
JOIN "user" u ON u.id = m.user_id
WHERE m.workspace_id = $1
ORDER BY m.created_at ASC;

-- name: IsMemberServiceAccount :one
-- comment.go calls this with the comment author's user_id (resolveActor
-- returns userID for member-typed actors). Look up via (workspace_id, user_id)
-- — the natural unique key — instead of member.id, otherwise the check
-- always misses and Teamlead service-account comments still trigger agents.
SELECT is_service_account FROM member WHERE workspace_id = $1 AND user_id = $2;

-- name: SetMemberServiceAccount :exec
UPDATE member SET is_service_account = $3 WHERE workspace_id = $1 AND user_id = $2;
