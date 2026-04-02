import type { EmitterContext, GeneratedFile } from '@workos/oagen';

/**
 * Generate PHP configuration files: .php-cs-fixer.dist.php for code formatting.
 */
export function generateConfig(_ctx?: EmitterContext): GeneratedFile[] {
  return [
    {
      path: '.php-cs-fixer.dist.php',
      content: `<?php

declare(strict_types=1);

use PhpCsFixer\\Config;
use PhpCsFixer\\Finder;

return (new Config())
    ->setRules([
        '@PSR12' => true,
        'ordered_imports' => ['sort_algorithm' => 'alpha'],
        'no_unused_imports' => true,
        'single_quote' => true,
        'trailing_comma_in_multiline' => true,
        'declare_strict_types' => true,
    ])
    ->setRiskyAllowed(true)
    ->setFinder(
        (new Finder())
            ->in(__DIR__)
            ->exclude(['vendor'])
    )
;
`,
      headerPlacement: 'skip',
      integrateTarget: true,
      overwriteExisting: true,
    },
  ];
}
