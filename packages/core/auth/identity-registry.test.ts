import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  readIdentities,
  activeToken,
  activeIdentity,
  switchIdentity,
} from "./identity-registry";

// The registry reads `window.localStorage`. Vitest's default env here is node
// (jsdom without an origin doesn't expose localStorage), so stub a minimal one
// — matching store.test.ts's inject-a-fake-storage approach.
function makeLocalStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: makeLocalStorage() });
});

describe("identity-registry", () => {
  it("readIdentities parses a valid registry", () => {
    window.localStorage.setItem(
      "multica_identities",
      JSON.stringify([
        { id: "human", name: "Human", role: "owner", email: "h@a.local", token: "mul_x" },
      ]),
    );
    const list = readIdentities();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("Human");
  });

  it("readIdentities returns [] on missing or malformed data", () => {
    expect(readIdentities()).toEqual([]);
    window.localStorage.setItem("multica_identities", "not json");
    expect(readIdentities()).toEqual([]);
    window.localStorage.setItem("multica_identities", JSON.stringify({ nope: 1 }));
    expect(readIdentities()).toEqual([]);
  });

  it("readIdentities drops entries missing id or token", () => {
    window.localStorage.setItem(
      "multica_identities",
      JSON.stringify([
        { id: "ok", name: "OK", role: "member", email: "o@a.local", token: "mul_ok" },
        { name: "no id or token" },
        { id: "no-token" },
      ]),
    );
    expect(readIdentities().map((i) => i.id)).toEqual(["ok"]);
  });

  it("activeToken / activeIdentity reflect multica_token", () => {
    window.localStorage.setItem(
      "multica_identities",
      JSON.stringify([
        { id: "louis", name: "Louis", role: "member", email: "l@a.local", token: "mul_lou" },
      ]),
    );
    expect(activeToken()).toBeNull();
    expect(activeIdentity()).toBeNull();

    window.localStorage.setItem("multica_token", "mul_lou");
    expect(activeToken()).toBe("mul_lou");
    expect(activeIdentity()?.id).toBe("louis");
  });

  it("switchIdentity persists the token and triggers reload", () => {
    const reload = vi.fn();
    switchIdentity("mul_new", reload);
    expect(window.localStorage.getItem("multica_token")).toBe("mul_new");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("switchIdentity still reloads when token is unchanged", () => {
    window.localStorage.setItem("multica_token", "mul_same");
    const reload = vi.fn();
    switchIdentity("mul_same", reload);
    expect(window.localStorage.getItem("multica_token")).toBe("mul_same");
    expect(reload).toHaveBeenCalledOnce();
  });
});
