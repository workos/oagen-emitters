import type { Model, Field, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { typeName, fileName, propertyName, escapeReserved, moduleName } from './naming.js';
import { fieldSwiftType } from './type-map.js';

/**
 * Generate one Swift `Codable` struct file per IR model.
 *
 * Each struct gets: a doc comment, `public let` properties (camelCase), a
 * `public init` (required params first, optionals defaulted to `nil`), and a
 * `CodingKeys` enum mapping Swift properties to wire keys.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  const module = moduleName(ctx);
  return models.map((model) => ({
    path: `Sources/${module}/Models/${fileName(model.name)}.swift`,
    content: renderModel(model),
  }));
}

/** Render a doc comment block from a description (each line prefixed `/// `). */
function docComment(description: string | undefined, indent: string): string {
  if (!description) return '';
  return description
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `${indent}/// ${line.trim()}` : `${indent}///`))
    .join('\n');
}

interface RenderedField {
  prop: string;
  type: string;
  optional: boolean;
  field: Field;
}

function renderedField(field: Field): RenderedField {
  const prop = propertyName(field.domainName ?? field.name);
  const type = fieldSwiftType(field.type, field.required);
  return { prop, type, optional: type.endsWith('?'), field };
}

function renderModel(model: Model): string {
  const name = typeName(model.name);
  const lines: string[] = [];
  lines.push('import Foundation');
  lines.push('');

  const doc = docComment(model.description, '');
  if (doc) lines.push(doc);

  // Deduplicate by Swift property name: flattening discriminated-union variants
  // can repeat a field (same property from multiple variants), which would emit
  // duplicate stored-property declarations and CodingKeys cases.
  const seenProps = new Set<string>();
  const fields = model.fields.map(renderedField).filter((f) => {
    if (seenProps.has(f.prop)) return false;
    seenProps.add(f.prop);
    return true;
  });

  if (fields.length === 0) {
    lines.push(`public struct ${name}: Codable, Sendable, Equatable {`);
    lines.push('    public init() {}');
    lines.push('}');
    return lines.join('\n');
  }

  lines.push(`public struct ${name}: Codable, Sendable, Equatable {`);

  // Properties (in spec order for deterministic, readable output).
  for (const f of fields) {
    const fdoc = docComment(f.field.description, '    ');
    if (fdoc) lines.push(fdoc);
    if (f.field.deprecated) {
      lines.push('    @available(*, deprecated)');
    }
    lines.push(`    public let ${f.prop}: ${f.type}`);
  }
  lines.push('');

  // Public memberwise initializer: required first, then optionals (= nil).
  const initParams = [...fields].sort((a, b) => Number(a.optional) - Number(b.optional));
  lines.push('    public init(');
  const paramLines = initParams.map((f) => `        ${f.prop}: ${f.type}${f.optional ? ' = nil' : ''}`);
  lines.push(paramLines.join(',\n'));
  lines.push('    ) {');
  for (const f of fields) {
    lines.push(`        self.${f.prop} = ${f.prop}`);
  }
  lines.push('    }');

  // CodingKeys mapping Swift property -> wire key.
  lines.push('');
  lines.push('    private enum CodingKeys: String, CodingKey {');
  for (const f of fields) {
    const wire = f.field.name;
    const plain = toCamelCase(f.field.domainName ?? f.field.name);
    const caseId = escapeReserved(plain);
    if (plain === wire) {
      lines.push(`        case ${caseId}`);
    } else {
      lines.push(`        case ${caseId} = "${wire}"`);
    }
  }
  lines.push('    }');

  lines.push('}');
  return lines.join('\n');
}
