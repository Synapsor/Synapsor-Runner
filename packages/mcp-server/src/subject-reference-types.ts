export type SubjectReferenceDigest = `sha256:${string}`;

export type SubjectReferenceAuthorityContext = {
  source_id: string;
  read_boundary_digest: SubjectReferenceDigest;
  generation_lock_fingerprint: SubjectReferenceDigest;
  tenant_scope_fingerprint: SubjectReferenceDigest;
  principal_scope_fingerprint?: SubjectReferenceDigest;
  workflow_session_id: string;
};
