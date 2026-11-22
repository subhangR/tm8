import { z } from 'zod';
import type { EgressMode, HttpMethod, KeyInjection } from '../types.js';
import type { ConnectorOperation, ValueRule } from './operations.js';

export interface ConnectorDenyEntry {
  methods: readonly HttpMethod[];
  pathPattern: RegExp;
}

export interface ConnectorTemplate {
  id: string;
  hosts: readonly string[];
  injection: KeyInjection;
  defaultPathPrefixes: readonly string[];
  deny: readonly ConnectorDenyEntry[];
  /**
   * The vetted operations (independent review F02). A connector request must match one of them.
   * A template without operations is unrestricted: the executor enforces it as generic mode, and
   * the broker refuses to store a connector policy for it. Every built-in template has some.
   */
  operations?: readonly ConnectorOperation[];
  /** Agent headers the operations accept, by lowercase name. Any other agent header is refused. */
  headers?: Readonly<Record<string, ValueRule>>;
}

export type ConnectorRegistry = Readonly<Record<string, ConnectorTemplate>>;
const ALL: readonly HttpMethod[] = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Fixed list from the vault brief; case-insensitive after URL normalization. */
export const GENERIC_DENY_SEGMENTS: ReadonlySet<string> = new Set([
  'token', 'tokens', 'api_keys', 'api-keys', 'apikeys', 'keys', 'credentials', 'secrets',
  'authorizations', 'oauth', 'webhooks', 'hooks', 'ssh_keys', 'gpg_keys', 'deploy_keys', 'sessions', 'invitations',
]);

// ---------------------------------------------------------------------------
// Vetted operations (independent review F02)
// ---------------------------------------------------------------------------
//
// Each list is deliberately narrow. It covers reads plus a few ordinary writes. It holds no
// credential, grant, webhook or persistence operation, and nothing that runs many requests as
// one. Every JSON object is `.strict()`: the broker sends the agent's own value, so a key the
// schema does not name must fail rather than be silently stripped. A content part, an input
// item or a Slack block takes only the types listed, picked by its `type`: a provider resolves
// some others, such as a stored file id, a stored response item or a workspace file (builder-
// side review, F02). Only data a provider resolves nothing in, tool JSON schemas and tool
// arguments, is accepted as any JSON object.

/** A JSON object whose unknown keys fail. */
const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const anyObject = z.record(z.unknown());
const finite = z.number().finite();

