"use client";

import { Tooltip, TooltipTrigger, TooltipContent } from "@multica/ui/components/ui/tooltip";
import { LikeButton } from "./like-button";
import { ClassifyButtons } from "./classify-buttons";

// AITO1: classify-reaction emojis are plain strings, not unicode glyphs.
// Render them with a readable label once a choice has been made.
const CLASSIFY_LABELS: Record<string, string> = {
  read: "📖 Read",
  write: "✏️ Write",
};

interface ReactionItem {
  id: string;
  actor_type: string;
  actor_id: string;
  emoji: string;
}

interface GroupedReaction {
  emoji: string;
  count: number;
  reacted: boolean;
  actors: { type: string; id: string }[];
}

function groupReactions(reactions: ReactionItem[], currentUserId?: string): GroupedReaction[] {
  const map = new Map<string, GroupedReaction>();
  for (const r of reactions) {
    let group = map.get(r.emoji);
    if (!group) {
      group = { emoji: r.emoji, count: 0, reacted: false, actors: [] };
      map.set(r.emoji, group);
    }
    group.count++;
    group.actors.push({ type: r.actor_type, id: r.actor_id });
    if (r.actor_type === "member" && r.actor_id === currentUserId) {
      group.reacted = true;
    }
  }
  return Array.from(map.values());
}

interface ReactionBarProps {
  reactions: ReactionItem[];
  currentUserId?: string;
  onToggle: (emoji: string) => void;
  getActorName: (type: string, id: string) => string;
  className?: string;
  hideAddButton?: boolean;
  // AITO1: when true, render [📖 Read] [✏️ Write] classify-buttons instead of
  // the like button (for comments with the aito1:classify_request sentinel).
  classifyMode?: boolean;
}

function ReactionBar({
  reactions,
  currentUserId,
  onToggle,
  getActorName,
  className,
  hideAddButton,
  classifyMode,
}: ReactionBarProps) {
  const grouped = groupReactions(reactions, currentUserId);
  const userAlreadyLiked = grouped.some((g) => g.emoji === "👍" && g.reacted);
  const alreadyClassified = grouped.some(
    (g) => (g.emoji === "read" || g.emoji === "write") && g.reacted,
  );

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className ?? ""}`}>
      {grouped.map((g) => (
        <Tooltip key={g.emoji}>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => onToggle(g.emoji)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-brand/15 ${
                  g.reacted
                    ? "border-brand/30 bg-brand/8 text-brand"
                    : "border-brand/10 bg-brand/4 text-muted-foreground"
                }`}
              >
                <span>{CLASSIFY_LABELS[g.emoji] ?? g.emoji}</span>
                <span>{g.count}</span>
              </button>
            }
          />
          <TooltipContent side="top">
            {g.actors.map((a) => getActorName(a.type, a.id)).join(", ")}
          </TooltipContent>
        </Tooltip>
      ))}
      {classifyMode
        ? !alreadyClassified && <ClassifyButtons onToggle={onToggle} />
        : !hideAddButton && !userAlreadyLiked && <LikeButton onToggle={onToggle} />}
    </div>
  );
}

export { ReactionBar, type ReactionBarProps, type ReactionItem };
