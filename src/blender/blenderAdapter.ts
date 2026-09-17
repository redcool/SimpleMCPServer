import { getCachedConfig, type AppConfig } from '../config.js';
import { callAdapterTool, isAdapterTool } from '../mcpAdapter.js';

export type BlenderConfig = Pick<AppConfig, 'evalEnabled' | 'mcpServers' | 'allowedTools' | 'limits'>;
export interface BlenderAdapterDependencies { getConfig(): BlenderConfig; isAvailable(toolName: string): boolean; call(toolName: string, args: Record<string, unknown>): Promise<unknown>; }
export function blenderResultText(result: unknown): string { if (typeof result === 'string') return result; const text=JSON.stringify(result); if (text===undefined) throw new Error('Blender adapter returned no serializable result'); return text; }
export const defaultBlenderDependencies: BlenderAdapterDependencies = { getConfig:getCachedConfig, isAvailable:isAdapterTool, call:callAdapterTool };
export function resolveBlenderExecutionTool(args: Record<string,unknown>, cfg: BlenderConfig, isAvailable:(name:string)=>boolean): string {
  if (!cfg.evalEnabled) throw new Error('Blender tools are disabled (evalEnabled=false)');
  let requested: string|undefined; if (args.adapter !== undefined) { if (typeof args.adapter !== 'string' || !args.adapter.trim()) throw new Error('adapter must be a non-empty string prefix'); requested=args.adapter.trim(); }
  const configured=(cfg.mcpServers??[]).filter(s=>s.enabled!==false); const prefixes=configured.map(s=>s.toolsPrefix??s.name); const candidates=requested?[requested]:prefixes;
  for (const prefix of candidates) { const count=prefixes.filter(p=>p===prefix).length; if(count>1) throw new Error('ambiguous Blender adapter prefix: '+prefix); if(count===0) continue; const name=prefix+'.execute_blender_code'; if(isAvailable(name)) return name; }
  throw new Error('no connected Blender adapter'+(requested?" for target '"+requested+"'":'')+'; checked: '+(candidates.join(', ')||'(none configured)'));
}
export async function executeBlenderCode(args:Record<string,unknown>,code:string,deps:BlenderAdapterDependencies=defaultBlenderDependencies):Promise<string>{ const toolName=resolveBlenderExecutionTool(args,deps.getConfig(),deps.isAvailable); return blenderResultText(await deps.call(toolName,{code})); }