const NUMBER = /^[1-9][0-9]{0,9}$/;
const PER_PAGE = /^(?:[1-9]|[1-9][0-9]|100)$/;
const PAGE = /^[1-9][0-9]{0,4}$/;
const DIRECTION = /^(?:asc|desc)$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2}))?$/;
const SEARCH_TEXT = /^[^\0-\x1f\x7f]{1,512}$/;
const JSON_ACCEPT = /^application\/json$/;
const API_VERSION_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// GitHub (https://docs.github.com/en/rest). No GraphQL: /graphql is a multiplexer and is refused.
const GH_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const GH_REF = /^[^\0-\x20\x7f~^:?*[\\]{1,255}$/;
/** One path segment of a repository file. Never `.` or `..` (the URL parser already folds those). */
const GH_FILE_SEGMENT = /^(?!\.{1,2}$)[^\0-\x1f\x7f]{1,255}$/;
const GH_PAGING = { per_page: PER_PAGE, page: PAGE };
const GH_REPO_PARAMS = { owner: GH_LOGIN, repo: GH_REPO };
const GH_ISSUE_PARAMS = { ...GH_REPO_PARAMS, issue_number: NUMBER };
const GITHUB_OPERATIONS: readonly ConnectorOperation[] = [
  { id: 'users.getAuthenticated', method: 'GET', path: '/user', body: null },
  { id: 'repos.get', method: 'GET', path: '/repos/{owner}/{repo}', params: GH_REPO_PARAMS, body: null },
  { id: 'repos.contents.get', method: 'GET', path: '/repos/{owner}/{repo}/contents/{path+}',
    params: { ...GH_REPO_PARAMS, path: GH_FILE_SEGMENT }, query: { ref: GH_REF }, body: null },
  { id: 'issues.list', method: 'GET', path: '/repos/{owner}/{repo}/issues', params: GH_REPO_PARAMS, body: null,
    query: { ...GH_PAGING, state: /^(?:open|closed|all)$/, labels: /^[^\0-\x1f\x7f]{1,1024}$/, sort: /^(?:created|updated|comments)$/,
      direction: DIRECTION, since: TIMESTAMP, milestone: /^(?:\*|none|[1-9][0-9]{0,9})$/,
      assignee: /^(?:\*|none|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/, creator: GH_LOGIN, mentioned: GH_LOGIN } },
  { id: 'issues.get', method: 'GET', path: '/repos/{owner}/{repo}/issues/{issue_number}', params: GH_ISSUE_PARAMS, body: null },
  { id: 'issues.create', method: 'POST', path: '/repos/{owner}/{repo}/issues', params: GH_REPO_PARAMS,
    body: { kind: 'json', schema: strict({ title: z.string().min(1).max(256), body: z.string().max(65536).optional(),
      labels: z.array(z.string().min(1).max(50)).max(100).optional(), assignees: z.array(z.string().regex(GH_LOGIN)).max(10).optional(),
      milestone: z.number().int().positive().nullable().optional() }) } },
  { id: 'issues.comments.list', method: 'GET', path: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
    params: GH_ISSUE_PARAMS, query: { ...GH_PAGING, since: TIMESTAMP }, body: null },
  { id: 'issues.comments.create', method: 'POST', path: '/repos/{owner}/{repo}/issues/{issue_number}/comments',
    params: GH_ISSUE_PARAMS, body: { kind: 'json', schema: strict({ body: z.string().min(1).max(65536) }) } },
  { id: 'pulls.list', method: 'GET', path: '/repos/{owner}/{repo}/pulls', params: GH_REPO_PARAMS, body: null,
    query: { ...GH_PAGING, state: /^(?:open|closed|all)$/, head: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}):[^\0-\x20\x7f~^:?*[\\]{1,255}$/,
      base: GH_REF, sort: /^(?:created|updated|popularity|long-running)$/, direction: DIRECTION } },
  { id: 'pulls.get', method: 'GET', path: '/repos/{owner}/{repo}/pulls/{pull_number}', params: { ...GH_REPO_PARAMS, pull_number: NUMBER }, body: null },
  { id: 'search.issues', method: 'GET', path: '/search/issues', requiredQuery: ['q'], body: null,
    query: { ...GH_PAGING, q: SEARCH_TEXT, sort: /^(?:comments|reactions|interactions|created|updated)$/, order: DIRECTION } },
  { id: 'search.repositories', method: 'GET', path: '/search/repositories', requiredQuery: ['q'], body: null,
    query: { ...GH_PAGING, q: SEARCH_TEXT, sort: /^(?:stars|forks|help-wanted-issues|updated)$/, order: DIRECTION } },
  { id: 'orgs.repos.list', method: 'GET', path: '/orgs/{org}/repos', params: { org: GH_LOGIN }, body: null,
    query: { ...GH_PAGING, type: /^(?:all|public|private|forks|sources|member)$/, sort: /^(?:created|updated|pushed|full_name)$/, direction: DIRECTION } },
];
const GITHUB_HEADERS = {
  accept: /^application\/(?:json|vnd\.github(?:\.v3)?(?:\.(?:raw|html|text|full|diff|patch|sha|object))?(?:\+json)?)$/,
  'x-github-api-version': API_VERSION_DATE,
};

// OpenAI (https://platform.openai.com/docs/api-reference). Function tools only: no MCP, file
// search, code interpreter or computer tools. Nothing stored: no `store: true`, no background
// run, no previous response, conversation or stored prompt. No files, batches or fine-tuning.
// No content part or input item names a stored object either: a file goes inline as
// `file_data`, never by `file_id`, and no input item is an `item_reference` or carries an id.
const OPENAI_MODEL = /^[A-Za-z0-9._:-]{1,128}$/;
const openAiModel = z.string().regex(OPENAI_MODEL);
const imageDetail = z.enum(['auto', 'low', 'high']);
const openAiChatPart = z.discriminatedUnion('type', [
  strict({ type: z.literal('text'), text: z.string() }),
  strict({ type: z.literal('image_url'), image_url: strict({ url: z.string(), detail: imageDetail.optional() }) }),
  strict({ type: z.literal('input_audio'), input_audio: strict({ data: z.string(), format: z.enum(['wav', 'mp3']) }) }),
  strict({ type: z.literal('file'), file: strict({ file_data: z.string(), filename: z.string().max(256).optional() }) }),
  strict({ type: z.literal('refusal'), refusal: z.string() })]);
const openAiChatToolCall = strict({ id: z.string().max(256), type: z.literal('function'),
  function: strict({ name: z.string().regex(TOOL_NAME), arguments: z.string() }) });
const openAiInputPart = z.discriminatedUnion('type', [
  strict({ type: z.literal('input_text'), text: z.string() }),
  strict({ type: z.literal('input_image'), image_url: z.string(), detail: imageDetail.optional() }),
  strict({ type: z.literal('input_file'), file_data: z.string(), filename: z.string().max(256).optional() }),
  strict({ type: z.literal('output_text'), text: z.string() }),
  strict({ type: z.literal('refusal'), refusal: z.string() })]);
const openAiInputItem = z.discriminatedUnion('type', [
  // A message may leave out its `type`, as the API allows.
  strict({ type: z.literal('message').optional(), role: z.enum(['user', 'assistant', 'system', 'developer']),
    content: z.union([z.string(), z.array(openAiInputPart)]) }),
  strict({ type: z.literal('function_call'), call_id: z.string().max(256), name: z.string().regex(TOOL_NAME), arguments: z.string() }),
  strict({ type: z.literal('function_call_output'), call_id: z.string().max(256), output: z.string() })]);
const openAiChatTool = strict({ type: z.literal('function'), function: strict({ name: z.string().regex(TOOL_NAME),
  description: z.string().max(8192).optional(), parameters: anyObject.optional(), strict: z.boolean().nullable().optional() }) });
const openAiChatFormat = z.union([strict({ type: z.literal('text') }), strict({ type: z.literal('json_object') }),
  strict({ type: z.literal('json_schema'), json_schema: strict({ name: z.string().regex(TOOL_NAME), description: z.string().max(8192).optional(),
    schema: anyObject.optional(), strict: z.boolean().nullable().optional() }) })]);
const openAiChatMessage = strict({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(openAiChatPart)]).nullable().optional(), name: z.string().max(64).optional(),
  tool_calls: z.array(openAiChatToolCall).optional(), tool_call_id: z.string().max(256).optional(), refusal: z.string().nullable().optional() });
