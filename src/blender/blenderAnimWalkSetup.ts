import type { BlenderTemplateTool } from './blenderTemplateTools.js';
const q=(v:unknown)=>JSON.stringify(String(v));
const BLENDER_ANIM_WALK_SETUP: BlenderTemplateTool = {
  name: 'blender.anim.walk_setup',
  description: 'Activate Robot_Walk on an armature and configure playback.',
  inputSchema: { type: 'object', properties: { rig:{type:'string'}, action:{type:'string'}, start:{type:'integer'}, end:{type:'integer'}, save:{type:'boolean'}, filepath:{type:'string'} } },
  buildCode(a) {
    const rig=a.rig ? q(a.rig) : 'bpy.context.active_object.name';
    const act=q(a.action || 'Robot_Walk');
    const start=Number.isFinite(Number(a.start)) ? Math.trunc(Number(a.start)) : null;
    const end=Number.isFinite(Number(a.end)) ? Math.trunc(Number(a.end)) : null;
    const save=a.save === true ? 'True' : 'False';
    const path=a.filepath ? q(a.filepath) : 'None';
    return ['import bpy, json','rig=bpy.data.objects.get('+rig+')','if rig is None or rig.type != "ARMATURE": raise RuntimeError("armature rig not found")','act=bpy.data.actions.get('+act+')','if act is None: raise RuntimeError("action not found")','start=int('+(start===null ? 'act.frame_start' : String(start))+'); end=int('+(end===null ? 'act.frame_end' : String(end))+')','if end < start: raise RuntimeError("invalid frame range")','rig.animation_data_create(); rig.animation_data.action=act','scene=bpy.context.scene; scene.frame_start=start; scene.frame_end=end; scene.frame_set(start)','saved=False','if '+save+':\n bpy.ops.wm.save_as_mainfile(filepath='+path+'); saved=True','result={"rig":rig.name,"action":act.name,"start":start,"end":end,"frame":scene.frame_current,"saved":saved}','print(json.dumps(result,ensure_ascii=False))'].join('\n');
  }
};
export function getBlenderWalkTools(): BlenderTemplateTool[] { return [BLENDER_ANIM_WALK_SETUP]; }
export function isBlenderWalkTool(n:string): boolean { return n === BLENDER_ANIM_WALK_SETUP.name; }
export function runBlenderWalkTool(n:string,a:Record<string,unknown>,exec:(c:string)=>Promise<string>) { if(!isBlenderWalkTool(n)) throw new Error('unknown Blender walk tool'); return exec(BLENDER_ANIM_WALK_SETUP.buildCode(a)); }