import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate PHP exception class hierarchy.
 */
export function generateErrors(ctx?: EmitterContext): GeneratedFile[] {
  const ns = ctx?.namespacePascal ?? 'WorkOS';
  const files: GeneratedFile[] = [];

  // Base ApiException
  files.push({
    path: 'lib/Exception/ApiException.php',
    content: `
namespace ${ns}\\Exception;

class ApiException extends \\Exception
{
    public readonly ?int $statusCode;
    public readonly ?string $requestId;
    public readonly ?string $apiErrorCode;
    public readonly ?string $error;
    public readonly ?string $errorDescription;
    public readonly ?array $errors;
    public readonly ?string $rawBody;

    public function __construct(
        string $message = '',
        ?int $statusCode = null,
        ?string $requestId = null,
        ?string $apiErrorCode = null,
        ?string $error = null,
        ?string $errorDescription = null,
        ?array $errors = null,
        ?string $rawBody = null,
        ?\\Throwable $previous = null,
    ) {
        parent::__construct($message, $statusCode ?? 0, $previous);
        $this->statusCode = $statusCode;
        $this->requestId = $requestId;
        $this->apiErrorCode = $apiErrorCode;
        $this->error = $error;
        $this->errorDescription = $errorDescription;
        $this->errors = $errors;
        $this->rawBody = $rawBody;
    }

    public static function fromResponse(int $statusCode, array $body, ?string $requestId = null): static
    {
        $message = $body['message'] ?? 'No message';
        return new static(
            message: $message,
            statusCode: $statusCode,
            requestId: $requestId,
            apiErrorCode: $body['code'] ?? null,
            error: $body['error'] ?? null,
            errorDescription: $body['error_description'] ?? null,
            errors: $body['errors'] ?? null,
            rawBody: json_encode($body) ?: null,
        );
    }
}`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  // Status-code-specific exceptions
  const exceptions: { name: string; doc: string; status: number }[] = [
    { name: 'BadRequestException', doc: '400 Bad Request', status: 400 },
    { name: 'AuthenticationException', doc: '401 Unauthorized', status: 401 },
    { name: 'AuthorizationException', doc: '403 Forbidden', status: 403 },
    { name: 'NotFoundException', doc: '404 Not Found', status: 404 },
    { name: 'ConflictException', doc: '409 Conflict', status: 409 },
    { name: 'UnprocessableEntityException', doc: '422 Unprocessable Entity', status: 422 },
    { name: 'RateLimitExceededException', doc: '429 Rate Limited', status: 429 },
    { name: 'ServerException', doc: '500+ Server Error', status: 500 },
  ];

  for (const ex of exceptions) {
    const retryAfterProp =
      ex.name === 'RateLimitExceededException'
        ? `
    public readonly ?float $retryAfter;

    public function __construct(
        string $message = '',
        ?int $statusCode = ${ex.status},
        ?string $requestId = null,
        ?string $apiErrorCode = null,
        ?string $error = null,
        ?string $errorDescription = null,
        ?array $errors = null,
        ?string $rawBody = null,
        ?float $retryAfter = null,
        ?\\Throwable $previous = null,
    ) {
        parent::__construct($message, $statusCode, $requestId, $apiErrorCode, $error, $errorDescription, $errors, $rawBody, $previous);
        $this->retryAfter = $retryAfter;
    }`
        : '';

    files.push({
      path: `lib/Exception/${ex.name}.php`,
      content: `
namespace ${ns}\\Exception;

/**
 * ${ex.doc}.
 */
class ${ex.name} extends ApiException
{${retryAfterProp}
}`,
      integrateTarget: true,
      overwriteExisting: true,
    });
  }

  // Non-HTTP exceptions
  files.push({
    path: 'lib/Exception/ConfigurationException.php',
    content: `
namespace ${ns}\\Exception;

/**
 * Missing or invalid configuration.
 */
class ConfigurationException extends \\RuntimeException
{
}`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  files.push({
    path: 'lib/Exception/ConnectionException.php',
    content: `
namespace ${ns}\\Exception;

/**
 * Raised when the SDK cannot connect to the API.
 */
class ConnectionException extends \\RuntimeException
{
}`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  files.push({
    path: 'lib/Exception/TimeoutException.php',
    content: `
namespace ${ns}\\Exception;

/**
 * Raised when the API request times out.
 */
class TimeoutException extends \\RuntimeException
{
}`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  // Baseline compat: WorkOSException interface
  files.push({
    path: 'lib/Exception/WorkOSException.php',
    content: `
namespace ${ns}\\Exception;

use Throwable;

interface WorkOSException extends Throwable
{
}`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  // Baseline compat: BaseRequestException
  files.push({
    path: 'lib/Exception/BaseRequestException.php',
    content: `
namespace ${ns}\\Exception;

class BaseRequestException extends ApiException implements WorkOSException
{
}`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  // Baseline compat: GenericException
  files.push({
    path: 'lib/Exception/GenericException.php',
    content: `
namespace ${ns}\\Exception;

class GenericException extends ApiException implements WorkOSException
{
}`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  // Baseline compat: UnexpectedValueException
  files.push({
    path: 'lib/Exception/UnexpectedValueException.php',
    content: `
namespace ${ns}\\Exception;

class UnexpectedValueException extends \\UnexpectedValueException implements WorkOSException
{
}`,
    integrateTarget: true,
    overwriteExisting: true,
  });

  return files;
}

/** Map from status code to exception class name. */
export const STATUS_CODE_EXCEPTIONS: Record<number, string> = {
  400: 'BadRequestException',
  401: 'AuthenticationException',
  403: 'AuthorizationException',
  404: 'NotFoundException',
  409: 'ConflictException',
  422: 'UnprocessableEntityException',
  429: 'RateLimitExceededException',
};
