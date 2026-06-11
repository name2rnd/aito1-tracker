package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// opencodeBlockedArgs are flags hardcoded by the daemon that must not be
// overridden by user-configured custom_args.
var opencodeBlockedArgs = map[string]blockedArgMode{
	"--format": blockedWithValue, // json output format for daemon communication
}

// opencodeBackend implements Backend by spawning `opencode run --format json`
// and reading streaming JSON events from stdout — the same pattern as Claude.
type opencodeBackend struct {
	cfg Config
}

func (b *opencodeBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
	execPath := b.cfg.ExecutablePath
	if execPath == "" {
		execPath = "opencode"
	}
	resolved, err := exec.LookPath(execPath)
	if err != nil {
		return nil, fmt.Errorf("opencode executable not found at %q: %w", execPath, err)
	}
	if runtime.GOOS == "windows" {
		if native := resolveOpenCodeNativeFromShim(resolved, os.Stat); native != "" {
			b.cfg.Logger.Info("opencode resolved to native binary to avoid .cmd shim argv truncation", "shim", resolved, "native", native)
			resolved = native
		}
	}
	execPath = resolved

	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 20 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)

	args := []string{"run", "--format", "json"}
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if opts.SystemPrompt != "" {
		args = append(args, "--prompt", opts.SystemPrompt)
	}
	if opts.MaxTurns > 0 {
		b.cfg.Logger.Warn("opencode does not support --max-turns; ignoring", "maxTurns", opts.MaxTurns)
	}
	if opts.ResumeSessionID != "" {
		args = append(args, "--session", opts.ResumeSessionID)
	}
	args = append(args, filterCustomArgs(opts.CustomArgs, opencodeBlockedArgs, b.cfg.Logger)...)
	args = append(args, prompt)

	cmd := exec.CommandContext(runCtx, execPath, args...)
	hideAgentWindow(cmd)
	b.cfg.Logger.Info("agent command", "exec", execPath, "args", args)
	cmd.WaitDelay = 10 * time.Second
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}

	env := buildEnv(b.cfg.Env)
	// Auto-approve all tool use in daemon mode.
	env = append(env, `OPENCODE_PERMISSION={"*":"allow"}`)
	cmd.Env = env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("opencode stdout pipe: %w", err)
	}
	cmd.Stderr = newLogWriter(b.cfg.Logger, "[opencode:stderr] ")

	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start opencode: %w", err)
	}

	b.cfg.Logger.Info("opencode started", "pid", cmd.Process.Pid, "cwd", opts.Cwd, "model", opts.Model)

	msgCh := make(chan Message, 256)
	resCh := make(chan Result, 1)

	// Close stdout when the context is cancelled so the scanner unblocks.
	go func() {
		<-runCtx.Done()
		_ = stdout.Close()
	}()

	go func() {
		defer cancel()
		defer close(msgCh)
		defer close(resCh)

		startTime := time.Now()
		scanResult := b.processEvents(stdout, msgCh)

		// Wait for process exit.
		exitErr := cmd.Wait()
		duration := time.Since(startTime)

		if runCtx.Err() == context.DeadlineExceeded {
			scanResult.status = "timeout"
			scanResult.errMsg = fmt.Sprintf("opencode timed out after %s", timeout)
		} else if runCtx.Err() == context.Canceled {
			scanResult.status = "aborted"
			scanResult.errMsg = "execution cancelled"
		} else if exitErr != nil && scanResult.status == "completed" {
			scanResult.status = "failed"
			scanResult.errMsg = fmt.Sprintf("opencode exited with error: %v", exitErr)
		}

		b.cfg.Logger.Info("opencode finished", "pid", cmd.Process.Pid, "status", scanResult.status, "duration", duration.Round(time.Millisecond).String())

		// Recover the final step's output that `run --format json` drops on exit
		// (flush race) by reading the persisted session straight from opencode's
		// SQLite store. The stream stays the live source for tool-use and
		// intermediate text; the store is the source of truth for the final
		// answer the daemon parses.
		if scanResult.status == "completed" && scanResult.sessionID != "" {
			recCtx, recCancel := context.WithTimeout(context.Background(), 15*time.Second)
			full, final, recErr := b.readSessionOutput(recCtx, scanResult.sessionID)
			recCancel()
			if recErr != nil {
				b.cfg.Logger.Warn("opencode session read failed; using streamed output", "error", recErr, "session", scanResult.sessionID)
			} else if full != "" {
				if final != "" && !strings.Contains(scanResult.output, strings.TrimSpace(final)) {
					// The final text never streamed — backfill the timeline so
					// task_message isn't missing the agent's closing message.
					trySend(msgCh, Message{Type: MessageText, Content: final})
				}
				scanResult.output = full
			}
		}

		// Build usage map. OpenCode doesn't report model per-step, so we
		// attribute all usage to the configured model (or "unknown").
		var usage map[string]TokenUsage
		u := scanResult.usage
		if u.InputTokens > 0 || u.OutputTokens > 0 || u.CacheReadTokens > 0 || u.CacheWriteTokens > 0 {
			model := opts.Model
			if model == "" {
				model = "unknown"
			}
			usage = map[string]TokenUsage{model: u}
		}

		resCh <- Result{
			Status:     scanResult.status,
			Output:     scanResult.output,
			Error:      scanResult.errMsg,
			DurationMs: duration.Milliseconds(),
			SessionID:  scanResult.sessionID,
			Usage:      usage,
		}
	}()

	return &Session{Messages: msgCh, Result: resCh}, nil
}

