// SPDX-License-Identifier: MPL-2.0
import { ADVANCED_TOOLS } from "./advanced-catalog.mjs";
export function matches(schema, value) {
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (schema.required || []).every((k) => Object.hasOwn(value, k)) &&
        Object.keys(value).every(
          (k) =>
            Object.hasOwn(schema.properties, k) &&
            matches(schema.properties[k], value[k]),
        )
      );
    case "string":
      return (
        typeof value === "string" &&
        value.length >= (schema.minLength || 0) &&
        value.length <= (schema.maxLength ?? Infinity)
      );
    case "integer":
      if (!Number.isInteger(value)) return false; // falls through
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= (schema.minimum ?? -Infinity) &&
        value <= (schema.maximum ?? Infinity)
      );
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        value.length >= (schema.minItems || 0) &&
        value.length <= (schema.maxItems ?? Infinity) &&
        value.every((v) => matches(schema.items, v))
      );
    default:
      return false;
  }
}
export function validateAdvanced(tool, args) {
  const spec = ADVANCED_TOOLS.find((x) => x.name === tool);
  return spec ? matches(spec.inputSchema, args) : undefined;
}
