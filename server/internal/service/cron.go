package service

import (
	"fmt"
	"time"

	"github.com/adhocore/gronx"
)

// ComputeNextRun parses a cron expression and returns the next fire time in the
// given timezone.
//
// Backed by gronx (not robfig/cron) so the scheduler supports day-of-week
// extensions needed for processes anchored to weekdays:
//   - nth weekday:     `0 17 * * 5#4`  → 4th Friday of the month at 17:00
//   - last weekday:    `0 17 * * 5L`   → last Friday of the month
//   - nearest weekday: `0 9 15W * *`   → weekday nearest the 15th
//
// robfig/cron supported none of these and treated a both-set day-of-month +
// day-of-week as OR, which cannot express "the 4th Friday".
func ComputeNextRun(cronExpr, timezone string) (time.Time, error) {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid timezone %q: %w", timezone, err)
	}
	if !gronx.New().IsValid(cronExpr) {
		return time.Time{}, fmt.Errorf("parse cron: invalid expression %q", cronExpr)
	}
	// gronx computes relative to the reference time's location, so anchor "now"
	// to the trigger's timezone. inclusive=false → strictly the NEXT tick.
	next, err := gronx.NextTickAfter(cronExpr, time.Now().In(loc), false)
	if err != nil {
		return time.Time{}, fmt.Errorf("compute next run: %w", err)
	}
	return next, nil
}

// ValidateTimezone returns an error if the timezone string is not recognized.
func ValidateTimezone(timezone string) error {
	_, err := time.LoadLocation(timezone)
	if err != nil {
		return fmt.Errorf("invalid timezone %q: %w", timezone, err)
	}
	return nil
}
