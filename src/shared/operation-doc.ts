import type { Operation } from '@workos/oagen';

/**
 * The text an emitter documents an operation with: its `summary` as the lead
 * line, a blank line, then its `description`.
 *
 * The IR carries the two apart — `Operation.description` never includes the
 * summary — so an emitter that reads `description` alone drops the one-line
 * label every documented method opens with. Every emitter reads the method's
 * doc text, and the text a deprecation message is distilled from, through
 * here, so all of them show the same thing.
 *
 * - Both present and different: `<summary>\n\n<description>`.
 * - Only one present, or both the same text: that text, once.
 * - Neither present (absent, empty or whitespace-only): `undefined`, and the
 *   emitter falls back to whatever it writes for an undocumented operation.
 */
export function operationDoc(op: Pick<Operation, 'summary' | 'description'>): string | undefined {
  const summary = presentText(op.summary);
  const description = presentText(op.description);
  if (summary && description && summary !== description) {
    return `${summary}\n\n${description}`;
  }
  return description ?? summary;
}

function presentText(text: string | undefined): string | undefined {
  return typeof text === 'string' && text.trim() !== '' ? text : undefined;
}