const openAiResponsesTool = strict({ type: z.literal('function'), name: z.string().regex(TOOL_NAME),
  description: z.string().max(8192).nullable().optional(), parameters: anyObject.nullable().optional(), strict: z.boolean().nullable().optional() });
const openAiResponsesFormat = z.union([strict({ type: z.literal('text') }), strict({ type: z.literal('json_object') }),
  strict({ type: z.literal('json_schema'), name: z.string().regex(TOOL_NAME), schema: anyObject,
    description: z.string().max(8192).optional(), strict: z.boolean().nullable().optional() })]);
const OPENAI_OPERATIONS: readonly ConnectorOperation[] = [
  { id: 'models.list', method: 'GET', path: '/v1/models', body: null },
  { id: 'models.retrieve', method: 'GET', path: '/v1/models/{model}', params: { model: OPENAI_MODEL }, body: null },
  { id: 'embeddings.create', method: 'POST', path: '/v1/embeddings', body: { kind: 'json', schema: strict({ model: openAiModel,
    // Token lists hold at most 8,192 tokens, the embedding models' input limit. They come before
    // the string list so that a passing body raises few union issues (JSON_BODY_ISSUE_BUDGET).
    input: z.union([z.string(), z.array(z.number().int()).min(1).max(8192), z.array(z.string()).min(1).max(2048),
      z.array(z.array(z.number().int()).min(1).max(8192)).min(1).max(2048)]),
    dimensions: z.number().int().positive().optional(), encoding_format: z.enum(['float', 'base64']).optional(), user: z.string().max(256).optional() }) } },
  { id: 'chat.completions.create', method: 'POST', path: '/v1/chat/completions', body: { kind: 'json', schema: strict({
    model: openAiModel, messages: z.array(openAiChatMessage).min(1),
    max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
    temperature: finite.optional(), top_p: finite.optional(), n: z.number().int().min(1).max(8).optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).nullable().optional(),
    presence_penalty: finite.optional(), frequency_penalty: finite.optional(), seed: z.number().int().optional(),
    logit_bias: z.record(finite).optional(), logprobs: z.boolean().optional(), top_logprobs: z.number().int().min(0).max(20).optional(),
    response_format: openAiChatFormat.optional(), tools: z.array(openAiChatTool).max(128).optional(),
    tool_choice: z.union([z.enum(['none', 'auto', 'required']),
      strict({ type: z.literal('function'), function: strict({ name: z.string().regex(TOOL_NAME) }) })]).optional(),
    parallel_tool_calls: z.boolean().optional(), reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    user: z.string().max(256).optional(),
    // A stored completion stays readable at the provider. Chat completions do not store by default.
    store: z.literal(false).optional(), stream: z.literal(false).optional() }) } },
  { id: 'responses.create', method: 'POST', path: '/v1/responses', body: { kind: 'json', schema: strict({
    model: openAiModel, input: z.union([z.string(), z.array(openAiInputItem).min(1)]),
    instructions: z.string().nullable().optional(), max_output_tokens: z.number().int().positive().nullable().optional(),
    temperature: finite.nullable().optional(), top_p: finite.nullable().optional(),
    tools: z.array(openAiResponsesTool).max(128).optional(),
    tool_choice: z.union([z.enum(['none', 'auto', 'required']), strict({ type: z.literal('function'), name: z.string().regex(TOOL_NAME) })]).optional(),
    parallel_tool_calls: z.boolean().nullable().optional(),
    text: strict({ format: openAiResponsesFormat.optional(), verbosity: z.enum(['low', 'medium', 'high']).optional() }).optional(),
    reasoning: strict({ effort: z.enum(['minimal', 'low', 'medium', 'high']).nullable().optional(),
      summary: z.enum(['auto', 'concise', 'detailed']).nullable().optional() }).optional(),
    truncation: z.enum(['auto', 'disabled']).nullable().optional(), user: z.string().max(256).optional(),
    // Required: the Responses API stores a response unless told not to.
    store: z.literal(false), stream: z.literal(false).optional() }) } },
];

