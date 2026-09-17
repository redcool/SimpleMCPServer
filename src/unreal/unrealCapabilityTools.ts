import { callUnrealOperation, type UnrealAdapterDependencies } from './unrealAdapter.js';
export interface UnrealCapabilityTool{name:string;description:string;operation:string;inputSchema:Record<string,unknown>;write:boolean;}
const A={type:'string',minLength:1,description:'Configured Unreal adapter prefix.'}; const confirm={type:'boolean',description:'Required for destructive operations.'};
const TOOLS:UnrealCapabilityTool[]=[
{name:'unreal.level.open',description:'Open an Unreal level.',operation:'level_open',write:true,inputSchema:{type:'object',properties:{levelPath:{type:'string'},dryRun:{type:'boolean'},confirm}}},
{name:'unreal.level.save',description:'Save the current Unreal level.',operation:'level_save',write:true,inputSchema:{type:'object',properties:{dryRun:{type:'boolean'},confirm}}},
{name:'unreal.actor.spawn',description:'Spawn an actor in the current Unreal level.',operation:'actor_spawn',write:true,inputSchema:{type:'object',properties:{classPath:{type:'string'},label:{type:'string'},location:{type:'array'},rotation:{type:'array'},dryRun:{type:'boolean'},confirm}}},
{name:'unreal.actor.transform',description:'Transform an actor in the current Unreal level.',operation:'actor_transform',write:true,inputSchema:{type:'object',properties:{actor:{type:'string'},location:{type:'array'},rotation:{type:'array'},scale:{type:'array'},dryRun:{type:'boolean'},confirm}}},
{name:'unreal.material.inspect',description:'Inspect an Unreal material.',operation:'material_inspect',write:false,inputSchema:{type:'object',properties:{materialPath:{type:'string'}}}},
{name:'unreal.animation.list',description:'List Unreal animation assets.',operation:'animation_list',write:false,inputSchema:{type:'object',properties:{rootPath:{type:'string'}}}},
{name:'unreal.animation.play',description:'Play an animation asset in the current Unreal editor context.',operation:'animation_play',write:true,inputSchema:{type:'object',properties:{animationPath:{type:'string'},dryRun:{type:'boolean'},confirm}}}
];
export function getUnrealCapabilityTools(){return TOOLS.map(t=>({...t,inputSchema:{...t.inputSchema,properties:{...((t.inputSchema.properties??{}) as Record<string,unknown>),adapter:A}}}));}
export async function runUnrealCapabilityTool(n:string,args:Record<string,unknown>,deps?:UnrealAdapterDependencies){const t=TOOLS.find(x=>x.name===n);if(!t)throw new Error('unknown Unreal capability tool: '+n);if(t.write && args.dryRun!==true && args.confirm!==true)throw new Error('write operation requires confirm=true or dryRun=true');return callUnrealOperation(t.operation,args,deps);}
