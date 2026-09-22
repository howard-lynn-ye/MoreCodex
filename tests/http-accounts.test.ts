import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { defaultConfig } from "../src/config";
import { forwardHttpAccountRequest, httpAccountCredentials, httpAccountModels, inspectHttpAccount, type HttpAccount } from "../src/http-accounts";
import { compactRequest, modelsRequest, responseRequest } from "../src/server";

const roots: string[] = [];
afterEach(()=>{ for (const root of roots.splice(0)) {
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('http-accounts-')) throw Error('Unsafe test cleanup target');
  rmSync(root,{recursive:true,force:true});
} });
const jwt=(body:any)=>`header.${Buffer.from(JSON.stringify(body)).toString('base64url')}.signature`;
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'http-accounts-')); roots.push(root);
  const config=defaultConfig('browser-only');config.httpOnly=true;config.httpAccountsFile=join(root,'accounts.json');
  const accounts:HttpAccount[]=['alpha','beta','gamma'].map(id=>({id,label:id.toUpperCase(),provider:'codex',enabled:true,
    credentialFile:join(root,`${id}.json`),accountId:`workspace-${id}`,email:`${id}@example.test`,
    models:[{id:'gpt-6-astra',catalog:{slug:'gpt-6-astra',display_name:'GPT-6 Astra',visibility:'list',tool_mode:'function',supported_reasoning_levels:[]}}]}));
  const saveAuth=(index:number,user=accounts[index]!.id)=>writeFileSync(accounts[index]!.credentialFile,JSON.stringify({auth_mode:'chatgpt',tokens:{
    account_id:`workspace-${user}`,access_token:`test-token-${user}`,id_token:jwt({email:`${user}@example.test`})}}));
  const save=()=>writeFileSync(config.httpAccountsFile!,JSON.stringify({version:1,accounts}));
  accounts.forEach((_,i)=>saveAuth(i));save();
  return {root,config,accounts,save,saveAuth};
}
const request=(signal?:AbortSignal)=>new Request('http://127.0.0.1/v1/responses',{method:'POST',headers:{authorization:'Bearer desktop-BETA',cookie:'private-cookie','chatgpt-account-id':'desktop-BETA','openai-project':'wrong-project'},body:'{}',signal});
const body=(id='alpha')=>({model:`account-http/${id}/gpt-6-astra`,input:[{role:'user',content:'hello'}],stream:false});
const done=(id='r-test')=>Response.json({id,object:'response',model:'gpt-6-astra',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'OK'}]}]});

