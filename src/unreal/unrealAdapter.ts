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
 for(const prefix of candidates){ if(prefixes.filter(p=>p===prefix).length>1) throw new Error('ambiguous Unreal adapter prefix: '+prefix); if(prefixes.includes(prefix) && isAvailable(prefix+'.execute_python')) return prefix; }
 throw new Error('no connected Unreal adapter'+(typeof requested==='string'?" for target '"+requested+"'":'')+'; checked: '+(candidates.join(', ')||'(none configured)'));
}
function pythonDispatcher(operation:string,args:Record<string,unknown>):string {
 const payload=JSON.stringify({operation,args});
 return "import unreal, json\n"+
  "request="+JSON.stringify(payload)+"\n"+
  "request=json.loads(request)\n"+
  "op=request['operation']; args=request['args']\n"+
  "out={'ok':False,'operation':op,'warnings':[]}\n"+
  "try:\n"+
  "  if op=='health': out.update(ok=True, result={'engine_version': unreal.SystemLibrary.get_engine_version(), 'editor': True})\n"+
  "  elif op=='capabilities': out.update(ok=True, result={'python': True, 'asset_registry': True, 'geometry_collection': hasattr(unreal,'GeometryCollection'), 'version': unreal.SystemLibrary.get_engine_version()})\n"+
  "  elif op=='project_info': out.update(ok=True, result={'project_dir': unreal.Paths.project_dir(), 'project_name': unreal.Paths.get_project_file_path()})\n"+
  "  elif op=='level_snapshot': out.update(ok=True, result={'world': unreal.EditorLevelLibrary.get_editor_world().get_path_name() if unreal.EditorLevelLibrary.get_editor_world() else None})\n"+
  "  elif op=='fracture_manifest':\n"+
  "    path=args.get('manifestPath'); exists=bool(path and __import__('os').path.exists(path)); data=json.load(open(path,encoding='utf-8')) if exists else None; out.update(ok=True, result={'manifestPath':path, 'exists':exists, 'mode':'read', 'manifest':data})\n"+
  "  elif op=='fracture_validate':\n"+
  "    path=args.get('manifestPath'); exists=bool(path and __import__('os').path.exists(path)); data=json.load(open(path,encoding='utf-8')) if exists else {}; checks=[]; checks.append({'code':'MANIFEST_EXISTS','status':'pass' if exists else 'error'}); checks.append({'code':'SCHEMA_VERSION','status':'pass' if data.get('schemaVersion')=='fracture-1.0' else 'warning'}); checks.append({'code':'CHUNKS_PRESENT','status':'pass' if data.get('chunks') else 'warning'}); out.update(ok=exists, result={'manifestPath':path, 'status':'pass' if exists and all(c['status']!='error' for c in checks) else 'warning', 'checks':checks})\n"+
  "  elif op.startswith('fracture_') and args.get('dryRun') is True: out.update(ok=True, result={'mode':'dry_run', 'operation':op, 'source':args.get('source'), 'output':args.get('outputDir') or args.get('outputFile'), 'backend':'ue_python_probe', 'note':'Dry run validated routing and parameters; Geometry Collection export requires a UE editor backend.'})\n"+
  "  else: out.update(ok=False, error={'code':'UNSUPPORTED_OPERATION','message':'Operation requires a registered Unreal Python backend: '+op})\n"+
  "except Exception as e: out.update(ok=False, error={'code':'UNREAL_PYTHON_ERROR','message':str(e)})\n"+
  "print(json.dumps(out, ensure_ascii=False))";
}
export async function callUnrealOperation(operation:string,args:Record<string,unknown>,deps:UnrealAdapterDependencies=defaultUnrealDependencies):Promise<string>{
 const prefix=resolveUnrealAdapter(args,deps.getConfig(),deps.isAvailable); const {adapter:_adapter,...params}=args; const python=prefix+'.execute_python';
 const result=await deps.call(python,{python:pythonDispatcher(operation,params)}); const text=unrealResultText(result);
 try { const parsed=JSON.parse(text) as {ok?:boolean;error?:{message?:string}}; if(parsed.ok===false) throw new Error(parsed.error?.message??'Unreal operation failed'); return text; } catch(e){ if(e instanceof SyntaxError) return text; throw e; }
}