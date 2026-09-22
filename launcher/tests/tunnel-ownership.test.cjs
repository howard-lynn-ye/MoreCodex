const test=require('node:test');
const assert=require('node:assert/strict');
const {RuntimeSupervisor,managedTunnelConnectArgs}=require('../electron/runtime-supervisor.cjs');
function fixture(){
  const config={mode:'full',brokerSocketPath:'\\\\.\\pipe\\acceptance-current',tunnel:{alias:'current',tunnelId:'same-remote-tunnel'}};
  const invocation={executable:'C:\\runtime\\bun.exe',args:['C:\\runtime\\cli.js','mcp','--contract','native','--broker-socket',config.brokerSocketPath]};
  const args=managedTunnelConnectArgs(config,invocation);
  const supervisor=new RuntimeSupervisor({app:{isPackaged:false},logger:{info(){},warn(){},error(){}},sourceRoot:process.cwd(),coreHome:process.cwd(),browserDescriptorPath:'descriptor',runtimeInvocationFactory:()=>invocation});
  const entry={alias:'current',runtime_state:'ready',live_runtime:{found:true,match_reason:'control_plane_tunnel_id',base_url:'http://127.0.0.1:17890',status:{control_plane_tunnel_id:'same-remote-tunnel',channels:[{name:'main',details:[{key:'command',value:args[args.indexOf('--mcp-command')+1]}]}]}}};
  supervisor.runTunnelCommand=async()=>({code:0,output:JSON.stringify({entries:[entry]})});
  return {config,supervisor,entry};
}
test('same remote Tunnel ID cannot make a different local broker ready',async()=>{
  const {config,supervisor,entry}=fixture();
  entry.live_runtime.status.channels[0].details[0].value=entry.live_runtime.status.channels[0].details[0].value.replace('acceptance-current','old-validation');
  const result=await supervisor.readTunnelHealth(config);
  assert.equal(result.ready,false);assert.equal(result.ownershipConflict,true);assert.equal(supervisor.tunnelHealthBaseUrl,null);
});
test('verified command and Tunnel binding can be adopted without a reported PID',async()=>{
  const {config,supervisor}=fixture();
  assert.equal((await supervisor.readTunnelHealth(config)).ready,true);
  assert.equal(supervisor.tunnelHealthBaseUrl,'http://127.0.0.1:17890');
});
test('startup refuses a foreign runtime without issuing stop or connect',async()=>{
  const {config,supervisor,entry}=fixture();
  entry.live_runtime.status.control_plane_tunnel_id='other-tunnel';
  supervisor.assertTunnelClientReady=()=>{};
  supervisor.runTunnelStopCommand=async()=>assert.fail('must not stop another installation');
  supervisor.runTunnelConnectCommand=async()=>assert.fail('must not start competing pollers');
  await assert.rejects(supervisor.startTunnel(config),/ownership could not be verified/);
});
test('unobserved runtime marked ready does not establish ownership',async()=>{
  const {config,supervisor,entry}=fixture();entry.live_runtime={found:false};
  assert.equal((await supervisor.readTunnelHealth(config)).ready,false);
});
test('shutdown does not adopt another broker to stop it',async()=>{
  const {config,supervisor,entry}=fixture();
  entry.live_runtime.status.control_plane_tunnel_id='other-tunnel';
  await assert.rejects(supervisor.adoptConfiguredTunnelForStop(config),/ownership could not be verified/);
  assert.equal(supervisor.tunnel,null);
});
