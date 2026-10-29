import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Runtime helpers the generated PHP code calls into, emitted beside the
 * models and services so a regenerated SDK never references a class it does
 * not ship.
 *
 * `Internal\DateTimeFormat::iso8601` is the one serialization path for every
 * outgoing `\DateTimeInterface` — a body field in `toArray()`, a request
 * input, a query parameter. It renders UTC ISO 8601 with millisecond
 * precision and a literal `Z` suffix, the only form the API accepts.
 * `\DateTimeInterface::RFC3339_EXTENDED`, used before, keeps the value's own
 * offset (`2025-01-01T00:00:00.000+00:00`), which the API rejects
 * (oagen-emitters#293).
 */
export function generateRuntime(ctx: EmitterContext): GeneratedFile[] {
  const ns = ctx.namespacePascal;
  return [
    {
      path: 'lib/Internal/DateTimeFormat.php',
      content: [
        `namespace ${ns}\\Internal;`,
        '',
        '/**',
        ' * Renders date-time values in the one form the API accepts: ISO 8601 in UTC',
        ' * with millisecond precision and a literal `Z` suffix.',
        ' *',
        " * `\\DateTimeInterface::RFC3339_EXTENDED` keeps the value's own offset",
        ' * (`+00:00`), which the API rejects.',
        ' */',
        'final class DateTimeFormat',
        '{',
        "    public const ISO_8601_UTC = 'Y-m-d\\TH:i:s.v\\Z';",
        '',
        '    /**',
        '     * Format `$value` as UTC ISO 8601 with a `Z` suffix, or pass `null`',
        '     * through so an omitted optional value stays omitted.',
        '     */',
        '    public static function iso8601(?\\DateTimeInterface $value): ?string',
        '    {',
        '        if ($value === null) {',
        '            return null;',
        '        }',
        '',
        '        return \\DateTimeImmutable::createFromInterface($value)',
        "            ->setTimezone(new \\DateTimeZone('UTC'))",
        '            ->format(self::ISO_8601_UTC);',
        '    }',
        '}',
      ].join('\n'),
      overwriteExisting: true,
    },
  ];
}

/**
 * The PHP expression that serializes `accessor` — a `\DateTimeInterface` or
 * `null` — for the wire through the shared runtime helper. Fully qualified,
 * as every other cross-namespace reference in the generated code is, so no
 * `use` block has to be maintained.
 */
export function dateTimeWireExpr(ns: string, accessor: string): string {
  return `\\${ns}\\Internal\\DateTimeFormat::iso8601(${accessor})`;
}
