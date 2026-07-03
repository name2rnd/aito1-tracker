// AITO1-patch (Патч 40): local identity registry for the login-less fork.
//
// This fork removed the login wall (single-user, localhost-only). Instead of
// authenticating, the operator picks which existing member they act as. Each
// member already has a long-lived PAT (Human/Louis/Teamlead/Remote Human);
// the switcher writes the chosen PAT into `multica_token`, which flips the web
// app into Bearer/token mode (see web-providers `hasLegacyToken`) so the Go
// backend resolves identity from the PAT — exactly how Brain and the CLI act
// as a member today.
//
// The registry (names + PATs) lives ONLY in localStorage, seeded once out of
// band. It is never baked into the bundle or committed — the same PATs already
// sit plaintext in ~/.multica/config.json and ~/.aito1/*.env on this machine,
// so localStorage does not widen the (single-user) threat model.

const REGISTRY_KEY = "multica_identities";
const TOKEN_KEY = "multica_token";

export interface LocalIdentity {
  /** Stable key, e.g. "human" / "louis" / "teamlead". */
  id: string;
  /** Display name shown in the switcher. */
  name: string;
  /** owner | admin | member — shown as a hint, not enforced client-side. */
  role: string;
  email: string;
  /** Personal access token (mul_…) this member acts under. */
  token: string;
}

function ls(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Parse the seeded identity registry; returns [] on missing/malformed data. */
export function readIdentities(): LocalIdentity[] {
  const store = ls();
  if (!store) return [];
  try {
    const raw = store.getItem(REGISTRY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is LocalIdentity =>
        !!x &&
        typeof x === "object" &&
        typeof (x as LocalIdentity).id === "string" &&
        typeof (x as LocalIdentity).token === "string",
    );
  } catch {
    return [];
  }
}

/** The PAT currently in effect (whoever we're acting as), or null. */
export function activeToken(): string | null {
  return ls()?.getItem(TOKEN_KEY) ?? null;
}

/** The registry entry matching the active token, or null if none matches. */
export function activeIdentity(): LocalIdentity | null {
  const token = activeToken();
  if (!token) return null;
  return readIdentities().find((i) => i.token === token) ?? null;
}

/**
 * Switch the acting member: persist the PAT and reload so the app
 * re-initializes in Bearer mode under the new identity. `reload` is injectable
 * for tests; defaults to a full page reload.
 */
export function switchIdentity(
  token: string,
  reload: () => void = () => window.location.reload(),
): void {
  const store = ls();
  if (!store) return;
  store.setItem(TOKEN_KEY, token);
  reload();
}
