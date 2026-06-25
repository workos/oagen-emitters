import type { EmitterContext } from '@workos/oagen';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isScopedRun } from '../shared/resolved-ops.js';

/**
 * Scoped-run reconciliation for Go's FLAT aggregate files.
 *
 * Unlike Rust (one source file per model/enum), Go inlines every type into a
 * single `models.go` / `enums.go` and every webhook event into one
 * `pkg/events/events.go`. A scoped (`--services`) run regenerates these flat
 * files from the FULL new spec, which breaks scoping two ways:
 *
 *   1. ADDITION — a brand-new model/enum/event that belongs to an OUT-OF-SCOPE
 *      service gets inlined, so a scoped batch leaks unrelated changes
 *      (violates Option B: a scoped batch should contain ONLY the selected
 *      service's changes).
 *   2. REMOVAL / RENAME — a type the new spec renamed away (e.g.
 *      `OrganizationDomainStandAlone` → `OrganizationDomain`) is no longer
 *      produced, so its block vanishes from `models.go`; but an out-of-scope
 *      resource file (NOT regenerated this run) still references the old name →
 *      `undefined: OrganizationDomainStandAlone` and the package won't compile.
 *
 * The fix mirrors the Rust principle: in a scoped run, only the selected
 * services' types should reflect the new spec; everything else must be
 * preserved exactly as it is on disk. Because Go's manifest records the flat
 * FILE path (`models.go`) and not per-type paths, we recover the per-type
 * "present before" signal by reading the prior file from `ctx.outputDir`
 * (the emitter already reads `go.mod` from there in tests.ts). A type/const
 * block is then reconciled as:
 *
 *   - KEEP a freshly generated block iff it is IN-SCOPE or its name was present
 *     in the prior file  → drops brand-new out-of-scope additions (fix #1).
 *   - CARRY OVER verbatim any prior block whose name(s) the new spec no longer
 *     produces                          → retains renamed/removed types (fix #2).
 *
 * A full (non-scoped) run skips all of this and emits the new spec verbatim.
 */

/** A single named top-level declaration block in a flat Go file. */
export interface NamedBlock {
  /** Every type/const name this block declares (a batched `type (...)` alias block declares several). */
  names: string[];
  /** Verbatim text of the block (no trailing blank line). */
  text: string;
  /**
   * Whether the block's owning model/enum is in scope this run. Set by the
   * generator for freshly produced blocks; omitted (treated as false) for
   * blocks parsed from the prior on-disk file.
   */
  inScope?: boolean;
}

/** Read the prior on-disk content of a generated file, or null when unavailable. */
export function readPriorFile(relPath: string, ctx: EmitterContext): string | null {
  if (!ctx.outputDir) return null;
  const abs = resolve(ctx.outputDir, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parse a flat Go file into the set of top-level type names it declares, mapped
 * to the verbatim text of each declaration block (including its leading doc
 * comment). Used to recover the per-type "present before" signal a scoped run
 * needs. Recognizes the exact shapes the Go emitter produces:
 *   - `type Name struct { ... }`        (brace-balanced)
 *   - `type Name = Other`               (single-line alias)
 *   - `type Name string` + `const ( ... )`  (string enum)
 *   - `type ( A = X\n B = X )`          (batched alias block — declares many)
 * The leading `package` clause and any standalone trailing `const (...)` block
 * (e.g. the events file) are returned separately by {@link parseFlatGoBlocks}.
 */
export function parseFlatGoBlocks(content: string): {
  blocks: NamedBlock[];
  byName: Map<string, NamedBlock>;
} {
  const lines = content.split('\n');
  const blocks: NamedBlock[] = [];
  let i = 0;

  // Skip the generated header / package clause / leading blanks; those are
  // re-emitted by the generator, not carried over.
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith('package ') || t === '' || t.startsWith('// Code generated')) {
      i++;
      continue;
    }
    break;
  }

  while (i < lines.length) {
    // Collect a leading run of `//` doc-comment lines.
    const start = i;
    while (i < lines.length && lines[i].trim().startsWith('//')) i++;

    if (i >= lines.length) break;
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === 'type (') {
      // Batched alias block: `type (` ... `)`. Each inner line is `Name = Other`.
      const names: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== ')') {
        const m = lines[i].trim().match(/^(\w+)\s*=/);
        if (m) names.push(m[1]);
        i++;
      }
      i++; // consume ')'
      blocks.push({ names, text: lines.slice(start, i).join('\n') });
    } else if (/^type\s+(\w+)\s+struct\s*\{/.test(trimmed)) {
      const name = trimmed.match(/^type\s+(\w+)/)![1];
      // Brace-balanced struct body.
      let depth = 0;
      let sawOpen = false;
      while (i < lines.length) {
        for (const ch of lines[i]) {
          if (ch === '{') {
            depth++;
            sawOpen = true;
          } else if (ch === '}') depth--;
        }
        i++;
        if (sawOpen && depth === 0) break;
      }
      blocks.push({ names: [name], text: lines.slice(start, i).join('\n') });
    } else if (/^type\s+(\w+)\s+\w+\s+string\b/.test(trimmed) || /^type\s+(\w+)\s+string\b/.test(trimmed)) {
      // String enum: `type Name string` possibly followed by a `const ( ... )`.
      const name = trimmed.match(/^type\s+(\w+)/)![1];
      i++;
      // Skip blank lines then an optional const block.
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && lines[j].trim() === 'const (') {
        i = j;
        while (i < lines.length && lines[i].trim() !== ')') i++;
        i++; // consume ')'
      }
      blocks.push({ names: [name], text: lines.slice(start, i).join('\n') });
    } else if (/^type\s+(\w+)\s*=/.test(trimmed)) {
      // Single-line alias: `type Name = Other`.
      const name = trimmed.match(/^type\s+(\w+)/)![1];
      i++;
      blocks.push({ names: [name], text: lines.slice(start, i).join('\n') });
    } else {
      // Unrecognized top-level construct (e.g. a standalone `const (...)`).
      // Skip the line so parsing stays robust; such constructs are never
      // carried over by name.
      i++;
    }
    // Skip trailing blank lines between blocks (re-added on reassembly).
    while (i < lines.length && lines[i].trim() === '') i++;
  }

  const byName = new Map<string, NamedBlock>();
  for (const b of blocks) for (const n of b.names) byName.set(n, b);
  return { blocks, byName };
}

