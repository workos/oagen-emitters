export interface DocParameter {
  name: string;
  description?: string;
  deprecated?: boolean;
}

/** Render a Swift doc comment block from a free-form description. */
export function renderDocComment(description: string | undefined, indent: string): string {
  if (!description) return '';
  return description
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `${indent}/// ${line.trim()}` : `${indent}///`))
    .join('\n');
}

/** Render `- Parameter` doc lines for a Swift method signature. */
export function renderParameterDocs(params: DocParameter[], indent: string): string[] {
  return params.map((param) => `${indent}/// - Parameter ${param.name}: ${renderParameterDescription(param)}`);
}

function renderParameterDescription(param: DocParameter): string {
  const firstLine =
    param.description
      ?.trim()
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  if (firstLine) {
    if (/^deprecated\b/i.test(firstLine)) return firstLine;
    return param.deprecated ? `Deprecated. ${firstLine}` : firstLine;
  }

  const fallback = param.name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return param.deprecated ? `Deprecated. The ${fallback} value.` : `The ${fallback} value.`;
}
