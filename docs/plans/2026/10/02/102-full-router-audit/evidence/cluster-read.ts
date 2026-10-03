import { kubectl } from '../../../../../../../../infrastructure/scripts/lib/k8s/kubectl.ts'
async function k(args:string[]) {const r=await kubectl(args,{timeoutMs:45000});if(r.exitCode)throw new Error(r.stderr);return r.stdout}
const mode=process.argv[2]
if(mode==='db') {
 const p=JSON.parse(await k(['get','pods','-n','postgres','-l','cnpg.io/cluster=postgres,cnpg.io/instanceRole=primary','-o','json'])).items[0].metadata.name
 const query=await Bun.file(process.argv[3]).text()
 process.stdout.write(await k(['exec','-n','postgres',p,'-c','postgres','--','env','PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=15000','psql','-X','-U','postgres','-d','multi_ai_router','-v','ON_ERROR_STOP=1','-P','pager=off','-c',query]))
} else if(mode==='status') {
 console.log(await k(['get','pods','-n','multi-ai-router','-o','custom-columns=NAME:.metadata.name,PHASE:.status.phase,IMAGE:.spec.containers[*].image,RESTARTS:.status.containerStatuses[*].restartCount,NODE:.spec.nodeName']))
 console.log(await k(['top','pod','-n','multi-ai-router']))
 console.log(await k(['get','cluster','postgres','-n','postgres','-o','jsonpath={.status.phase}{"\\n"}{.status.conditions}{"\\n"}{.status.lastSuccessfulBackup}{"\\n"}']))
 console.log(await k(['get','backups','-n','postgres','-o','custom-columns=NAME:.metadata.name,PHASE:.status.phase,STARTED:.status.startedAt,STOPPED:.status.stoppedAt']))
 console.log(await k(['get','events','-n','multi-ai-router','--field-selector','type=Warning','-o','custom-columns=TIME:.lastTimestamp,REASON:.reason,MESSAGE:.message']))
} else if(mode==='logs') {
 const p=JSON.parse(await k(['get','pods','-n','multi-ai-router','-o','json'])).items[0].metadata.name
 const raw=await k(['logs','-n','multi-ai-router',p,'--since=24h','--timestamps=true'])
 const levels:Record<string,number>={},messages:Record<string,number>={},statuses:Record<string,number>={};let first='',last='',count=0
 const errors:Record<string,number>={}
 for(const l of raw.trim().split('\n')){const i=l.indexOf(' ');const time=l.slice(0,i);let r;try{r=JSON.parse(l.slice(i+1))}catch{continue}count++;first||=time;last=time;levels[r.level]=(levels[r.level]??0)+1;const msg=r.msg??r.message;messages[msg]=(messages[msg]??0)+1;if(msg==='request completed'){const key=`${r.method} ${r.path} ${r.status}`;statuses[key]=(statuses[key]??0)+1}if(r.errorClass)errors[r.errorClass]=(errors[r.errorClass]??0)+1}
 console.log(JSON.stringify({capturedAt:new Date().toISOString(),pod:p,first,last,count,levels,messages,statuses,errors},null,2))
}
