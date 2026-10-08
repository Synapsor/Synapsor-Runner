import { assertSavedBoundaryAuthoringEnvelopeCurrent, type BoundaryAuthoringResumeLoad } from "./boundary-authoring-resume.js";
import { OLDER_AUTHORING_SETUP_MESSAGE } from "./authoring-protocol.js";
import type { BoundaryAccessNotice } from "./boundary-cli-picker.js";

/** Public entry gate precedes metadata/menu construction. It reads only the
 * native envelope and current records; unsupported records never select a compatibility route. */
export async function enterSavedAuthoringSetup(projectRoot: string, present: (notice: BoundaryAccessNotice) => void): Promise<boolean> {
  try { await assertSavedBoundaryAuthoringEnvelopeCurrent(projectRoot); return true; }
  catch (error) {
    if ((error as { code?: string })?.code !== "AUTHORING_SETUP_OLDER_VERSION") throw error;
    present(olderSetupNotice());
    return false;
  }
}

function olderSetupNotice(): BoundaryAccessNotice {
  return { tone: "warning", title: "Older setup cannot be resumed", lines: [OLDER_AUTHORING_SETUP_MESSAGE],
    footer: "The saved setup is unchanged; no model request or migration was started." };
}
/** Inner entry uses the same presentation owner after the native binding load. */
export function savedSetupEntryNotice(loaded: BoundaryAuthoringResumeLoad): BoundaryAccessNotice | undefined {
  return loaded.status === "invalid" && loaded.reason === OLDER_AUTHORING_SETUP_MESSAGE ? olderSetupNotice() : undefined;
}
