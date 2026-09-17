import { callUnrealOperation, type UnrealAdapterDependencies } from './unrealAdapter.js';
export interface UnrealAssetTool { name:string; description:string; operation:string; inputSchema:Record<string,unknown>; }
const A={type:'string',minLength:1,description:'Configured Unreal adapter prefix.'};
const TOOLS:UnrealAssetTool[]=[
{name:'unreal.asset.manifest',description:'Read a structured Unreal asset manifest without modifying assets.',operation:'asset_manifest',inputSchema:{type:'object',properties:{assetPath:{type:'string'},rootPath:{type:'string'}}}},
{name:'unreal.asset.import_status',description:'Read the status of an Unreal asset import job.',operation:'asset_import_status',inputSchema:{type:'object',properties:{jobId:{type:'string'},assetPath:{type:'string'}}}},
{name:'unreal.asset.validate',description:'Validate an Unreal asset for mesh, skeleton, materials and animation requirements.',operation:'asset_validate',inputSchema:{type:'object',properties:{assetPath:{type:'string'},kind:{type:'string'}}}},
{name:'unreal.job.status',description:'Read an asynchronous Unreal MCP job status.',operation:'job_status',inputSchema:{type:'object',properties:{jobId:{type:'string'}},required:['jobId']}},
{name:'unreal.job.wait',description:'Wait for an asynchronous Unreal MCP job.',operation:'job_wait',inputSchema:{type:'object',properties:{jobId:{type:'string'},timeoutMs:{type:'number'}},required:['jobId']}}
];
export function getUnrealAssetTools(){return TOOLS.map(t=>({...t,inputSchema:{...t.inputSchema,properties:{...((t.inputSchema.properties??{}) as Record<string,unknown>),adapter:A}}}));}
export function isUnrealAssetTool(n:string){return TOOLS.some(t=>t.name===n);}
export async function runUnrealAssetTool(n:string,args:Record<string,unknown>,deps?:UnrealAdapterDependencies){const t=TOOLS.find(x=>x.name===n);if(!t)throw new Error('unknown Unreal asset tool: '+n);return callUnrealOperation(t.operation,args,deps);}
