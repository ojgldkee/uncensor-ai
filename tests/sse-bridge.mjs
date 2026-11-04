import assert from 'node:assert/strict'
import {createSseParser,classifyOpenRouterEvent,isUsableAssistantAnswer} from '../supabase/functions/uncensor-api/sse-bridge.mjs'

const enc=new TextEncoder()
const p=createSseParser()
assert.deepEqual(p.push(enc.encode(': hello\r\n\r\n')),[])
const split='data: {"choices":[{"delta":{"reasoning":"thought"},"finish_reason":null}]}\r\n\r\n'
assert.deepEqual(p.push(enc.encode(split.slice(0,35))),[])
const event=p.push(enc.encode(split.slice(35)))
assert.equal(event.length,1)
assert.equal(classifyOpenRouterEvent(event[0]).kind,'reasoning','Reasoning is real upstream activity, not a failure')
const e='data: {"choices":[{"delta":{"content":"A useful answer"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
const textEvents=p.push(enc.encode(e))
assert.equal(classifyOpenRouterEvent(textEvents[0]).text,'A useful answer')
assert.equal(classifyOpenRouterEvent(textEvents[1]).kind,'done')
const providerError=p.push(enc.encode('data: {"error":{"code":429,"message":"Provider rate limited"},"choices":[{"delta":{"content":""},"finish_reason":"error"}]}\n\n'))
assert.equal(classifyOpenRouterEvent(providerError[0]).kind,'error')
assert.match(classifyOpenRouterEvent(providerError[0]).error,/rate limited/)
const n=createSseParser()
const arr=n.push(enc.encode('data: {"choices":[{"delta":{"content":[{"type":"text","text":"Hello"}]},"finish_reason":"length"}]}\n\n'))
assert.equal(classifyOpenRouterEvent(arr[0]).text,'Hello')
assert.equal(classifyOpenRouterEvent(arr[0]).finishReason,'length')
assert.equal(isUsableAssistantAnswer('_No available model started producing an answer.'),false)
assert.equal(isUsableAssistantAnswer('Generation failed: timed out'),false)
assert.equal(isUsableAssistantAnswer('We analyzed three ads and found rising CPM.'),true)
console.log('Streaming SSE, reasoning, errors, and answer classification regression tests passed')
