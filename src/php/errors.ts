import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate PHP exception class hierarchy.
 */
export function generateErrors(ctx?: EmitterContext): GeneratedFile[] {
  const ns = ctx?.namespacePascal ?? 'WorkOS';
  const files: GeneratedFile[] = [];

  // Base ApiException — accepts both new-style (string message) and legacy (Response object) constructors
  files.push({
    path: 'lib/Exception/ApiException.php',
    content: `
namespace ${ns}\\Exception;

class ApiException extends \\Exception implements WorkOSException
{
    public $requestId = "";
    public $responseError;
    public $responseErrorDescription;
    public $responseErrors;
    public $responseCode;
    public $responseMessage;
    public $response;
    public readonly ?int $statusCode;
    public readonly ?string $apiErrorCode;
    public readonly ?string $error;
    public readonly ?string $errorDescription;
    public readonly ?array $errors;
    public readonly ?string $rawBody;

    /**
     * Accepts both new-style (string $message, ...) and legacy (Response $response) constructors.
     */
    public function __construct(
        string|\\${ns}\\Resource\\Response $messageOrResponse = '',
        ?int $statusCode = null,
        ?string $requestId = null,
        ?string $apiErrorCode = null,
        ?string $error = null,
        ?string $errorDescription = null,
        ?array $errors = null,
        ?string $rawBody = null,
        ?\\Throwable $previous = null,
    ) {
        // Legacy constructor: accepts a Response object (used by Client.php / BaseRequestException)
        if ($messageOrResponse instanceof \\${ns}\\Resource\\Response) {
            $this->response = $messageOrResponse;
            $responseJson = $messageOrResponse->json();

            $this->requestId = $messageOrResponse->headers['x-request-id'] ?? '';
            $this->responseError = $responseJson['error'] ?? null;
            $this->responseErrorDescription = $responseJson['error_description'] ?? null;
            $this->responseErrors = $responseJson['errors'] ?? null;
            $this->responseCode = $responseJson['code'] ?? null;
            $this->responseMessage = $responseJson['message'] ?? null;

            $this->statusCode = $messageOrResponse->statusCode;
            $this->apiErrorCode = $responseJson['code'] ?? null;
            $this->error = $responseJson['error'] ?? null;
            $this->errorDescription = $responseJson['error_description'] ?? null;
            $this->errors = $responseJson['errors'] ?? null;
            $this->rawBody = $messageOrResponse->body ?? null;

            parent::__construct($messageOrResponse->body ?? '', $messageOrResponse->statusCode ?? 0);
            return;
        }

        // New-style constructor
        parent::__construct($messageOrResponse, $statusCode ?? 0, $previous);
        $this->statusCode = $statusCode;
        $this->requestId = $requestId ?? '';
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
            messageOrResponse: $message,
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
class ${ex.name} extends BaseRequestException
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
