import { callUnrealOperation, type UnrealAdapterDependencies } from './unrealAdapter.js';
export interface UnrealTool { name:string; description:string; inputSchema:Record<string,unknown>; operation:string; }
const ADAPTER={type:'string',minLength:1,description:'Configured Unreal adapter prefix; omit for first available.'};
const TOOLS:UnrealTool[]=[
 {name:'unreal.health',description:'Read Unreal MCP/editor health and connection status.',operation:'health',inputSchema:{type:'object',properties:{}}},
 {name:'unreal.capabilities',description:'List Unreal MCP capabilities and engine version.',operation:'capabilities',inputSchema:{type:'object',properties:{}}},
 {name:'unreal.project.info',description:'Read current Unreal project and editor information.',operation:'project_info',inputSchema:{type:'object',properties:{}}},
 {name:'unreal.level.snapshot',description:'Read the current Unreal level snapshot without modifying the project.',operation:'level_snapshot',inputSchema:{type:'object',properties:{}}},
];
export function getUnrealTools(){return TOOLS.map(t=>({...t,inputSchema:{...t.inputSchema,properties:{...((t.inputSchema.properties??{}) as Record<string,unknown>),adapter:ADAPTER}}}));}
export function isCuratedUnrealTool(name:string){return TOOLS.some(t=>t.name===name);}
export async function runCuratedUnrealTool(name:string,args:Record<string,unknown>,deps?:UnrealAdapterDependencies){const t=TOOLS.find(x=>x.name===name);if(!t)throw new Error('unknown curated Unreal tool: '+name);return callUnrealOperation(t.operation,args,deps);}
export async function callCuratedUnrealMcp(name:string,args:Record<string,unknown>,deps?:UnrealAdapterDependencies){try{return {content:[{type:'text' as const,text:await runCuratedUnrealTool(name,args,deps)}]};}catch(err){return {content:[{type:'text' as const,text:JSON.stringify({error:err instanceof Error?err.message:String(err)})}],isError:true};}}
export async function callCuratedUnrealRpc(id:unknown,name:string,args:Record<string,unknown>,deps?:UnrealAdapterDependencies){try{return {jsonrpc:'2.0',id,result:{content:[{type:'text' as const,text:await runCuratedUnrealTool(name,args,deps)}]}};}catch(err){return {jsonrpc:'2.0',id,error:{code:-32603,message:err instanceof Error?err.message:String(err)}};}}
