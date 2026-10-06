/** Declared synthetic metadata and operator facts. No private verdict data is
 * supplied to the scripted model; it reads its actual transmitted catalog and
 * confirmed-answer references. Stage preparation is not model planning proof. */
export const READ_PROCESS_FACTS = {
  job: "Read the parcel register's public name and the selected unit measure for this task.",
  policy: "studio.parcels is the parcel register. studio.parcels.label is the public parcel name. The task may read label and units only. The operational meaning of units is not established here; ask the operator before mapping it. Never expose internal notes or keys.",
  question: "What does the unit measure mean for this parcel view?",
  raw: "  The requested count of parcels for this task. 🧭  ",
} as const;
