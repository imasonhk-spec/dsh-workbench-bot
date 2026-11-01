import { fail } from '../roles.js'

// Model-callable manifests use this bounded JSON Schema subset; unknown constraints fail closed.
export function validateInput(schema, value, depth = 0) {
  const supported = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'description', 'title', 'default']
  if (!schema || depth > 16 || Object.keys(schema).some(k => !supported.includes(k))) throw fail('CAPABILITY_SCHEMA_UNSUPPORTED', '业务输入约束不受支持，不能自动调用')
  const reject = () => { throw fail('INVALID_OPERATION_INPUT', '业务参数不符合已注册输入约束') }
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) reject()
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (schema.type === 'integer' ? !Number.isSafeInteger(value) : schema.type !== type || type === 'number' && !Number.isFinite(value)) reject()
  if (type === 'object') {
    for (const name of schema.required || []) if (!Object.hasOwn(value, name)) reject()
    for (const [name, item] of Object.entries(value)) {
      if (!schema.properties?.[name]) { if (schema.additionalProperties !== true) reject() }
      else validateInput(schema.properties[name], item, depth + 1)
    }
  } else if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 100)) reject()
    for (const item of value) validateInput(schema.items, item, depth + 1)
  } else if (type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 32000))) reject()
  else if (type === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) reject()
  return value
}
