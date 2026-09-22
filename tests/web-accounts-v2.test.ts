import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { modelsRequest, responseRequest } from "../src/server";
import { mergeDiscoveredModels } from "../src/web-account-cli";
import { resolveWebAccountModel, webModelId, type WebAccount } from "../src/web-accounts";
import { responseModelSlugs } from "../src/web-model-guard";
import { saveWebAccountRegistry } from "../src/web-account-store";
const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const native={models:[{slug:"native-template",display_name:"Native",priority:0,visibility:"list",supported_in_api:true,
  supported_reasoning_levels:[{effort:"high",description:"High"}],tool_mode:"tool_namespace",context_window:200000}]};
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"web-v2-"));roots.push(root);const config=defaultConfig("browser-only");config.webAccountsFile=join(root,"accounts.json");
  const accounts:WebAccount[]=Array.from({length:4},(_,index)=>({id:`account-${index}`,label:`Alias ${index}`,email:`test${index}@example.test`,enabled:true,
    solAvailable:true,proAvailable:true,browserHostDescriptorPath:join(root,`${index}/runtime/browser.json`),sessionHome:join(root,String(index)),
    userId:`user-${index}`,accountId:`workspace-${index}`,catalogIdentity:{userId:`user-${index}`,accountId:`workspace-${index}`},catalogVerifiedAt:new Date().toISOString(),
    models:[{slug:`actual-${index}`,title:`Actual title ${index}`,available:true,adapterRoute:"chatgpt-web/pro"}]}));
  const template=join(root,"native.json");writeFileSync(template,JSON.stringify(native));
  const save=()=>writeFileSync(config.webAccountsFile!,JSON.stringify({version:2,accounts,nativeCatalogFile:template}));save();return{accounts,config,save};
}
test("dynamic account/model catalogue uses observed names, and rename preserves stable IDs",()=>{
  const {accounts,config,save}=fixture();const before=accounts.map(a=>webModelId(a,a.models![0]!));
  expect((augmentNativeModelCatalog(native,config).models as any[]).slice(1).map(row=>row.display_name)).toEqual(accounts.map(a=>`${a.models![0]!.title} ${a.label}`));
  accounts[0]!.label="大学账号";accounts[0]!.models![0]!.title="New upstream title";save();expect(webModelId(accounts[0]!,accounts[0]!.models![0]!)).toBe(before[0]!);
  expect(new Set(before).size).toBe(4);
});
test("changing workspace does not inherit a prior model ID or prior availability proof",()=>{
  const {accounts,config,save}=fixture(),account=accounts[0]!,old=webModelId(account,account.models![0]!);account.accountId="different-workspace";save();
  expect((augmentNativeModelCatalog(native,config).models as any[]).some(row=>row.slug===old)).toBe(false);
  expect(()=>resolveWebAccountModel(old,config)).toThrow("No fallback");
});
test("unavailable and unmapped discoveries are not advertised, rediscovery drops revoked models",()=>{
  const {accounts,config,save}=fixture();const account=accounts[0]!;
  account.models=mergeDiscoveredModels(account,[{slug:"unmapped",title:"New",available:true}]);save();
  expect((augmentNativeModelCatalog(native,config).models as any[]).filter(row=>row.slug.startsWith("chatgpt-web/account-0/"))).toHaveLength(0);
});
test("native authentication/network failure preserves independent Web catalogue",async()=>{
  const {config}=fixture();
  const denied=await modelsRequest(new Request("http://127.0.0.1/v1/models"),config,async()=>new Response(null,{status:401}));
  const offline=await modelsRequest(new Request("http://127.0.0.1/v1/models"),config,async()=>{throw Error("offline");});
  expect(denied.status).toBe(200);expect(await denied.json()).toEqual(await offline.json());
});
test("exact public selection binds account/model independently of Codex authorization",async()=>{
  const {config,accounts}=fixture();const account=accounts[2]!,id=webModelId(account,account.models![0]!);let captured:any;
  const result=await responseRequest(new Request("http://127.0.0.1/v1/responses",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer unrelated-codex-login"},body:JSON.stringify({model:id,input:"hello",stream:false})}),config,provider=>{captured=provider;return{name:"test",async runTurn(_parsed:any,_request:any,emit:any){emit({type:"text_delta",text:"ok"});emit({type:"done",stopReason:"stop",endTurn:true});}};});
  expect(result.status).toBe(200);expect(captured.chatgptWeb.modelBinding).toEqual({accountId:account.id,publicModelId:id,webModelSlug:account.models![0]!.slug});
  expect(captured.chatgptWeb.accountIdentity.userId).toBe(account.userId);
});
test("Web SSE evidence parses full metadata and incremental patches",()=>{
  expect(responseModelSlugs({message:{metadata:{model_slug:"actual"}}})).toEqual(["actual"]);
  expect(responseModelSlugs({p:"/message/metadata/model_slug",v:"different"})).toEqual(["different"]);
});

test("full mode cannot inherit another account's default Tunnel",()=>{
  const {config,accounts}=fixture(),account=accounts[0]!;config.mode="full";
  expect(()=>resolveWebAccountModel(webModelId(account,account.models![0]!),config)).toThrow("Another account's tool channel will not be used");
});

test("existing-browser routes retain enrolled identity across model selection without a launcher fallback",()=>{
  const {config,accounts,save}=fixture(),account=accounts[1]!;
  account.externalBrowser={userDataDir:join(roots.at(-1)!,"Chrome User Data")};save();
  const selected=resolveWebAccountModel(webModelId(account,account.models![0]!),config);
  expect(selected.config.browserHost).toBe("external-cdp");
  expect(selected.config.browserHostDescriptorPath).toBeUndefined();
  expect(selected.config.externalBrowser).toEqual({...account.externalBrowser,email:account.email,userId:account.userId,accountId:account.accountId});
  expect(selected.config.webModelBinding?.publicModelId).toBe(webModelId(account,account.models![0]!));
  expect(selected.config.webAccountIdentity?.accountId).toBe(account.accountId!);
});

test("a browser path is not identity evidence and an external source must be absolute",()=>{
  const {config,accounts,save}=fixture(),account=accounts[1]!;
  account.externalBrowser={userDataDir:"Profile 11"};save();
  expect(()=>resolveWebAccountModel(webModelId(account,account.models![0]!),config)).toThrow("existing-browser");
  account.externalBrowser.userDataDir=join(roots.at(-1)!,"Chrome User Data");delete account.catalogIdentity;save();
  expect(()=>resolveWebAccountModel(webModelId(account,account.models![0]!),config)).toThrow("No fallback");
});

test("a broken catalogue cannot leave an edited account registry behind",()=>{
  const {config}=fixture(),file=config.webAccountsFile!,before=readFileSync(file,"utf8"),registry=JSON.parse(before);
  registry.accounts[0].label="Renamed";registry.catalogOutputFile=join(roots.at(-1)!,"export.json");
  writeFileSync(registry.nativeCatalogFile,"invalid JSON");
  expect(()=>saveWebAccountRegistry(file,before,registry,config)).toThrow();
  expect(readFileSync(file,"utf8")).toBe(before);expect(existsSync(file+".lock")).toBe(false);
});

test("CLI edits refresh exported names and reject stale concurrent writes",()=>{
  const {config}=fixture(),file=config.webAccountsFile!,before=readFileSync(file,"utf8"),registry=JSON.parse(before);
  registry.accounts[0].label="大学账号";registry.catalogOutputFile=join(roots.at(-1)!,"export.json");
  saveWebAccountRegistry(file,before,registry,config);
  const updated=readFileSync(file,"utf8");
  expect(JSON.parse(readFileSync(registry.catalogOutputFile,"utf8")).models.some((m:any)=>m.display_name==="Actual title 0 大学账号")).toBe(true);
  expect(()=>saveWebAccountRegistry(file,before,registry,config)).toThrow("changed concurrently");
  expect(readFileSync(file,"utf8")).toBe(updated);
});
