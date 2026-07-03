"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  readIdentities,
  switchIdentity,
  useAuthStore,
  type LocalIdentity,
} from "@multica/core/auth";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@multica/ui/components/ui/card";
import { Button } from "@multica/ui/components/ui/button";
import { ActorAvatar } from "@multica/ui/components/common/actor-avatar";

// AITO1-patch (Патч 40): the login wall is gone. This route is now a dev
// identity-picker — the graceful fallback shown ONLY when localStorage holds no
// PAT (fresh browser or cleared storage). Normal navigation never lands here:
// the proxy funnels every URL into the workspace and a seeded token keeps the
// operator authed. Picking a member writes its PAT and reloads into the app.
// Replaces the upstream email-OTP + Google OAuth + CLI/desktop handoff flow;
// CLI browser-login is dropped — the CLI uses its configured PAT directly.
export default function Page() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [identities, setIdentities] = useState<LocalIdentity[]>([]);
  const [manual, setManual] = useState("");

  useEffect(() => {
    setIdentities(readIdentities());
  }, []);

  // Already acting as someone (e.g. landed here with a valid token) → leave the
  // picker; the proxy sends "/" on into the workspace board.
  useEffect(() => {
    if (user) router.replace("/");
  }, [user, router]);

  const enterManual = () => {
    const token = manual.trim();
    if (token) switchIdentity(token);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Choose identity</CardTitle>
          <CardDescription>
            Local tracker — pick the member to act as.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {identities.length > 0 ? (
            <div className="space-y-1.5">
              {identities.map((ident) => (
                <button
                  key={ident.id}
                  type="button"
                  onClick={() => switchIdentity(ident.token)}
                  className="flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted"
                >
                  <ActorAvatar
                    name={ident.name}
                    initials={ident.name.charAt(0).toUpperCase()}
                    size={28}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-tight">
                      {ident.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground leading-tight">
                      {ident.email} · {ident.role}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              No identities seeded in this browser. Paste a personal access token
              (mul_…) to get in, then re-seed the registry.
            </p>
          )}

          <div className="space-y-2 border-t pt-4">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="mul_… (paste a PAT)"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <Button
              className="w-full"
              onClick={enterManual}
              disabled={!manual.trim()}
            >
              Enter
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
