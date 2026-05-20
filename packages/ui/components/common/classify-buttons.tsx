"use client";

// AITO1 permission system: classify an unknown command from the Teamlead's
// grant-request comment. Two buttons map to reaction emojis `read` / `write`
// (plain strings — comment_reaction.emoji has no charset constraint). Brain's
// state machine routes `comment_reaction:added` with these emojis to command
// classification (see brain/listener/state_machine.py:_maybe_classify_from_reaction).
// Rendered instead of LikeButton when the comment carries the
// `<!-- aito1:classify_request -->` sentinel.

interface ClassifyButtonsProps {
  onToggle: (emoji: string) => void;
  className?: string;
}

function ClassifyButtons({ onToggle, className }: ClassifyButtonsProps) {
  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-xs text-muted-foreground">Что делает эта команда?</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Read"
          title="Только читает данные — разрешу навсегда, без записи в план"
          onClick={() => onToggle("read")}
          className="inline-flex items-center gap-1 rounded-full border border-brand/20 bg-brand/5 px-3 py-1 text-xs text-foreground transition-colors hover:bg-brand/15"
        >
          <span>📖</span>
          <span>Read</span>
        </button>
        <button
          type="button"
          aria-label="Write"
          title="Модифицирует внешнюю систему — добавлю action в этот план"
          onClick={() => onToggle("write")}
          className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/5 px-3 py-1 text-xs text-foreground transition-colors hover:bg-amber-500/15"
        >
          <span>✏️</span>
          <span>Write</span>
        </button>
      </div>
    </div>
  );
}

export { ClassifyButtons };