// Anthropic (https://docs.claude.com/en/api). Custom tools only: no server tools, MCP servers or
// containers. No `anthropic-beta` header, which is what unlocks the Files and other beta APIs.
// No content block reads a stored file either: a `file` source is refused here, not left to the
// missing header. Images and documents come inline or by URL.
// No message batches: /v1/messages/batches is a multiplexer and is refused.
const ANTHROPIC_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const anthropicModel = z.string().regex(ANTHROPIC_ID);
const anthropicCache = strict({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() }).nullable().optional();
const anthropicText = strict({ type: z.literal('text'), text: z.string(), cache_control: anthropicCache });
const anthropicImage = strict({ type: z.literal('image'), cache_control: anthropicCache, source: z.discriminatedUnion('type', [
  strict({ type: z.literal('base64'), media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']), data: z.string() }),
  strict({ type: z.literal('url'), url: z.string() })]) });
const anthropicDocument = strict({ type: z.literal('document'), cache_control: anthropicCache, title: z.string().max(500).nullable().optional(),
  context: z.string().nullable().optional(), citations: strict({ enabled: z.boolean() }).optional(), source: z.discriminatedUnion('type', [
    strict({ type: z.literal('base64'), media_type: z.literal('application/pdf'), data: z.string() }),
    strict({ type: z.literal('text'), media_type: z.literal('text/plain'), data: z.string() }),
    strict({ type: z.literal('url'), url: z.string() })]) });
const anthropicBlock = z.discriminatedUnion('type', [anthropicText, anthropicImage, anthropicDocument,
  strict({ type: z.literal('tool_use'), id: z.string().max(256), name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), input: anyObject,
    cache_control: anthropicCache }),
  strict({ type: z.literal('tool_result'), tool_use_id: z.string().max(256), is_error: z.boolean().optional(), cache_control: anthropicCache,
    content: z.union([z.string(), z.array(z.discriminatedUnion('type', [anthropicText, anthropicImage]))]).optional() }),
  strict({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }),
  strict({ type: z.literal('redacted_thinking'), data: z.string() })]);
const anthropicMessages = z.array(strict({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(anthropicBlock).min(1)]) })).min(1);
const anthropicSystem = z.union([z.string(), z.array(anthropicText)]);
const anthropicTool = strict({ name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), description: z.string().max(65536).optional(),
  input_schema: anyObject, type: z.literal('custom').optional(),
  cache_control: strict({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() }).nullable().optional() });
const anthropicToolChoice = z.union([
  strict({ type: z.literal('auto'), disable_parallel_tool_use: z.boolean().optional() }),
  strict({ type: z.literal('any'), disable_parallel_tool_use: z.boolean().optional() }),
  strict({ type: z.literal('tool'), name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), disable_parallel_tool_use: z.boolean().optional() }),
  strict({ type: z.literal('none') })]);
