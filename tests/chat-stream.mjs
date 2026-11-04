import assert from 'node:assert/strict'
import {runChatGeneration} from '../supabase/functions/uncensor-api/chat-stream.mjs'

const enc=new TextEncoder()
const data=(payload)=>'data: '+JSON.stringify(payload)+'\n\n'
const content=(text,reason=null)=>data({choices:[{delta:{content:text},finish_reason:reason}]})
const reasoning=(text)=>data({choices:[{delta:{reasoning:text},finish_reason:null}]})
const error=(message)=>data({error:{code:503,message},choices:[{delta:{content:''},finish_reason:'error'}]})
const finished='data: [DONE]\n\n'
function response(...frames){
  return {ok:true,status:200,body:new ReadableStream({
    start(controller){
      for(const frame of frames)controller.enqueue(enc.encode(frame))
      controller.close()
    },
  })}
}
const base={preferred:'slow-reasoning-model',fallbacks:['fallback-model'],messages:[{role:'user',content:'Diagnose these ads'}],
  apiKey:'test-key',maxTokens:5000,temperature:.4,totalWallMs:5000,primaryWallMs:2000,
  fallbackWallMs:2000}
const events=[],attempts=[]
let calls=[]
let result=await runChatGeneration({...base,fetchImpl:async(url,opts)=>{
  calls.push(JSON.parse(opts.body).model)
  return response(reasoning('working through evidence'),content('Full useful answer.'),finished)
},onEvent:e=>events.push(e),onAttempt:e=>attempts.push(e)})
assert.equal(result.ok,true)
assert.equal(result.full,'Full useful answer.')
assert.equal(result.model,'slow-reasoning-model')
assert.deepEqual(calls,['slow-reasoning-model'])
assert.ok(events.some(e=>e.type==='status'&&/reasoning/i.test(e.text)))
assert.equal(attempts[0].reason,'completed')
assert.equal(attempts[0].saw_reasoning,true)
assert.ok(result.attempts.length===1)

calls=[]
result=await runChatGeneration({...base,fetchImpl:async(url,opts)=>{
  const model=JSON.parse(opts.body).model
  calls.push(model)
  return model==='slow-reasoning-model'
    ?response(reasoning('something'),error('503 provider terminated'))
    :response(content('Recovered on fallback.'),finished)
},onEvent:()=>{}})
assert.equal(result.ok,true)
assert.equal(result.model,'fallback-model')
assert.equal(result.full,'Recovered on fallback.')
assert.equal(result.attempts.length,2)
assert.equal(result.attempts[0].reason,'sse_error')

calls=[]
result=await runChatGeneration({...base,fetchImpl:async(url,opts)=>{
  const model=JSON.parse(opts.body).model
  calls.push(model)
  return model==='slow-reasoning-model'
    ?response(reasoning('spent all tokens'),data({choices:[{delta:{content:''},finish_reason:'length'}]}),finished)
    :response(content('Second provider answered.'),finished)
},onEvent:()=>{}})
assert.equal(result.ok,true)
assert.equal(result.model,'fallback-model')
assert.equal(result.attempts[0].reason,'empty_reasoning_budget')

result=await runChatGeneration({...base,fetchImpl:async()=>{
  return response(content('A partial but valuable analysis.'),error('provider dropped'))
},onEvent:()=>{}})
assert.equal(result.ok,true)
assert.equal(result.partial,true)
assert.equal(result.full,'A partial but valuable analysis.')
assert.equal(result.attempts.length,1,'Do not mix another model into an already streaming answer')

result=await runChatGeneration({...base,fetchImpl:async()=>({ok:false,status:429,json:async()=>({error:{message:'Rate limit'}})}),onEvent:()=>{}})
assert.equal(result.ok,false)
assert.equal(result.attempts.length,2)
assert.equal(result.attempts[0].http_status,429)
console.log('Streaming provider fallback and recovery regression tests passed')
