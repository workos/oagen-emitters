import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate PHP configuration and utility files.
 */
export function generateConfig(ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;
  return [
    {
      path: 'lib/Resource/Webhook.php',
      content: `
namespace ${ns}\\Resource;

/**
 * Representation of a WorkOS webhook event.
 */
class Webhook
{
    /**
     * Parse a webhook payload JSON string into an object.
     *
     * @param string $payload JSON string
     * @return object
     */
    public static function constructFromPayload(string $payload): object
    {
        return (object) json_decode($payload, false);
    }

    /**
     * Compute an HMAC-SHA256 signature for webhook verification.
     *
     * @param int|string $timestamp Unix timestamp (ms)
     * @param string $payload JSON payload string
     * @param string $secret Webhook signing secret
     * @return string Hex-encoded signature
     */
    public function computeSignature(int|string $timestamp, string $payload, string $secret): string
    {
        $signedPayload = "{$timestamp}.{$payload}";
        return hash_hmac('sha256', $signedPayload, $secret);
    }
}`,
      overwriteExisting: true,
    },
    {
      path: 'lib/Resource/WebhookResponse.php',
      content: `
namespace ${ns}\\Resource;

/**
 * Response structure for WorkOS webhook action verdicts.
 */
class WebhookResponse
{
    public const USER_REGISTRATION_ACTION = 'user_registration_action_response';
    public const AUTHENTICATION_ACTION = 'authentication_action_response';
    public const VERDICT_ALLOW = 'Allow';
    public const VERDICT_DENY = 'Deny';

    private string $object;

    /** @var array<string, mixed> */
    private array $payload;

    private string $signature;

    /**
     * Create a new WebhookResponse instance.
     *
     * @param string $type Either USER_REGISTRATION_ACTION or AUTHENTICATION_ACTION
     * @param string $secret Webhook secret for signing
     * @param string $verdict Either VERDICT_ALLOW or VERDICT_DENY
     * @param string|null $errorMessage Required when verdict is VERDICT_DENY
     * @return self
     */
    public static function create(string $type, string $secret, string $verdict, ?string $errorMessage = null): self
    {
        if (!in_array($type, [self::USER_REGISTRATION_ACTION, self::AUTHENTICATION_ACTION], true)) {
            throw new \\InvalidArgumentException('Invalid response type');
        }

        if ($secret === '') {
            throw new \\InvalidArgumentException('Secret is required');
        }

        if (!in_array($verdict, [self::VERDICT_ALLOW, self::VERDICT_DENY], true)) {
            throw new \\InvalidArgumentException('Invalid verdict');
        }

        if ($verdict === self::VERDICT_DENY && ($errorMessage === null || $errorMessage === '')) {
            throw new \\InvalidArgumentException('Error message is required when verdict is Deny');
        }

        $instance = new self();
        $instance->object = $type;

        $payload = [
            'timestamp' => time() * 1000,
            'verdict' => $verdict,
        ];

        if ($verdict === self::VERDICT_DENY) {
            $payload['error_message'] = $errorMessage;
        }

        $instance->payload = $payload;

        $timestamp = $payload['timestamp'];
        $payloadString = json_encode($payload);
        $instance->signature = (new Webhook())->computeSignature($timestamp, (string) $payloadString, $secret);

        return $instance;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return [
            'object' => $this->object,
            'payload' => $this->payload,
            'signature' => $this->signature,
        ];
    }

    public function toJson(): string
    {
        return (string) json_encode($this->toArray());
    }
}`,
      overwriteExisting: true,
    },
  ];
}
