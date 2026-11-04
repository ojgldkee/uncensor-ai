import {createSseParser,classifyOpenRouterEvent} from './sse-bridge.mjs'

// Runs model attempts inside ONE downstream SSE request. This deliberately does
// NOT abort reasoning models merely because delta.content has not appeared.
export async function runChatGeneration({
  preferred,fallbacks=[],messages,apiKey,maxTokens=5000,temperature=0.6,
  fetchImpl=fetch,onEvent=()=>{},onAttempt=()=>{},onCheckpoint=async()=>{},
  startedAt=Date.now(),now=()=>Date.now(),signal,
  totalWallMs=118000,primaryWallMs=78000,fallbackWallMs=35000,
}){
  const models=[preferred,...fallbacks].filter((m,i,a)=>m&&a.indexOf(m)===i).slice(0,4)
  const deadline=startedAt+totalWallMs
  const attempts=[]
  const recordAttempt=(record)=>{attempts.push(record);onAttempt(record)}
  let lastError='No model produced a visible answer.'
  for(let i=0;i<models.length;i++){
    const model=models[i],remaining=deadline-now()
    if(remaining<4000)break
    const attemptMs=Math.max(2000,Math.min(i===0?primaryWallMs:fallbackWallMs,remaining-2500))
    const began=now(),controller=new AbortController()
    const timeout=setTimeout(()=>controller.abort('attempt_deadline'),attemptMs)
    const stop=()=>controller.abort('client_cancelled')
    if(signal)signal.addEventListener('abort',stop,{once:true})
    let reader=null,firstEventAt=0,firstTextAt=0,sawReasoning=false,usage=null,finishReason=null
    let full='',gotDone=false,upstreamError=null
    try{
      onEvent({type:'status',text:i===0
        ?'Connecting to '+model+'…'
        :'Trying fallback model '+model+'…'})
      const res=await fetchImpl('https://openrouter.ai/api/v1/chat/completions',{
        method:'POST',
        headers:{
          authorization:'Bearer '+apiKey,'content-type':'application/json',
          'X-Title':'Uncensor AI',
        },
        body:JSON.stringify({
          model,stream:true,usage:{include:true},
          temperature,max_tokens:maxTokens,messages,
          provider:{allow_fallbacks:true,zdr:true,data_collection:'deny'},
        }),
        signal:controller.signal,
      })
      if(!res.ok||!res.body){
        const raw=await res.json().catch(()=>({}))
        upstreamError=String(raw?.error?.message||('HTTP '+res.status)).slice(0,600)
        lastError=model+' returned '+upstreamError
        recordAttempt({model,elapsed_ms:now()-began,http_status:res.status,reason:'http_error',error:upstreamError})
        continue
      }
      reader=res.body.getReader()
      const parser=createSseParser()
      let sinceCheckpoint=0,lastCheckpointAt=now()
      const readFrame=async frame=>{
        if(!firstEventAt)firstEventAt=now()
        const info=classifyOpenRouterEvent(frame)
        if(info.usage)usage=info.usage
        if(info.finishReason)finishReason=info.finishReason
        if(info.kind==='error'){
          upstreamError=info.error||'Provider stream terminated with error'
          return 'error'
        }
        if(info.kind==='done'){gotDone=true;return 'done'}
        if(info.reasoning&&!sawReasoning&&!full){
          sawReasoning=true
          onEvent({type:'status',text:model+' is reasoning…'})
        }
        if(info.text){
          if(!firstTextAt){
            firstTextAt=now()
            onEvent({type:'model',model,fallback_from:model!==preferred?preferred:null})
          }
          full+=info.text
          onEvent({type:'token',text:info.text})
          if(full.length-sinceCheckpoint>=2200||
            (full.length>=250&&now()-lastCheckpointAt>=10000)){
            sinceCheckpoint=full.length;lastCheckpointAt=now()
            try{await onCheckpoint(full,model,false)}catch(e){
              recordAttempt({model,reason:'checkpoint_failed',error:String(e).slice(0,300)})
            }
          }
        }
        return null
      }
      let stopReading=false
      while(!stopReading){
        const part=await reader.read()
        if(part.done){
          for(const frame of parser.flush()){
            const mode=await readFrame(frame)
            if(mode==='error'||mode==='done'){stopReading=true;break}
          }
          break
        }
        for(const frame of parser.push(part.value)){
          const mode=await readFrame(frame)
          if(mode==='error'||mode==='done'){stopReading=true;break}
        }
      }
      const detail={model,elapsed_ms:now()-began,http_status:res.status,
        first_event_ms:firstEventAt?firstEventAt-began:null,
        first_text_ms:firstTextAt?firstTextAt-began:null,
        saw_reasoning:sawReasoning,visible_chars:full.length,
        finish_reason:finishReason||null,
      }
      if(full.trim()){
        const interrupted=Boolean(upstreamError)||(finishReason==='error')||(!gotDone&&!finishReason)
        recordAttempt({...detail,reason:interrupted?'partial_stream':'completed',
          error:upstreamError?upstreamError.slice(0,400):null})
        return {ok:true,partial:interrupted,model,full,usage,finishReason,
          attempts,error:upstreamError||null}
      }
      const reason=upstreamError?'sse_error':finishReason==='length'
        ?'empty_reasoning_budget':gotDone?'empty_complete':'no_visible_content'
      const error=upstreamError||(
        reason==='empty_reasoning_budget'
        ?'Model used its output budget without producing visible text'
        :'Stream ended without visible answer text')
      recordAttempt({...detail,reason,error:error.slice(0,400)})
      lastError=model+': '+error
    }catch(e){
      const aborted=controller.signal.aborted
      const reason=signal?.aborted?'client_cancelled':aborted?'attempt_timeout':'provider_exception'
      const error=(e instanceof Error?e.message:String(e)).slice(0,450)
      recordAttempt({model,elapsed_ms:now()-began,reason,error,
        first_event_ms:firstEventAt?firstEventAt-began:null,
        saw_reasoning:sawReasoning,visible_chars:full.length})
      if(full.trim())return {ok:true,partial:true,model,full,usage,
        finishReason,attempts,error:reason+': '+error}
      lastError=model+': '+reason+(error?': '+error:'')
      if(signal?.aborted)return {ok:false,cancelled:true,full:'',attempts,error:lastError}
    }finally{
      clearTimeout(timeout)
      if(signal)signal.removeEventListener('abort',stop)
      controller.abort('finished')
      if(reader)void reader.cancel().catch(()=>{})
    }
  }
  return {ok:false,full:'',attempts,error:lastError}
}