/**
 * Reconcile freshly generated named blocks against the prior on-disk file for a
 * scoped run. Returns the ordered list of block texts to emit. See file-level
 * docs for the keep/carry-over rules. In a scoped run a block is emitted as:
 *   - IN-SCOPE                  → the freshly generated text (apply the new spec).
 *   - out-of-scope, existed before → the PRIOR on-disk text, FROZEN, so an
 *     unrelated change to that type in the same spec delta doesn't leak into a
 *     scoped batch (Option B). (Falls back to fresh text only when the new
 *     block's names span multiple prior blocks — a batched-alias regrouping —
 *     which can't be frozen 1:1.)
 *   - out-of-scope, brand-new   → dropped (the addition that broke the build).
 * Then any prior block the new spec no longer produces at all is carried over
 * verbatim (renamed/removed types still referenced by un-regenerated code).
 *
 * @param newBlocks    Per-type blocks the current spec produced (in emit order),
 *                     each tagged with `inScope`.
 * @param relPath      Flat file path (e.g. `models.go`) for reading the prior file.
 * @param ctx          Emitter context (provides `outputDir` + scope sets).
 * @param alsoEmitted  Names this file emits OUTSIDE `newBlocks` (e.g. the fixed
 *                     `PaginationParams` struct). They must be excluded from the
 *                     carry-over, or the prior copy would be re-appended and
 *                     redeclare the separately-emitted one.
 */
export function reconcileFlatBlocks(
  newBlocks: NamedBlock[],
  relPath: string,
  ctx: EmitterContext,
  alsoEmitted: Set<string> = new Set<string>(),
): string[] {
  // Full run: emit everything the new spec produced, unchanged.
  if (!isScopedRun(ctx)) return newBlocks.map((b) => b.text);

  const prior = readPriorFile(relPath, ctx);
  // No prior file to reconcile against (first generation / missing output dir):
  // fall back to scope-only gating so we never leak brand-new out-of-scope
  // types, but there's nothing on disk to retain.
  const priorParsed = prior ? parseFlatGoBlocks(prior) : { blocks: [], byName: new Map<string, NamedBlock>() };

  const out: string[] = [];
  const emittedNames = new Set<string>();

  for (const block of newBlocks) {
    if (block.inScope) {
      out.push(block.text);
      for (const n of block.names) emittedNames.add(n);
      continue;
    }
    // Out of scope: freeze to the prior on-disk text when this block maps 1:1
    // to a single prior block; that keeps an out-of-scope type byte-identical to
    // disk even if the new spec changed it. A brand-new out-of-scope block has
    // no prior block → it is dropped.
    const priorBlocks = block.names.map((n) => priorParsed.byName.get(n)).filter((b): b is NamedBlock => !!b);
    const uniquePrior = new Set(priorBlocks);
    if (uniquePrior.size === 1) {
      const pb = priorBlocks[0];
      if (!pb.names.some((n) => emittedNames.has(n))) {
        out.push(pb.text);
        for (const n of pb.names) emittedNames.add(n);
      }
    } else if (uniquePrior.size > 1) {
      // A regrouping spread this out-of-scope block's names across several prior
      // blocks. NEVER regenerate out-of-scope content (the fresh text could
      // re-point an alias at a renamed canonical the scoped run didn't emit);
      // instead freeze every distinct prior block verbatim. All names are
      // on-disk here (the generator only puts in-scope ∪ on-disk names in an
      // out-of-scope block), so this fully retains them.
      for (const pb of uniquePrior) {
        if (pb.names.some((n) => emittedNames.has(n))) continue;
        out.push(pb.text);
        for (const n of pb.names) emittedNames.add(n);
      }
    }
    // uniquePrior.size === 0 → brand-new out-of-scope → drop.
  }

  // Carry over prior blocks the new spec no longer produces at all (renamed /
  // removed types still referenced by out-of-scope, un-regenerated code),
  // excluding any name this file emits elsewhere (e.g. PaginationParams).
  for (const block of priorParsed.blocks) {
    if (block.names.some((n) => alsoEmitted.has(n))) continue;
    if (block.names.every((n) => !emittedNames.has(n))) {
      out.push(block.text);
      for (const n of block.names) emittedNames.add(n);
    }
  }

  return out;
}
