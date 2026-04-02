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
    ->setRules([])
    ->setFinder(
        (new Finder())
            ->in(__DIR__)
            ->exclude(['vendor'])
    )
;
`,
      headerPlacement: 'skip',
      integrateTarget: true,
      skipIfExists: true,
    },
  ];
}
