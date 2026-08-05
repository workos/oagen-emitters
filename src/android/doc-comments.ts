import { escapeBlockComment } from '@workos/oagen';

export interface DocParameter {
  name: string;
  description?: string;
  deprecated?: boolean;
}

/**
 * Render a KDoc block from a free-form description.
 *
 * Spec descriptions are attacker-influenceable free text and KDoc is a `/* … *\/`
 * block comment, so every description passes through `escapeBlockComment` — an
 * embedded comment terminator would otherwise close the comment and turn the
 * remainder of the text into live Kotlin source.
 */
export function renderDocComment(description: string | undefined, indent: string): string[] {
  const lines = docBodyLines(description);
  if (lines.length === 0) return [];
  if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
  return [`${indent}/**`, ...lines.map((line) => (line ? `${indent} * ${line}` : `${indent} *`)), `${indent} */`];
}

/**
 * Render a KDoc block for a method: a description plus `@param` / `@return` tags.
 * Returns an empty array when there is nothing to document.
 */
export function renderMethodDoc(
  description: string | undefined,
  params: DocParameter[],
  returns: string | undefined,
  indent: string,
): string[] {
  const body = docBodyLines(description);
  const tags: string[] = [];
  for (const param of params) {
    tags.push(`@param ${param.name} ${renderParameterDescription(param)}`);
  }
  if (returns) tags.push(`@return ${escapeBlockComment(returns)}`);
  if (body.length === 0 && tags.length === 0) return [];

  const out: string[] = [`${indent}/**`];
  for (const line of body) out.push(line ? `${indent} * ${line}` : `${indent} *`);
  if (body.length > 0 && tags.length > 0) out.push(`${indent} *`);
  for (const tag of tags) out.push(`${indent} * ${tag}`);
  out.push(`${indent} */`);
  return out;
}

/** Normalize and escape a description into KDoc body lines. */
function docBodyLines(description: string | undefined): string[] {
  if (!description) return [];
  const trimmed = description.trim();
  if (!trimmed) return [];
  return escapeBlockComment(trimmed)
    .split('\n')
    .map((line) => line.trim());
}

function renderParameterDescription(param: DocParameter): string {
  const firstLine =
    param.description
      ?.trim()
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  if (firstLine) {
    const escaped = escapeBlockComment(firstLine);
    if (/^deprecated\b/i.test(escaped)) return escaped;
    return param.deprecated ? `Deprecated. ${escaped}` : escaped;
  }

  const fallback = param.name
    .split('`')
    .join('')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return param.deprecated ? `Deprecated. The ${fallback} value.` : `The ${fallback} value.`;
}
