import {createTokenObserver} from '../../../../../../../apps/api/src/services/usage/tokens.ts'
import {correlationIdFrom} from '../../../../../../../apps/api/src/services/usage/record.ts'
import {createPriceBook} from '../../../../../../../apps/api/src/services/cost/book.ts'
import {resolveWindow} from '../../../../../../../apps/api/src/services/usage-read/window.ts'
import {buildAxis} from '../../../../../../../apps/api/src/services/usage-read/axis.ts'
import {createQuotaFloorTask} from '../../../../../../../apps/api/src/scheduler/tasks/quota-floor.ts'
const enc = new TextEncoder()
const cached = createTokenObserver()
cached.observe(enc.encode(JSON.stringify({usage:{input_tokens:100,input_tokens_details:{cached_tokens:40},output_tokens:5}})))
console.log(JSON.stringify({case:'07.1 Responses cached input',expectedUncached:60,actual:cached.counts()}))
const large = createTokenObserver()
large.observe(enc.encode('{"usage":{"prompt_tokens":2147483648,"completion_tokens":1}}'))
console.log(JSON.stringify({case:'07.2 PG integer overflow accepted',actual:large.counts()}))
const id='11111111-1111-4111-8111-111111111111'
console.log(JSON.stringify({case:'07.3 reused caller UUID',sameInternalId:correlationIdFrom(id)===correlationIdFrom(id)}))
const axis=buildAxis(resolveWindow({window:'lifetime'},new Date('2026-10-02T23:00Z')))
console.log(JSON.stringify({case:'07.4 lifetime axis',count:axis.length,first:axis[0],last:axis.at(-1)}))
let release;let loads=0
const book=createPriceBook({load:()=>{loads++;return new Promise(r=>{release=r})},refreshIntervalMs:1000})
const old=book.refresh();const afterWrite=book.refresh();release([]);await Promise.all([old,afterWrite])
console.log(JSON.stringify({case:'08.2 refresh snapshot barrier',loads,samePromise:old===afterWrite}))
const now=new Date('2026-10-02T12:00Z')
let live={accountId:'a',window:'five_hour',resetsAt:new Date('2026-10-02T11:00Z'),lastCheckedAt:new Date('2026-10-02T10:00Z'),utilization:1,utilizationSource:'continuous',resetSource:'provider-reported'}
const floor=createQuotaFloorTask({accounts:{list:async()=>[{id:'a'}],listQuotaWindows:async()=>{const stale={...live};live={...live,resetsAt:new Date('2026-10-02T17:00Z'),lastCheckedAt:now};return [stale]},upsertQuotaWindow:async(id,state)=>{live={...live,...state,utilization:state.utilization??null,resetsAt:state.resetsAt??null};return live}},health:{stateOf:()=>({lastSignalAt:null})},intervalMs:1000,idleAfterMs:1000})
await floor.run({now,signal:new AbortController().signal,logger:{info:()=>{}}})
console.log(JSON.stringify({case:'09.2 new quota overwritten by stale sweep',actual:live}))
