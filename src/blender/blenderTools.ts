import { getBlenderTemplateDefinitions } from './blenderTemplateTools.js';
import { getBlenderAdvancedTools } from './blenderAdvancedTools.js';
import { getBlenderExportValidationTools } from './blenderExportValidation.js';
import { getBlenderWalkTools } from './blenderAnimWalkSetup.js';
import { defaultBlenderDependencies, resolveBlenderExecutionTool, blenderResultText, type BlenderAdapterDependencies } from './blenderAdapter.js';

const definitions = () => [...getBlenderTemplateDefinitions(), ...getBlenderAdvancedTools(),
  ...getBlenderExportValidationTools(), ...getBlenderWalkTools()];
export function isCuratedBlenderTool(name: string): boolean { return definitions().some(t => t.name === name); }
export function getCuratedBlenderTools() {
  return definitions().map(t => ({ name: t.name, description: t.description,
    inputSchema: { ...t.inputSchema, properties: { ...((t.inputSchema.properties ?? {}) as Record<string, unknown>),
      adapter: { type: 'string', minLength: 1, description: 'Configured Blender adapter prefix; omit for first available. No fallback when explicitly selected.' },
    } },
  }));
}

export async function runCuratedBlenderTool(
  name: string, args: Record<string, unknown>, deps: BlenderAdapterDependencies = defaultBlenderDependencies,
): Promise<string> {
  const tool = definitions().find(t => t.name === name);
  if (!tool) throw new Error('unknown curated Blender tool: ' + name);
  const cfg = deps.getConfig();
  if (!cfg.evalEnabled) throw new Error('Blender tools are disabled (evalEnabled=false)');
  if (cfg.allowedTools.length && !cfg.allowedTools.includes(name)) throw new Error('Blender tool is not allowed: ' + name);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > cfg.limits.maxToolArgsBytes) throw new Error('Blender tool arguments too large');
  const execName = resolveBlenderExecutionTool(args, cfg, deps.isAvailable);
  const { adapter: _adapter, ...params } = args;
  const code = tool.buildCode(params);
  // Never retry scripts: a failed call may already have changed its scene.
  return blenderResultText(await deps.call(execName, { code }));
}

export async function callCuratedBlenderMcp(name: string, args: Record<string, unknown>, deps?: BlenderAdapterDependencies) {
  try {
    return { content: [{ type: 'text' as const, text: await runCuratedBlenderTool(name, args, deps) }] };
  } catch (err) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], isError: true };
  }
}

export async function callCuratedBlenderRpc(id: unknown, name: string, args: Record<string, unknown>, deps?: BlenderAdapterDependencies) {
  try {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text' as const, text: await runCuratedBlenderTool(name, args, deps) }] } };
  } catch (err) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
  }
}