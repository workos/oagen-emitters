import type { Model, Field, EmitterContext, GeneratedFile } from '@workos/oagen';
import { toCamelCase } from '@workos/oagen';
import { isModelInScope } from '../shared/resolved-ops.js';
import { typeName, fileName, propertyName, mainSourcePath, subPackage, ktStringLiteral } from './naming.js';
import { fieldKotlinType, implicitImportsFor } from './type-map.js';
import { resolveTypeImports, renderImportBlock } from './imports.js';
import { renderDocComment } from './doc-comments.js';

/**
 * Generate one `@Serializable data class` file per IR model.
 *
 * Each class gets: a KDoc block, primary-constructor `val` properties (camelCase,
 * required first then nullable-with-`= null`), and an explicit `@SerialName` per
 * property mapping it to its wire key.
 */
export function generateModels(models: Model[], ctx: EmitterContext): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (const model of models) {
    // Scoped (`--services`) runs leave out-of-scope model files untouched on disk.
    if (!isModelInScope(model.name, ctx)) continue;
    files.push({
      path: mainSourcePath(ctx, 'models', fileName(model.name)),
      content: renderModel(model, ctx),
    });
  }
  return files;
}

interface RenderedField {
  prop: string;
  type: string;
  optional: boolean;
  field: Field;
}

function renderedField(field: Field): RenderedField {
  const prop = propertyName(field.domainName ?? field.name);
  const type = fieldKotlinType(field.type, field.required);
  return { prop, type, optional: type.endsWith('?'), field };
}

function renderModel(model: Model, ctx: EmitterContext): string {
  const name = typeName(model.name);
  const pkg = subPackage(ctx, 'models');

  // Deduplicate by Kotlin property name: flattening discriminated-union variants
  // can repeat a field (same property from multiple variants), which would
  // declare the same constructor parameter twice.
  const seenProps = new Set<string>();
  const fields = model.fields.map(renderedField).filter((f) => {
    if (seenProps.has(f.prop)) return false;
    seenProps.add(f.prop);
    return true;
  });

  const imports = new Set<string>(['kotlinx.serialization.Serializable']);
  if (fields.length > 0) imports.add('kotlinx.serialization.SerialName');
  for (const f of fields) {
    for (const imp of implicitImportsFor(f.type)) imports.add(imp);
  }
  for (const imp of resolveTypeImports(
    ctx,
    fields.map((f) => f.type),
  )) {
    imports.add(imp);
  }

  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  lines.push('');
  const importLines = renderImportBlock(imports, pkg);
  if (importLines.length > 0) {
    lines.push(...importLines);
    lines.push('');
  }

  lines.push(...renderDocComment(model.description, ''));

  // A Kotlin `data class` requires at least one constructor parameter, so a
  // field-less model degrades to a plain class.
  if (fields.length === 0) {
    lines.push('@Serializable');
    lines.push(`public class ${name}`);
    return lines.join('\n');
  }

  // Required properties first, then nullable ones (which get `= null`), so
  // callers can omit optionals and rely on named arguments.
  const ordered = [...fields].sort((a, b) => Number(a.optional) - Number(b.optional));

  lines.push('@Serializable');
  lines.push(`public data class ${name}(`);
  for (const f of ordered) {
    lines.push(...renderDocComment(f.field.description, '    '));
    if (f.field.deprecated) lines.push('    @Deprecated("This field is deprecated.")');
    lines.push(`    @SerialName(${ktStringLiteral(f.field.name)})`);
    const suffix = f.optional ? ' = null' : '';
    lines.push(`    public val ${f.prop}: ${f.type}${suffix},`);
  }
  lines.push(')');
  return lines.join('\n');
}

/** The Kotlin property name a model field is exposed under (used by tests.ts). */
export function modelFieldPropertyName(field: Field): string {
  return propertyName(field.domainName ?? field.name);
}

/** The plain (unescaped) camelCase form of a field's property name. */
export function modelFieldPlainName(field: Field): string {
  return toCamelCase(field.domainName ?? field.name);
}
