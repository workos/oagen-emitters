#!/usr/bin/env node
/**
 * PHP SDK generation wrapper.
 */
import { execSync } from 'node:child_process';

// Build oagen command with all passed arguments
const extraArgs = process.argv.slice(2).join(' ');
const baseCmd = 'oagen generate --lang php --output ./sdk-php --namespace WorkOS --api-surface ./sdk-php-surface.json';
const fullCmd = extraArgs ? `${baseCmd} ${extraArgs}` : baseCmd;

// Run oagen generate
execSync(fullCmd, { stdio: 'inherit' });