test('all three labels use independent fixed authentication despite desktop account switches',async()=>{
  const {config}=fixture();
  expect(httpAccountModels(config).map(m=>m.display_name)).toEqual(['GPT-6 Astra · ALPHA · Codex','GPT-6 Astra · BETA · Codex','GPT-6 Astra · GAMMA · Codex']);
  for(const id of ['alpha','beta','gamma']) {
    const result=await forwardHttpAccountRequest(request(),config,body(id),'responses',async req=>{
      expect(req.url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(req.headers.get('authorization')).toBe(`Bearer test-token-${id}`);
      expect(req.headers.get('chatgpt-account-id')).toBe(`workspace-${id}`);
      expect(req.headers.get('cookie')).toBeNull();expect(req.headers.get('openai-project')).toBeNull();
      expect(req.redirect).toBe('error');expect((await req.json() as any).model).toBe('gpt-6-astra');return done(`r-${id}`);
    });
    expect((await result.json() as any).model).toBe(body(id).model);
  }
});
test('replaced or missing account credential never falls back and leaves other accounts usable',async()=>{
  const {config,saveAuth}=fixture();saveAuth(0,'beta');
  expect(httpAccountModels(config)).toHaveLength(2);
  let called=false;
  await expect(forwardHttpAccountRequest(request(),config,body(),'responses',async()=>{called=true;return done();})).rejects.toThrow('fixed binding');
  expect(called).toBe(false);
  expect((await forwardHttpAccountRequest(request(),config,body('gamma'),'responses',async()=>done())).status).toBe(200);
});
test('streaming retains chunked Unicode and rewrites the response model',async()=>{
  const {config}=fixture();const text='data: '+JSON.stringify({type:'response.output_text.delta',delta:'通过🙂'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{id:'r-stream',model:'gpt-6-astra',status:'completed',output:[]}})+'\n\ndata: [DONE]\n\n';
  const bytes=new TextEncoder().encode(text);
  const response=await forwardHttpAccountRequest(request(),config,{...body(),stream:true},'responses',async()=>new Response(new ReadableStream({start(c){for(const byte of bytes)c.enqueue(new Uint8Array([byte]));c.close();}}),{headers:{'content-type':'text/event-stream'}}));
  const output=await response.text();expect(output).toContain('通过🙂');expect(output).toContain('account-http/alpha/gpt-6-astra');expect(output).toContain('[DONE]');
});

test('Codex SSE without Content-Type is aggregated for ordinary requests and truncated streams fail',async()=>{
  const {config}=fixture();
  const makeStream=(completed:boolean)=>new Response(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'+(completed?'data: '+JSON.stringify({type:'response.completed',response:{id:'r-headerless',model:'gpt-6-astra',status:'completed',output:[]}})+'\n\n':'')));
  const response=await forwardHttpAccountRequest(request(),config,body(),'responses',async req=>{expect((await req.json() as any).stream).toBe(true);return makeStream(true);});
  expect(response.headers.get('content-type')).toContain('application/json');
  expect((await response.json() as any).model).toBe(body().model);
  await expect(forwardHttpAccountRequest(request(),config,body(),'responses',async()=>makeStream(false))).rejects.toThrow('before completion');
});

test('Codex terminal events that omit output are completed from actual output-item events',async()=>{
  const {config}=fixture();
  const events=[{type:'response.output_item.done',output_index:0,item:{type:'message',content:[{type:'output_text',text:'verified answer'}]}},
    {type:'response.completed',response:{id:'r-omitted',model:'gpt-6-astra',status:'completed',output:[]}}];
  const response=await forwardHttpAccountRequest(request(),config,body(),'responses',async()=>new Response(new TextEncoder().encode(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''))));
  expect((await response.json() as any).output[0].content[0].text).toBe('verified answer');
});
test('compaction and previous response ownership persist on disk and reject cross-account reuse',async()=>{
  const {config}=fixture();
  await forwardHttpAccountRequest(request(),config,body(),'responses/compact',async req=>{
    expect(req.url).toEndWith('/responses');expect((await req.json() as any).input.at(-1)).toEqual({type:'compaction_trigger'});return Response.json({id:'cmp-alpha',status:'completed',output:[{type:'compaction',encrypted_content:'OPAQUE_ALPHA'}]});
  });
  expect(readFileSync(config.httpAccountsFile!+'.response-owners.json','utf8')).not.toContain('OPAQUE_ALPHA');
  const continuation={...body(),input:[{type:'compaction',encrypted_content:'OPAQUE_ALPHA'}]};
  expect((await forwardHttpAccountRequest(request(),config,continuation,'responses',async()=>done())).status).toBe(200);
  await expect(forwardHttpAccountRequest(request(),config,{...continuation,model:body('beta').model},'responses',async()=>done())).rejects.toThrow('another or unverified account');
});
test('HTTP cancellation reaches upstream and does not dispatch a replacement request',async()=>{
  const {config}=fixture();const abort=new AbortController();let calls=0;
  const running=forwardHttpAccountRequest(request(abort.signal),config,body(),'responses',req=>new Promise((_resolve,reject)=>{calls++;req.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true});}));
  abort.abort();await expect(running).rejects.toThrow('cancelled');expect(calls).toBe(1);
});
test('API route pins credential, strips Codex-only fields, preserves tools and selects its own Tunnel',async()=>{
  const {config,accounts,save}=fixture();const account=accounts[0]!;account.provider='api';
  writeFileSync(account.credentialFile,'sk-private-test-key');account.credentialSha256=createHash('sha256').update('sk-private-test-key').digest('hex');
  account.projectId='proj_alpha';account.tunnelId='tunnel_0123456789abcdef0123456789abcdef';save();
  const raw={...body(),prompt_cache_key:'test',codex_internal_field:'remove',tools:[{type:'function',name:'read_file',parameters:{type:'object'}}]};
  await forwardHttpAccountRequest(request(),config,raw,'responses',async req=>{
    expect(req.url).toBe('https://api.openai.com/v1/responses');expect(req.headers.get('chatgpt-account-id')).toBeNull();expect(req.headers.get('openai-project')).toBe('proj_alpha');
    const value=await req.json() as any;expect(value.codex_internal_field).toBeUndefined();expect(value.tools).toHaveLength(2);expect(value.tools[1].tunnel_id).toBe(account.tunnelId);return done();
  });
  writeFileSync(account.credentialFile,'sk-different-account');expect(()=>httpAccountCredentials(account)).toThrow('changed');
});
test('upstream failures are account-specific and do not expose raw secrets or retry',async()=>{
  const {config}=fixture();let calls=0;
  await expect(forwardHttpAccountRequest(request(),config,body(),'responses',async()=>{calls++;return new Response('secret error payload',{status:401});})).rejects.toThrow('ALPHA codex: upstream returned HTTP 401');expect(calls).toBe(1);
});