// ── Event handlers ──

// eventResult holds the accumulated state from processing the event stream.
type eventResult struct {
	status    string
	errMsg    string
	output    string
	sessionID string
	usage     TokenUsage // accumulated token usage across all steps
}

// processEvents reads JSON lines from r, dispatches events to ch, and returns
// the accumulated result. This is the core scanner loop, extracted for testability.
func (b *opencodeBackend) processEvents(r io.Reader, ch chan<- Message) eventResult {
	var output strings.Builder
	var sessionID string
	var usage TokenUsage
	finalStatus := "completed"
	var finalError string

	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var event opencodeEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			continue
		}

		if event.SessionID != "" {
			sessionID = event.SessionID
		}

		switch event.Type {
		case "text":
			b.handleTextEvent(event, ch, &output)
		case "tool_use":
			b.handleToolUseEvent(event, ch)
		case "error":
			b.handleErrorEvent(event, ch, &finalStatus, &finalError)
		case "step_start":
			trySend(ch, Message{Type: MessageStatus, Status: "running"})
		case "step_finish":
			// Accumulate token usage from step_finish events.
			if t := event.Part.Tokens; t != nil {
				usage.InputTokens += t.Input
				usage.OutputTokens += t.Output
				if t.Cache != nil {
					usage.CacheReadTokens += t.Cache.Read
					usage.CacheWriteTokens += t.Cache.Write
				}
			}
		}
	}

	// Check for scanner errors (e.g. broken pipe, read errors).
	if scanErr := scanner.Err(); scanErr != nil {
		b.cfg.Logger.Warn("opencode stdout scanner error", "error", scanErr)
		if finalStatus == "completed" {
			finalStatus = "failed"
			finalError = fmt.Sprintf("stdout read error: %v", scanErr)
		}
	}

	return eventResult{
		status:    finalStatus,
		errMsg:    finalError,
		output:    output.String(),
		sessionID: sessionID,
		usage:     usage,
	}
}

func (b *opencodeBackend) handleTextEvent(event opencodeEvent, ch chan<- Message, output *strings.Builder) {
	text := event.Part.Text
	if text != "" {
		output.WriteString(text)
		trySend(ch, Message{Type: MessageText, Content: text})
	}
}

