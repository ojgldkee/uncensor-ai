import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync('app.js','utf8');
const css=fs.readFileSync('styles.css','utf8');
const html=fs.readFileSync('index.html','utf8');

assert.ok(app.includes("pendingRuns:new Map()"),'Each chat must own its in-flight generation');
assert.ok(!app.includes('state.sending')&&!app.includes('state.abort'),'Global generation state must be removed');
assert.ok(app.includes("localStorage.getItem('uncensor.activeChatId')"),'Startup must restore the last chat');
assert.ok(app.includes('seq!==state.chatOpenSeq'),'Stale chat loads must not overwrite a newer selection');
assert.ok(!/function newChat\([^)]*\)\{[^}]*controller\.abort/.test(app),'Switching to a new chat must not cancel another chat');
assert.ok(/#renameChatInput\s*\{\s*font-size:\s*16px/.test(css),'Rename input must not trigger iOS focus zoom');
assert.ok(html.includes('app.js?v=39')&&html.includes('styles.css?v=39'),'Cache URLs must match the release');

const helpers=app.slice(app.indexOf('function activeThreadKey()'),app.indexOf('function when(v)'));
assert.ok(helpers.startsWith('function activeThreadKey()')&&helpers.includes('function bindRunConversation('));

const storage=new Map();
const state={activeId:'A',draftId:'draft-1',pendingRuns:new Map(),activeConversation:null};
const dom={
  sendBtn:{textContent:'',classList:{toggle(){} }},
  typing:{classList:{toggle(){}},querySelector(){return {textContent:''}}}
};
const ctx={
  state,localStorage:{setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  $:id=>dom[id]||{classList:{contains:()=>true}},
  renderConversations(){},syncKnowledgeScopeUI(){},
  api:async()=>({conversation:{title:'A'},messages:[]}),
  renderMessages(){},header(){},
};
vm.createContext(ctx);
vm.runInContext(helpers,ctx);

const a={key:'chat:A',conversationId:'A',draftId:'draft-1',controller:new AbortController()};
const b={key:'chat:B',conversationId:'B',draftId:'draft-2',controller:new AbortController()};
state.pendingRuns.set(a.key,a);
state.pendingRuns.set(b.key,b);
assert.equal(ctx.activeRun(),a);
state.activeId='B';
assert.equal(ctx.activeRun(),b,'Switching chats must select only its own run');
ctx.activeRun().controller.abort();
assert.equal(b.controller.signal.aborted,true);
assert.equal(a.controller.signal.aborted,false,'Stopping B must not stop A');
assert.equal(ctx.runIsVisible(a),false,'An old response must not render in another chat');

const offscreen={key:'draft:old',conversationId:null,draftId:'old',controller:new AbortController()};
state.pendingRuns.set(offscreen.key,offscreen);
ctx.bindRunConversation(offscreen,'new-chat-id','New Chat');
assert.equal(state.activeId,'B','A response from another chat cannot hijack the current view');
assert.equal(offscreen.conversationId,'new-chat-id');
assert.ok(state.pendingRuns.has('chat:new-chat-id'));

const onscreen={key:'draft:visible',conversationId:null,draftId:'visible',controller:new AbortController()};
state.activeId=null;state.draftId='visible';
state.pendingRuns.set(onscreen.key,onscreen);
ctx.bindRunConversation(onscreen,'saved-id','Saved Chat');
assert.equal(state.activeId,'saved-id','The current draft should become its saved conversation');
assert.equal(storage.get('uncensor.activeChatId'),'saved-id','Refresh should reopen that chat');
assert.equal(ctx.activeRun(),onscreen);


const openCode=app.slice(app.indexOf('async function openChat(id){'),app.indexOf('async function patchChat('));
assert.ok(openCode.startsWith('async function openChat(id){'));
const resolvers=new Map();
ctx.api=path=>new Promise(resolve=>resolvers.set(path.split('/').pop(),resolve));
ctx.closeSidebar=()=>{};
vm.runInContext(openCode,ctx);
state.activeId='A';state.chatOpenSeq=0;state.messages=[];
const openingB=ctx.openChat('B');
const openingC=ctx.openChat('C');
resolvers.get('C')({conversation:{id:'C',title:'Chat C'},messages:[{content:'C',role:'user'}]});
await openingC;
resolvers.get('B')({conversation:{id:'B',title:'Chat B'},messages:[{content:'B',role:'user'}]});
await openingB;
assert.equal(state.activeId,'C','A slow previous response must not switch the selected chat');
assert.equal(state.messages[0].content,'C','Slow chat load must not overwrite the newest conversation');

console.log('Concurrent chat and mobile navigation regression tests passed');

assert.ok(html.includes('id="knowledgeInspectorModal"'),'Knowledge Inspector modal must exist');
assert.ok(html.includes('id="knowledgeViewProcessing"')&&html.includes('id="knowledgeViewAttention"'),'Persistent Processing and Needs Attention views must exist');
assert.ok(app.includes('openKnowledgeInspector')&&app.includes('loadKnowledgeInspector'),'Inspector must load extracted source text');
assert.ok(app.includes("setKnowledgeView('processing')")&&app.includes("setKnowledgeView('attention')"),'Processing views must be wired');
assert.ok(app.includes('openRetrievalDebugger')&&app.includes('/api/retrieval/debug'),'Retrieval debugger must be wired');
