import type {
  ApplicationTools,
  ApplicationToolRequest,
  ApplicationToolResult,
} from '@randolph/runtime/contracts';

type Json = Record<string, unknown>;
const MAX_TOOL_BYTES = 64 * 1024;
const record = (value: unknown): value is Json =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');

export function prepareApplicationTools(tools: ApplicationTools): Json[] {
  if (
    !tools ||
    typeof tools.onRequest !== 'function' ||
    !Array.isArray(tools.definitions) ||
    !tools.definitions.length ||
    tools.definitions.length > 8
  )
    throw new Error('Application tools require a bounded definition list and a runtime handler.');
  const names = new Set<string>();
  const definitions = tools.definitions.map((definition) => {
    if (
      !record(definition) ||
      !text(definition.name, 80) ||
      !/^randolph_[a-z][a-z0-9_]*$/.test(definition.name) ||
      names.has(definition.name) ||
      !text(definition.description, 4000) ||
      !record(definition.inputSchema) ||
      definition.inputSchema.type !== 'object'
    )
      throw new Error('Invalid or duplicate application tool definition.');
    names.add(definition.name);
    return {
      type: 'function',
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    };
  });
  const encoded = JSON.stringify(definitions);
  if (Buffer.byteLength(encoded) > MAX_TOOL_BYTES)
    throw new Error('Application tool definitions exceed the size limit.');
  return JSON.parse(encoded) as Json[];
}

export function applicationToolRequest(
  message: Json,
  definitions: Json[],
): ApplicationToolRequest | undefined {
  const params = message.params;
  if (
    !record(params) ||
    params.namespace !== null ||
    !text(params.threadId, 256) ||
    !text(params.turnId, 256) ||
    !text(params.callId, 256) ||
    !text(params.tool, 80) ||
    !definitions.some((definition) => definition.name === params.tool) ||
    !record(params.arguments)
  )
    return undefined;
  const requestId = message.id;
  if (!(typeof requestId === 'number' && Number.isSafeInteger(requestId)) && !text(requestId, 256))
    return undefined;
  if (Buffer.byteLength(JSON.stringify(params.arguments)) > MAX_TOOL_BYTES) return undefined;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId,
    requestId: requestId as string | number,
    name: params.tool,
    arguments: params.arguments,
  };
}

export function applicationToolResponse(result: ApplicationToolResult): Json {
  if (
    !record(result) ||
    typeof result.success !== 'boolean' ||
    typeof result.text !== 'string' ||
    result.text.includes('\0') ||
    Buffer.byteLength(result.text) > MAX_TOOL_BYTES
  )
    throw new Error('The application tool handler returned an invalid or oversized receipt.');
  return { success: result.success, contentItems: [{ type: 'inputText', text: result.text }] };
}