const anthropicThinking = z.union([strict({ type: z.literal('enabled'), budget_tokens: z.number().int().positive() }), strict({ type: z.literal('disabled') })]);
const ANTHROPIC_OPERATIONS: readonly ConnectorOperation[] = [
  { id: 'models.list', method: 'GET', path: '/v1/models', body: null,
    query: { limit: /^(?:[1-9]|[1-9][0-9]|[1-9][0-9]{2}|1000)$/, after_id: ANTHROPIC_ID, before_id: ANTHROPIC_ID } },
  { id: 'models.get', method: 'GET', path: '/v1/models/{model_id}', params: { model_id: ANTHROPIC_ID }, body: null },
  { id: 'messages.create', method: 'POST', path: '/v1/messages', body: { kind: 'json', schema: strict({
    model: anthropicModel, max_tokens: z.number().int().positive(), messages: anthropicMessages, system: anthropicSystem.optional(),
    temperature: finite.optional(), top_p: finite.optional(), top_k: z.number().int().nonnegative().optional(),
    stop_sequences: z.array(z.string()).max(16).optional(), tools: z.array(anthropicTool).max(128).optional(),
    tool_choice: anthropicToolChoice.optional(), metadata: strict({ user_id: z.string().max(256).nullable().optional() }).optional(),
    thinking: anthropicThinking.optional(), service_tier: z.enum(['auto', 'standard_only']).optional(),
    stream: z.literal(false).optional() }) } },
  { id: 'messages.countTokens', method: 'POST', path: '/v1/messages/count_tokens', body: { kind: 'json', schema: strict({
    model: anthropicModel, messages: anthropicMessages, system: anthropicSystem.optional(),
    tools: z.array(anthropicTool).max(128).optional(), tool_choice: anthropicToolChoice.optional(), thinking: anthropicThinking.optional() }) } },
];
const ANTHROPIC_HEADERS = { accept: JSON_ACCEPT, 'anthropic-version': API_VERSION_DATE };

// Stripe (https://docs.stripe.com/api). Reads plus creating a customer. No money movement, no
// `expand`, and no Stripe-Account header (it acts as a connected account). PaymentIntent reads
// are left out: a PaymentIntent carries its `client_secret`, a credential the response filter
// does not remove.
const stripeId = (prefix: string): RegExp => new RegExp(`^${prefix}_[A-Za-z0-9]{1,64}$`);
const STRIPE_LIMIT = /^(?:[1-9]|[1-9][0-9]|100)$/;
const STRIPE_BOOL = /^(?:true|false)$/;
const STRIPE_TEXT = /^[^\0-\x1f\x7f]{1,500}$/;
const STRIPE_EMAIL = /^[^\0-\x20\x7f]{1,512}$/;
const stripeList = (prefix: string) => ({ limit: STRIPE_LIMIT, starting_after: stripeId(prefix), ending_before: stripeId(prefix) });
const STRIPE_OPERATIONS: readonly ConnectorOperation[] = [
  { id: 'customers.list', method: 'GET', path: '/v1/customers', query: { ...stripeList('cus'), email: STRIPE_EMAIL }, body: null },
  { id: 'customers.retrieve', method: 'GET', path: '/v1/customers/{customer}', params: { customer: stripeId('cus') }, body: null },
  { id: 'customers.create', method: 'POST', path: '/v1/customers', body: { kind: 'form',
    fields: { name: STRIPE_TEXT, email: STRIPE_EMAIL, description: STRIPE_TEXT, phone: /^[0-9+() .-]{1,32}$/ },
    patterns: [[/^metadata\[[A-Za-z0-9_-]{1,40}\]$/, /^[^\0-\x1f\x7f]{0,500}$/]] } },
  { id: 'products.list', method: 'GET', path: '/v1/products', query: { ...stripeList('prod'), active: STRIPE_BOOL }, body: null },
  { id: 'products.retrieve', method: 'GET', path: '/v1/products/{product}', params: { product: stripeId('prod') }, body: null },
  { id: 'prices.list', method: 'GET', path: '/v1/prices', body: null,
    query: { ...stripeList('price'), active: STRIPE_BOOL, product: stripeId('prod'), currency: /^[a-z]{3}$/ } },
  { id: 'prices.retrieve', method: 'GET', path: '/v1/prices/{price}', params: { price: stripeId('price') }, body: null },
];
const STRIPE_HEADERS = { accept: JSON_ACCEPT, 'stripe-version': /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.[a-z]+)?$/, 'idempotency-key': /^[A-Za-z0-9_-]{1,255}$/ };

