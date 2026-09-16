function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

type JsonSchemaValue = boolean | Record<string, unknown>

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
])

const LEGACY_KINDS = new Set([
  "any",
  "array",
  "boolean",
  "enum",
  "integer",
  "intersect",
  "intersection",
  "literal",
  "never",
  "null",
  "nullable",
  "number",
  "object",
  "optional",
  "string",
  "undefined",
  "union",
  "unknown",
])

const LEGACY_FIELDS = new Set([
  "element",
  "kind",
  "inner",
  "optional",
  "value",
  "values",
  "variants",
  "wrapped",
])

const SCHEMA_MAP_FIELDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
])

const SCHEMA_ARRAY_FIELDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

const SCHEMA_VALUE_FIELDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
])

const SCHEMA_KEYWORDS = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$ref",
  "$schema",
  "$vocabulary",
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "default",
  "definitions",
  "dependentRequired",
  "dependentSchemas",
  "description",
  "else",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "readOnly",
  "required",
  "title",
  "type",
  "unevaluatedItems",
  "unevaluatedProperties",
  "uniqueItems",
  "writeOnly",
])

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value.filter((item): item is string => typeof item === "string")
  return values.length === value.length ? values : undefined
}

function validSchemaType(value: unknown): boolean {
  if (typeof value === "string") return JSON_SCHEMA_TYPES.has(value)
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item) => typeof item === "string" && JSON_SCHEMA_TYPES.has(item))
}

function legacyKind(schema: Record<string, unknown>): string | undefined {
  const explicitKind = stringValue(schema.kind)?.toLowerCase()
  if (explicitKind && LEGACY_KINDS.has(explicitKind)) return explicitKind

  const type = stringValue(schema.type)
  const normalized = type?.toLowerCase()
  if (!normalized || !LEGACY_KINDS.has(normalized)) return undefined
  if (!validSchemaType(type) || Object.keys(schema).some((key) => LEGACY_FIELDS.has(key))) {
    return normalized
  }
  return undefined
}

function looksLikeJsonSchema(schema: Record<string, unknown>): boolean {
  if (Object.keys(schema).length === 0) return true
  if (schema.type !== undefined && !validSchemaType(schema.type)) return false
  return Object.keys(schema).some((key) => SCHEMA_KEYWORDS.has(key))
}

function isOptionalSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false
  if (booleanValue(schema.optional) === true) return true

  const kind = legacyKind(schema)
  if (kind === "optional") return true
  if (kind !== "union") return false

  const variants = Array.isArray(schema.variants)
    ? schema.variants
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : []
  return variants.some((variant) => legacyKind(isRecord(variant) ? variant : {}) === "undefined")
}

function schemaValue(value: unknown, seen: WeakSet<object>): JsonSchemaValue {
  if (typeof value === "boolean") return value
  if (!isRecord(value)) return {}
  return convertSchema(value, seen)
}

function setSchemaProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

function schemaMap(value: unknown, seen: WeakSet<object>): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    setSchemaProperty(out, key, schemaValue(item, seen))
  }
  return out
}

function schemaArray(value: unknown, seen: WeakSet<object>): unknown[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => schemaValue(item, seen))
}

function isSchemaValue(value: unknown): value is JsonSchemaValue {
  return typeof value === "boolean" || isRecord(value)
}

function copySchemaObject(
  source: Record<string, unknown>,
  seen: WeakSet<object>,
  legacy: boolean,
  forcedType?: string,
): JsonSchemaValue {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(source)) {
    if (legacy && LEGACY_FIELDS.has(key)) continue
    if (key === "nullable" || (forcedType !== undefined && key === "type")) continue

    if (key === "required") {
      const required = stringArray(value)
      if (required) out.required = required
    } else if (SCHEMA_MAP_FIELDS.has(key)) {
      out[key] = schemaMap(value, seen)
    } else if (SCHEMA_ARRAY_FIELDS.has(key)) {
      out[key] = schemaArray(value, seen)
    } else if (SCHEMA_VALUE_FIELDS.has(key)) {
      out[key] =
        Array.isArray(value) && key === "items"
          ? schemaArray(value, seen)
          : schemaValue(value, seen)
    } else {
      out[key] = value
    }
  }

  if (forcedType !== undefined) out.type = forcedType
  if (booleanValue(source.nullable) === true) return makeNullable(out)
  return out
}

function makeNullable(schema: Record<string, unknown>): Record<string, unknown> {
  const type = schema.type
  if (typeof type === "string") {
    if (type === "null") return schema
    return { ...schema, type: [type, "null"] }
  }
  if (Array.isArray(type) && !type.includes("null")) {
    return { ...schema, type: [...type, "null"] }
  }
  if (Array.isArray(schema.anyOf)) {
    return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] }
  }
  return { anyOf: [schema, { type: "null" }] }
}

function legacyVariants(schema: Record<string, unknown>): unknown[] {
  if (Array.isArray(schema.variants)) return schema.variants
  if (Array.isArray(schema.anyOf)) return schema.anyOf
  return []
}

