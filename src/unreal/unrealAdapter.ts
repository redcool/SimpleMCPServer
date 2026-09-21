import { getCachedConfig, type AppConfig } from '../config.js';
import { callAdapterTool, isAdapterTool } from '../mcpAdapter.js';
export type UnrealConfig = Pick<AppConfig, 'evalEnabled'|'mcpServers'|'allowedTools'|'limits'>;
export interface UnrealAdapterDependencies { getConfig(): UnrealConfig; isAvailable(name:string):boolean; call(name:string,args:Record<string,unknown>):Promise<unknown>; }
export const defaultUnrealDependencies: UnrealAdapterDependencies={getConfig:getCachedConfig,isAvailable:isAdapterTool,call:callAdapterTool};
export function unrealResultText(value:unknown):string { if(typeof value==='string') return value; const text=JSON.stringify(value); if(text===undefined) throw new Error('Unreal adapter returned no serializable result'); return text; }
export function resolveUnrealAdapter(args:Record<string,unknown>,cfg:UnrealConfig,isAvailable:(name:string)=>boolean):string { if(!cfg.evalEnabled) throw new Error('Unreal tools are disabled (evalEnabled=false)'); const configured=(cfg.mcpServers??[]).filter(s=>s.enabled!==false); const prefixes=configured.map(s=>s.toolsPrefix??s.name); const requested=args.adapter; if(requested!==undefined&&(typeof requested!=='string'||!requested.trim())) throw new Error('adapter must be a non-empty string prefix'); const candidates=typeof requested==='string'?[requested.trim()]:prefixes; for(const prefix of candidates){if(prefixes.filter(p=>p===prefix).length>1) throw new Error('ambiguous Unreal adapter prefix: '+prefix); if(prefixes.includes(prefix)&&isAvailable(prefix+'.execute_python')) return prefix;} throw new Error('no connected Unreal adapter'+(typeof requested==='string'?" for target '"+requested+"'":'')+'; checked: '+(candidates.join(', ')||'(none configured)')); }
function pythonDispatcher(operation:string,args:Record<string,unknown>):string { const payload=JSON.stringify({operation,args}); return "import unreal, json\n"+
"request=json.loads("+JSON.stringify(payload)+")\n"+
"op=request['operation']; args=request['args']\n"+
"out={'ok':False,'operation':op,'warnings':[]}\n"+
"try:\n"+
"  if op=='health': out.update(ok=True,result={'engine_version':unreal.SystemLibrary.get_engine_version(),'editor':True})\n"+
"  elif op=='capabilities': out.update(ok=True,result={'python':True,'asset_registry':True,'geometry_collection':hasattr(unreal,'GeometryCollection'),'version':unreal.SystemLibrary.get_engine_version()})\n"+
"  elif op=='project_info': out.update(ok=True,result={'project_dir':unreal.Paths.project_dir(),'project_name':unreal.Paths.get_project_file_path()})\n"+
"  elif op=='level_snapshot': out.update(ok=True,result={'world':unreal.EditorLevelLibrary.get_editor_world().get_path_name() if unreal.EditorLevelLibrary.get_editor_world() else None})\n"+
"  elif op=='model_create_primitive':\n"+
"    if args.get('dryRun') is True: out.update(ok=True,result={'mode':'dry_run','operation':op,'primitive':args.get('primitive'),'label':args.get('label')})\n"+
"    else:\n"+
"      meshes={'cube':'/Engine/BasicShapes/Cube.Cube','sphere':'/Engine/BasicShapes/Sphere.Sphere','cylinder':'/Engine/BasicShapes/Cylinder.Cylinder','cone':'/Engine/BasicShapes/Cone.Cone','plane':'/Engine/BasicShapes/Plane.Plane'}; mesh=unreal.load_asset(meshes.get(args.get('primitive'))); actor=unreal.EditorLevelLibrary.spawn_actor_from_class(unreal.StaticMeshActor,unreal.Vector(*args.get('location',[0,0,0])),unreal.Rotator(*args.get('rotation',[0,0,0]))); actor.set_actor_label(args.get('label')); actor.static_mesh_component.set_static_mesh(mesh); actor.set_actor_scale3d(unreal.Vector(*args.get('scale',[1,1,1]))); out.update(ok=bool(actor and mesh),result={'actor':actor.get_path_name() if actor else None,'mesh':mesh.get_path_name() if mesh else None})\n"+
"  elif op=='model_transform_actor':\n"+
"    target=str(args.get('actor')); a=next((x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_path_name()==target or x.get_actor_label()==target),None);\n"+
"    if a: a.set_actor_location(unreal.Vector(*args.get('location',[0,0,0])),False,False); a.set_actor_rotation(unreal.Rotator(*args.get('rotation',[0,0,0])),False); a.set_actor_scale3d(unreal.Vector(*args.get('scale',[1,1,1])))\n"+
"    out.update(ok=bool(a),result={'actor':target,'updated':bool(a)})\n"+
"  elif op=='model_delete_actor':\n"+
"    target=str(args.get('actor')); a=next((x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_path_name()==target or x.get_actor_label()==target),None); deleted=bool(a);\n"+
"    if a: a.destroy_actor()\n"+
"    out.update(ok=deleted,result={'actor':target,'deleted':deleted})\n"+
"  elif op=='model_inspect':\n"+
"    if op=='model_inspect_native': out.update(ok=True,result={'backend':'native_cpp','status':'bridge_contract_only','availability':'native_bridge_not_connected'})\n"+
"    asset=unreal.load_asset(args.get('assetPath')) if args.get('assetPath') else None; out.update(ok=bool(asset),result={'path':args.get('assetPath'),'class':asset.get_class().get_name() if asset else None,'materials':None,'availability':{'materials':'ue_python_api_unavailable','lods':'ue_python_api_unavailable','collision':'ue_python_api_unavailable'},'lods':None,'collision':None})\n"+
"  elif op=='model_inspect_actor':\n"+
"    target=str(args.get('actor')); a=next((x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_path_name()==target or x.get_actor_label()==target),None); out.update(ok=bool(a),result={'actor':target,'match':({'path':a.get_path_name(),'label':a.get_actor_label(),'class':a.get_class().get_name(),'location':[a.get_actor_location().x,a.get_actor_location().y,a.get_actor_location().z],'rotation':[a.get_actor_rotation().pitch,a.get_actor_rotation().yaw,a.get_actor_rotation().roll],'scale':[a.get_actor_scale3d().x,a.get_actor_scale3d().y,a.get_actor_scale3d().z],'bounds':({'origin':[a.get_actor_location().x,a.get_actor_location().y,a.get_actor_location().z],'extent':[a.get_actor_bounds(True)[1].x,a.get_actor_bounds(True)[1].y,a.get_actor_bounds(True)[1].z]} if hasattr(a,'get_actor_bounds') else None),'components':[c.get_class().get_name() for c in a.get_components_by_class(unreal.ActorComponent)]} if a else None)})\n"+
"  elif op=='model_assign_material':\n"+
"    target=str(args.get('actor')); mat=unreal.load_asset(args.get('materialPath')); a=next((x for x in unreal.EditorLevelLibrary.get_all_level_actors() if x.get_path_name()==target or x.get_actor_label()==target),None); comp=a.static_mesh_component if a and hasattr(a,'static_mesh_component') else None; assigned=bool(comp and mat);\n"+
"    if assigned: comp.set_material(0,mat)\n"+
"    out.update(ok=assigned,result={'actor':target,'material':args.get('materialPath'),'assigned':assigned})\n"+
"  elif op=='model_batch_create_primitives':\n"+
"    items=args.get('items',[]);\n"+
"    if args.get('dryRun') is True: out.update(ok=True,result={'mode':'dry_run','count':len(items)})\n"+
"    else:\n"+
"      meshes={'cube':'/Engine/BasicShapes/Cube.Cube','sphere':'/Engine/BasicShapes/Sphere.Sphere','cylinder':'/Engine/BasicShapes/Cylinder.Cylinder','cone':'/Engine/BasicShapes/Cone.Cone','plane':'/Engine/BasicShapes/Plane.Plane'}; created=[]\n"+
"      for item in items:\n"+
"        mesh=unreal.load_asset(meshes.get(item.get('primitive'))); a=unreal.EditorLevelLibrary.spawn_actor_from_class(unreal.StaticMeshActor,unreal.Vector(*item.get('location',[0,0,0])),unreal.Rotator(*item.get('rotation',[0,0,0]))); a.set_actor_label(item.get('label')); a.static_mesh_component.set_static_mesh(mesh); a.set_actor_scale3d(unreal.Vector(*item.get('scale',[1,1,1]))); created.append({'label':a.get_actor_label(),'path':a.get_path_name(),'mesh':mesh.get_path_name() if mesh else None})\n"+
"      out.update(ok=len(created)==len(items),result={'created':created})\n"+
"  elif op=='fracture_manifest':\n"+
"    path=args.get('manifestPath'); exists=bool(path and __import__('os').path.exists(path)); data=json.load(open(path,encoding='utf-8')) if exists else None; out.update(ok=True,result={'manifestPath':path,'exists':exists,'manifest':data})\n"+
"  else: out.update(ok=False,error={'code':'UNSUPPORTED_OPERATION','message':'Unsupported Unreal operation: '+op})\n"+
"except Exception as e: out.update(ok=False,error={'code':'UNREAL_PYTHON_ERROR','message':str(e)})\n"+
"print(json.dumps(out,ensure_ascii=False))"; }
export async function callUnrealOperation(operation:string,args:Record<string,unknown>,deps:UnrealAdapterDependencies=defaultUnrealDependencies):Promise<string>{ const prefix=resolveUnrealAdapter(args,deps.getConfig(),deps.isAvailable); const {adapter:_adapter,...params}=args; const text=unrealResultText(await deps.call(prefix+'.execute_python',{python:pythonDispatcher(operation,params)})); try{const parsed=JSON.parse(text) as {ok?:boolean;error?:{message?:string}}; if(parsed.ok===false) throw new Error(parsed.error?.message??'Unreal operation failed');}catch(e){if(e instanceof SyntaxError)return text; throw e;} return text; }