// handleToolUseEvent processes "tool_use" events from opencode. A single
// tool_use event contains both the call and result in part.state when the
// tool has completed (state.status == "completed").
func (b *opencodeBackend) handleToolUseEvent(event opencodeEvent, ch chan<- Message) {
	// Extract input from state.input (the tool invocation parameters).
	var input map[string]any
	if event.Part.State != nil && event.Part.State.Input != nil {
		_ = json.Unmarshal(event.Part.State.Input, &input)
	}

	// Emit the tool-use message.
	trySend(ch, Message{
		Type:   MessageToolUse,
		Tool:   event.Part.Tool,
		CallID: event.Part.CallID,
		Input:  input,
	})

	// If the tool has completed, also emit a tool-result message.
	if event.Part.State != nil && event.Part.State.Status == "completed" {
		outputStr := extractToolOutput(event.Part.State.Output)
		trySend(ch, Message{
			Type:   MessageToolResult,
			Tool:   event.Part.Tool,
			CallID: event.Part.CallID,
			Output: outputStr,
		})
	}
}

// handleErrorEvent processes "error" events from opencode. OpenCode can exit
// with RC=0 even on errors (e.g. invalid model), so error events are the
// reliable signal for failures.
func (b *opencodeBackend) handleErrorEvent(event opencodeEvent, ch chan<- Message, finalStatus, finalError *string) {
	errMsg := ""
	if event.Error != nil {
		errMsg = event.Error.Message()
	}
	if errMsg == "" {
		errMsg = "unknown opencode error"
	}

	b.cfg.Logger.Warn("opencode error event", "error", errMsg)
	trySend(ch, Message{Type: MessageError, Content: errMsg})

	*finalStatus = "failed"
	*finalError = errMsg
}