function convertLegacySchema(
  source: Record<string, unknown>,
  kind: string,
  seen: WeakSet<object>,
): JsonSchemaValue {
  if (kind === "optional") return schemaValue(source.wrapped ?? source.inner, seen)
  if (kind === "nullable") {
    const wrapped = schemaValue(source.wrapped ?? source.inner, seen)
    return typeof wrapped === "boolean" ? wrapped : makeNullable(wrapped)
  }
  if (kind === "undefined" || kind === "never" || kind === "any" || kind === "unknown") return {}

  if (kind === "union" || kind === "intersect" || kind === "intersection") {
    const variants = legacyVariants(source)
      .map((variant) => schemaValue(variant, seen))
      .filter(
        (variant) =>
          isSchemaValue(variant) &&
          (typeof variant === "boolean" || Object.keys(variant).length > 0),
      )
    if (variants.length === 0) return copySchemaObject(source, seen, true)
    if (variants.length === 1) return variants[0] ?? {}

    const out = copySchemaObject(source, seen, true)
    if (typeof out !== "boolean") out[kind === "union" ? "anyOf" : "allOf"] = variants
    return out
  }

  if (kind === "object") {
    const converted = copySchemaObject(source, seen, true, "object")
    if (typeof converted === "boolean") return converted
    const out = converted
    const sourceProperties = isRecord(source.properties) ? source.properties : undefined
    if (!sourceProperties) return out

    const properties: Record<string, unknown> = {}
    const optional = stringArray(source.optional) ?? []
    for (const [key, value] of Object.entries(sourceProperties)) {
      setSchemaProperty(properties, key, schemaValue(value, seen))
    }
    out.properties = properties

    const explicitRequired = stringArray(source.required)
    const required =
      explicitRequired ??
      Object.entries(sourceProperties)
        .filter(([key, value]) => !optional.includes(key) && !isOptionalSchema(value))
        .map(([key]) => key)
    if (required.length > 0) out.required = required
    else delete out.required
    return out
  }

  if (kind === "array") {
    const converted = copySchemaObject(source, seen, true, "array")
    if (typeof converted === "boolean") return converted
    const out = converted
    if (!("items" in source) && "element" in source) out.items = schemaValue(source.element, seen)
    return out
  }

  if (kind === "enum") {
    const converted = copySchemaObject(source, seen, true)
    if (typeof converted === "boolean") return converted
    const out = converted
    if (!("enum" in out) && Array.isArray(source.values)) out.enum = source.values
    return out
  }

  if (kind === "literal") {
    const converted = copySchemaObject(source, seen, true)
    if (typeof converted === "boolean") return converted
    const out = converted
    if (!("const" in out) && "value" in source) out.const = source.value
    return out
  }

  const scalarType =
    kind === "string" ||
    kind === "number" ||
    kind === "boolean" ||
    kind === "integer" ||
    kind === "null"
      ? kind
      : undefined
  return scalarType ? copySchemaObject(source, seen, true, scalarType) : {}
}

function convertSchema(source: Record<string, unknown>, seen: WeakSet<object>): JsonSchemaValue {
  if (seen.has(source)) return {}
  seen.add(source)
  try {
    const kind = legacyKind(source)
    if (kind) return convertLegacySchema(source, kind, seen)
    if (!looksLikeJsonSchema(source)) return {}
    return copySchemaObject(source, seen, false)
  } finally {
    seen.delete(source)
  }
}

export function toJsonSchema(schema: unknown): unknown {
  if (typeof schema === "boolean") return schema
  if (!isRecord(schema)) return {}
  return convertSchema(schema, new WeakSet<object>())
}

/**
 * Normalize nullable type arrays for Gemini's generate transport (#99).
 * The gateway can turn these into any_of with sibling fields, which Vertex
 * rejects. Use a single type plus nullable, omit null defaults, and leave
 * genuine multi-type unions and required fields unchanged.
 */
export function geminiSafeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSafeJsonSchema)
  if (!isRecord(schema)) return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === "default" && value === null) continue
    // Literal values (const, enum, defaults, examples) are data, not schemas.
    const converted =
      SCHEMA_MAP_FIELDS.has(key) && isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, child]) => [name, geminiSafeJsonSchema(child)]),
          )
        : SCHEMA_ARRAY_FIELDS.has(key) || SCHEMA_VALUE_FIELDS.has(key)
          ? geminiSafeJsonSchema(value)
          : value
    setSchemaProperty(out, key, converted)
  }
  const type = out.type
  if (Array.isArray(type)) {
    const entries = type.filter((entry): entry is string => typeof entry === "string")
    const nonNull = entries.filter((entry) => entry !== "null")
    if (entries.length === type.length && entries.includes("null") && nonNull.length === 1) {
      out.type = nonNull[0]
      out.nullable = true
    }
  }
  return out
}
