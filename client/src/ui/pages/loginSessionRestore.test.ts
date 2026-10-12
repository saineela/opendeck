import { describe, expect, it, vi } from "vitest";
import { restoreLibraryAfterAccountSignIn } from "./loginSessionRestore";

describe("post-login library restoration", () => {
  it("reloads app data and restores YouTube for an already-linked account", async () => {
    const loadAppLibrary = vi.fn(async () => undefined);
    const recoverConnection = vi.fn(async () => undefined);

    await restoreLibraryAfterAccountSignIn({ loadAppLibrary, recoverConnection }, true);

    expect(loadAppLibrary).toHaveBeenCalledOnce();
    expect(recoverConnection).toHaveBeenCalledOnce();
    expect(loadAppLibrary.mock.invocationCallOrder[0]).toBeLessThan(
      recoverConnection.mock.invocationCallOrder[0],
    );
  });

  it("loads app data without retrying YouTube linking when no YouTube account is linked", async () => {
    const loadAppLibrary = vi.fn(async () => undefined);
    const recoverConnection = vi.fn(async () => undefined);

    await restoreLibraryAfterAccountSignIn({ loadAppLibrary, recoverConnection }, false);

    expect(loadAppLibrary).toHaveBeenCalledOnce();
    expect(recoverConnection).not.toHaveBeenCalled();
  });
});