// resolveOpenCodeNativeFromShim returns the path to the native OpenCode
// executable bundled inside the npm package, given the path to the npm
// `opencode.cmd` shim that PATH lookup found on Windows. Returns "" if shim
// doesn't end in `.cmd` or no candidate npm platform package has a bundled
// native binary present.
//
// Windows batch argument forwarding via `%*` does not preserve newlines, so
// multi-line positional argv is truncated at the first newline before the
// shim hands off to the JS entrypoint. Daemon prompts can include literal
// newlines (system prompt + user message), which makes the agent see only
// the first line. Native binary spawn skips the cmd.exe layer entirely.
//
// Layout when installed via `npm install -g opencode-ai`:
//
//	<prefix>\opencode.cmd                                                                       (shim)
//	<prefix>\node_modules\opencode-ai\node_modules\opencode-windows-{x64,x64-baseline,arm64}\bin\opencode.exe (native)
//
// `opencode-windows-x64-baseline` ships for older CPUs without AVX2;
// `opencode-windows-arm64` ships for Surface / Copilot+ PC hosts.
// Candidates are tried in GOARCH-preferred order so the most likely match
// for the current host comes first.
//
// statFn is injected so this is testable on non-Windows hosts.
func resolveOpenCodeNativeFromShim(shimPath string, statFn func(string) (os.FileInfo, error)) string {
	if !strings.EqualFold(filepath.Ext(shimPath), ".cmd") {
		return ""
	}
	prefix := filepath.Dir(shimPath)
	for _, pkg := range opencodeWindowsPackageCandidates(runtime.GOARCH) {
		candidate := filepath.Join(prefix, "node_modules", "opencode-ai", "node_modules", pkg, "bin", "opencode.exe")
		if _, err := statFn(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// opencodeWindowsPackageCandidates returns the npm platform package names
// that may host the bundled `opencode.exe` on Windows, ordered so the most
// likely match for the given GOARCH comes first. ARM64 hosts try the arm64
// build first; everything else tries x64, then the baseline x64 build for
// older CPUs without AVX2, then arm64 as a final fallback. Cost is one
// extra statFn call per miss when the GOARCH-preferred package isn't
// installed.
func opencodeWindowsPackageCandidates(goarch string) []string {
	switch goarch {
	case "arm64":
		return []string{"opencode-windows-arm64", "opencode-windows-x64", "opencode-windows-x64-baseline"}
	default:
		return []string{"opencode-windows-x64", "opencode-windows-x64-baseline", "opencode-windows-arm64"}
	}
}

// extractToolOutput converts the tool state output (which may be a string or
// structured object) into a string.
func extractToolOutput(output any) string {
	if output == nil {
		return ""
	}
	if s, ok := output.(string); ok {
		return s
	}
	data, _ := json.Marshal(output)
	return string(data)
}

// ── JSON types for `opencode run --format json` stdout events ──

// opencodeEvent represents a single JSON line from `opencode run --format json`.
//
// Event types observed in real output:
//
//	"step_start"  — agent step begins
//	"text"        — text output from agent (part.text)
//	"tool_use"    — tool invocation with call and result (part.tool, part.callID, part.state)
//	"error"       — error from opencode (error.name, error.data.message)
//	"step_finish" — agent step completes (includes token usage)
type opencodeEvent struct {
	Type      string            `json:"type"`
	Timestamp int64             `json:"timestamp,omitempty"`
	SessionID string            `json:"sessionID,omitempty"`
	Part      opencodeEventPart `json:"part"`
	Error     *opencodeError    `json:"error,omitempty"`
}

// opencodeEventPart represents the part field in an opencode event.
type opencodeEventPart struct {
	ID        string `json:"id,omitempty"`
	MessageID string `json:"messageID,omitempty"`
	SessionID string `json:"sessionID,omitempty"`
	Type      string `json:"type,omitempty"`

	// Text events
	Text string `json:"text,omitempty"`

	// Tool use events
	Tool   string             `json:"tool,omitempty"`
	CallID string             `json:"callID,omitempty"`
	State  *opencodeToolState `json:"state,omitempty"`

	// step_finish token usage
	Tokens *opencodeTokens `json:"tokens,omitempty"`
}

// opencodeTokens represents token usage in a step_finish event.
type opencodeTokens struct {
	Input  int64                `json:"input"`
	Output int64                `json:"output"`
	Cache  *opencodeCacheTokens `json:"cache,omitempty"`
}

type opencodeCacheTokens struct {
	Read  int64 `json:"read"`
	Write int64 `json:"write"`
}

// opencodeToolState represents the state of a tool invocation.
type opencodeToolState struct {
	Status string          `json:"status,omitempty"`
	Input  json.RawMessage `json:"input,omitempty"`
	Output any             `json:"output,omitempty"`
}

// opencodeError represents an error event from opencode.
type opencodeError struct {
	Name string           `json:"name,omitempty"`
	Data *opencodeErrData `json:"data,omitempty"`
}

// Message returns the human-readable error message.
func (e *opencodeError) Message() string {
	if e.Data != nil && e.Data.Message != "" {
		return e.Data.Message
	}
	if e.Name != "" {
		return e.Name
	}
	return ""
}

type opencodeErrData struct {
	Message string `json:"message,omitempty"`
}

// ── Final-output recovery from the opencode session store ──
//
// opencode 1.16.2 `run --format json` drops the final step's text part and
// closing step_finish from stdout on process exit (a flush-on-exit race in the
// Bun runtime): every non-final step streams fully, but the last step emits
// only its step_start. A single-step answer therefore reaches stdout as just a
// step_start with no text. The agent's final marker (e.g. [PLAN] /
// [EXECUTOR REPORT]) lives in that dropped step, so without recovery the daemon
// sees empty output and marks the task failed.
//
// The persisted session is the source of truth. `opencode export <sessionID>`
// exists for this but proved unreliable right after a run: it spins up its own
// server that races the just-exited run's lingering server and prints truncated
// JSON for tens of seconds. The session store itself — a SQLite DB — already
// holds every part the instant the run exits, so we read it directly (WAL-aware,
// via the sqlite3 CLI) instead. The trade-off is a dependency on opencode's
// internal DB layout; if a future opencode changes it, recovery falls back to
// the streamed output.

// opencodeSessionIDRe whitelists the session-id charset so it can be safely
// interpolated into the SQL below (opencode ids look like "ses_<base62>").
var opencodeSessionIDRe = regexp.MustCompile(`^ses_[A-Za-z0-9]+$`)

// opencodeDBPath returns the path to opencode's session SQLite store, honoring
// MULTICA_OPENCODE_DB then XDG_DATA_HOME, defaulting to ~/.local/share/opencode.
func opencodeDBPath() string {
	if p := os.Getenv("MULTICA_OPENCODE_DB"); p != "" {
		return p
	}
	dataHome := os.Getenv("XDG_DATA_HOME")
	if dataHome == "" {
		dataHome = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(dataHome, "opencode", "opencode.db")
}

// opencodeDBRow is one row from the session-store query: an assistant text part
// plus the time_created of its message (used to identify the last message).
type opencodeDBRow struct {
	Text        string `json:"text"`
	MessageTime int64  `json:"mt"`
}

// readSessionOutput reads the assistant output for a finished opencode session
// straight from the session store (via `sqlite3 -json`). It returns the same
// (full, final) pair the stream would have, recovering the final step the stream
// drops. The sessionID is validated against a strict charset before being
// interpolated into the query, so it cannot inject SQL.
func (b *opencodeBackend) readSessionOutput(ctx context.Context, sessionID string) (full, final string, err error) {
	if !opencodeSessionIDRe.MatchString(sessionID) {
		return "", "", fmt.Errorf("invalid opencode session id %q", sessionID)
	}
	query := "SELECT json_extract(p.data,'$.text') AS text, m.time_created AS mt " +
		"FROM part p JOIN message m ON p.message_id = m.id " +
		"WHERE p.session_id = '" + sessionID + "' " +
		"AND json_extract(m.data,'$.role') = 'assistant' " +
		"AND json_extract(p.data,'$.type') = 'text' " +
		"AND json_extract(p.data,'$.text') IS NOT NULL " +
		"ORDER BY m.time_created, p.time_created;"
	cmd := exec.CommandContext(ctx, "sqlite3", "-json", opencodeDBPath(), query)
	hideAgentWindow(cmd)
	out, runErr := cmd.Output()
	if runErr != nil {
		return "", "", fmt.Errorf("read opencode session %s: %w", sessionID, runErr)
	}
	return parseOpencodeDBRows(out)
}

// parseOpencodeDBRows turns the `sqlite3 -json` result into (full, final):
//
//	full  — every assistant text part concatenated in store order (the complete
//	        output, including any text that did stream through);
//	final — the text parts of the last assistant message (max message time),
//	        i.e. the closing message the stream tends to drop.
//
// Empty output (no rows — sqlite3 prints nothing) yields empty strings and no
// error, so the caller cleanly falls back to the streamed output.
func parseOpencodeDBRows(data []byte) (full, final string, err error) {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" {
		return "", "", nil
	}
	var rows []opencodeDBRow
	if err := json.Unmarshal([]byte(trimmed), &rows); err != nil {
		return "", "", fmt.Errorf("parse opencode db rows: %w", err)
	}
	if len(rows) == 0 {
		return "", "", nil
	}
	var lastMT int64
	for _, r := range rows {
		if r.MessageTime > lastMT {
			lastMT = r.MessageTime
		}
	}
	var fullB, finalB strings.Builder
	for _, r := range rows {
		fullB.WriteString(r.Text)
		if r.MessageTime == lastMT {
			finalB.WriteString(r.Text)
		}
	}
	return fullB.String(), finalB.String(), nil
}
