import { z } from 'zod';
import { ActorSummarySchema } from './schemas.js';

export const TOOL_MAX_SOURCE_BYTES = 256 * 1024;
export const TOOL_MAX_OUTPUT_BYTES = 64 * 1024;
export const TOOL_MAX_INPUTS = 64;
export const DEFAULT_TOOL_CAP = 8;
export const TOOL_DEFAULT_TIMEOUT_SECONDS = 900;

const Id = z.string().uuid();
const InputName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Flag = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
// Runtime control names cannot be supplied as inputs: some make data execute as code.
export const TOOL_RESERVED_ENV_NAMES = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TERM', 'COLORTERM', 'LANG',
  'TMPDIR', 'ENV', 'BASH_ENV', 'IFS', 'CDPATH', 'GLOBIGNORE', 'SHELLOPTS', 'BASHOPTS', 'PS4',
  'PROMPT_COMMAND', 'PWD', 'OLDPWD'] as const;
export const TOOL_RESERVED_ENV_PREFIXES = ['TM8_', 'LD_', 'DYLD_', 'BASH_FUNC_', 'PYTHON', 'LC_'] as const;
const ReservedEnvironment = new Set<string>(TOOL_RESERVED_ENV_NAMES);
const Env = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .refine(value => !ReservedEnvironment.has(value.toUpperCase())
    && !TOOL_RESERVED_ENV_PREFIXES.some(prefix => value.toUpperCase().startsWith(prefix)), 'runtime environment names are reserved');
