import { httpAccountCredentials, HttpAccountError, inspectHttpAccount, readHttpAccounts } from "./http-accounts";
import { loadConfig } from "./config";

/** No browser or login flow is started by these commands. */
export async function httpAccountCommand(args: string[]): Promise<void> {
  const action=args.shift()??'status';
  if(!['status','check'].includes(action)||args.length) throw Error('Use http-accounts status or http-accounts check');
  const accounts=readHttpAccounts(loadConfig())?.accounts??[];
  const results=[];
  for(const account of accounts){
    try{
      httpAccountCredentials(account);
      const catalog=action==='check'?await inspectHttpAccount(account):undefined;
      results.push({id:account.id,label:account.label,provider:account.provider,enabled:account.enabled,status:catalog?'catalogue-reachable':'credential-bound',models:catalog?.models.map((model:any)=>model.slug??model.id)??account.models.map(model=>model.id)});
    }catch(error){results.push({id:account.id,label:account.label,provider:account.provider,enabled:account.enabled,status:error instanceof HttpAccountError?error.code:'account_check_failed',message:error instanceof HttpAccountError?error.message:'Account check failed'});}
  }
  process.stdout.write(JSON.stringify({accounts:results,browserUsed:false},null,2)+'\n');
}
