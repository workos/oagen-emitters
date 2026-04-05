import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate PHP exception class files.
 */
export function generateErrors(ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;
  const files: GeneratedFile[] = [];

  // Base ApiException
  files.push({
    path: 'lib/Exception/ApiException.php',
    content: generateApiException(ns),
    overwriteExisting: true,
  });

  // BaseRequestException (intermediate class for HTTP exceptions)
  files.push({
    path: 'lib/Exception/BaseRequestException.php',
    content: generateBaseRequestException(ns),
    overwriteExisting: true,
  });

  // HTTP exceptions
  const httpExceptions: { name: string; statusCode: number; extra?: string }[] = [
    { name: 'BadRequestException', statusCode: 400 },
    { name: 'AuthenticationException', statusCode: 401 },
    { name: 'AuthorizationException', statusCode: 403 },
    { name: 'NotFoundException', statusCode: 404 },
    { name: 'ConflictException', statusCode: 409 },
    { name: 'UnprocessableEntityException', statusCode: 422 },
    { name: 'RateLimitExceededException', statusCode: 429, extra: 'retryAfter' },
    { name: 'ServerException', statusCode: 500 },
  ];

  for (const ex of httpExceptions) {
    files.push({
      path: `lib/Exception/${ex.name}.php`,
      content: generateHttpException(ns, ex.name, ex.statusCode, ex.extra),
      overwriteExisting: true,
    });
  }

  // Non-HTTP exceptions
  files.push({
    path: 'lib/Exception/ConfigurationException.php',
    content: generateSimpleException(ns, 'ConfigurationException'),
    overwriteExisting: true,
  });
  files.push({
    path: 'lib/Exception/ConnectionException.php',
    content: generateSimpleException(ns, 'ConnectionException'),
    overwriteExisting: true,
  });
  files.push({
    path: 'lib/Exception/TimeoutException.php',
    content: generateSimpleException(ns, 'TimeoutException'),
    overwriteExisting: true,
  });

  return files;
}

function generateApiException(ns: string): string {
  const lines: string[] = [];
  // No <?php here — the file header from fileHeader() provides it
  lines.push(`namespace ${ns}\\Exception;`);
  lines.push('');
  lines.push('/** @phpstan-consistent-constructor */');
  lines.push('class ApiException extends \\Exception');
  lines.push('{');
  lines.push('    public function __construct(');
  lines.push("        string $message = '',");
  lines.push('        public readonly ?int $statusCode = null,');
  lines.push('        public readonly ?string $requestId = null,');
  lines.push('        ?\\Throwable $previous = null,');
  lines.push('    ) {');
  lines.push('        parent::__construct($message, $statusCode ?? 0, $previous);');
  lines.push('    }');
  lines.push('');
  lines.push(
    '    public static function fromResponse(int $statusCode, array $body, ?string $requestId = null): static',
  );
  lines.push('    {');
  lines.push("        $message = $body['message'] ?? 'Unknown error';");
  lines.push('        return new static($message, $statusCode, $requestId);');
  lines.push('    }');
  lines.push('}');
  return lines.join('\n');
}

function generateBaseRequestException(ns: string): string {
  const lines: string[] = [];
  // No <?php here — the file header from fileHeader() provides it
  lines.push(`namespace ${ns}\\Exception;`);
  lines.push('');
  lines.push('class BaseRequestException extends ApiException');
  lines.push('{');
  lines.push('}');
  return lines.join('\n');
}

function generateHttpException(ns: string, name: string, statusCode: number, extra?: string): string {
  const lines: string[] = [];
  // No <?php here — the file header from fileHeader() provides it
  lines.push(`namespace ${ns}\\Exception;`);
  lines.push('');
  lines.push(`class ${name} extends BaseRequestException`);
  lines.push('{');

  if (extra === 'retryAfter') {
    lines.push('    public ?int $retryAfter = null;');
    lines.push('');
    lines.push('    public function __construct(');
    lines.push("        string $message = '',");
    lines.push(`        ?int $statusCode = ${statusCode},`);
    lines.push('        ?string $requestId = null,');
    lines.push('        ?\\Throwable $previous = null,');
    lines.push('        ?int $retryAfter = null,');
    lines.push('    ) {');
    lines.push('        parent::__construct($message, $statusCode, $requestId, $previous);');
    lines.push('        $this->retryAfter = $retryAfter;');
    lines.push('    }');
  }

  lines.push('}');
  return lines.join('\n');
}

function generateSimpleException(ns: string, name: string): string {
  const lines: string[] = [];
  // No <?php here — the file header from fileHeader() provides it
  lines.push(`namespace ${ns}\\Exception;`);
  lines.push('');
  lines.push(`class ${name} extends \\Exception`);
  lines.push('{');
  lines.push('}');
  return lines.join('\n');
}
