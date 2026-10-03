import {benchApp,scrape} from '../../../../../../../apps/api/bench/harness.ts'
import {stubUpstream} from '../../../../../../../apps/api/bench/upstream.ts'
const enc=new TextEncoder()
for(const delayMs of [0,100]){
 const bench=benchApp({provider:'anthropic-api',upstream:stubUpstream({dialect:'anthropic',stream:false,firstByteDelayMs:1})})
 const payload=enc.encode(JSON.stringify({model:'claude-opus-5',max_tokens:16,messages:[{role:'user',content:'hello'}]}))
 const body=new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(payload);controller.close()},delayMs)}})
 const request=new Request('http://router.local/v1/messages',{method:'POST',headers:{'x-api-key':bench.key,'content-type':'application/json'},body,duplex:'half'})
 const response=await bench.app.fetch(request)
 await response.arrayBuffer()
 const exposition=await scrape(bench)
 console.log(JSON.stringify({delayMs,status:response.status,overhead:exposition.split('\n').filter(line=>/^router_overhead_seconds_(sum|count)/.test(line))}))
}
