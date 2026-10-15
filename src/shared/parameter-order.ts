/** Keep existing positional slots; append new parameters within each required/defaulted group. */
export function preserveParameterOrder<T>(
  parameters: T[],
  baseline: readonly { name: string }[] | undefined,
  name: (parameter: T) => string,
  isOptional: (parameter: T) => boolean,
): T[] {
  if (!baseline?.length) return parameters;
  const positions = new Map(baseline.map((parameter, index) => [parameter.name, index]));
  return [...parameters].sort((left, right) => {
    const requiredOrder = Number(isOptional(left)) - Number(isOptional(right));
    if (requiredOrder) return requiredOrder;
    return (positions.get(name(left)) ?? baseline.length) - (positions.get(name(right)) ?? baseline.length);
  });
}
