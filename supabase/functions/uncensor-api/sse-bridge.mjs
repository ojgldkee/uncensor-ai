// OpenRouter-compatible SSE decoding and message classification.
// Pure ESM so the Edge Function and Node regression suite use identical logic.
export function createSseParser(){
  const decoder=new TextDecoder()
  let pending=''
  function extract(){
    pending=pending.replace(/\r\n/g,'\n')
    const events=[]
    let boundary
    while((boundary=pending.indexOf('\n\n'))!==-1){
      const frame=pending.slice(0,boundary)
      pending=pending.slice(boundary+2)
      const data=frame.split('\n').filter(line=>line.startsWith('data:'))
        .map(line=>line.slice(5).replace(/^ /,'')).join('\n').trim()
      if(!data)continue
      if(data==='[DONE]'){events.push({done:true});continue}
      try{events.push({value:JSON.parse(data)})}
      catch{events.push({malformed:true})}
    }
    return events
  }
  return {
    push(bytes){
      pending+=decoder.decode(bytes,{stream:true})
      return extract()
    },
    flush(){
      pending+=decoder.decode()
      const events=extract()
      if(pending.trim()){
        const data=pending.trim().startsWith('data:')?pending.trim().slice(5).trim():''
        if(data==='[DONE]')events.push({done:true})
        else if(data){try{events.push({value:JSON.parse(data)})}catch{events.push({malformed:true})}}
      }
      pending=''
      return events
    },
  }
}
export function classifyOpenRouterEvent(frame){
  if(frame?.done)return {kind:'done',text:'',reasoning:false,usage:null,finishReason:null}
  if(frame?.malformed)return {kind:'malformed',text:'',reasoning:false,usage:null,finishReason:null}
  const value=frame?.value||{}
  const choice=Array.isArray(value.choices)?value.choices[0]||{}:{}
  const delta=choice.delta||{}
  const raw=delta.content
  const text=typeof raw==='string'?raw:Array.isArray(raw)
    ?raw.map(part=>typeof part==='string'?part:typeof part?.text==='string'?part.text:'').join('')
    :''
  const reasoning=Boolean(delta.reasoning||delta.reasoning_content||
    (Array.isArray(delta.reasoning_details)&&delta.reasoning_details.length)||
    (Array.isArray(value.reasoning_details)&&value.reasoning_details.length))
  const finishReason=choice.finish_reason||null
  const error=value.error?.message||
    (finishReason==='error'?'The provider stopped the stream with an error.':null)
  return {
    kind:error?'error':(text?'text':reasoning?'reasoning':finishReason?'finish':'metadata'),
    text,reasoning,usage:value.usage||null,
    finishReason,
    error:error?String(error):null,
    errorCode:value.error?.code??null,
  }
}
export function isUsableAssistantAnswer(content){
  const s=String(content||'').trim()
  if(!s)return false
  return !/^(?:_No available model|_The model did not produce|Generation failed:|_No model produced a usable answer|_Generation failed|_This attempt failed)/i.test(s)
}
