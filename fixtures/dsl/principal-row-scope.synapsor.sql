CREATE AGENT CONTEXT care_session
  BIND hospital_id FROM HTTP_CLAIM hospital_id REQUIRED
  BIND principal FROM HTTP_CLAIM sub REQUIRED
  TENANT BINDING hospital_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY care.inspect_assigned_patient
  DESCRIPTION 'Inspect one patient assigned to the authenticated case manager within the trusted hospital.'
  RETURNS HINT 'Returns reviewed patient fields and evidence only when both tenant and assignee locks match.'
  USING CONTEXT care_session
  SOURCE local_postgres
  ON public.patients
  PRIMARY KEY id
  TENANT KEY hospital_id
  PRINCIPAL SCOPE KEY assigned_to
  LOOKUP patient_id BY id
  ARG patient_id STRING REQUIRED MAX LENGTH 128 DESCRIPTION 'Reviewed patient identifier.'
  ALLOW READ id, hospital_id, display_name, care_status, updated_at
  KEEP OUT assigned_to, diagnosis_notes, insurance_member_id
  REQUIRE EVIDENCE
  MAX ROWS 1
END
