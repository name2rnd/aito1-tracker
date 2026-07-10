import { beforeEach, describe, expect, it } from "vitest";
import { useIssuePeekStore } from "./peek-store";

describe("issue peek store", () => {
  beforeEach(() => {
    useIssuePeekStore.setState({ openId: null });
  });

  it("starts closed", () => {
    expect(useIssuePeekStore.getState().openId).toBeNull();
  });

  it("open sets the id", () => {
    useIssuePeekStore.getState().open("AIT-42");
    expect(useIssuePeekStore.getState().openId).toBe("AIT-42");
  });

  it("open replaces the currently open id", () => {
    const { open } = useIssuePeekStore.getState();
    open("AIT-42");
    open("AIT-43");
    expect(useIssuePeekStore.getState().openId).toBe("AIT-43");
  });

  it("close clears the id", () => {
    useIssuePeekStore.getState().open("AIT-42");
    useIssuePeekStore.getState().close();
    expect(useIssuePeekStore.getState().openId).toBeNull();
  });
});
