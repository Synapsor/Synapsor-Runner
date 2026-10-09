import { AuthoringMaterialContextError, assertAuthoringMaterial, resolveAuthoringMaterialContext,
  snapshotAuthoringMaterial } from "./authoring-resume-material.js";

/** Capture before resolving configuration: the caller's original objects must
 * never be serialized again after an asynchronous screening boundary. This
 * adapter supplies no save permission; the Resume writer still owns its CAS. */
export async function prepareAuthoringResumeMaterial(projectRoot: string, value: unknown) {
  const captured = snapshotAuthoringMaterial(value);
  const material: unknown = JSON.parse(captured);
  if (!material || typeof material !== "object" || Array.isArray(material)
    || typeof (material as Record<string, unknown>).created_at !== "string")
    throw new AuthoringMaterialContextError("AUTHORING_MATERIAL_CONTEXT_UNAVAILABLE");
  const owner = Object.freeze({ projectRoot, jobCreatedAt: (material as { created_at: string }).created_at });
  const context = await resolveAuthoringMaterialContext(owner);
  const recheck = () => assertAuthoringMaterial({ value: JSON.parse(captured), owner,
    origin: "retained_material", context });
  const json = await recheck();
  return Object.freeze({ json, recheck });
}
