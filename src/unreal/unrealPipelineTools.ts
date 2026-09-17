import { callUnrealOperation, type UnrealAdapterDependencies } from './unrealAdapter.js';
export interface UnrealPipelineTool{name:string;description:string;operation:string;inputSchema:Record<string,unknown>;}
const A={type:'string',minLength:1,description:'Configured Unreal adapter prefix.'};
const TOOLS:UnrealPipelineTool[]=[
{name:'unreal.pipeline.validate',description:'Validate the Unreal project pipeline without claiming engine import success.',operation:'pipeline_validate',inputSchema:{type:'object',properties:{assetPath:{type:'string'},levelPath:{type:'string'},expected:{type:'string'},dryRun:{type:'boolean'}}}},
{name:'unreal.pipeline.compare_manifest',description:'Compare an expected Unreal manifest with the current project state.',operation:'pipeline_compare_manifest',inputSchema:{type:'object',properties:{expected:{type:'string'}},required:['expected']}},
{name:'unreal.pipeline.smoke_test',description:'Run a bounded Unreal MCP smoke test and return job status.',operation:'pipeline_smoke_test',inputSchema:{type:'object',properties:{assetPath:{type:'string'},levelPath:{type:'string'},timeoutMs:{type:'number'},dryRun:{type:'boolean'}}}},
{name:'unreal.pipeline.snapshot',description:'Capture a read-only Unreal project and level snapshot.',operation:'pipeline_snapshot',inputSchema:{type:'object',properties:{rootPath:{type:'string'},levelPath:{type:'string'}}}}
];
export function getUnrealPipelineTools(){return TOOLS.map(t=>({...t,inputSchema:{...t.inputSchema,properties:{...((t.inputSchema.properties??{}) as Record<string,unknown>),adapter:A}}}));}
export async function runUnrealPipelineTool(n:string,args:Record<string,unknown>,deps?:UnrealAdapterDependencies){const t=TOOLS.find(x=>x.name===n);if(!t)throw new Error('unknown Unreal pipeline tool: '+n);return callUnrealOperation(t.operation,args,deps);}
