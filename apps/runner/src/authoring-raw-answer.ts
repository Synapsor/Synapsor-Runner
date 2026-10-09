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