test('expiry affects only its account and a shared workspace cannot share opaque continuation',async()=>{
  const {config,accounts,save}=fixture();
  const alphaAuth=JSON.parse(readFileSync(accounts[0]!.credentialFile,'utf8'));
  alphaAuth.tokens.access_token=jwt({exp:Math.floor(Date.now()/1000)-60});
  writeFileSync(accounts[0]!.credentialFile,JSON.stringify(alphaAuth));
  expect(()=>httpAccountCredentials(accounts[0]!)).toThrow('expired');
  expect(httpAccountModels(config).map(model=>model.slug)).toEqual([body('beta').model,body('gamma').model]);
  alphaAuth.tokens.access_token='test-token-alpha';writeFileSync(accounts[0]!.credentialFile,JSON.stringify(alphaAuth));
  accounts[1]!.accountId=accounts[0]!.accountId;save();
  const betaAuth=JSON.parse(readFileSync(accounts[1]!.credentialFile,'utf8'));betaAuth.tokens.account_id=accounts[0]!.accountId;
  writeFileSync(accounts[1]!.credentialFile,JSON.stringify(betaAuth));
  await forwardHttpAccountRequest(request(),config,body(),'responses',async()=>Response.json({id:'shared-workspace',status:'completed',output:[{type:'reasoning',encrypted_content:'same-workspace-private-context'}]}));
  const continuation={...body('beta'),input:[{type:'reasoning',encrypted_content:'same-workspace-private-context'}]};
  await expect(forwardHttpAccountRequest(request(),config,continuation,'responses',async()=>done())).rejects.toThrow('another or unverified account');
});
test('HTTP-only server rejects all browser inference and compaction before adapter creation',async()=>{
  const {config}=fixture();
  for(const handler of [responseRequest,compactRequest]) {
    const req=new Request('http://localhost/v1/responses',{method:'POST',body:JSON.stringify({...body(),model:'chatgpt-web/pro'})});
    const response=await handler(req,config,()=>{throw Error('browser must never be created');});expect(response.status).toBe(409);
  }
});
test('account catalogue remains available when the current desktop login cannot list native models',async()=>{
  const {config}=fixture();const response=await modelsRequest(request(),config,async()=>new Response('Unauthorized',{status:401}));
  expect((await response.json() as any).models).toHaveLength(3);
});
test('catalogue inspection authenticates independently without changing files',async()=>{
  const {accounts}=fixture();const prior=readFileSync(accounts[1]!.credentialFile,'utf8');
  const result=await inspectHttpAccount(accounts[1]!,async req=>{expect(req.headers.get('authorization')).toBe('Bearer test-token-beta');return Response.json({models:[{slug:'gpt-6-astra'}]});});
  expect(result.models).toHaveLength(1);expect(readFileSync(accounts[1]!.credentialFile,'utf8')).toBe(prior);
});
