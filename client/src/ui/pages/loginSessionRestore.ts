import type { LibraryController } from "../../player/LibraryController";

/** Refresh account-owned data, rechecking YouTube only when the account is linked. */
export async function restoreLibraryAfterAccountSignIn(
  libraryController: Pick<LibraryController, "loadAppLibrary" | "recoverConnection">,
  youtubeLinked: boolean,
): Promise<void> {
  await libraryController.loadAppLibrary();
  if (youtubeLinked) void libraryController.recoverConnection();
}
