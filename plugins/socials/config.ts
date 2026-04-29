export function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Config value "${name}" must be a non-empty string.`);
  }
  return value;
}
