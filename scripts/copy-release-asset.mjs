import { cp } from "node:fs/promises";
import { basename } from "node:path";

export async function copyReleaseAsset(source, destination) {
  // Local stores can contain credentials and may be unreadable after Docker
  // tests. Exclude them before traversal, not only after the package is copied.
  await cp(source, destination, { recursive: true, filter: (entry) => basename(entry) !== ".synapsor" });
}