export type ToolJsonValue = null | boolean | number | string | ToolJsonValue[] | { [key: string]: ToolJsonValue };
export const ToolJsonValueSchema: z.ZodType<ToolJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(ToolJsonValueSchema), z.record(ToolJsonValueSchema),
]));
const Common = {
  name: InputName, required: z.boolean().optional(), description: z.string().max(20000).optional(),
  flag: Flag.optional(), short: z.string().regex(/^[A-Za-z]$/).optional(), env: Env.optional(),
};
const InputUnion = z.discriminatedUnion('type', [
  z.object({ ...Common, type: z.literal('string'), default: z.string().optional() }).strict(),
  z.object({ ...Common, type: z.literal('path'), default: z.string().min(1).optional() }).strict(),
  z.object({ ...Common, type: z.literal('int'), default: z.number().int().safe().optional(),
    min: z.number().int().safe().optional(), max: z.number().int().safe().optional() }).strict(),
  z.object({ ...Common, type: z.literal('number'), default: z.number().finite().optional(),
    min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
  z.object({ ...Common, type: z.literal('bool'), default: z.boolean().optional() }).strict(),
  z.object({ ...Common, type: z.literal('enum'), options: z.array(z.string().min(1)).min(1).max(256),
    default: z.string().optional() }).strict(),
  z.object({ ...Common, type: z.literal('json'), default: ToolJsonValueSchema.optional() }).strict(),
  // A secret declares a slot. Neither a literal value nor a default belongs in a definition.
  z.object({ ...Common, type: z.literal('secret') }).strict(),
]);
export const ToolInputSchema = InputUnion.superRefine((input, ctx) => {
  const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (input.type === 'int' || input.type === 'number') {
    if (input.min !== undefined && input.max !== undefined && input.min > input.max) reject('min must not exceed max');
    if (input.default !== undefined && ((input.min !== undefined && input.default < input.min)
      || (input.max !== undefined && input.default > input.max))) reject('default must be within min and max');
  }
  if (input.type === 'enum') {
    if (new Set(input.options).size !== input.options.length) reject('duplicate enum options');
    if (input.default !== undefined && !input.options.includes(input.default)) reject('default must be an enum option');
  }
  if (!input.env && !Env.safeParse(input.name.toUpperCase()).success) reject('default environment name is reserved');
});
export type ToolInput = z.infer<typeof ToolInputSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  description: z.string().max(20000), help: z.string().max(20000),
  runtime: z.enum(['bash', 'python']),
  source: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= TOOL_MAX_SOURCE_BYTES,
    'source exceeds 256 KiB'),
  inputs: z.array(ToolInputSchema).max(TOOL_MAX_INPUTS),
  tm8Access: z.enum(['none', 'read', 'write']),
  timeoutSeconds: z.number().int().positive().max(2147483647),
}).strict().superRefine((definition, ctx) => {
  const names = new Set<string>(), flags = new Set<string>(), shorts = new Set<string>(), envs = new Set<string>();
  definition.inputs.forEach((input, index) => {
    const reject = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inputs', index], message });
    const flag = input.flag ?? input.name.replaceAll('_', '-');
    const env = input.env ?? input.name.toUpperCase();
    const usedFlags = input.type === 'bool' ? [flag, `no-${flag}`]
      : input.type === 'secret' ? [flag, `${flag}-from-env`] : [flag];
    if (names.has(input.name)) reject('duplicate input name');
    if (usedFlags.some(value => flags.has(value)) || flag === 'help') reject('duplicate or reserved input flag');
    if (envs.has(env)) reject('duplicate input environment name');
    if (input.short && (shorts.has(input.short) || input.short === 'h')) reject('duplicate or reserved input short flag');
    names.add(input.name); usedFlags.forEach(value => flags.add(value)); envs.add(env);
    if (input.short) shorts.add(input.short);
  });
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export const ToolEntitySchema = z.object({ kind: z.literal('tool'), definition: ToolDefinitionSchema }).strict();
export type ToolEntity = z.infer<typeof ToolEntitySchema>;

/** Validate a resolved non-secret value against its declaration; path confinement is checked by execution. */
export function validateToolInputValue(input: ToolInput, value: unknown): boolean {
  switch (input.type) {
    case 'secret': return false;
    case 'string': return typeof value === 'string';
    case 'path': return typeof value === 'string' && value.length > 0 && !value.includes('\0');
    case 'bool': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string' && input.options.includes(value);
    case 'json': return ToolJsonValueSchema.safeParse(value).success;
    case 'int': case 'number': return typeof value === 'number' && Number.isFinite(value)
      && (input.type !== 'int' || Number.isSafeInteger(value))
      && (input.min === undefined || value >= input.min) && (input.max === undefined || value <= input.max);
  }
}
export const ToolSecretReferenceSchema = z.object({ secret: z.union([Id, z.literal('passed')]) }).strict();
export const ToolRunStateSchema = z.enum(['running', 'exited', 'timed_out', 'killed']);
export type ToolRunState = z.infer<typeof ToolRunStateSchema>;
/** Stored inputs contain only values or secret references, never the secret itself. */
export const ToolRunSchema = z.object({
  id: Id, spaceId: Id, toolId: Id, toolVersion: z.number().int().positive(), sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  inputs: z.record(ToolJsonValueSchema), state: ToolRunStateSchema,
  keepOpen: z.boolean(), exitCode: z.number().int().nullable(),
  startedAt: z.string().nullable(), exitedAt: z.string().nullable(),
  outputTail: z.string().refine(value => new TextEncoder().encode(value).byteLength <= TOOL_MAX_OUTPUT_BYTES),
  parentSessionId: Id.nullable(),
  invoker: z.lazy(() => ActorSummarySchema).nullable().optional(),
}).strict();
export type ToolRun = z.infer<typeof ToolRunSchema>;
export const ToolSecretBindingSchema = z.object({ inputName: InputName, credentialId: Id, keyHint: z.string().nullable(), boundBy: z.lazy(() => ActorSummarySchema).nullable().optional() }).strict();
export const ToolViewSchema = z.object({
  id: Id, spaceId: Id, version: z.number().int().positive(), sourceSha256: z.string().regex(/^[0-9a-f]{64}$/), definition: ToolDefinitionSchema,
  config: z.record(ToolJsonValueSchema), secretBindings: z.array(ToolSecretBindingSchema),
  sourceChangedSinceViewerLastRun: z.object({ byActor: z.lazy(() => ActorSummarySchema).nullable(), at: z.string(), fromSha: z.string(), toSha: z.string() }).strict().nullable().optional(),
}).strict();
export type ToolView = z.infer<typeof ToolViewSchema>;
const Command = { clientMutationId: z.string().min(1), actorId: Id.optional() };
const Versioned = { ...Command, toolId: Id, expectedVersion: z.number().int().positive() };
export const ToolCreateInputSchema = z.object({ ...Command, spaceId: Id, definition: ToolDefinitionSchema }).strict();
export const ToolUpdateInputSchema = z.object({ ...Versioned, definition: ToolDefinitionSchema }).strict();
export const ToolConfigSetInputSchema = z.object({ ...Versioned, inputName: InputName, value: ToolJsonValueSchema }).strict();
export const ToolConfigUnsetInputSchema = z.object({ ...Versioned, inputName: InputName }).strict();
export const ToolSecretBindInputSchema = z.object({
  ...Versioned, inputName: InputName, credentialId: Id.optional(),
  value: z.string().min(1).max(4096).optional(), label: z.string().min(1).max(120).optional(),
}).strict().superRefine((input, ctx) => {
  if ((input.credentialId !== undefined) === (input.value !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'supply exactly one of credentialId or value' });
  }
});
export const ToolSecretUnbindInputSchema = ToolConfigUnsetInputSchema;
/** Ephemeral secrets are supplied over the authenticated request body, never the command line or run record. */
export const ToolRunInputSchema = z.object({
  ...Command, toolId: Id, expectedVersion: z.number().int().positive().optional(), inputs: z.record(ToolJsonValueSchema).optional(),
  secrets: z.record(z.string().min(1).max(4096)).optional(), cwd: z.string().min(1).max(4096).optional(),
  keepOpen: z.boolean().default(false),
}).strict();
export type ToolCreateInput = z.infer<typeof ToolCreateInputSchema>;
export type ToolUpdateInput = z.infer<typeof ToolUpdateInputSchema>;
export type ToolConfigSetInput = z.infer<typeof ToolConfigSetInputSchema>;
export type ToolConfigUnsetInput = z.infer<typeof ToolConfigUnsetInputSchema>;
export type ToolSecretBindInput = z.infer<typeof ToolSecretBindInputSchema>;
export type ToolSecretUnbindInput = z.infer<typeof ToolSecretUnbindInputSchema>;
export type ToolRunInput = z.infer<typeof ToolRunInputSchema>;