// Slack (https://docs.slack.dev/reference/methods). Conversation and user ids only. A message
// cannot set its own username or icon, act as the user, or carry app metadata. Blocks are
// header, section, divider, context and image blocks, with images by URL: a `slack_file` or a
// remote file block names a file stored in the workspace, and an accessory or action is
// interactive. Attachments carry the legacy text fields only, with no blocks or actions.
const SLACK_CHANNEL = /^[CDG][A-Z0-9]{8,12}$/;
const SLACK_USER = /^[UW][A-Z0-9]{8,12}$/;
const SLACK_TS = /^[0-9]{10}\.[0-9]{6}$/;
const SLACK_BOOL = /^(?:true|false|0|1)$/;
const slackPlainText = strict({ type: z.literal('plain_text'), text: z.string(), emoji: z.boolean().optional() });
const slackMrkdwn = strict({ type: z.literal('mrkdwn'), text: z.string(), verbatim: z.boolean().optional() });
const slackTextObject = z.discriminatedUnion('type', [slackPlainText, slackMrkdwn]);
const slackImageUrl = { image_url: z.string(), alt_text: z.string() };
const slackBlockId = z.string().max(255).optional();
const slackBlock = z.discriminatedUnion('type', [
  strict({ type: z.literal('header'), block_id: slackBlockId, text: slackPlainText }),
  strict({ type: z.literal('section'), block_id: slackBlockId, text: slackTextObject.optional(), fields: z.array(slackTextObject).max(10).optional() }),
  strict({ type: z.literal('divider'), block_id: slackBlockId }),
  strict({ type: z.literal('context'), block_id: slackBlockId,
    elements: z.array(z.discriminatedUnion('type', [slackPlainText, slackMrkdwn, strict({ type: z.literal('image'), ...slackImageUrl })])).min(1).max(10) }),
  strict({ type: z.literal('image'), block_id: slackBlockId, ...slackImageUrl, title: slackPlainText.optional() })]);
const slackAttachment = strict({ fallback: z.string().optional(), color: z.string().max(32).optional(), pretext: z.string().optional(),
  author_name: z.string().optional(), author_link: z.string().optional(), author_icon: z.string().optional(), title: z.string().optional(),
  title_link: z.string().optional(), text: z.string().optional(), image_url: z.string().optional(), thumb_url: z.string().optional(),
  footer: z.string().optional(), footer_icon: z.string().optional(), ts: z.number().int().nonnegative().optional(),
  fields: z.array(strict({ title: z.string().optional(), value: z.string().optional(), short: z.boolean().optional() })).optional(),
  mrkdwn_in: z.array(z.enum(['pretext', 'text', 'fields'])).max(3).optional() });
const SLACK_OPERATIONS: readonly ConnectorOperation[] = [
  { id: 'chat.postMessage', method: 'POST', path: '/api/chat.postMessage', body: { kind: 'json', schema: strict({
    channel: z.string().regex(SLACK_CHANNEL), text: z.string().max(40000).optional(), blocks: z.array(slackBlock).max(50).optional(),
    attachments: z.array(slackAttachment).max(100).optional(), thread_ts: z.string().regex(SLACK_TS).optional(),
    reply_broadcast: z.boolean().optional(), mrkdwn: z.boolean().optional(), unfurl_links: z.boolean().optional(),
    unfurl_media: z.boolean().optional(), parse: z.enum(['full', 'none']).optional(), link_names: z.boolean().optional(),
  }).refine((message) => message.text !== undefined || message.blocks !== undefined || message.attachments !== undefined) } },
  { id: 'conversations.info', method: 'GET', path: '/api/conversations.info', requiredQuery: ['channel'], body: null,
    query: { channel: SLACK_CHANNEL, include_locale: SLACK_BOOL, include_num_members: SLACK_BOOL } },
  { id: 'conversations.history', method: 'GET', path: '/api/conversations.history', requiredQuery: ['channel'], body: null,
    query: { channel: SLACK_CHANNEL, cursor: /^[A-Za-z0-9+/=_-]{1,512}$/, limit: /^(?:[1-9]|[1-9][0-9]{1,2})$/,
      latest: SLACK_TS, oldest: SLACK_TS, inclusive: SLACK_BOOL } },
  { id: 'users.info', method: 'GET', path: '/api/users.info', requiredQuery: ['user'], body: null,
    query: { user: SLACK_USER, include_locale: SLACK_BOOL } },
];

