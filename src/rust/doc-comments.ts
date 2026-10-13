/**
 * Render spec prose as `///` doc-comment lines.
 *
 * Blank lines are preserved as a bare `///` rather than dropped: rustdoc and
 * clippy parse the comment body as Markdown, so a paragraph break after a list
 * item must survive or the next paragraph becomes a lazy list continuation and
 * `clippy::doc_lazy_continuation` fails the build under `-D warnings`. Runs of
 * blank lines collapse to one, and leading/trailing blank lines are trimmed so
 * the block never starts or ends with an empty `///`.
 */
export function docCommentLines(text: string): string[] {
  const out: string[] = [];
  let pendingBlank = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) {
      pendingBlank = out.length > 0;
      continue;
    }
    if (pendingBlank) out.push('///');
    pendingBlank = false;
    out.push(`/// ${line}`);
  }
  return out;
}
