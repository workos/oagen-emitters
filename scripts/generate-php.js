#!/usr/bin/env node
/**
 * PHP SDK generation wrapper.
 * Runs oagen generate for PHP, then applies PHPUnit compatibility fixes.
 */
import { execSync } from 'node:child_process';

// Build oagen command with all passed arguments
const extraArgs = process.argv.slice(2).join(' ');
const baseCmd = 'oagen generate --lang php --output ./sdk-php --namespace WorkOS --api-surface ./sdk-php-surface.json';
const fullCmd = extraArgs ? `${baseCmd} ${extraArgs}` : baseCmd;

// Run oagen generate
execSync(fullCmd, { stdio: 'inherit' });

// Extract --target directory from args for the PHPUnit compat fix
const targetIdx = process.argv.indexOf('--target');
if (targetIdx !== -1 && process.argv[targetIdx + 1]) {
  const targetDir = process.argv[targetIdx + 1];
  execSync(`node scripts/fix-phpunit-compat.js ${targetDir}`, { stdio: 'inherit' });
}
