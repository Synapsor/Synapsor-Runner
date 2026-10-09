/** Read an operator's words unchanged under the displayed-question currentness check.
 * Interpretation, mapping, confirmation and protected saves remain with their owners.
 * No natural-language routing and no lease is held across operator input.
 */
export async function readCurrentAuthoringRawAnswer(input: {
  assertCurrent: () => Promise<void>;
  read: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  await input.assertCurrent();
  const answer = await input.read();
  await input.assertCurrent();
  return answer;
}

/** A retained request is a recovery choice, never an English answer classifier.
 * Existing producer fences and budgets are checked by the caller before this
 * choice and again at dispatch. The choice does not clear or save any fence. */
export async function chooseRetainedReadRevision(input: {
  assertCurrent: () => Promise<void>;
  choose: () => Promise<string | undefined>;
}): Promise<"retry_retained" | "change" | "pause"> {
  await input.assertCurrent();
  const choice = await input.choose();
  await input.assertCurrent();
  return choice === "retry_retained" || choice === "change" ? choice : "pause";
}
