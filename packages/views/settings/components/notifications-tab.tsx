"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { notificationPreferenceOptions } from "@multica/core/notification-preferences/queries";
import { useUpdateNotificationPreferences } from "@multica/core/notification-preferences/mutations";
import type { NotificationGroupKey, NotificationPreferences } from "@multica/core/types";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Switch } from "@multica/ui/components/ui/switch";
import { toast } from "sonner";
import { useT } from "../../i18n";

// Inbox event groups rendered in the per-event toggle list. `system_notifications`
// is a sibling preference key but lives in its own section below.
const INBOX_GROUP_KEYS = [
  "assignments",
  "status_changes",
  "comments",
  "updates",
  "agent_activity",
] as const;
type InboxGroupKey = (typeof INBOX_GROUP_KEYS)[number];

export function NotificationsTab() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const { data } = useQuery(notificationPreferenceOptions(wsId));
  const mutation = useUpdateNotificationPreferences();

  const preferences = data?.preferences ?? {};

  const handleToggle = (key: NotificationGroupKey, enabled: boolean) => {
    const updated: NotificationPreferences = {
      ...preferences,
      [key]: enabled ? "all" : "muted",
    };
    // Remove keys set to "all" (default) to keep the object clean
    if (enabled) {
      delete updated[key];
    }
    mutation.mutate(updated, {
      onError: () => toast.error(t(($) => $.notifications.toast_failed)),
    });
  };

  const systemEnabled = preferences.system_notifications !== "muted";

  // Telegram master switch — the flag lives in aito1_settings
  // (`notifications.telegram.enabled`), reached via the same-origin Brain BFF.
  // Off → the AITO1 brain sends no Telegram messages; the Human relies on the
  // Inbox instead.
  const TG_KEY = ["notification-settings", "telegram"] as const;
  const qc = useQueryClient();
  const tgQuery = useQuery({
    queryKey: TG_KEY,
    queryFn: async (): Promise<{ telegram_enabled: boolean }> => {
      const r = await fetch("/bff/notification-settings", { credentials: "include" });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });
  const tgMutation = useMutation({
    mutationFn: async (enabled: boolean): Promise<{ telegram_enabled: boolean }> => {
      const r = await fetch("/bff/notification-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ telegram_enabled: enabled }),
      });
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: TG_KEY });
      const prev = qc.getQueryData<{ telegram_enabled: boolean }>(TG_KEY);
      qc.setQueryData(TG_KEY, { telegram_enabled: enabled });
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(TG_KEY, ctx.prev);
      toast.error(t(($) => $.notifications.toast_failed));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: TG_KEY }),
  });
  const telegramEnabled = tgQuery.data?.telegram_enabled ?? false;

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.notifications.title)}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t(($) => $.notifications.description)}
          </p>
        </div>

        <Card>
          <CardContent className="divide-y">
            {INBOX_GROUP_KEYS.map((key: InboxGroupKey) => {
              const enabled = preferences[key] !== "muted";
              return (
                <div
                  key={key}
                  className="flex items-center justify-between py-3 first:pt-0 last:pb-0"
                >
                  <div className="space-y-0.5 pr-4">
                    <p className="text-sm font-medium">{t(($) => $.notifications.groups[key].label)}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(($) => $.notifications.groups[key].description)}
                    </p>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) => handleToggle(key, checked)}
                  />
                </div>
              );
            })}
          </CardContent>
        </Card>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.notifications.system.title)}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t(($) => $.notifications.system.description)}
          </p>
        </div>

        <Card>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5 pr-4">
                <p className="text-sm font-medium">{t(($) => $.notifications.system.label)}</p>
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.notifications.system.hint)}
                </p>
              </div>
              <Switch
                checked={systemEnabled}
                onCheckedChange={(checked) => handleToggle("system_notifications", checked)}
              />
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">{t(($) => $.notifications.telegram.title)}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {t(($) => $.notifications.telegram.description)}
          </p>
        </div>

        <Card>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5 pr-4">
                <p className="text-sm font-medium">{t(($) => $.notifications.telegram.label)}</p>
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.notifications.telegram.hint)}
                </p>
              </div>
              <Switch
                checked={telegramEnabled}
                disabled={tgQuery.isLoading || tgMutation.isPending}
                onCheckedChange={(checked) => tgMutation.mutate(checked)}
              />
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
