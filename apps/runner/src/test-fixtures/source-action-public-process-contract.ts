/** Declared synthetic operator facts, never a saved question or acceptance
 * record. The controlled responder must still read its actual native frame. */
import { ownedProgramInspection } from "./owned-authoring-program.js";

export const actionPublicProcessInspection = ownedProgramInspection;
export const ACTION_PUBLIC_PROCESS_FACTS = {
  model: "owned-public-action-offline",
  question: "Should the second parcel packing proposal require the parcel to be available?",
  outcomes: ["studio.pack_parcel_1", "studio.pack_parcel_2"],
  reviewClasses: ["studio.pack1_review", "studio.pack2_review"],
  raw: "  Require available=true; refuse unavailable parcels. 🧭\t ",
  job: "Prepare both independent studio.pack_parcel_1 and studio.pack_parcel_2 parcel packing proposals from the attached rules. Read parcel labels and units. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the requested unit count.",
  sourceLines: [
    "Two independent parcel packing proposal outcomes: studio.pack_parcel_1 and studio.pack_parcel_2.",
    "The first packing Action requires available=true; refuse unavailable parcels.",
    "Whether the second packing Action requires availability is undecided. Ask the current operator before compiling its eligibility rule.",
    "The assistant may read parcel labels and units only. studio.parcels is the parcel register; studio.parcels.label is the public parcel name; studio.parcels.units is the requested unit count.",
    "Every Action accepts integer caller units from 1 to 10 inclusive and changes only units together with Runner's maintained counter. Proposals expire after 300 seconds. Tenant scope and reviewer identity come from trusted backend context, never caller arguments; this synthetic baseline declares no row-level principal restriction. Propose only; never execute.",
    "Each Action has an independent human reviewer requirement: studio.pack_parcel_1 uses studio.pack1_review; studio.pack_parcel_2 uses studio.pack2_review. Both require one parcel_reviewer; no shared limits or automatic approval.",
    "Synthetic source-owner operating fact: every studio.parcels writer increments integer version on every update. This is an operator assertion, not independently observed enforcement.",
    "Availability stays private to Runner verification and is never returned to the assistant.",
    "Customer selection and status presentation remain client responsibilities, unverified.",
  ],
} as const;

export type ActionPublicProcessStop = "unanswered" | "raw-beforewrite" | "raw-lostack"
  | "source-beforewrite" | "source-lostack" | "spent" | "none";
