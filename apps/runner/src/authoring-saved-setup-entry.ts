import { assertSavedBoundaryAuthoringEnvelopeCurrent } from "./boundary-authoring-resume.js";
import { OLDER_AUTHORING_SETUP_MESSAGE } from "./authoring-protocol.js";
import type { BoundaryAccessNotice } from "./boundary-cli-picker.js";

/** Public entry gate precedes metadata/menu construction. It reads only the
 * native envelope; unsupported records never select a compatibility route. */
export async function enterSavedAuthoringSetup(projectRoot: string, present: (notice: BoundaryAccessNotice) => void): Promise<boolean> {
  try { await assertSavedBoundaryAuthoringEnvelopeCurrent(projectRoot); return true; }
  catch (error) {
    if ((error as { code?: string })?.code !== "AUTHORING_SETUP_OLDER_VERSION") throw error;
    present({ tone: "warning", title: "Older setup cannot be resumed", lines: [OLDER_AUTHORING_SETUP_MESSAGE],
      footer: "The saved setup is unchanged; no model request or migration was started." });
    return false;
  }
}
