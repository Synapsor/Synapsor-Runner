/** Existing scalar math grammar, shared by normalization and authoring. */
export const ACTION_RULE_MATH_OPERATIONS = ["add", "subtract", "min", "max"] as const;
export const ACTION_RULE_MATH_MIN_INPUTS = 2;
export const ACTION_RULE_MATH_MAX_INPUTS = 16;
export const ACTION_RULE_MATH_GUIDANCE =
  'Numeric arithmetic uses {"kind":"math","operation":"add","inputs":[<first scalar expression>,<second scalar expression>]}; operation may be add, subtract, min or max, with 2–16 ordered inputs. Use this scalar expression in effect set/atomic_updates set or in rule derive, referenced by {"kind":"derived","name":"<declared name>"}. Preserve the intended operands and their order (especially subtraction), catalog types/units, collection filters and bounds. Do not invent units or replace a computed result with a caller-supplied total. Operation names are not node kinds; add/arithmetic aliases are not supported. Resubmit the complete affected component and validate the complete draft; syntax guidance establishes neither policy correctness nor execution readiness.';