export const CONNECTORS: ConnectorRegistry = Object.freeze({
  github: {
    id: 'github', hosts: ['api.github.com'], injection: { kind: 'bearer' }, defaultPathPrefixes: ['/repos', '/user', '/orgs', '/search'],
    operations: GITHUB_OPERATIONS, headers: GITHUB_HEADERS,
    deny: [
      // https://docs.github.com/en/rest/apps/oauth-applications — token checks, resets and grants.
      { methods: ALL, pathPattern: /(?:^|\/)(?:tokens?|access_tokens|authorizations|credentials|applications)(?:\/|$)/i },
      // https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
      { methods: ALL, pathPattern: /^\/app\/installations\/[^/]+\/access_tokens(?:\/|$)/i },
      // https://docs.github.com/en/rest/users/keys and https://docs.github.com/en/rest/deploy-keys/deploy-keys
      { methods: ALL, pathPattern: /(?:^|\/)(?:keys|ssh_keys|ssh_signing_keys|gpg_keys|deploy_keys)(?:\/|$)/i },
      // https://docs.github.com/en/rest/repos/webhooks and https://docs.github.com/en/rest/orgs/webhooks
      { methods: ALL, pathPattern: /(?:^|\/)(?:hooks|webhooks)(?:\/|$)/i },
      // https://docs.github.com/en/rest/actions/secrets — includes org, repo and environment secrets.
      { methods: ALL, pathPattern: /(?:^|\/)secrets(?:\/|$)/i },
      // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
      { methods: ALL, pathPattern: /(?:^|\/)oauth(?:\/|$)/i },
      // https://docs.github.com/en/rest/orgs/members#create-an-organization-invitation
      { methods: ALL, pathPattern: /(?:^|\/)invitations?(?:\/|$)/i },
      // https://docs.github.com/en/rest/orgs/personal-access-tokens
      { methods: ALL, pathPattern: /(?:^|\/)personal-access-tokens?(?:-requests)?(?:\/|$)/i },
      // https://docs.github.com/en/rest/apps/webhooks — the GitHub App spelling is singular 'hook'.
      { methods: ALL, pathPattern: /^\/app\/hook(?:\/|$)/i },
      // https://docs.github.com/en/rest/collaborators/collaborators and https://docs.github.com/en/rest/orgs/members
      { methods: ALL, pathPattern: /(?:^|\/)(?:collaborators|outside_collaborators|memberships)(?:\/|$)/i },
    ],
  },
  openai: {
    id: 'openai', hosts: ['api.openai.com'], injection: { kind: 'bearer' },
    defaultPathPrefixes: ['/v1/responses', '/v1/chat/completions', '/v1/embeddings', '/v1/models'],
    operations: OPENAI_OPERATIONS, headers: { accept: JSON_ACCEPT },
    deny: [
      // https://platform.openai.com/docs/api-reference/admin-api-keys — deny the entire administration surface.
      { methods: ALL, pathPattern: /^\/v1\/(?:organization|organizations|admin)(?:\/|$)/i },
      // https://platform.openai.com/docs/api-reference/realtime-sessions — ephemeral credentials/client secrets.
      { methods: ALL, pathPattern: /(?:^|\/)(?:api_keys|admin_api_keys|service_accounts|client_secrets|sessions|transcription_sessions|tokens?|keys|credentials)(?:\/|$)/i },
      // https://platform.openai.com/docs/guides/webhooks — registration can create an exfiltration channel.
      { methods: ALL, pathPattern: /(?:^|\/)(?:webhooks|hooks|oauth|authorizations|secrets|invitations)(?:\/|$)/i },
    ],
  },
  anthropic: {
    id: 'anthropic', hosts: ['api.anthropic.com'], injection: { kind: 'header', name: 'x-api-key' },
    defaultPathPrefixes: ['/v1/messages', '/v1/models'],
    operations: ANTHROPIC_OPERATIONS, headers: ANTHROPIC_HEADERS,
    deny: [
      // https://platform.claude.com/docs/en/manage-claude/admin-api — API keys, invites, members and service accounts.
      { methods: ALL, pathPattern: /^\/v1\/(?:organizations?|admin)(?:\/|$)/i },
      // https://platform.claude.com/docs/en/manage-claude/admin-api — credential/admin aliases fail closed too.
      { methods: ALL, pathPattern: /(?:^|\/)(?:api_keys|api-keys|apikeys|keys|tokens?|credentials|service_accounts|secrets|oauth|authorizations|invitations|invites|sessions|webhooks|hooks)(?:\/|$)/i },
    ],
  },
  stripe: {
    // https://docs.stripe.com/api/authentication — Stripe explicitly supports bearer auth.
    id: 'stripe', hosts: ['api.stripe.com'], injection: { kind: 'bearer' },
    defaultPathPrefixes: ['/v1/customers', '/v1/products', '/v1/prices'],
    operations: STRIPE_OPERATIONS, headers: STRIPE_HEADERS,
    deny: [
      // https://docs.stripe.com/api/tokens and https://docs.stripe.com/api/ephemeral_keys
      { methods: ALL, pathPattern: /(?:^|\/)(?:tokens?|ephemeral_keys|api_keys|keys|credentials)(?:\/|$)/i },
      // https://docs.stripe.com/api/webhook_endpoints
      { methods: ALL, pathPattern: /(?:^|\/)(?:webhook_endpoints|webhooks|hooks)(?:\/|$)/i },
      // https://docs.stripe.com/stripe-apps/store-secrets
      { methods: ALL, pathPattern: /^\/v1\/apps\/secrets(?:\/|$)/i },
      // https://docs.stripe.com/connect/oauth-reference — OAuth exchange/revocation and client-secret sessions.
      { methods: ALL, pathPattern: /(?:^|\/)(?:oauth|secrets|sessions|authorizations|invitations)(?:\/|$)/i },
      // https://docs.stripe.com/api/terminal/connection_tokens — Terminal credentials.
      { methods: ALL, pathPattern: /(?:^|\/)connection_tokens(?:\/|$)/i },
      // https://docs.stripe.com/api/account_sessions and https://docs.stripe.com/api/accounts/login_link
      { methods: ALL, pathPattern: /(?:^|\/)(?:account_sessions|account_links|login_links|verification_sessions)(?:\/|$)/i },
    ],
  },
  slack: {
    id: 'slack', hosts: ['slack.com'], injection: { kind: 'bearer' },
    defaultPathPrefixes: ['/api/chat.postMessage', '/api/conversations.info', '/api/conversations.history', '/api/users.info'],
    operations: SLACK_OPERATIONS, headers: { accept: JSON_ACCEPT },
    deny: [
      // https://docs.slack.dev/reference/methods/oauth.v2.access/ — also covers exchange and token rotation.
      { methods: ALL, pathPattern: /^\/api\/(?:oauth|openid|auth)(?:[./]|$)/i },
      // https://docs.slack.dev/reference/methods/apps.connections.open/ — socket, manifest and permission channels.
      { methods: ALL, pathPattern: /^\/api\/apps\.(?:connections|permissions|manifest|uninstall)(?:[./]|$)/i },
      // https://docs.slack.dev/reference/methods/admin.users.invite/ — deny admin persistence/credential operations.
      { methods: ALL, pathPattern: /^\/api\/admin\.(?:users|invites|apps|teams|auth|barriers)(?:[./]|$)/i },
      // https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
      { methods: ALL, pathPattern: /(?:^|[/.])(?:tokens?|api_keys|keys|credentials|secrets|authorizations|webhooks|hooks|ssh_keys|gpg_keys|deploy_keys|sessions|invitations)(?:[/.]|$)/i },
      // https://docs.slack.dev/reference/methods/users.admin.invite/ — legacy invitation endpoint.
      { methods: ALL, pathPattern: /^\/api\/users\.admin\.(?:invite|setAdmin|setOwner)(?:[./]|$)/i },
      // https://docs.slack.dev/reference/methods/apps.auth.external.get/ — returns an external OAuth token.
      { methods: ALL, pathPattern: /^\/api\/apps\.(?:auth|managed\.permissions|user\.connection)(?:[./]|$)/i },
      // https://docs.slack.dev/reference/methods/rtm.connect/ — returns a credentialed WebSocket URL.
      { methods: ALL, pathPattern: /^\/api\/rtm\.(?:connect|start)(?:[./]|$)/i },
    ],
  },
});

