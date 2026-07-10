import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppLink } from "./app-link";
import { NavigationProvider } from "./context";
import type { NavigationAdapter } from "./types";

function renderWithNav(
  ui: React.ReactElement,
  overrides: Partial<NavigationAdapter> = {},
) {
  const adapter: NavigationAdapter = {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    pathname: "/test/issues",
    searchParams: new URLSearchParams(),
    openInNewTab: vi.fn(),
    ...overrides,
  };
  render(<NavigationProvider value={adapter}>{ui}</NavigationProvider>);
  return adapter;
}

describe("AppLink", () => {
  it("plain click navigates via push when no onActivate", async () => {
    const nav = renderWithNav(<AppLink href="/test/issues/AIT-42">Open</AppLink>);
    await userEvent.click(screen.getByText("Open"));
    expect(nav.push).toHaveBeenCalledWith("/test/issues/AIT-42");
  });

  it("plain click runs onActivate instead of navigating", async () => {
    const onActivate = vi.fn();
    const nav = renderWithNav(
      <AppLink href="/test/issues/AIT-42" onActivate={onActivate}>
        Open
      </AppLink>,
    );
    await userEvent.click(screen.getByText("Open"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("modifier click opens a new tab even when onActivate is set", () => {
    const onActivate = vi.fn();
    const nav = renderWithNav(
      <AppLink href="/test/issues/AIT-42" onActivate={onActivate}>
        Open
      </AppLink>,
    );
    fireEvent.click(screen.getByText("Open"), { metaKey: true });
    expect(nav.openInNewTab).toHaveBeenCalledWith("/test/issues/AIT-42");
    expect(onActivate).not.toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
  });
});
