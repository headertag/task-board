import vinext from "vinext";
import { defineConfig } from "vite";
import hosting from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";
export default defineConfig(async()=>{
 process.env.CLOUDFLARE_CF_FETCH_ENABLED??="false";
 process.env.WRANGLER_SEND_METRICS??="false";
 const { cloudflare }=await import("@cloudflare/vite-plugin");
 return {plugins:[vinext(),sites({mockAuth:true}),cloudflare({viteEnvironment:{name:"rsc",childEnvironments:["ssr"]},inspectorPort:false,config:{main:"./build/sites-worker.ts",compatibility_flags:["nodejs_compat"],d1_databases:hosting.d1?[{binding:hosting.d1,database_name:"task-board-local",database_id:"00000000-0000-4000-8000-000000000000"}]:[]}})]};
});
