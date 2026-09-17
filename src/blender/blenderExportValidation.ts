import { BLENDER_ACTION_COMPAT } from './blenderActionCompat.js';

export interface BlenderExportValidationTool { name: string; description: string; inputSchema: Record<string, unknown>; buildCode(args: Record<string, unknown>): string; }
const py = (v: unknown) => JSON.stringify(String(v));
const scan = () => [
'import bpy, json',
BLENDER_ACTION_COMPAT,
'objs = sorted(list(bpy.context.scene.objects), key=lambda o: o.name)',
'meshes = [{"name":o.name,"data":o.data.name,"vertices":len(o.data.vertices),"edges":len(o.data.edges),"polygons":len(o.data.polygons),"materials":[m.name if m else None for m in o.data.materials]} for o in objs if o.type=="MESH"]',
'armatures = [{"name":o.name,"data":o.data.name,"bone_count":len(o.data.bones),"bones":[b.name for b in sorted(o.data.bones,key=lambda b:b.name)]} for o in objs if o.type=="ARMATURE"]',
'actions = [{"name":a.name,"frame_start":float(a.frame_start),"frame_end":float(a.frame_end),"fcurves":len(action_fcurves(a))} for a in sorted(bpy.data.actions,key=lambda a:a.name)]',
'uvs = [{"mesh":o.name,"layers":[u.name for u in o.data.uv_layers],"active":o.data.uv_layers.active.name if o.data.uv_layers.active else None} for o in objs if o.type=="MESH"]',
'materials = [{"name":m.name,"use_nodes":bool(m.use_nodes),"users":int(m.users)} for m in sorted(bpy.data.materials,key=lambda m:m.name)]',
'result = {"schema":"blender.export.manifest.v1","scene":bpy.context.scene.name,"meshes":meshes,"armatures":armatures,"actions":actions,"uvs":uvs,"materials":materials}',
'print(json.dumps(result,ensure_ascii=False,sort_keys=True))'
].join('\n');
const MANIFEST: BlenderExportValidationTool = { name:'blender.export.manifest', description:'Scan mesh, armature, actions, UV layers and materials before export.', inputSchema:{type:'object',properties:{}}, buildCode:() => scan() + '\nprint("DONE — export manifest generated")' };
const COMPARE: BlenderExportValidationTool = { name:'blender.export.compare_manifest', description:'Compare expected manifest JSON with the current Blender scan.', inputSchema:{type:'object',properties:{expected:{type:'string'}},required:['expected']}, buildCode(args) { if(typeof args.expected !== 'string' || !args.expected.trim()) throw new Error('expected JSON string is required'); const e=py(args.expected); return scan() + '\nexpected=json.loads(' + e + ')\n' +
'def diff(a,b,p=""):\n c=[]\n if isinstance(a,dict) and isinstance(b,dict):\n  for k in sorted(set(a)|set(b)):\n   q=(p+"."+k) if p else k\n   if k not in a: c.append({"path":q,"kind":"unexpected","current":b[k]})\n   elif k not in b: c.append({"path":q,"kind":"missing","expected":a[k]})\n   else: c.extend(diff(a[k],b[k],q))\n elif a!=b: c.append({"path":p,"kind":"changed","expected":a,"current":b})\n return c\nchanges=diff(expected,result)\nprint(json.dumps({"matches":not changes,"differences":changes,"difference_count":len(changes),"expected":expected,"current":result},ensure_ascii=False,sort_keys=True))\nprint("DONE — export manifest comparison complete")'; } };
const TOOLS=[MANIFEST,COMPARE];
export function getBlenderExportValidationTools(){ return TOOLS; }
export function isBlenderExportValidationTool(name:string){ return TOOLS.some(t=>t.name===name); }
export async function runBlenderExportValidationTool(name:string,args:Record<string,unknown>,execute:(code:string)=>Promise<string>){ const t=TOOLS.find(x=>x.name===name); if(!t) throw new Error('unknown Blender export validation tool: '+name); return execute(t.buildCode(args)); }