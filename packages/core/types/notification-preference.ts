export type NotificationGroupKey =
  | "assignments"
  | "status_changes"
  | "comments"
  | "updates"
  | "agent_activity"
  | "system_notifications";

export type NotificationGroupValue = "all" | "muted";

// Delivery channel for "task ready for review" notifications. Shares the same
// preferences map (a special key), so the AITO1 brain (shared DB) reads it to
// gate its Telegram channel while the web app fires a browser banner.
export type DeliveryChannel = "telegram" | "browser";

export type NotificationPreferences = Partial<
  Record<NotificationGroupKey, NotificationGroupValue>
> & {
  delivery_channel?: DeliveryChannel;
};

export interface NotificationPreferenceResponse {
  workspace_id: string;
  preferences: NotificationPreferences;
}
