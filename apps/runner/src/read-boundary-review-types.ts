export type ReadChangeCounts = { fields: number; permissions: number; rawRemoved: number; analysisRemoved: number;
  rawAdded: number; analysisAdded: number; selectionAdded: number; selectionRemoved: number;
  exclusions: number; representation: number; other: number };
export type ReviewSection = { id: string; title: string; lines: string[]; children?: ReviewSection[]; changeCounts?: ReadChangeCounts };