/** The template registered under `id`, never an inherited property such as `constructor`. */
export function findConnector(registry: ConnectorRegistry, id: string | null | undefined): ConnectorTemplate | undefined {
  return typeof id === 'string' && Object.hasOwn(registry, id) ? registry[id] : undefined;
}

/**
 * The template under `id` when it lists vetted operations. Only such a template may back a
 * stored connector policy. One without operations is enforced as generic mode, which is weaker.
 */
export function vettedConnector(registry: ConnectorRegistry, id: string | null | undefined): ConnectorTemplate | undefined {
  const connector = findConnector(registry, id);
  return connector?.operations && connector.operations.length > 0 ? connector : undefined;
}

/**
 * The mode a policy actually runs in (review F02, brief addendum 5): `connector` only when it
 * names a template with vetted operations, otherwise the weaker `generic`. The broker binds this
 * into each per-use API approval, so the owner sees it before approving, and an approval given
 * under one mode never authorizes a request under the other. The default registry is the one the
 * broker's executor uses and the one `vault.policies.set` admits connector policies against.
 */
export function enforcedMode(policy: { mode: EgressMode; connector: string | null }, registry: ConnectorRegistry = CONNECTORS): EgressMode {
  return policy.mode === 'connector' && vettedConnector(registry, policy.connector) ? 'connector' : 'generic';
}
