#!/usr/bin/env node
/**
 * Post-generation compatibility fixes for the PHP SDK target repo.
 *
 * 1. Converts @dataProvider docblock annotations to #[DataProvider] attributes (PHPUnit 13)
 * 2. Removes error_log() deprecation noise from old SDK files superseded by generated resources
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: fix-phpunit-compat.js <target-dir>');
  process.exit(1);
}

// ── Fix 1: PHPUnit @dataProvider → #[DataProvider] ──────────────────────────

const testsDir = resolve(targetDir, 'tests');

function fixDataProviders(filePath) {
  let content = readFileSync(filePath, 'utf8');
  const original = content;

  const hasImport = content.includes('use PHPUnit\\Framework\\Attributes\\DataProvider');

  content = content.replace(
    /(\n)([ \t]*)\/\*\*\s*\n\s*\*\s*@dataProvider\s+(\w+)\s*\n\s*\*\//g,
    (_match, newline, indent, provider) => `${newline}${indent}#[DataProvider('${provider}')]`,
  );

  if (content !== original && !hasImport) {
    content = content.replace(
      /(use PHPUnit\\Framework\\TestCase;)/,
      'use PHPUnit\\Framework\\Attributes\\DataProvider;\n$1',
    );
  }

  if (content !== original) {
    writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

// ── Fix 2: Remove error_log() deprecation calls from old SDK files ──────────

function removeDeprecationLogs(filePath) {
  if (!existsSync(filePath)) return false;

  let content = readFileSync(filePath, 'utf8');
  const original = content;

  // Remove blocks like:
  //     $msg = "... is deprecated...";
  //     error_log($msg);
  // or just standalone error_log() with deprecation strings
  content = content.replace(
    /\n\s*\$msg\s*=\s*"[^"]*(?:deprecated|is being deprecated)[^"]*";\s*\n\s*error_log\(\$msg\);\s*\n/gi,
    '\n',
  );

  // Also handle single-line: error_log("... deprecated ...");
  content = content.replace(/\n\s*error_log\("[^"]*(?:deprecated|is being deprecated)[^"]*"\);\s*\n/gi, '\n');

  if (content !== original) {
    writeFileSync(filePath, content, 'utf8');
    return true;
  }
  return false;
}

// ── Fix 3: Fix mock-without-expectations notices in TestHelper ───────────────
//
// Root cause: TestHelper.setUp() creates a mock via createMock() for every test,
// but only tests that call mockRequest() set expectations on it. PHPUnit 13 warns
// about mocks without expectations.
//
// Fix: use createStub() in setUp() (no expectations needed), then create a fresh
// mock inside prepareRequestMock() where expectations ARE set.

function fixTestHelperMock(targetDir) {
  const testHelper = resolve(targetDir, 'tests', 'TestHelper.php');
  if (!existsSync(testHelper)) return false;

  let content = readFileSync(testHelper, 'utf8');
  const original = content;

  // Change createMock to createStub in setUp — tests that don't mock requests get a harmless stub
  content = content.replace(
    '$this->createMock("\\WorkOS\\RequestClient\\RequestClientInterface")',
    '$this->createStub("\\WorkOS\\RequestClient\\RequestClientInterface")',
  );

  // In prepareRequestMock, upgrade to a real mock (with expects) and re-register with Client
  const oldPrepare =
    '    private function prepareRequestMock($method, $url, $headers, $params)\n' +
    '    {\n' +
    '        return $this->requestClientMock\n' +
    "            ->expects(static::atLeastOnce())->method('request')";

  const newPrepare =
    '    private function prepareRequestMock($method, $url, $headers, $params)\n' +
    '    {\n' +
    '        $this->requestClientMock = $this->createMock("\\WorkOS\\RequestClient\\RequestClientInterface");\n' +
    '        Client::setRequestClient($this->requestClientMock);\n' +
    '        return $this->requestClientMock\n' +
    "            ->expects(static::atLeastOnce())->method('request')";

  content = content.replace(oldPrepare, newPrepare);

  if (content !== original) {
    writeFileSync(testHelper, content, 'utf8');
    return true;
  }
  return false;
}

// ── Fix 4: Upgrade stub→mock in tests that directly use requestClientMock ───

function fixDirectMockUsage(targetDir) {
  let count = 0;

  walk(
    resolve(targetDir, 'tests'),
    (f) => f.endsWith('.php'),
    (filePath) => {
      if (filePath.endsWith('TestHelper.php')) return;

      let content = readFileSync(filePath, 'utf8');
      const original = content;

      // Pattern 1: Client::setRequestClient($this->requestClientMock) then expects()
      content = content.replace(
        /Client::setRequestClient\(\$this->requestClientMock\);\s*\n(\s*)\$this->requestClientMock\s*\n(\s*)->expects\(/g,
        '$this->requestClientMock = $this->createMock("\\WorkOS\\RequestClient\\RequestClientInterface");\n$1Client::setRequestClient($this->requestClientMock);\n$1$this->requestClientMock\n$2->expects(',
      );

      // Pattern 2: Any $varMock->expects() where $varMock was created with createStub
      // Upgrade that specific usage from stub to mock
      content = content.replace(/(\n)([ \t]*)(\$\w*[Mm]ock\w*)->expects\(/g, (match, newline, indent, varName) => {
        const escaped = varName.replace('$', '\\$');
        const stubPattern = new RegExp(escaped + '\\s*=\\s*\\$this->createStub\\(([^)]+)\\)');
        const stubMatch = content.match(stubPattern);
        if (stubMatch) {
          const className = stubMatch[1];
          return `${newline}${indent}${varName} = $this->createMock(${className});\n${indent}${varName}->expects(`;
        }
        return match;
      });

      if (content !== original) {
        writeFileSync(filePath, content, 'utf8');
        count++;
      }
    },
  );

  return count;
}

// ── Fix 5: Add AllowMockObjectsWithoutExpectations for mocks that need onlyMethods ──

function fixMockBuilderNotices(targetDir) {
  let count = 0;
  const attr = '#[\\PHPUnit\\Framework\\Attributes\\AllowMockObjectsWithoutExpectations]';

  walk(
    resolve(targetDir, 'tests'),
    (f) => f.endsWith('.php'),
    (filePath) => {
      let content = readFileSync(filePath, 'utf8');
      const original = content;

      // Split into methods by matching "public function test"
      const lines = content.split('\n');
      const methodRanges = []; // [{start, end, name}]

      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*public function (test\w+)\(/);
        if (m) {
          if (methodRanges.length > 0) {
            methodRanges[methodRanges.length - 1].end = i - 1;
          }
          methodRanges.push({ start: i, end: lines.length - 1, name: m[1] });
        }
      }

      const methodsToAnnotate = new Set();
      for (const range of methodRanges) {
        const body = lines.slice(range.start, range.end + 1).join('\n');
        if (body.includes('getMockBuilder') && !body.includes('->expects(')) {
          methodsToAnnotate.add(range.start);
        }
      }

      if (methodsToAnnotate.size > 0) {
        // Insert attributes before the method lines (work backwards to preserve indices)
        const sortedLines = [...methodsToAnnotate].sort((a, b) => b - a);
        for (const lineIdx of sortedLines) {
          // Don't add if already present
          if (lineIdx > 0 && lines[lineIdx - 1].includes('AllowMockObjectsWithoutExpectations')) continue;
          const indent = lines[lineIdx].match(/^(\s*)/)[1];
          lines.splice(lineIdx, 0, `${indent}${attr}`);
        }
        content = lines.join('\n');
      }

      if (content !== original) {
        writeFileSync(filePath, content, 'utf8');
        count++;
      }
    },
  );

  return count;
}

// ── Run fixes ───────────────────────────────────────────────────────────────

function walk(dir, filter, cb) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) walk(p, filter, cb);
    else if (filter(e)) cb(p);
  }
}

let dpFixed = 0;
walk(
  testsDir,
  (f) => f.endsWith('Test.php'),
  (f) => {
    if (fixDataProviders(f)) dpFixed++;
  },
);
if (dpFixed > 0) console.log(`Fixed PHPUnit @dataProvider annotations in ${dpFixed} file(s)`);

const libDir = resolve(targetDir, 'lib');
let logFixed = 0;
walk(
  libDir,
  (f) => f.endsWith('.php'),
  (f) => {
    if (removeDeprecationLogs(f)) logFixed++;
  },
);
if (logFixed > 0) console.log(`Removed deprecation error_log() calls from ${logFixed} file(s)`);

if (fixTestHelperMock(targetDir)) {
  console.log('Fixed TestHelper: createStub in setUp, createMock only when expectations are set');
}

const directMockFixed = fixDirectMockUsage(targetDir);
if (directMockFixed > 0) {
  console.log(`Fixed direct mock usage in ${directMockFixed} test file(s)`);
}

// Fix all test files: createMock → createStub for mocks that don't have expectations set on them.
// We identify "safe" createMock calls: those where the returned object is only used with
// willReturn/method (stub behavior), not expects() (mock behavior).
// Simple heuristic: replace createMock with createStub in setUp() methods and for mocks
// stored in properties that are later upgraded by prepareRequestMock/direct expects.
let stubFixCount = 0;
walk(
  resolve(targetDir, 'tests'),
  (f) => f.endsWith('.php'),
  (filePath) => {
    if (filePath.endsWith('TestHelper.php')) return;
    let content = readFileSync(filePath, 'utf8');
    const orig = content;

    // Fix SigningOnlySessionHandlerTest's own setUp createMock
    content = content.replace(
      /\$this->requestClientMock\s*=\s*\$this->createMock\(\\WorkOS\\RequestClient\\RequestClientInterface::class\)/g,
      '$this->requestClientMock = $this->createStub(\\WorkOS\\RequestClient\\RequestClientInterface::class)',
    );

    // Replace createMock → createStub for mocks that never have expects() called on them.
    // Catches both $fooMock and $mockFoo naming patterns.
    content = content.replace(
      /(\$\w*[Mm]ock\w*)\s*=\s*\$this->createMock\(([^)]+)\);/g,
      (match, varName, className) => {
        const escaped = varName.replace('$', '\\$');
        const expectsPattern = new RegExp(escaped + '\\s*->\\s*expects\\(');
        if (expectsPattern.test(content)) {
          return match; // Keep as createMock — it has expectations
        }
        return `${varName} = $this->createStub(${className});`;
      },
    );

    // Convert all getMockBuilder()->getMock() to createStub().
    // Tests that need expects() will be upgraded by the direct-mock-usage fix (Fix 4).
    content = content.replace(
      /(\$\w*[Mm]ock\w*)\s*=\s*\$this->getMockBuilder\(([^)]+)\)\s*\n\s*->getMock\(\);/g,
      '$1 = $this->createStub($2);',
    );

    if (content !== orig) {
      writeFileSync(filePath, content, 'utf8');
      stubFixCount++;
    }
  },
);
if (stubFixCount > 0) console.log(`Fixed createMock → createStub in ${stubFixCount} test file(s)`);

const mockBuilderFixed = fixMockBuilderNotices(targetDir);
if (mockBuilderFixed > 0)
  console.log(`Added #[AllowMockObjectsWithoutExpectations] in ${mockBuilderFixed} test file(s)`);
