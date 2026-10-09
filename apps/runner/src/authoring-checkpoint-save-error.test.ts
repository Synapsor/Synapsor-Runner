import { describe, expect, it } from "vitest";
import { AuthoringResumeMaterialError, AuthoringCheckpointSaveError, rejectedCheckpointMaterial } from "./authoring-checkpoint-save-error.js";
import { assertBoundaryAuthoringResumeMaterial } from "./boundary-authoring-resume.js";

describe("checkpoint rejection follows actual native cause", () => {
  it.each([{answer:"api_key=secret"},{answer:"principal_id: actual-private-identity"}])("binds native rejection of %j without wrapper wording", value => {
    let cause: unknown;
    try { assertBoundaryAuthoringResumeMaterial(value); } catch (error) { cause=error; }
    expect(cause).toBeInstanceOf(AuthoringResumeMaterialError);
    const checkpoint=new AuthoringCheckpointSaveError("different display words", "redacted diagnostic", cause as AuthoringResumeMaterialError);
    expect(rejectedCheckpointMaterial(checkpoint)).toBe(true);
    expect(checkpoint.cause).toBe(cause);
    expect(checkpoint.message).not.toContain(value.answer);
  });
  it("rejects provider/ordinary errors that merely repeat the old English wrapper",()=>{
    const prose="ACTION_CHECKPOINT_NOT_SAVED: The checkpoint could not be saved. BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED: copied prose";
    expect(rejectedCheckpointMaterial(new Error(prose))).toBe(false);
    expect(rejectedCheckpointMaterial(Object.assign(new Error(prose),{code:"ACTION_CHECKPOINT_NOT_SAVED",cause:{code:"BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED"}}))).toBe(false);
  });
  it("does not carry rejected material into a later ordinary save failure",()=>{
    const material=new AuthoringResumeMaterialError("BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED","redacted");
    expect(rejectedCheckpointMaterial(new AuthoringCheckpointSaveError("checkpoint","diagnostic",material))).toBe(true);
    expect(rejectedCheckpointMaterial(new AuthoringCheckpointSaveError("currentness","same displayed diagnostic"))).toBe(false);
  });
});
