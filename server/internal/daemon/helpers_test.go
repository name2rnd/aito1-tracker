package daemon

import (
	"strings"
	"testing"
	"time"
)

func TestParseFlexDuration(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want time.Duration
	}{
		{"5d", 5 * 24 * time.Hour},
		{"1d", 24 * time.Hour},
		{"1d12h", 36 * time.Hour},
		{"2d30m", 2*24*time.Hour + 30*time.Minute},
		{"0.5d", 12 * time.Hour},
		{"1.5d", 36 * time.Hour},
		{".5d", 12 * time.Hour},
		{"120h", 120 * time.Hour},
		{"24h", 24 * time.Hour},
		{"30m", 30 * time.Minute},
	}
	for _, tc := range cases {
		got, err := parseFlexDuration(tc.in)
		if err != nil {
			t.Errorf("parseFlexDuration(%q) unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("parseFlexDuration(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestParseFlexDuration_Invalid(t *testing.T) {
	t.Parallel()
	for _, in := range []string{
		"",
		"xyz",
		"5days",
		"abc5d",
		// Overflow: 30 digits is well past int64/float64 safe range; must error
		// rather than silently produce 0h.
		"999999999999999999999999999999d",
	} {
		if _, err := parseFlexDuration(in); err == nil {
			t.Errorf("parseFlexDuration(%q) expected error, got nil", in)
		}
	}
}

func TestHumanCount(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0"},
		{42, "42"},
		{999, "999"},
		{1000, "1.0k"},
		{1234, "1.2k"},
		{187000, "187.0k"},
		{999999, "1000.0k"},
		{1000000, "1.0M"},
		{1200000, "1.2M"},
	}
	for _, tc := range cases {
		if got := humanCount(tc.in); got != tc.want {
			t.Errorf("humanCount(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestAppendFailureDiag(t *testing.T) {
	t.Parallel()

	// The opaque transient-failure case we actually want to diagnose: the
	// original message is preserved, and a run-shape suffix is appended with
	// duration, tool count, and per-model usage.
	msg := "API Error: The socket connection was closed unexpectedly."
	usage := []TaskUsageEntry{
		{Model: "claude-opus-4-7", InputTokens: 187000, OutputTokens: 2100, CacheReadTokens: 1200000, CacheWriteTokens: 45000},
	}
	got := appendFailureDiag(msg, "claude", 141*time.Second, 18, usage)

	if !strings.HasPrefix(got, msg) {
		t.Fatalf("original message not preserved as prefix: %q", got)
	}
	for _, want := range []string{
		"failed after 2m21s",
		"18 tools",
		"claude-opus-4-7",
		"in=187.0k",
		"out=2.1k",
		"cache_r=1.2M",
		"cache_w=45.0k",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("diag missing %q in: %q", want, got)
		}
	}
}

func TestAppendFailureDiag_NoUsageFallsBackToProvider(t *testing.T) {
	t.Parallel()
	// When usage carries no model name (early drop before any assistant turn),
	// the provider name stands in so the line is never blank.
	got := appendFailureDiag("boom", "claude", 3*time.Second, 0, []TaskUsageEntry{{InputTokens: 10}})
	if !strings.Contains(got, "claude in=10") {
		t.Errorf("expected provider fallback model, got: %q", got)
	}
	if !strings.Contains(got, "0 tools") {
		t.Errorf("expected zero tool count, got: %q", got)
	}
}
