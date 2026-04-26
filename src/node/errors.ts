import type { EmitterContext, GeneratedFile } from '@workos/oagen';
import { fileName } from './naming.js';
import { buildNodeStatusExceptions } from './sdk-errors.js';

/**
 * Static exception classes are hand-maintained in the target SDK.
 * Only typed exceptions derived from spec error models are generated here.
 */
export function generateErrors(ctx?: EmitterContext): GeneratedFile[] {
  if (!ctx?.spec) return [];

  const typedErrors = collectTypedErrors(ctx);
  if (typedErrors.length === 0) return [];

  const files: GeneratedFile[] = [];
  const exportLines: string[] = [];

  for (const { modelName, statusCode, baseException } of typedErrors) {
    const exceptionClassName = `${modelName}Exception`;
    const filePath = `src/common/exceptions/${fileName(modelName)}.exception.ts`;
    const baseImport = baseException
      ? `import { ${baseException} } from './${fileName(baseException.replace(/Exception$/, '')).replace(/^/, '')}.exception';\n\n`
      : '';
    const baseClass = baseException ?? 'Error';

    files.push({
      path: filePath,
      content: `${baseImport}export class ${exceptionClassName} extends ${baseClass} {
  readonly status = ${statusCode};
  readonly name = '${exceptionClassName}';
  readonly requestID: string;
  readonly data?: any;

  constructor({ message, requestID, data }: { message?: string; requestID: string; data?: any }) {
    ${baseException ? `super(${baseException === 'UnauthorizedException' ? 'requestID' : `{ message: message ?? '${modelName} error', requestID }`});` : 'super();'}
    this.message = message ?? '${modelName} error';
    this.requestID = requestID;
    if (data) this.data = data;
  }
}`,
      skipIfExists: true,
      integrateTarget: false,
    });

    exportLines.push(`export { ${exceptionClassName} } from './${fileName(modelName)}.exception';`);
  }

  if (exportLines.length > 0) {
    files.push({
      path: 'src/common/exceptions/typed-errors.ts',
      content: exportLines.join('\n'),
      skipIfExists: true,
      integrateTarget: false,
    });
  }

  return files;
}

function collectTypedErrors(
  ctx: EmitterContext,
): { modelName: string; statusCode: number; baseException: string | null }[] {
  const statusToBase = buildNodeStatusExceptions(ctx.spec.sdk);
  const seen = new Set<string>();
  const results: { modelName: string; statusCode: number; baseException: string | null }[] = [];

  for (const service of ctx.spec.services) {
    for (const op of service.operations) {
      for (const err of op.errors) {
        if (err.type?.kind === 'model' && !seen.has(err.type.name)) {
          seen.add(err.type.name);
          results.push({
            modelName: err.type.name,
            statusCode: err.statusCode,
            baseException: statusToBase[err.statusCode] ?? (err.statusCode >= 500 ? 'GenericServerException' : null),
          });
        }
      }
    }
  }

  return results;
}
