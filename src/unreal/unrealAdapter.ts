import { getCachedConfig, type AppConfig } from '../config.js';
import { callAdapterTool, isAdapterTool } from '../mcpAdapter.js';
export type UnrealConfig = Pick<AppConfig, 'evalEnabled'|'mcpServers'|'allowedTools'|'limits'>;
export interface UnrealAdapterDependencies { getConfig(): UnrealConfig; isAvailable(name:string):boolean; call(name:string,args:Record<string,unknown>):Promise<unknown>; }
export const defaultUnrealDependencies: UnrealAdapterDependencies={getConfig:getCachedConfig,isAvailable:isAdapterTool,call:callAdapterTool};
export function unrealResultText(value:unknown):string { if(typeof value==='string') return value; const text=JSON.stringify(value); if(text===undefined) throw new Error('Unreal adapter returned no serializable result'); return text; }
export function resolveUnrealAdapter(args:Record<string,unknown>,cfg:UnrealConfig,isAvailable:(name:string)=>boolean):string {
 if(!cfg.evalEnabled) throw new Error('Unreal tools are disabled (evalEnabled=false)');
 const configured=(cfg.mcpServers??[]).filter(s=>s.enabled!==false); const prefixes=configured.map(s=>s.toolsPrefix??s.name); const requested=args.adapter;
 if(requested!==undefined && (typeof requested!=='string'||!requested.trim())) throw new Error('adapter must be a non-empty string prefix');
 const candidates=typeof requested==='string'?[requested.trim()]:prefixes;
 for(const prefix of candidates){ if(prefixes.filter(p=>p===prefix).length>1) throw new Error('ambiguous Unreal adapter prefix: '+prefix); if(prefixes.includes(prefix) && isAvailable(prefix+'.execute_unreal_code')) return prefix; }
 throw new Error('no connected Unreal adapter'+(typeof requested==='string'?" for target '"+requested+"'":'')+'; checked: '+(candidates.join(', ')||'(none configured)'));
}
export async function callUnrealOperation(operation:string,args:Record<string,unknown>,deps:UnrealAdapterDependencies=defaultUnrealDependencies):Promise<string>{ const prefix=resolveUnrealAdapter(args,deps.getConfig(),deps.isAvailable); const tool=prefix+'.'+operation; if(!deps.isAvailable(tool)) throw new Error('Unreal adapter does not expose '+operation+' on '+prefix); const {adapter:_adapter,...params}=args; return unrealResultText(await deps.call(tool,params)); }
