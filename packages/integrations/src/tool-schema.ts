import { z } from 'zod';

/** Derive advertised JSON Schema from the same schema that validates tool calls. */
export function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const description = schema.description ? { description: schema.description } : {};
  const def = schema._def as { typeName: string };
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      const required = Object.entries(shape).filter(([, child]) => !child.isOptional()).map(([key]) => key);
      return { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([key, child]) => [key, jsonSchema(child)])),
        ...(required.length ? { required } : {}), additionalProperties: false, ...description };
    }
    case 'ZodOptional': case 'ZodDefault': {
      const inner = jsonSchema((schema._def as { innerType: z.ZodTypeAny }).innerType);
      return { ...inner, ...description };
    }
    case 'ZodString': {
      const checks = (schema._def as { checks: { kind: string; value?: number }[] }).checks;
      const max = checks.find(check => check.kind === 'max')?.value;
      const min = checks.find(check => check.kind === 'min')?.value;
      return { type: 'string', ...(min !== undefined ? { minLength: min } : {}), ...(max !== undefined ? { maxLength: max } : {}), ...description };
    }
    case 'ZodNumber': {
      const checks = (schema._def as { checks: { kind: string; value?: number }[] }).checks;
      const max = checks.find(check => check.kind === 'max')?.value;
      const min = checks.find(check => check.kind === 'min')?.value;
      return { type: checks.some(check => check.kind === 'int') ? 'integer' : 'number',
        ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}), ...description };
    }
    // refine(): the advertised shape is the inner one; the refinement is enforced on call.
    case 'ZodEffects': return { ...jsonSchema((schema._def as { schema: z.ZodTypeAny }).schema), ...description };
    case 'ZodBoolean': return { type: 'boolean', ...description };
    case 'ZodEnum': return { type: 'string', enum: (schema._def as { values: string[] }).values, ...description };
    case 'ZodArray': {
      const { type, maxLength } = schema._def as { type: z.ZodTypeAny; maxLength?: { value: number } };
      return { type: 'array', items: jsonSchema(type), ...(maxLength ? { maxItems: maxLength.value } : {}), ...description };
    }
    default: throw new Error(`unsupported tool schema: ${def.typeName}`);
  }
}
