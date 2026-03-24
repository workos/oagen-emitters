export {
  collectModelRefs,
  collectEnumRefs,
  assignModelsToServices,
  collectFieldDependencies,
  collectRequestBodyModels,
} from '@workos/oagen';

/**
 * Compute a relative import path between two files within the generated SDK.
 * Strips .ts extension from the result.
 */
export function relativeImport(fromFile: string, toFile: string): string {
  const fromDir = fromFile.split('/').slice(0, -1);
  const toFileParts = toFile.split('/');
  const toDir = toFileParts.slice(0, -1);
  const toFileName = toFileParts[toFileParts.length - 1];

  let common = 0;
  while (common < fromDir.length && common < toDir.length && fromDir[common] === toDir[common]) {
    common++;
  }

  const ups = fromDir.length - common;
  const downs = toDir.slice(common);
  const parts = [...Array(ups).fill('..'), ...downs, toFileName];
  let result = parts.join('/');
  result = result.replace(/\.ts$/, '');
  if (!result.startsWith('.')) result = './' + result;
  return result;
}

/**
 * Render a JSDoc comment block from a description string.
 * Handles multiline descriptions by prefixing each line with ` * `.
 * Returns the lines with the given indent (default 0 spaces).
 */
export function docComment(description: string, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  const descLines = description.split('\n');
  if (descLines.length === 1) {
    return [`${pad}/** ${descLines[0]} */`];
  }
  const lines: string[] = [`${pad}/**`];
  for (const line of descLines) {
    lines.push(line === '' ? `${pad} *` : `${pad} * ${line}`);
  }
  lines.push(`${pad} */`);
  return lines;
}
