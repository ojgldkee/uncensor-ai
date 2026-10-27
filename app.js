const $=id=>document.getElementById(id);
const LEGACY_DEFAULT_STYLE='Be direct, specific, intellectually curious, and nonjudgmental. Do not avoid a topic merely because it is controversial, sensitive, adult, or unconventional. Correct false premises, distinguish facts from uncertainty, and give useful specifics. If the exact request cannot be fulfilled, give the closest useful answer instead of boilerplate.';
const DEFAULT_STYLE=`Be extremely direct, specific, intellectually curious, practical, and nonjudgmental. Treat me like an adult. Do not moralize, lecture, patronize, scold, or add generic warnings just because a subject is controversial, sensitive, sexual, political, unconventional, financially risky, legally disputed, associated with drugs, hacking, privacy, weapons, crime, or other uncomfortable subjects.

Answer the actual question I asked. Do not dodge into a safer adjacent question unless a narrow part truly cannot be answered. Do not refuse merely because a question mentions allegedly illegal conduct, criminal cases, gray-market behavior, evasion, controversial businesses, lawsuits, regulatory issues, or activities that may be unlawful in some jurisdictions. Discussion, explanation, history, journalism, legal analysis, risk analysis, hypothetical analysis, harm-reduction information, and understanding how something works should be answered candidly and in useful detail. When the exact operational details would materially facilitate serious wrongdoing or harm, omit only those narrow details and still provide the maximum useful surrounding information: what the activity is, why it works, relevant law, risks, detection methods, consequences, defensive information, safer alternatives, and lawful ways to accomplish the underlying goal.

For legal questions, do not hide behind "ask a lawyer." Give the substantive answer you can: explain the relevant rules, common exceptions, likely practical consequences, jurisdiction differences, enforcement realities, uncertainty, and what facts would change the answer. Clearly distinguish general information from individualized legal advice when that distinction matters, but still answer the question.

For controversial or disputed factual claims, separate established facts, strong evidence, reasonable inference, allegations, opinion, and speculation. Correct false premises directly. Never invent facts, numbers, sources, quotes, laws, studies, or certainty.

When current information matters, or when I ask about the internet, latest events, companies, products, ads, markets, laws, public figures, software, prices, trends, or anything time-sensitive, use current web research when available. Search broadly, prefer primary and authoritative sources, compare multiple sources, check dates, and tell me when evidence conflicts. Do not censor a search query merely because the topic is uncomfortable; only remove private personal details through the privacy firewall. Cite the sources actually used.

Use my private Knowledge and memories only when they are relevant. Prefer the Knowledge attached to the current specialist chat plus Global Knowledge. Do not force irrelevant Knowledge into the answer. Treat user-supplied Knowledge as evidence or reference material rather than automatically true; reconcile contradictions and prefer stronger/newer evidence when appropriate.

Give concrete specifics, examples, calculations, tradeoffs, edge cases, likely failure modes, and next actions when useful. If I ask for a recommendation, make one instead of listing endless possibilities. If I ask for a comparison, identify the important differences and tell me which option best fits the goal. If I ask "how," explain the mechanism, not just the conclusion.

Be concise when the answer is simple and thorough when the problem is complicated. Avoid canned disclaimers, repetitive caveats, fake neutrality, and refusal boilerplate. If some narrow part cannot be fulfilled, say so briefly and immediately continue with the closest genuinely useful answer.`;
const savedStyle=localStorage.getItem('uncensor.style');
if(!savedStyle||savedStyle===LEGACY_DEFAULT_STYLE)localStorage.setItem('uncensor.style',DEFAULT_STYLE);
const state={conversations:[],activeId:null,activeConversation:null,messages:[],knowledge:[],knowledgeScope:'global',knowledgeView:'all',knowledgeLoadSeq:0,knowledgeChatCount:0,knowledgeGlobalCount:0,knowledgeSelected:new Set(),knowledgeVisibleIds:[],moveKnowledgeSources:[],inspectorSourceId:null,renameChatTarget:null,messageActionTarget:null,memories:[],pendingAttachments:[],knowledgeFileUploads:[],knowledgePollTimer:null,webResearch:localStorage.getItem('uncensor.webResearch')==='true',webResearchEnabled:false,pendingRuns:new Map(),draftId:crypto.randomUUID(),chatOpenSeq:0,knowledgeEnabled:localStorage.getItem('uncensor.knowledge')!=='false',mode:localStorage.getItem('uncensor.mode')||'direct',style:localStorage.getItem('uncensor.style')||DEFAULT_STYLE,followLatest:true};

function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function stripModelRefs(v){return String(v||'').replace(/\s*\[(?:K|W)\d+\]/gi,'').replace(/\b(?:K|W)\d+(?:\/(?:K|W)\d+)*(?:'s)?\b/gi,'the source');}
function splitAssistantMeta(v){
  const raw=String(v||'');
  const m=raw.match(/\n?\[\[NEXT\]\]\s*([\s\S]*?)\s*\[\[\/NEXT\]\]\s*$/i);
  if(!m)return{body:raw,followups:[]};
  const followups=String(m[1]||'').split(/\n+/).map(x=>x.replace(/^\s*[-*•\d.)]+\s*/,'').trim()).filter(x=>x.length>8).slice(0,3);
  return{body:raw.slice(0,m.index).trimEnd(),followups};
}
function cleanMessageText(v){return stripModelRefs(splitAssistantMeta(v).body).replace(/\n{3,}/g,'\n\n').trim();}
function inlineMd(v){
  let s=esc(v);
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/__(.+?)__/g,'<strong>$1</strong>');
  s=s.replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<em>$2</em>').replace(/(^|[^_])_([^_\n]+)_/g,'$1<em>$2</em>');
  s=s.replace(/\`([^\`\n]+)\`/g,'<code>$1</code>');
  s=s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}
function isTableDivider(line){return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);}
function tableCells(line){return line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>inlineMd(x.trim()));}
function md(v){
  const lines=String(v||'').replace(/\r\n?/g,'\n').split('\n'),out=[];let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(/^\s*\`\`\`/.test(line)){
      const lang=line.trim().slice(3).trim().replace(/[^a-z0-9_-]/gi,'');const code=[];i++;
      while(i<lines.length&&!/^\s*\`\`\`/.test(lines[i])){code.push(lines[i]);i++;}
      if(i<lines.length)i++;
      out.push('<pre><code'+(lang?' class="language-'+esc(lang)+'"':'')+'>'+esc(code.join('\n'))+'</code></pre>');continue;
    }
    if(!line.trim()){i++;continue;}
    const h=line.match(/^(#{1,3})\s+(.+)$/);if(h){out.push('<h'+h[1].length+'>'+inlineMd(h[2])+'</h'+h[1].length+'>');i++;continue;}
    if(/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)){out.push('<hr>');i++;continue;}
    if(i+1<lines.length&&line.includes('|')&&isTableDivider(lines[i+1])){
      const head=tableCells(line),rows=[];i+=2;
      while(i<lines.length&&lines[i].trim()&&lines[i].includes('|')){rows.push(tableCells(lines[i]));i++;}
      out.push('<div class="message-table-wrap"><table><thead><tr>'+head.map(x=>'<th>'+x+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+head.map((_,j)=>'<td>'+(row[j]||'')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');continue;
    }
    if(/^\s*>\s?/.test(line)){
      const parts=[];while(i<lines.length&&/^\s*>\s?/.test(lines[i])){parts.push(lines[i].replace(/^\s*>\s?/,''));i++;}
      out.push('<blockquote>'+parts.map(inlineMd).join('<br>')+'</blockquote>');continue;
    }
    if(/^\s*[-*+]\s+/.test(line)){
      const items=[];while(i<lines.length&&/^\s*[-*+]\s+/.test(lines[i])){items.push(lines[i].replace(/^\s*[-*+]\s+/,''));i++;}
      out.push('<ul>'+items.map(x=>'<li>'+inlineMd(x)+'</li>').join('')+'</ul>');continue;
    }
    if(/^\s*\d+[.)]\s+/.test(line)){
      const items=[];while(i<lines.length&&/^\s*\d+[.)]\s+/.test(lines[i])){items.push(lines[i].replace(/^\s*\d+[.)]\s+/,''));i++;}
      out.push('<ol>'+items.map(x=>'<li>'+inlineMd(x)+'</li>').join('')+'</ol>');continue;
    }
    const para=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,3})\s+/.test(lines[i])&&!/^\s*[-*+]\s+/.test(lines[i])&&!/^\s*\d+[.)]\s+/.test(lines[i])&&!/^\s*>\s?/.test(lines[i])&&!/^\s*\`\`\`/.test(lines[i])&&!/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(lines[i])){
      if(i+1<lines.length&&lines[i].includes('|')&&isTableDivider(lines[i+1]))break;
      para.push(lines[i]);i++;
    }
    out.push('<p>'+para.map(inlineMd).join('<br>')+'</p>');
  }
  return out.join('');
}
const clientErrors=(()=>{try{return JSON.parse(localStorage.getItem('uncensor.clientErrors')||'[]').slice(0,12);}catch{return[];}})();
function recordClientError(scope,error){
  const message=error instanceof Error?error.message:String(error||'Unknown client error');
  clientErrors.unshift({scope:String(scope||'client'),message:message.slice(0,500),at:new Date().toISOString(),build:'v41'});
  if(clientErrors.length>12)clientErrors.length=12;
  try{localStorage.setItem('uncensor.clientErrors',JSON.stringify(clientErrors));}catch{}
}
function toast(t,ms=2500){const e=$('toast');e.textContent=t;e.classList.remove('hidden');updateLayoutMetrics();clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.add('hidden'),ms);}
async function copyText(v){
  const text=String(v||'');
  try{await navigator.clipboard.writeText(text);toast('Copied');return true;}
  catch{}
  try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.append(ta);ta.select();const ok=document.execCommand('copy');ta.remove();if(ok){toast('Copied');return true;}}catch{}
  toast('Could not copy automatically',3500);return false;
}
function configuredApiBase(){return String(localStorage.getItem('uncensor.apiBase')||((window.UNCENSOR_CONFIG||{}).apiBase)||'').replace(/\/$/,'');}
function endpoint(path){const b=configuredApiBase();if(b)return b+path;const base=(location.pathname.includes('/uncensor-ai')?'/uncensor-ai':'');return base+path;}
function accessKey(){return localStorage.getItem('uncensor.accessKey')||'';}
function sessionToken(){return localStorage.getItem('uncensor.sessionToken')||'';}
function hasPrivateAuth(){return Boolean(sessionToken()||accessKey());}
function authHeaders(extra={}){const h=Object.assign({'Content-Type':'application/json'},extra||{});const session=sessionToken(),key=accessKey();if(session)h['x-uncensor-session']=session;else if(key)h['x-uncensor-key']=key;return h;}
let authPromptShown=false;
function deviceName(){return (navigator.platform||'Private device')+' · '+(navigator.userAgent.includes('iPhone')?'iPhone':navigator.userAgent.includes('iPad')?'iPad':navigator.userAgent.includes('Android')?'Android':'Browser');}
function saveDeviceSession(d){
  localStorage.setItem('uncensor.sessionToken',d.session_token);
  localStorage.setItem('uncensor.sessionId',d.session_id||'');
  localStorage.setItem('uncensor.sessionExpires',d.expires_at||'');
  localStorage.removeItem('uncensor.accessKey');
  if($('accessKeyInput'))$('accessKeyInput').value='';
  authPromptShown=false;syncSettings();
}
function ensurePrivateAuth(){
  if(hasPrivateAuth())return true;
  if(!authPromptShown){
    authPromptShown=true;syncSettings();
    if($('settingsModal').classList.contains('hidden'))openModal('settingsModal');
    toast('This device is not linked yet. Use a one-time link code from an enrolled device.',4200);
  }else toast('This device is not linked. Open Settings to link it.',3000);
  return false;
}
async function enrollDeviceSession(){
  const key=accessKey();if(!key)return false;
  const r=await fetch(endpoint('/api/session/enroll'),{method:'POST',headers:{'Content-Type':'application/json','x-uncensor-key':key},body:JSON.stringify({device_name:deviceName()})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.error||'That recovery/master key is not valid.');
  saveDeviceSession(d);return true;
}
async function generatePairingCode(){
  if(!sessionToken()){toast('This device must already be enrolled to generate a link code.',4000);return;}
  const b=$('generatePairingCode');b.disabled=true;
  try{
    const d=await api('/api/session/pairing-code',{method:'POST',body:'{}'});
    $('pairingCodeValue').textContent=String(d.pairing_code||'');
    $('pairingCodeExpiry').textContent='Expires '+new Date(d.expires_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+' · one use only';
    $('pairingCodeBox').classList.remove('hidden');
    toast('One-time link code generated. Enter it on the new device.',4500);
  }catch(e){toast(e.message||'Could not generate link code',4500);}
  finally{b.disabled=false;}
}
async function redeemPairingCode(){
  const code=$('pairingCodeInput').value.trim();
  if(!code){toast('Enter the one-time link code first.');return;}
  const b=$('redeemPairingCode');b.disabled=true;
  try{
    const r=await fetch(endpoint('/api/session/redeem-pairing'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairing_code:code,device_name:deviceName()})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(d.error||'Could not link this device.');
    saveDeviceSession(d);$('pairingCodeInput').value='';$('pairingCodeBox').classList.add('hidden');
    closeModal('settingsModal');toast('Device linked securely.',3500);
    await Promise.all([loadChats(),loadKnowledge(),loadMemories(),health(),status()]);
  }catch(e){toast(e.message||'Could not link this device',4500);}
  finally{b.disabled=false;}
}
async function rotateRecoveryKeyFromDevice(){
  if(!sessionToken()){toast('Enroll this device first.',3500);return;}
  if(!confirm('Generate a new recovery key? Any older recovery/master key will stop working. Your current device session will stay signed in.'))return;
  try{
    const d=await api('/api/security/recovery-key/rotate',{method:'POST',body:'{}'});
    if(!d.recovery_key)throw new Error('Recovery key was not returned.')
    $('recoveryKeyValue').textContent=d.recovery_key;
    $('recoveryKeyBox').classList.remove('hidden');
    toast('New recovery key generated. Save it somewhere secure now.',5000);
  }catch(e){toast(e.message||'Could not rotate recovery key',4500);}
}

async function revokeCurrentDevice(){
  const id=localStorage.getItem('uncensor.sessionId')||'';
  try{if(id)await api('/api/sessions/'+encodeURIComponent(id),{method:'DELETE'});}catch{}
  localStorage.removeItem('uncensor.sessionToken');localStorage.removeItem('uncensor.sessionId');localStorage.removeItem('uncensor.sessionExpires');
  syncSettings();toast('This device session was revoked.');openModal('settingsModal');
}
async function exportFullBackup(){
  if(!ensurePrivateAuth())return;
  const btn=$('exportFullBackup');btn.disabled=true;$('backupStatus').textContent='Building backup…';
  try{
    const d=await api('/api/backup/export');
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const blob=new Blob([JSON.stringify(d,null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='uncensor-ai-backup-'+stamp+'.json';a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
    $('backupStatus').textContent='Backup downloaded. It contains decrypted private data — store it securely.';
    toast('Full backup downloaded',3500);
  }catch(e){$('backupStatus').textContent='Backup failed: '+(e.message||'unknown error');toast(e.message||'Backup failed',4500);}
  finally{btn.disabled=false;}
}
async function api(path,opt={},attempt=0){
  const method=String(opt.method||'GET').toUpperCase(),canRetry=method==='GET'&&attempt<2;
  const controller=new AbortController(),external=opt.signal||null;
  const timeoutMs=Math.max(5000,Number(opt.timeoutMs||30000));
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  const onAbort=()=>controller.abort();
  if(external)external.addEventListener('abort',onAbort,{once:true});
  try{
    const h=Object.assign(authHeaders(),opt.headers||{});
    const request=Object.assign({},opt,{headers:h,signal:controller.signal});
    delete request.timeoutMs;
    const r=await fetch(endpoint(path),request);
    const tx=await r.text();let d={};try{d=tx?JSON.parse(tx):{};}catch{d={error:tx||'Unexpected response'};}
    if(r.status===401&&d.requires_access_key&&sessionToken()){localStorage.removeItem('uncensor.sessionToken');localStorage.removeItem('uncensor.sessionId');localStorage.removeItem('uncensor.sessionExpires');syncSettings();}
    if(!r.ok){
      if(canRetry&&[408,425,429,500,502,503,504].includes(r.status)){await new Promise(x=>setTimeout(x,350*(attempt+1)));return api(path,opt,attempt+1);}
      throw Object.assign(new Error(d.error||('Request failed '+r.status)),{data:d,status:r.status});
    }
    return d;
  }catch(e){
    if(e?.name==='AbortError'&&!external?.aborted){
      const timeoutError=Object.assign(new Error('Request timed out. Check your connection and try again.'),{code:'TIMEOUT'});
      recordClientError(path,timeoutError);
      if(canRetry){await new Promise(x=>setTimeout(x,350*(attempt+1)));return api(path,opt,attempt+1);}
      throw timeoutError;
    }
    if(canRetry&&!(e&&e.status)&&!external?.aborted){await new Promise(x=>setTimeout(x,350*(attempt+1)));return api(path,opt,attempt+1);}
    if(!external?.aborted)recordClientError(path,e);
    throw e;
  }finally{
    clearTimeout(timer);
    if(external)external.removeEventListener('abort',onAbort);
  }
}
function updateLayoutMetrics(){
  const wrap=document.querySelector('.composer-wrap');
  const h=Math.ceil(wrap?.getBoundingClientRect().height||156);
  document.documentElement.style.setProperty('--composer-space',(h+10)+'px');
  const vv=window.visualViewport;
  document.documentElement.style.setProperty('--app-height',Math.max(320,Math.round(vv?.height||window.innerHeight))+'px');
}
function autoGrow(){const e=$('input');e.style.height='auto';e.style.height=Math.min(200,e.scrollHeight)+'px';$('charCount').textContent=e.value.length.toLocaleString()+' / 50,000';requestAnimationFrame(updateLayoutMetrics);}
function nearMessageBottom(){const root=$('messages');return root.scrollHeight-root.scrollTop-root.clientHeight<90;}
function updateJumpLatest(){const near=nearMessageBottom();state.followLatest=near;$('jumpLatest')?.classList.toggle('hidden',near);}
function scrollToLatest(force=false){const root=$('messages');if(force||state.followLatest){root.scrollTop=root.scrollHeight;state.followLatest=true;$('jumpLatest')?.classList.add('hidden');}}
function activeTitle(){return (state.activeConversation&&state.activeConversation.title)||(state.conversations.find(x=>x.id===state.activeId)||{}).title||'New chat';}
function header(){$('chatTitleButton').textContent=activeTitle();$('deleteChatTop').disabled=!state.activeId;$('exportChat').disabled=!state.messages.length;}
function activeThreadKey(){return state.activeId?'chat:'+state.activeId:'draft:'+state.draftId;}
function activeRun(){return state.pendingRuns.get(activeThreadKey())||null;}
function runIsVisible(run){return run.conversationId?state.activeId===run.conversationId:(!state.activeId&&state.draftId===run.draftId);}
function rememberActiveChat(){if(state.activeId)localStorage.setItem('uncensor.activeChatId',state.activeId);else localStorage.removeItem('uncensor.activeChatId');}
function refreshSendingUI(){
  const run=activeRun(),busy=Boolean(run);
  $('sendBtn').textContent=busy?'■':'↑';
  $('sendBtn').classList.toggle('stop',busy);
  $('typing').classList.toggle('hidden',!busy);
  const label=$('typing').querySelector('em');
  if(label)label.textContent=run?.research?'Researching current web…':'Thinking…';
}
function bindRunConversation(run,id,title){
  if(!id)return;
  const wasVisible=runIsVisible(run);
  const nextKey='chat:'+id;
  if(run.key!==nextKey){state.pendingRuns.delete(run.key);run.key=nextKey;state.pendingRuns.set(nextKey,run);}
  run.conversationId=id;
  if(wasVisible){
    state.activeId=id;
    state.activeConversation=Object.assign({},state.activeConversation||{},{id,title:title||state.activeConversation?.title||'New chat'});
    rememberActiveChat();refreshSendingUI();renderConversations();syncKnowledgeScopeUI();
  }
}
async function refreshFinishedRun(run){
  if(!runIsVisible(run)||!run.conversationId)return false;
  const id=run.conversationId;
  const d=await api('/api/conversations/'+encodeURIComponent(id));
  if(!runIsVisible(run))return false;
  state.activeConversation=d.conversation;
  state.messages=d.messages||[];
  renderMessages(state.followLatest);renderConversations();header();syncKnowledgeScopeUI();
  return true;
}
function when(v){if(!v)return'';const m=Math.floor((Date.now()-new Date(v).getTime())/60000);if(m<1)return'now';if(m<60)return m+'m';const h=Math.floor(m/60);if(h<24)return h+'h';const d=Math.floor(h/24);return d<7?d+'d':new Date(v).toLocaleDateString([], {month:'short',day:'numeric'});}

async function status(){if(!configuredApiBase()){$('statusDot').className='status-dot setup';$('providerStatus').textContent='Backend URL not connected';$('settingsStatus').textContent='Supabase backend URL has not been attached to this build yet.';$('sendBtn').disabled=true;$('input').disabled=true;$('input').placeholder='Backend connection pending';return;}try{const d=await api('/api/status');$('sendBtn').disabled=!d.openrouter_enabled;$('input').disabled=!d.openrouter_enabled;$('input').placeholder=d.openrouter_enabled?'Message Uncensor AI…':'Backend connected — add OpenRouter key to enable chat';$('statusDot').className='status-dot '+(d.openrouter_enabled?'online':'setup');$('providerStatus').textContent=d.openrouter_enabled?'Backend + OpenRouter ready':'Backend connected · model key pending';state.webResearchEnabled=Boolean(d.web_research_enabled);syncSettings();const spend=Number(d.rolling_24h_spend||0),cap=Number(d.rolling_24h_cap||0);$('settingsStatus').textContent='Supabase connected · Memory '+(d.memory_enabled?'on':'off')+' · Knowledge processing '+(d.background_indexing_enabled?'on':'off')+' · USD '+spend.toFixed(3)+' / '+(cap?'USD '+cap.toFixed(2):'no cap')+' (24h)';if(d.default_model&&!localStorage.getItem('uncensor.model')&&[...$('modelSelect').options].some(o=>o.value===d.default_model))$('modelSelect').value=d.default_model;}catch(e){$('statusDot').className='status-dot setup';$('providerStatus').textContent='Backend unreachable';$('settingsStatus').textContent=e.message||'Backend connection failed';$('sendBtn').disabled=true;$('input').disabled=true;$('input').placeholder='Backend temporarily unavailable';}}

async function health(){
  const el=$('securityHealth'),detail=$('securityHealthDetail');
  if(!el||!detail)return;
  if(!hasPrivateAuth()){el.textContent='Locked';detail.textContent='Enroll this device to view the private security report.';return;}
  el.textContent='Checking…';
  try{
    const d=await api('/api/health');
    const x=d.details||{};
    const ok=d.status==='healthy';
    el.textContent=ok?'Healthy · maximum privacy controls on':'Attention required';
    el.classList.toggle('health-good',ok);el.classList.toggle('health-bad',!ok);
    detail.textContent=ok
      ? 'Encrypted rows: 100% · public grants: 0 · public storage: 0 · failed sources: '+Number(x.failed_sources||0)+' · queue: '+Number(x.queue_jobs||0)+' · active devices: '+Number(x.active_device_sessions||0)+' · checked '+new Date(d.checked_at||Date.now()).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
      : 'Plaintext rows: '+Number(x.plaintext_rows||0)+' · public grants: '+Number(x.unexpected_client_grants||0)+' · public bucket: '+Number(x.public_attachment_buckets||0)+' · storage policies: '+Number(x.storage_policies||0)+' · failed sources: '+Number(x.failed_sources||0)+' · worker error: '+String(x.worker_error||'none');
  }catch(e){
    el.textContent='Check failed';el.classList.remove('health-good');el.classList.add('health-bad');
    detail.textContent=e.message||'Could not read security health.';
  }
}

function renderConversations(){const root=$('conversationList');root.innerHTML='';const q=$('chatSearch').value.trim().toLowerCase();const rows=state.conversations.filter(c=>!q||String(c.title||'').toLowerCase().includes(q));$('chatCount').textContent=String(state.conversations.length);if(!rows.length){root.innerHTML='<div class="empty-list">'+(q?'No matching chats.':'No saved chats yet.')+'</div>';return;}rows.forEach(c=>{const el=document.createElement('div');el.className='conversation-item'+(c.id===state.activeId?' active':'')+(state.pendingRuns.has('chat:'+c.id)?' generating':'');const open=document.createElement('button');open.className='conversation-open';open.innerHTML='<span class="title">'+(c.pinned?'★ ':'')+esc(c.title||'New chat')+'</span><small>'+(state.pendingRuns.has('chat:'+c.id)?'● Thinking…':when(c.updated_at))+'</small>';open.onclick=()=>openChat(c.id);const a=document.createElement('div');a.className='conversation-actions';const pin=document.createElement('button');pin.textContent=c.pinned?'★':'☆';pin.title=c.pinned?'Unpin':'Pin';pin.onclick=e=>{e.stopPropagation();patchChat(c.id,{pinned:!c.pinned});};const ren=document.createElement('button');ren.textContent='✎';ren.title='Rename';ren.onclick=e=>{e.stopPropagation();renameChat(c.id,c.title);};const del=document.createElement('button');del.textContent='×';del.className='danger-hover';del.title='Delete permanently';del.onclick=e=>{e.stopPropagation();deleteChat(c.id,c.title);};a.append(pin,ren,del);el.append(open,a);root.append(el);});}
async function loadChats(){try{const d=await api('/api/conversations');state.conversations=d.conversations||[];if(state.activeId)state.activeConversation=state.conversations.find(x=>x.id===state.activeId)||state.activeConversation;renderConversations();header();}catch(e){recordClientError('loadChats',e);renderConversations();header();}}
async function openChat(id){
  const seq=++state.chatOpenSeq,previousId=state.activeId,previousConversation=state.activeConversation;
  state.activeId=id;rememberActiveChat();refreshSendingUI();renderConversations();closeSidebar();
  try{
    const d=await api('/api/conversations/'+encodeURIComponent(id));
    if(seq!==state.chatOpenSeq||state.activeId!==id)return;
    if(!d.conversation)throw new Error('Chat was not found.');
    state.activeConversation=d.conversation;
    state.messages=d.messages||[];state.followLatest=true;
    renderMessages();renderConversations();header();syncKnowledgeScopeUI();refreshSendingUI();
    if(!$('knowledgeModal').classList.contains('hidden'))loadKnowledge();
  }catch(e){
    if(seq!==state.chatOpenSeq||state.activeId!==id)return;
    state.activeId=previousId;state.activeConversation=previousConversation;
    rememberActiveChat();refreshSendingUI();renderConversations();header();
    recordClientError('openChat',e);toast(e.message||'Could not open chat');
  }
}
async function patchChat(id,p){try{const d=await api('/api/conversations/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(p)});if(id===state.activeId&&d.conversation)state.activeConversation=d.conversation;await loadChats();return d.conversation||true;}catch(e){toast(e.message||'Could not update chat',4000);throw e;}}
async function setUseGlobalKnowledge(enabled){
  if(!state.activeId)return;
  const toggle=$('useGlobalKnowledgeToggle');toggle.disabled=true;
  try{
    await patchChat(state.activeId,{use_global_knowledge:Boolean(enabled)});
    syncKnowledgeScopeUI();
    toast(enabled?'Global Knowledge enabled for '+activeTitle():'Focused mode enabled · Global Knowledge off',3500);
  }catch(e){
    toggle.checked=!enabled;
    toast(e.message||'Could not update Knowledge mode',4000);
  }finally{toggle.disabled=false;}
}
function renameChat(id=state.activeId,current=activeTitle()){
  if(!id){toast('Send a message first, then you can name the saved chat.',3500);return;}
  state.renameChatTarget={id,current:current||'New chat'};
  $('renameChatInput').value=current||'';
  openModal('renameChatModal');
  setTimeout(()=>{$('renameChatInput').focus();$('renameChatInput').select();},40);
}
async function saveChatRename(){
  const target=state.renameChatTarget;if(!target)return;
  const n=$('renameChatInput').value.trim();
  if(!n){toast('Enter a chat name.');return;}
  const btn=$('saveRenameChat');btn.disabled=true;
  try{
    await patchChat(target.id,{title:n.slice(0,120)});
    if(target.id===state.activeId){state.activeConversation=Object.assign({},state.activeConversation||{},{title:n.slice(0,120)});header();syncKnowledgeScopeUI();}
    closeModal('renameChatModal');toast('Chat renamed');
  }catch(e){console.error('Rename failed',e);}
  finally{btn.disabled=false;}
}
async function deleteChat(id=state.activeId,title=activeTitle()){if(!id)return;if(!confirm('Permanently delete “'+(title||'this chat')+'”?\\n\\nEvery saved message in it will be deleted and this cannot be undone.'))return;try{await api('/api/conversations/'+encodeURIComponent(id),{method:'DELETE'});const inFlight=state.pendingRuns.get('chat:'+id);if(inFlight)inFlight.controller.abort();if(state.activeId===id)newChat(false);await loadChats();toast('Chat permanently deleted');}catch(e){toast(e.message);}}
function newChat(close=true){
  ++state.chatOpenSeq;
  clearPendingAttachments();
  state.activeId=null;state.draftId=crypto.randomUUID();state.activeConversation=null;state.messages=[];state.followLatest=true;
  state.knowledgeScope='global';rememberActiveChat();
  renderMessages();renderConversations();header();syncKnowledgeScopeUI();refreshSendingUI();
  $('input').value='';autoGrow();$('input').focus();
  if(close)closeSidebar();
}

function fileKind(file){
  const type=String(file.type||'').toLowerCase(),name=String(file.name||'').toLowerCase();
  if(type.startsWith('image/'))return'image';
  if(type.startsWith('video/'))return'video';
  if(type.startsWith('audio/'))return'audio';
  if(type==='application/pdf'||name.endsWith('.pdf'))return'pdf';
  if(type.startsWith('text/')||/\.(txt|md|csv|json|html?|log|srt|vtt|js|ts|tsx|jsx|py|sql|css)$/i.test(name))return'text';
  return'file';
}
function isSupportedKnowledgeTextFile(file){
  if(String(file?.type||'').toLowerCase()==='application/pdf'||/\.pdf$/i.test(String(file?.name||'')))return true;
  return /\.(txt|md|csv|json|html?|log|srt|vtt|js|ts|tsx|jsx|py|sql|css)$/i.test(String(file?.name||'')) ||
    /^text\//i.test(String(file?.type||'')) || String(file?.type||'').toLowerCase()==='application/json';
}
function formatBytes(n){n=Number(n||0);if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(n>10485760?0:1)+' MB';}
function attIcon(kind){return kind==='image'?'▧':kind==='video'?'▶':kind==='audio'?'♪':kind==='pdf'?'PDF':kind==='url'?'↗':'▤';}
function renderAttachmentTray(){
  const tray=$('attachmentTray');tray.innerHTML='';
  if(!state.pendingAttachments.length){tray.classList.add('hidden');return;}
  tray.classList.remove('hidden');
  state.pendingAttachments.forEach((a,i)=>{
    const el=document.createElement('div');el.className='attachment-pill';
    el.innerHTML='<span class="att-icon">'+attIcon(a.kind)+'</span><span class="att-copy"><strong>'+esc(a.name||a.url||'Attachment')+'</strong><small>'+esc(a.kind)+(a.size?' · '+formatBytes(a.size):'')+'</small></span><button type="button" aria-label="Remove">×</button>';
    el.querySelector('button').onclick=()=>{const removed=state.pendingAttachments.splice(i,1)[0];renderAttachmentTray();if(removed&&removed.path)api('/api/uploads/discard',{method:'POST',body:JSON.stringify({path:removed.path})}).catch(()=>{});};
    tray.append(el);
  });
}
async function uploadAttachment(file){
  const kind=fileKind(file);
  const max=kind==='audio'?16*1024*1024:kind==='video'?100*1024*1024:50*1024*1024;
  if(file.size>max)throw new Error(file.name+' is too large. Current limit is '+Math.round(max/1048576)+' MB.');
  const signed=await api('/api/uploads/sign',{method:'POST',body:JSON.stringify({name:file.name,mime:file.type||'application/octet-stream',size:file.size,kind})});
  const fd=new FormData();fd.append('cacheControl','3600');fd.append('',file);
  const up=await fetch(signed.signed_url,{method:'PUT',headers:{'x-upsert':'false'},body:fd});
  if(!up.ok)throw new Error('Upload failed for '+file.name);
  state.pendingAttachments.push({kind,name:file.name,mime:file.type||'application/octet-stream',size:file.size,path:signed.path});
  renderAttachmentTray();
}
async function addFiles(files){
  closeModal('attachSheet');
  const list=[...files];if(!list.length)return;
  toast('Uploading '+list.length+' attachment'+(list.length===1?'':'s')+'…',5000);
  try{for(const file of list)await uploadAttachment(file);toast('Attachment ready');}catch(e){toast(e.message||'Upload failed',4500);}
}
function addWebsiteAttachment(){
  const raw=$('websiteUrlInput').value.trim();if(!raw)return;
  let url;try{url=new URL(raw);}catch{toast('Enter a valid website URL');return;}
  if(!['http:','https:'].includes(url.protocol)){toast('Only http/https websites are supported');return;}
  state.pendingAttachments.push({kind:'url',name:url.hostname,url:url.toString()});
  $('websiteUrlInput').value='';closeModal('websiteModal');renderAttachmentTray();toast('Website attached');
}
function clearPendingAttachments(){state.pendingAttachments=[];renderAttachmentTray();}

function safeHttpUrl(v){try{const u=new URL(String(v||''));return ['http:','https:'].includes(u.protocol)?u.toString():'';}catch{return'';}}
async function saveWebSourcesToKnowledge(sources){if(!state.activeId){toast('Send one message first so this chat exists, then save sources to it.',4500);return;}const urls=[...new Set((sources||[]).map(s=>safeHttpUrl(s.url)).filter(Boolean))].slice(0,10);if(!urls.length)return;let added=0,dupes=0,failed=0;toast('Saving web sources to this chat…',5000);for(const url of urls){try{const d=await api('/api/knowledge/url',{method:'POST',body:JSON.stringify({url,collection:'Web Research',conversation_id:state.activeId})});if(d.duplicate)dupes++;else added++;}catch{failed++;}}state.knowledgeScope='chat';await loadKnowledge();toast(added+' saved to this chat'+(dupes?' · '+dupes+' already existed and were attached':'')+(failed?' · '+failed+' failed':''),4000);}
function messageSources(m){
  const refs=new Set([...String(m?.content||'').matchAll(/\[((?:K|W)\d+)\]/g)].map(x=>x[1]));
  const sourceRows=(m?.sources||[]).filter(s=>!refs.size||(s.ref&&refs.has(String(s.ref))));
  const seen=new Set(),out=[];
  for(const s of sourceRows){
    const key=String(s.source_id||s.url||s.title||s.ref||'');
    if(!key||seen.has(key))continue;seen.add(key);out.push(s);
  }
  return out.slice(0,12);
}
function assistantLogoHtml(){return '<div class="avatar neural-mark" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><b></b></div>';}
function appendMessage(m,scroll=true){
  $('emptyState').classList.add('hidden');
  const root=$('messages'),el=document.createElement('article');el.className='message '+m.role;if(m.id)el.dataset.messageId=m.id;
  const atts=(m.attachments||[]).slice(0,12),attHtml=atts.length?'<div class="message-attachments">'+atts.map(a=>'<span class="message-attachment">'+attIcon(a.kind)+' '+esc(a.name||a.url||'Attachment')+'</span>').join('')+'</div>':'';
  if(m.role==='assistant'){
    const meta=splitAssistantMeta(m.content||''),display=stripModelRefs(meta.body);
    const followHtml=meta.followups.length?'<div class="followup-row">'+meta.followups.map((q,i)=>'<button type="button" class="followup-chip" data-follow-index="'+i+'">'+esc(q)+'</button>').join('')+'</div>':'';
    el.innerHTML=assistantLogoHtml()+'<div class="message-content"><div class="message-body">'+md(display)+'</div>'+attHtml+followHtml+'<div class="message-actions"><button class="copy-icon" type="button" title="Copy" aria-label="Copy">⧉</button><button class="more-message" type="button" title="More actions" aria-label="More actions">•••</button></div></div>';
    el.querySelector('.copy-icon').onclick=()=>copyText(cleanMessageText(m.content||''));
    el.querySelector('.more-message').onclick=()=>openMessageActions(m);
    el.querySelectorAll('.followup-chip').forEach(btn=>btn.onclick=()=>{const q=meta.followups[Number(btn.dataset.followIndex||0)]||'';if(q)send(q);});
  }else{
    el.innerHTML='<div class="message-content user-message-content"><div class="message-body">'+md(m.content||'')+'</div>'+attHtml+'<div class="message-actions user-message-actions"><button class="copy-icon" type="button" title="Copy" aria-label="Copy">⧉</button></div></div>';
    el.querySelector('.copy-icon').onclick=()=>copyText(m.content||'');
  }
  root.append(el);if(scroll)scrollToLatest();
  return el;
}
function renderMessages(forceBottom=true){
  const root=$('messages'),before=root.scrollTop;root.innerHTML='';
  $('emptyState').classList.toggle('hidden',state.messages.length>0);
  state.messages.forEach(m=>appendMessage(m,false));
  if(forceBottom){state.followLatest=true;scrollToLatest(true);}else{root.scrollTop=before;updateJumpLatest();}
  header();requestAnimationFrame(updateLayoutMetrics);
}

async function send(text){
  const existing=activeRun();
  if(existing){existing.controller.abort();return;}
  const t=String(text||'').trim();
  if(!t&&!state.pendingAttachments.length)return;
  if(!ensurePrivateAuth())return;
  const sendingAttachments=state.pendingAttachments.map(a=>({...a}));
  const useResearch=state.webResearch&&sendingAttachments.length===0;
  const safeMobile=/iPhone|iPad|iPod/i.test(navigator.userAgent);
  const run={
    key:activeThreadKey(),draftId:state.draftId,conversationId:state.activeId,
    controller:new AbortController(),research:useResearch,
    model:$('modelSelect').value,knowledge:state.knowledgeEnabled,style:state.style,mode:state.mode,
  };
  const user={role:'user',content:t||'Please analyze the attached item.',attachments:sendingAttachments};
  const assistant={role:'assistant',content:'',sources:[]};
  let node=null;
  state.pendingRuns.set(run.key,run);state.followLatest=true;
  state.messages.push(user);appendMessage(user);
  clearPendingAttachments();
  $('input').value='';autoGrow();refreshSendingUI();renderConversations();

  try{
    const route=useResearch?'/api/research':'/api/chat';
    const r=await fetch(endpoint(route),{
      method:'POST',signal:run.controller.signal,headers:authHeaders(),
      body:JSON.stringify({
        conversation_id:run.conversationId,message:t||'Please analyze the attached item.',
        attachments:sendingAttachments,model:run.model,use_knowledge:run.knowledge,
        style_prompt:run.style,response_mode:run.mode,stream:useResearch?false:!safeMobile
      })
    });
    if(!r.ok){const d=await r.json().catch(()=>({}));throw Object.assign(new Error(d.error||'Request failed'),{data:d,status:r.status});}

    if(useResearch||safeMobile){
      const d=await r.json();
      assistant.content=String(d.content||'');
      assistant.sources=Array.isArray(d.sources)?d.sources:[];
      bindRunConversation(run,String(d.conversation_id||''),String(d.title||''));
      if(!assistant.content.trim())throw new Error('The model returned an empty response.');
      if(useResearch&&runIsVisible(run)&&d.external_search_query)toast('Privacy firewall query: '+d.external_search_query,5000);
    }else{
      const reader=r.body.getReader(),dec=new TextDecoder();let buffer='';
      while(true){
        const part=await reader.read();
        if(part.done)break;
        buffer+=dec.decode(part.value,{stream:true});
        const events=buffer.split('\n\n');buffer=events.pop()||'';
        for(const raw of events){
          if(!raw.startsWith('data:'))continue;
          const p=raw.slice(5).trim();
          if(!p||p==='[DONE]')continue;
          let e;try{e=JSON.parse(p);}catch{continue;}
          if(e.type==='meta'){
            bindRunConversation(run,String(e.conversation_id||''),String(e.title||''));
            if(Array.isArray(e.sources))assistant.sources=e.sources;
          }
          if(e.type==='token'){
            assistant.content+=e.text||'';
            if(runIsVisible(run)){
              if(!node||!node.isConnected)node=appendMessage(assistant,false);
              const meta=splitAssistantMeta(assistant.content);node.querySelector('.message-body').innerHTML=md(stripModelRefs(meta.body));
              scrollToLatest();
            }
          }
          if(e.type==='error')throw new Error(e.error||'Model error');
        }
      }
      if(!assistant.content.trim())throw new Error('The model returned an empty response.');
    }

    // The API saves each completed answer. Reload only the conversation that made
    // this request, and only when it is still visible. Never write to another chat.
    if(runIsVisible(run)){
      const refreshed=await refreshFinishedRun(run).catch(e=>{recordClientError('refreshFinishedRun',e);return false;});
      if(!refreshed){state.messages.push(assistant);renderMessages();}
    }
  }catch(e){
    if(runIsVisible(run)){
      const stopped=e?.name==='AbortError'||run.controller.signal.aborted;
      const refreshed=await refreshFinishedRun(run).catch(()=>false);
      if(stopped){
        if(!refreshed&&assistant.content.trim()){assistant.content+='\n\n_[Stopped]_';state.messages.push(assistant);renderMessages();}
        toast('Generation stopped');
      }else if(!refreshed){
        state.messages.push({role:'assistant',content:'Error: '+(e.message||'Request failed'),sources:[]});
        renderMessages();toast(e.message||'Request failed',4500);
      }else{
        toast('Answer recovered from the server.',3500);
      }
    }else if(e?.name!=='AbortError'&&!run.controller.signal.aborted){
      recordClientError('backgroundChat',e);
    }
  }finally{
    state.pendingRuns.delete(run.key);
    refreshSendingUI();renderConversations();
    await loadChats();
    if(runIsVisible(run)){$('input').focus();header();void status();}
  }
}

function knowledgeCollection(x){return String((x.metadata&&x.metadata.collection)||'').trim();}
function knowledgeLogicalSources(items){
  const out=[],groups=new Map();
  for(const x of items||[]){
    const g=String((x.metadata&&x.metadata.file_group)||'');
    if(!g){out.push(Object.assign({_items:[x]},x));continue;}
    if(!groups.has(g))groups.set(g,[]);
    groups.get(g).push(x);
  }
  for(const parts of groups.values()){
    parts.sort((a,b)=>Number(a.metadata?.part||0)-Number(b.metadata?.part||0));
    const first=parts[0],statuses=parts.map(x=>String(x.status||'queued'));
    const status=statuses.includes('failed')?'failed':statuses.includes('processing')?'processing':statuses.includes('queued')?'queued':'ready';
    out.push(Object.assign({},first,{
      _items:parts,
      _file_group:true,
      status,
      char_count:parts.reduce((n,x)=>n+Number(x.char_count||0),0),
      chunk_count:parts.reduce((n,x)=>n+Number(x.chunk_count||0),0),
      embedded_chunk_count:parts.reduce((n,x)=>n+Number(x.embedded_chunk_count||0),0),
      enabled:parts.some(x=>x.enabled!==false),
      last_error:parts.find(x=>x.last_error)?.last_error||null
    }));
  }
  return out.sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0));
}
function syncKnowledgeScopeUI(){
  if(state.knowledgeScope==='chat'&&!state.activeId)state.knowledgeScope='global';
  const chat=state.knowledgeScope==='chat',global=state.knowledgeScope==='global';
  const title=state.activeConversation?.title||'this chat';
  const shortTitle=title.length>18?title.slice(0,18)+'…':title;
  const useGlobal=state.activeConversation?.use_global_knowledge===true;

  $('knowledgeLibraryTab').classList.toggle('active',chat);
  $('knowledgeLibraryTab').disabled=!state.activeId;
  $('knowledgeLibraryTab').textContent=state.activeId?shortTitle:'This chat';
  $('knowledgeGlobalTab').classList.toggle('active',global);

  $('knowledgeTitle').textContent=chat?'Knowledge · '+title:'Global Knowledge';
  $('knowledgeScopeDescription').textContent=chat
    ? 'Only sources assigned specifically to "'+title+'" are shown here.'
    : 'General sources live here. A specialist chat only uses them when you turn Global Knowledge on for that chat.';
  $('knowledgeSearch').placeholder=chat?'Search '+title+' sources…':'Search Global Knowledge…';
  $('knowledgeAddScopeText').textContent=state.activeId
    ? 'Anything you add here becomes specialist Knowledge for "'+title+'" only.'
    : 'Send one message first so this chat exists, then add specialist Knowledge to it.';

  const mode=$('chatKnowledgeMode');
  mode.classList.toggle('hidden',!chat);
  if(chat){
    $('useGlobalKnowledgeToggle').checked=useGlobal;
    $('chatKnowledgeModeTitle').textContent=useGlobal?'Focused + Global':'Focused mode';
    $('chatKnowledgeModeText').textContent=useGlobal
      ? state.knowledgeChatCount+' '+title+' source'+(state.knowledgeChatCount===1?'':'s')+' + '+state.knowledgeGlobalCount+' Global source'+(state.knowledgeGlobalCount===1?'':'s')+' can be retrieved.'
      : 'Only the '+state.knowledgeChatCount+' source'+(state.knowledgeChatCount===1?'':'s')+' assigned to '+title+' can be retrieved. Global is off.';
  }
}
function switchKnowledgeTab(tab){
  const prevScope=state.knowledgeScope;
  if(tab==='global'||(!state.activeId&&tab==='library'))state.knowledgeScope='global';
  else if(tab==='library')state.knowledgeScope='chat';
  if(prevScope!==state.knowledgeScope)state.knowledgeSelected.clear();
  const library=tab!=='add';
  $('knowledgeLibraryPanel').classList.toggle('hidden',!library);
  $('knowledgeAddPanel').classList.toggle('hidden',library);
  $('knowledgeAddTab').classList.toggle('active',!library);
  syncKnowledgeScopeUI();
  if(library){loadKnowledge();setTimeout(()=>$('knowledgeSearch').focus(),40);}
}
function syncKnowledgeBulkUI(){
  const selected=state.knowledgeSelected.size,visible=state.knowledgeVisibleIds||[];
  const allVisible=visible.length>0&&visible.every(id=>state.knowledgeSelected.has(id));
  const someVisible=visible.some(id=>state.knowledgeSelected.has(id));
  $('knowledgeBulkCount').textContent=selected+' selected';
  $('bulkMoveKnowledge').disabled=selected===0;
  $('clearKnowledgeSelection').disabled=selected===0;
  $('knowledgeSelectAll').checked=allVisible;
  $('knowledgeSelectAll').indeterminate=!allVisible&&someVisible;
}
function clearKnowledgeSelection(render=true){
  state.knowledgeSelected.clear();syncKnowledgeBulkUI();if(render)renderKnowledge();
}
function toggleAllVisibleKnowledge(checked){
  for(const id of state.knowledgeVisibleIds||[]){
    if(checked)state.knowledgeSelected.add(id);else state.knowledgeSelected.delete(id);
  }
  renderKnowledge();
}
function openMoveKnowledgeMany(sources){
  const list=(sources||[]).filter(Boolean);if(!list.length)return;
  state.moveKnowledgeSources=list;
  const count=list.length;
  $('moveKnowledgeTitle').textContent=count===1?'Move Knowledge source':'Move '+count+' Knowledge sources';
  $('moveKnowledgeSourceName').textContent=count===1
    ? 'Move “'+String(list[0].title||'Untitled')+'” to Global Knowledge or a specific chat.'
    : 'Move all '+count+' selected sources together. Large multi-part files stay grouped automatically.';
  const sel=$('moveKnowledgeDestination');sel.innerHTML='';
  const add=(value,label)=>{const o=document.createElement('option');o.value=value;o.textContent=label;sel.append(o);};
  add('global','Global · available in every chat');
  if(state.activeId)add('chat:'+state.activeId,'Chat · '+activeTitle());
  for(const chat of state.conversations){
    if(chat.id===state.activeId)continue;
    add('chat:'+chat.id,'Chat · '+String(chat.title||'New chat'));
  }
  const allGlobal=list.every(x=>x.global_enabled===true||!(x.conversation_ids||[]).length);
  sel.value=allGlobal&&state.activeId?'chat:'+state.activeId:'global';
  $('confirmMoveKnowledge').textContent=count===1?'Move source':'Move '+count+' sources';
  openModal('moveKnowledgeModal');
}
function openMoveKnowledge(source){openMoveKnowledgeMany([source]);}
function openBulkMoveKnowledge(){
  const all=knowledgeLogicalSources(state.knowledge||[]);
  openMoveKnowledgeMany(all.filter(x=>state.knowledgeSelected.has(String(x.id))));
}
async function confirmMoveKnowledge(){
  const sources=state.moveKnowledgeSources||[];if(!sources.length)return;
  const dest=$('moveKnowledgeDestination').value;
  const target=dest.startsWith('chat:')?'chat':'global';
  const conversationId=dest.startsWith('chat:')?dest.slice(5):'';
  const btn=$('confirmMoveKnowledge');btn.disabled=true;
  try{
    const d=await api('/api/knowledge/bulk-move',{method:'POST',body:JSON.stringify({
      source_ids:sources.map(x=>x.id),target,conversation_id:conversationId
    })});
    closeModal('moveKnowledgeModal');
    state.moveKnowledgeSources=[];
    state.knowledgeSelected.clear();
    state.knowledgeScope=target==='global'?'global':(conversationId===state.activeId?'chat':state.knowledgeScope);
    await loadKnowledge();syncKnowledgeScopeUI();
    const count=Number(d.logical_count||sources.length);
    toast(target==='global'
      ? 'Moved '+count+' source'+(count===1?'':'s')+' to Global Knowledge'
      : 'Moved '+count+' source'+(count===1?'':'s')+' to '+($('moveKnowledgeDestination').selectedOptions[0]?.textContent||'chat'),4500);
  }catch(e){toast(e.message||'Could not move selected sources',4500);}
  finally{btn.disabled=false;$('confirmMoveKnowledge').textContent='Move source';}
}

function sourceNeedsAttention(x){
  const q=x?.quality||{}
  return String(x?.status||'')==='failed'||['failed','poor','review'].includes(String(q.label||''))
}
function setKnowledgeView(view){
  state.knowledgeView=['all','processing','attention'].includes(view)?view:'all';
  for(const [name,id] of [['all','knowledgeViewAll'],['processing','knowledgeViewProcessing'],['attention','knowledgeViewAttention']]){
    const el=$(id);if(el)el.classList.toggle('active',state.knowledgeView===name);
  }
  if($('knowledgeViewAttention'))$('knowledgeViewAttention').classList.toggle('attention-active',state.knowledgeView==='attention');
  renderKnowledge();
}
function qualityLabel(q){
  if(!q)return 'unrated';
  if(q.score==null)return String(q.label||'processing');
  return String(q.score)+' · '+String(q.label||'').replace(/^./,c=>c.toUpperCase());
}
async function loadKnowledgeInspector(query=''){
  const id=state.inspectorSourceId;if(!id)return;
  const encoded=encodeURIComponent(id),qs=query?'?q='+encodeURIComponent(query):'';
  const d=await api('/api/knowledge/'+encoded+'/inspect'+qs);
  const s=d.source||{},q=s.quality||{},m=s.metadata||{};
  $('knowledgeInspectorTitle').textContent=s.title||'Knowledge Inspector';
  $('knowledgeInspectorSubtitle').textContent=(s.source_type||'source')+' · verify extracted text, metadata and searchability';
  $('knowledgeInspectorQuality').textContent=qualityLabel(q);
  $('knowledgeInspectorStatus').textContent=String(s.status||'unknown').replace(/^./,c=>c.toUpperCase());
  $('knowledgeInspectorChunks').textContent=Number(s.embedded_chunk_count||0).toLocaleString()+' / '+Number(s.chunk_count||0).toLocaleString();
  $('knowledgeInspectorChars').textContent=Number(s.char_count||0).toLocaleString();
  const issues=Array.isArray(q.issues)?q.issues:[];
  $('knowledgeInspectorIssues').classList.toggle('hidden',!issues.length);
  $('knowledgeInspectorIssues').innerHTML=issues.map(x=>'• '+esc(x)).join('<br>');
  $('inspectorTopic').value=m.topic||'';
  $('inspectorSubtopic').value=m.subtopic||'';
  $('inspectorAuthor').value=m.author||'';
  $('inspectorSourceDate').value=/^\d{4}-\d{2}-\d{2}$/.test(String(m.source_date||''))?m.source_date:'';
  $('inspectorEvidenceType').value=['unrated','official','research','practitioner','community','personal_data','reference'].includes(String(m.evidence_type||''))?m.evidence_type:'unrated';
  $('inspectorAuthority').value=String(Math.max(1,Math.min(5,Number(m.authority||3))));
  $('inspectorTags').value=Array.isArray(m.tags)?m.tags.join(', '):'';
  $('retryInspectorSource').classList.toggle('hidden',!q.can_retry);
  $('knowledgeInspectorChunkSummary').textContent=(query?d.match_count+' matching':'Showing '+Math.min(d.chunks?.length||0,d.match_count||0)+' of '+Number(d.match_count||0))+' extracted chunks';
  const root=$('knowledgeInspectorChunksList');root.innerHTML='';
  for(const c of d.chunks||[]){
    const el=document.createElement('div');el.className='inspector-chunk';
    const page=String(c.content||'').match(/\[PDF page\s+(\d+)/i)?.[1];
    const time=String(c.content||'').match(/^\[(\d\d:\d\d(?:-\d\d:\d\d)?)\]/)?.[1];
    el.innerHTML='<div class="inspector-chunk-head"><span>Chunk '+(Number(c.chunk_index)+1)+(page?' · PDF page '+esc(page):time?' · '+esc(time):'')+'</span><span>'+esc(String(c.content_hash||'').slice(0,10))+'</span></div><pre>'+esc(c.content||'')+'</pre>';
    root.append(el);
  }
  if(!(d.chunks||[]).length)root.innerHTML='<div class="knowledge-empty"><strong>No matching extracted text</strong><p>Try another search, or review the source quality and processing status above.</p></div>';
}
async function openKnowledgeInspector(source){
  state.inspectorSourceId=String(source?.id||'');if(!state.inspectorSourceId)return;
  $('knowledgeInspectorTest').classList.add('hidden');$('knowledgeInspectorTest').innerHTML='';
  $('knowledgeInspectorAnswer').classList.add('hidden');$('knowledgeInspectorAnswer').innerHTML='';
  $('knowledgeInspectorAsk').value='';$('knowledgeInspectorSearch').value='';
  openModal('knowledgeInspectorModal');
  $('knowledgeInspectorChunkSummary').textContent='Loading extracted Knowledge…';
  $('knowledgeInspectorChunksList').innerHTML='';
  try{await loadKnowledgeInspector('');}catch(e){toast(e.message||'Could not inspect this source',4500);}
}
async function saveInspectorMetadata(){
  if(!state.inspectorSourceId)return;
  const tags=$('inspectorTags').value.split(',').map(x=>x.trim()).filter(Boolean);
  const patch={
    topic:$('inspectorTopic').value.trim(),
    subtopic:$('inspectorSubtopic').value.trim(),
    author:$('inspectorAuthor').value.trim(),
    source_date:$('inspectorSourceDate').value,
    evidence_type:$('inspectorEvidenceType').value,
    authority:Number($('inspectorAuthority').value||3),
    tags
  };
  const b=$('saveInspectorMetadata');b.disabled=true;
  try{
    await api('/api/knowledge/'+encodeURIComponent(state.inspectorSourceId),{method:'PATCH',body:JSON.stringify({metadata_patch:patch})});
    await Promise.all([loadKnowledge(),loadKnowledgeInspector($('knowledgeInspectorSearch').value.trim())]);
    toast('Source metadata saved');
  }catch(e){toast(e.message||'Could not save metadata',4500);}
  finally{b.disabled=false;}
}
function parseSourceTestQuestions(value){
  return String(value||'').split(/\n+/).map(x=>x.replace(/^\s*\d+[.)]\s*/,'').trim()).filter(x=>x.length>12).slice(0,5);
}
async function askInspectorSource(questionOverride=''){
  if(!state.inspectorSourceId)return;
  const question=String(questionOverride||$('knowledgeInspectorAsk').value||'').trim();
  if(!question){toast('Ask a question about this source first.');return;}
  const b=$('askInspectorSource');b.disabled=true;
  const out=$('knowledgeInspectorAnswer');out.classList.remove('hidden');out.innerHTML='<span class="answer-loading">Answering only from this source…</span>';
  try{
    const d=await api('/api/knowledge/'+encodeURIComponent(state.inspectorSourceId)+'/ask',{method:'POST',body:JSON.stringify({question}),timeoutMs:90000});
    out.innerHTML='<div class="inspector-answer-label">Source-only answer</div><div class="inspector-answer-body">'+md(d.content||'No answer returned.')+'</div>';
  }catch(e){out.textContent=e.message||'Could not answer from this source';}
  finally{b.disabled=false;}
}
async function testInspectorSource(){
  if(!state.inspectorSourceId)return;
  const b=$('testInspectorSource');b.disabled=true;
  try{
    const d=await api('/api/knowledge/'+encodeURIComponent(state.inspectorSourceId)+'/test',{method:'POST',body:'{}',timeoutMs:90000});
    const questions=parseSourceTestQuestions(d.questions);
    const root=$('knowledgeInspectorTest');root.innerHTML='';
    if(!questions.length){root.textContent=d.questions||'No questions returned.';}
    else questions.forEach((q,i)=>{
      const row=document.createElement('div');row.className='source-test-question';
      row.innerHTML='<span><b>'+(i+1)+'.</b> '+esc(q)+'</span><button type="button" class="secondary-btn">Ask this</button>';
      row.querySelector('button').onclick=()=>{ $('knowledgeInspectorAsk').value=q; askInspectorSource(q); };
      root.append(row);
    });
    root.classList.remove('hidden');
  }catch(e){toast(e.message||'Could not generate source test',4500);}
  finally{b.disabled=false;}
}
async function suggestInspectorMetadata(){
  if(!state.inspectorSourceId)return;
  const b=$('suggestInspectorMetadata');b.disabled=true;
  try{
    const d=await api('/api/knowledge/'+encodeURIComponent(state.inspectorSourceId)+'/suggest-metadata',{method:'POST',body:'{}',timeoutMs:90000});
    const m=d.metadata||{};
    if(m.topic!=null)$('inspectorTopic').value=m.topic;
    if(m.subtopic!=null)$('inspectorSubtopic').value=m.subtopic;
    if(m.author!=null)$('inspectorAuthor').value=m.author;
    if(/^\d{4}-\d{2}-\d{2}$/.test(String(m.source_date||'')))$('inspectorSourceDate').value=m.source_date;
    if(['unrated','official','research','practitioner','community','personal_data','reference'].includes(String(m.evidence_type||'')))$('inspectorEvidenceType').value=m.evidence_type;
    if(m.authority!=null)$('inspectorAuthority').value=String(Math.max(1,Math.min(5,Number(m.authority||3))));
    if(Array.isArray(m.tags))$('inspectorTags').value=m.tags.join(', ');
    $('inspectorMetadataPanel').open=true;
    toast('Suggested details filled in · review before saving',4000);
  }catch(e){toast(e.message||'Could not suggest source details',4500);}
  finally{b.disabled=false;}
}
async function retryInspectorSource(){
  if(!state.inspectorSourceId)return;
  const b=$('retryInspectorSource');b.disabled=true;
  try{
    await api('/api/knowledge/'+encodeURIComponent(state.inspectorSourceId)+'/retry',{method:'POST',body:'{}'});
    await loadKnowledge();await loadKnowledgeInspector('');
    toast('Processing retry queued');
    scheduleKnowledgePoll();
  }catch(e){toast(e.message||'Could not retry source',4500);}
  finally{b.disabled=false;}
}
async function retryKnowledgeFromRow(source){
  const id=String(source?.id||'');if(!id)return;
  try{
    await api('/api/knowledge/'+encodeURIComponent(id)+'/retry',{method:'POST',body:'{}'});
    toast('Retry queued');await loadKnowledge();scheduleKnowledgePoll();
  }catch(e){toast(e.message||'Could not retry source',4500);}
}
function openRetrievalDebugger(){
  if(!state.activeId){toast('Open a specialist chat first.');return;}
  $('retrievalDebugQuery').value=$('input').value.trim();
  $('retrievalDebugSummary').textContent='Enter a question to inspect the retrieval pipeline.';
  $('retrievalDebugResults').innerHTML='';
  openModal('retrievalDebugModal');
}
async function runRetrievalDebugger(){
  if(!state.activeId){toast('Open a chat first.');return;}
  const query=$('retrievalDebugQuery').value.trim();if(!query){toast('Enter a question to inspect.');return;}
  const b=$('runRetrievalDebug');b.disabled=true;
  try{
    const d=await api('/api/retrieval/debug',{method:'POST',body:JSON.stringify({query,conversation_id:state.activeId}),timeoutMs:45000});
    $('retrievalDebugSummary').textContent=Number(d.candidate_count||0)+' candidates → '+Number(d.selected_count||0)+' selected · Global '+(d.include_global?'included':'off');
    const root=$('retrievalDebugResults');root.innerHTML='';
    for(const x of d.evaluated||[]){
      const el=document.createElement('div');el.className='retrieval-result '+(x.selected?'selected':'rejected');
      const reason=x.selected?(x.retrieval_reasons||[]).join(' · '):(x.rejection_reason||'not selected');
      el.innerHTML='<div class="retrieval-result-top"><strong>'+esc(x.title||'Knowledge')+' · section '+(Number(x.chunk_index||0)+1)+'</strong><span class="retrieval-result-badge">'+(x.selected?'SELECTED':'REJECTED')+'</span></div><small>relevance '+Number(x.relevance_score||0).toFixed(3)+' · similarity '+Number(x.similarity||0).toFixed(3)+' · '+esc(reason)+'</small><p>'+esc(x.content_preview||'')+'</p>';
      root.append(el);
    }
    if(!(d.evaluated||[]).length)root.innerHTML='<div class="knowledge-empty"><strong>No candidates</strong><p>No ready Knowledge passage cleared the scoped semantic search for this question.</p></div>';
  }catch(e){toast(e.message||'Could not inspect retrieval',4500);}
  finally{b.disabled=false;}
}

function renderKnowledge(){
  const root=$('knowledgeList');root.innerHTML='';
  const q=$('knowledgeSearch').value.trim().toLowerCase();
  const type=$('knowledgeTypeFilter').value;
  const statusFilter=$('knowledgeStatusFilter').value;
  const raw=state.knowledge||[],all=knowledgeLogicalSources(raw);
  const processingCount=all.filter(x=>['queued','processing'].includes(String(x.status||''))).length;
  const attentionCount=all.filter(sourceNeedsAttention).length;
  if($('knowledgeViewAllCount'))$('knowledgeViewAllCount').textContent=all.length;
  if($('knowledgeViewProcessingCount'))$('knowledgeViewProcessingCount').textContent=processingCount;
  if($('knowledgeViewAttentionCount'))$('knowledgeViewAttentionCount').textContent=attentionCount;
  if($('knowledgeViewProcessing'))$('knowledgeViewProcessing').classList.toggle('hidden',processingCount===0&&state.knowledgeView!=='processing');
  if($('knowledgeViewAttention'))$('knowledgeViewAttention').classList.toggle('hidden',attentionCount===0&&state.knowledgeView!=='attention');
  for(const [name,id] of [['all','knowledgeViewAll'],['processing','knowledgeViewProcessing'],['attention','knowledgeViewAttention']]){
    if($(id))$(id).classList.toggle('active',state.knowledgeView===name);
  }
  const allIds=new Set(all.map(x=>String(x.id)));
  for(const id of [...state.knowledgeSelected])if(!allIds.has(id))state.knowledgeSelected.delete(id);
  $('knowledgeCount').textContent=all.length+' source'+(all.length===1?'':'s');
  $('knowledgeTotalSources').textContent=all.length.toLocaleString();
  $('knowledgeReadySources').textContent=all.filter(x=>x.status==='ready').length.toLocaleString();
  $('knowledgeTotalChunks').textContent=raw.reduce((n,x)=>n+Number(x.chunk_count||0),0).toLocaleString();
  const rows=all.filter(x=>{
    const collection=knowledgeCollection(x).toLowerCase();
    const matchesQ=!q||String(x.title||'').toLowerCase().includes(q)||collection.includes(q)||String(x.source_type||'').toLowerCase().includes(q);
    const matchesType=type==='all'||String(x.source_type||'')===type;
    const matchesStatus=statusFilter==='all'||String(x.status||'')===statusFilter;
    const matchesView=state.knowledgeView==='processing'?['queued','processing'].includes(String(x.status||'')):
      state.knowledgeView==='attention'?sourceNeedsAttention(x):true;
    return matchesQ&&matchesType&&matchesStatus&&matchesView;
  });
  state.knowledgeVisibleIds=rows.map(x=>String(x.id));
  syncKnowledgeBulkUI();
  if(!rows.length){
    root.innerHTML='<div class="knowledge-empty"><div class="knowledge-empty-icon">▤</div><strong>'+(all.length?'No matching sources':(state.knowledgeScope==='chat'?'No '+esc(activeTitle())+' sources yet':'No Global Knowledge yet'))+'</strong><p>'+(all.length?'Try a different search or filter.':(state.knowledgeScope==='chat'?'Add only the sources you want this specialist chat to know.':'Put general-purpose sources here when you want multiple chats to share them.'))+'</p>'+(all.length||state.knowledgeScope!=='chat'?'':'<button id="emptyAddKnowledge" class="primary-btn">＋ Add source to '+esc(activeTitle())+'</button>')+'</div>';
    const b=$('emptyAddKnowledge');if(b)b.onclick=()=>switchKnowledgeTab('add');
    return;
  }
  rows.forEach(x=>{
    const total=Number(x.chunk_count||0),done=Number(x.embedded_chunk_count||0),status=String(x.status||'queued'),collection=knowledgeCollection(x),meta=x.metadata||{};
    const media=['video','audio'].includes(String(x.source_type||''));
    const pdfSource=String(x.source_type||'')==='pdf';
    const pct=media&&status!=='ready'?Math.max(3,Number(meta.media_progress||0)):
      pdfSource&&status!=='ready'?Math.max(3,Number(meta.pdf_progress||0)):
      (total?Math.round((done/total)*100):(status==='ready'?100:3));
    const typeLabel=x.source_type==='website'?'Website':x.source_type==='file'?'File':pdfSource?'PDF':x.source_type==='video'?'Video':x.source_type==='audio'?'Audio':'Notes';
    const typeIcon=x.source_type==='website'?'↗':x.source_type==='file'?'▤':pdfSource?'▧':x.source_type==='video'?'▶':x.source_type==='audio'?'♪':'✎';
    const partCount=(x._items||[]).length;
    const mediaDetail=media?(
      status==='ready'
        ? ((meta.duration_seconds?' · '+Math.floor(Number(meta.duration_seconds)/60)+':'+String(Math.floor(Number(meta.duration_seconds)%60)).padStart(2,'0'):'')+(meta.reference_sections?' · '+Number(meta.reference_sections)+' searchable refs':''))
        : (' · '+esc(String(meta.media_stage||status).replaceAll('_',' '))+(meta.duration_seconds?' · '+Math.floor(Number(meta.duration_seconds)/60)+':'+String(Math.floor(Number(meta.duration_seconds)%60)).padStart(2,'0'):''))
    ):'';
    const pdfDetail=meta.pdf_pages?(' · '+Number(meta.pdf_pages)+' pages · '+Number(meta.pdf_ocr_pages||0)+' OCR'+(Number(meta.pdf_ai_ocr_pages||0)?' ('+Number(meta.pdf_ai_ocr_pages||0)+' AI fallback)':'')+' · '+Number(meta.pdf_words||0).toLocaleString()+' words'):'';
    const persistentPdfDetail=pdfSource?(
      status==='ready'
        ? formatBytes(Number(meta.file_size||0))+(meta.pdf_words?' · '+Number(meta.pdf_words).toLocaleString()+' words':'')+' · '+done.toLocaleString()+'/'+total.toLocaleString()+' chunks'
        : formatBytes(Number(meta.file_size||0))+' · '+esc(String(meta.pdf_stage||status).replaceAll('_',' '))+(meta.pdf_words?' · '+Number(meta.pdf_words).toLocaleString()+' words':'')
    ):'';
    const baseDetail=media?(formatBytes(Number(meta.file_size||0))+mediaDetail):
      pdfSource?persistentPdfDetail:
      (Number(x.char_count||0).toLocaleString()+' chars · '+done.toLocaleString()+'/'+total.toLocaleString()+' chunks'+pdfDetail);
    const globalSource=x.global_enabled===true||!(x.conversation_ids||[]).length;
    const scopeBadge='<span class="knowledge-scope-chip '+(globalSource?'global':'chat')+'">'+(globalSource?'GLOBAL':'CHAT ONLY')+'</span>';
    const quality=x.quality||{},qualityChip='<span class="knowledge-quality-chip '+esc(String(quality.label||'unrated'))+'">'+esc(qualityLabel(quality))+'</span>';
    const selected=state.knowledgeSelected.has(String(x.id));
    const el=document.createElement('div');el.className='knowledge-item knowledge-library-item'+(x.enabled===false?' disabled':'')+(selected?' selected':'');
    el.innerHTML='<label class="knowledge-row-select" title="Select source"><input class="select-source" type="checkbox" '+(selected?'checked':'')+' /></label><div class="knowledge-card-body"><div class="knowledge-card-top"><div class="knowledge-source-icon">'+typeIcon+'</div><div class="knowledge-source-copy"><div class="knowledge-source-title-row"><strong>'+esc(x.title||'Untitled')+'</strong></div><div class="knowledge-badge-row">'+scopeBadge+qualityChip+(collection?'<span class="knowledge-collection-chip">'+esc(collection)+'</span>':'')+'</div></div></div><div class="knowledge-card-meta">'+typeLabel+(partCount>1?' · '+partCount+' segments':'')+' · '+baseDetail+' · '+(status==='ready'?'Ready':esc(status.replace(/^./,c=>c.toUpperCase())))+'</div>'+(status==='processing'||status==='queued'?'<div class="mini-progress"><span style="width:'+Math.max(3,pct)+'%"></span></div>':'')+(x.last_error?'<small class="source-error">'+esc(x.last_error)+'</small>':'')+'<div class="knowledge-card-footer"><button class="inspect-source" type="button">Inspect</button>'+(quality.can_retry?'<button class="retry-source" type="button">Retry</button>':'')+'<details class="knowledge-more"><summary aria-label="More source actions">•••</summary><div class="knowledge-more-menu"><button class="move-source" type="button">Move</button><button class="toggle" type="button">'+(x.enabled===false?'Enable':'Disable')+'</button><button class="rename" type="button">Rename</button>'+((state.knowledgeScope==='chat'&&globalSource)?'':'<button class="delete danger-hover" type="button">'+(state.knowledgeScope==='chat'?'Remove from chat':'Delete')+'</button>')+'</div></details></div></div>';
    const items=x._items||[x];
    el.querySelector('.select-source').onchange=e=>{if(e.target.checked)state.knowledgeSelected.add(String(x.id));else state.knowledgeSelected.delete(String(x.id));renderKnowledge();};
    el.querySelector('.inspect-source').onclick=()=>openKnowledgeInspector(x);
    const retry=el.querySelector('.retry-source');if(retry)retry.onclick=()=>retryKnowledgeFromRow(x);
    el.querySelector('.move-source').onclick=()=>openMoveKnowledge(x);
    el.querySelector('.toggle').onclick=async()=>{const value=x.enabled===false;await Promise.all(items.map(i=>api('/api/knowledge/'+encodeURIComponent(i.id),{method:'PATCH',body:JSON.stringify({enabled:value})})));loadKnowledge();};
    el.querySelector('.rename').onclick=async()=>{const n=prompt('Rename knowledge source',x.title||'');if(n&&n.trim()){await Promise.all(items.map(i=>api('/api/knowledge/'+encodeURIComponent(i.id),{method:'PATCH',body:JSON.stringify({title:n.trim().slice(0,160)})})));loadKnowledge();}};
    const del=el.querySelector('.delete');if(del)del.onclick=async()=>{const removing=state.knowledgeScope==='chat';const msg=removing?'Remove “'+x.title+'” from this chat? If no other chat uses it, it will automatically become Global.':'Permanently delete “'+x.title+'”?';if(confirm(msg)){await Promise.all(items.map(i=>api('/api/knowledge/'+encodeURIComponent(i.id)+(removing?'?conversation_id='+encodeURIComponent(state.activeId):''),{method:'DELETE'})));await loadKnowledge();toast(removing?'Removed from this chat':'Knowledge source deleted');}};
    root.append(el);
  });
}

function formatBytes(n){n=Number(n||0);if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(n<10485760?1:0)+' MB';}
function renderKnowledgeFileQueue(){
  const root=$('knowledgeFileQueue'),rows=state.knowledgeFileUploads||[];
  if(!rows.length){root.classList.add('hidden');root.innerHTML='';setFilePickerLabel('knowledgeFile','knowledgeTextFileLabel');return;}
  root.classList.remove('hidden');
  const selected=rows.filter(r=>r.status==='selected').length;
  const ready=rows.filter(r=>r.status==='ready').length;
  const duplicates=rows.filter(r=>r.status==='duplicate').length;
  const failed=rows.filter(r=>r.status==='failed').length;
  const working=rows.length-selected-ready-duplicates-failed;
  root.innerHTML='<div class="knowledge-upload-summary"><strong>'+(selected?selected+' file'+(selected===1?'':'s')+' staged':'Upload activity')+'</strong><span>'+(selected?selected+' ready to upload · ':'')+ready+' ready'+(duplicates?' · '+duplicates+' duplicate'+(duplicates===1?'':'s')+' blocked':'')+(working?' · '+working+' working':'')+(failed?' · '+failed+' failed':'')+'</span></div>';
  rows.forEach(r=>{
    const el=document.createElement('div');el.className='knowledge-upload-row'+(r.status==='selected'?' staged':'');
    el.innerHTML='<div class="knowledge-upload-top"><div class="knowledge-upload-name">'+esc(r.name)+'</div><div class="knowledge-upload-row-actions"><div class="knowledge-upload-state '+esc(r.status)+'">'+esc(r.label||r.status)+'</div>'+(r.status==='selected'?'<button class="remove-staged" type="button" title="Remove before upload">×</button>':(r.status==='failed'&&r.file?'<button class="retry-staged" type="button" title="Retry this PDF">Retry</button>':''))+'</div></div><div class="knowledge-upload-meta"><span>'+formatBytes(r.size)+'</span><span>'+esc(r.detail||'')+'</span></div><div class="knowledge-upload-bar"><span style="width:'+Math.max(0,Math.min(100,Number(r.pct||0)))+'%"></span></div>';
    const remove=el.querySelector('.remove-staged');if(remove)remove.onclick=()=>removeStagedKnowledgeFile(r.id);const retry=el.querySelector('.retry-staged');if(retry)retry.onclick=()=>{r.status='selected';r.label='retry ready';r.pct=0;r.detail='Ready to scan again';renderKnowledgeFileQueue();};
    root.append(el);
  });
  setFilePickerLabel('knowledgeFile','knowledgeTextFileLabel');
}
function setKnowledgeFileStatus(row,status,pct,detail,label){
  row.status=status;row.pct=Math.max(0,Math.min(100,Number(pct||0)));row.detail=detail||'';row.label=label||status;
  renderKnowledgeFileQueue();
  const rows=state.knowledgeFileUploads||[];
  if(rows.length){
    const avg=Math.round(rows.reduce((n,r)=>n+Number(r.pct||0),0)/rows.length);
    $('ingestProgressBar').style.width=avg+'%';
    const done=rows.filter(r=>['ready','duplicate','failed'].includes(r.status)).length;
    $('ingestProgressText').textContent=done+' / '+rows.length+' files finished'+(rows.some(r=>r.status==='duplicate')?' · duplicates blocked':'');
  }
}
function updateKnowledgeUploadRows(){
  const rows=state.knowledgeFileUploads||[];
  if(!rows.length)return;
  for(const row of rows){
    if(!row.sourceIds?.length || ['duplicate','failed','ready'].includes(row.status))continue;
    const items=(state.knowledge||[]).filter(x=>row.sourceIds.includes(x.id));
    if(!items.length)continue;
    const total=items.reduce((n,x)=>n+Number(x.chunk_count||0),0);
    const done=items.reduce((n,x)=>n+Number(x.embedded_chunk_count||0),0);
    const hasError=items.find(x=>x.status==='failed'||x.last_error);
    if(hasError){setKnowledgeFileStatus(row,'failed',100,hasError.last_error||'Indexing failed','failed');continue;}
    if(items.length===row.sourceIds.length && items.every(x=>x.status==='ready')){
      setKnowledgeFileStatus(row,'ready',100,total+' / '+total+' reference chunks indexed','ready');
    }else{
      const pdfItem=items.find(x=>String(x.source_type||'')==='pdf');
      if(pdfItem){
        const m=pdfItem.metadata||{},stage=String(m.pdf_stage||'processing').replaceAll('_',' ');
        const pct=Math.max(Number(m.pdf_progress||15),total?80+Math.round((done/total)*20):15);
        setKnowledgeFileStatus(row,'processing',pct,(m.pdf_words?Number(m.pdf_words).toLocaleString()+' words · ':'')+stage,stage);
        continue;
      }
      const mediaItem=items.find(x=>['video','audio'].includes(String(x.source_type||'')));
      if(mediaItem){
        const m=mediaItem.metadata||{},stage=String(m.media_stage||'processing').replaceAll('_',' ');
        const pct=Math.max(Number(m.media_progress||15),total?80+Math.round((done/total)*20):15);
        setKnowledgeFileStatus(row,'processing',pct,(m.reference_sections?Number(m.reference_sections)+' reference sections · ':'')+stage,stage);
      }else{
        const pct=70+(total?Math.round((done/total)*30):0);
        setKnowledgeFileStatus(row,'indexing',pct,done+' / '+total+' chunks indexed','indexing');
      }
    }
  }
}
function scheduleKnowledgePoll(){
  if(state.knowledgePollTimer){clearTimeout(state.knowledgePollTimer);state.knowledgePollTimer=null;}
  const open=!$('knowledgeModal').classList.contains('hidden');
  const working=(state.knowledge||[]).some(x=>!['ready','failed'].includes(String(x.status||''))) ||
    (state.knowledgeFileUploads||[]).some(x=>!['ready','duplicate','failed','selected'].includes(x.status));
  if(open&&working)state.knowledgePollTimer=setTimeout(()=>loadKnowledge(),2000);
}
async function sha256File(file){
  const buffer=await file.arrayBuffer();
  const digest=await crypto.subtle.digest('SHA-256',buffer);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function stageKnowledgeFiles(files){
  const rows=[...files].map((file,i)=>({id:String(Date.now())+'-'+i+'-'+Math.random(),name:file.name,size:file.size,status:'selected',label:'selected',pct:0,detail:'Ready to add',sourceIds:[],file,signature:file.name+'|'+file.size+'|'+file.lastModified}));
  state.knowledgeFileUploads.push(...rows);
  renderKnowledgeFileQueue();
  return rows;
}
function stageTextKnowledgeFiles(files){
  const existing=new Set((state.knowledgeFileUploads||[]).filter(r=>r.status==='selected').map(r=>r.signature));
  let added=0,skipped=0;
  for(const file of files){
    const signature=file.name+'|'+file.size+'|'+file.lastModified;
    if(existing.has(signature)){skipped++;continue;}
    existing.add(signature);added++;
    state.knowledgeFileUploads.push({
      id:(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random()),
      name:file.name,size:file.size,status:'selected',label:'staged',pct:0,
      detail:'Ready to upload with this batch',sourceIds:[],file,signature
    });
  }
  renderKnowledgeFileQueue();
  if(added)toast(added+' file'+(added===1?'':'s')+' staged'+(skipped?' · '+skipped+' already staged':''),2500);
  else if(skipped)toast('Those files are already staged.',2500);
}
function removeStagedKnowledgeFile(id){
  state.knowledgeFileUploads=(state.knowledgeFileUploads||[]).filter(r=>r.id!==id||r.status!=='selected');
  renderKnowledgeFileQueue();
}
async function loadKnowledge(){
  const seq=++state.knowledgeLoadSeq;
  try{
    syncKnowledgeScopeUI();
    const scope=state.knowledgeScope,conversationId=state.activeId||'';
    const qs=scope==='global'? '?scope=global' : '?scope=chat&conversation_id='+encodeURIComponent(conversationId);
    $('knowledgeList').setAttribute('aria-busy','true');
    const d=await api('/api/knowledge'+qs);
    if(seq!==state.knowledgeLoadSeq||scope!==state.knowledgeScope||conversationId!==(state.activeId||''))return;
    state.knowledge=d.sources||[];
    state.knowledgeChatCount=Number(d.chat_count||0);
    state.knowledgeGlobalCount=Number(d.global_count||0);
    if(state.activeConversation&&scope==='chat')state.activeConversation.use_global_knowledge=d.use_global_knowledge===true;
    syncKnowledgeScopeUI();renderKnowledge();updateKnowledgeUploadRows();scheduleKnowledgePoll();
  }catch(e){
    if(seq!==state.knowledgeLoadSeq)return;
    $('knowledgeList').innerHTML='<div class="error-list">'+esc(e.message)+'</div>';$('knowledgeCount').textContent='Load failed';
  }finally{
    if(seq===state.knowledgeLoadSeq)$('knowledgeList').removeAttribute('aria-busy');
  }
}
async function importKnowledgeUrls(){
  if(!state.activeId){toast('Send one message first so this chat exists, then add Knowledge.',4500);return;}
  const raw=$('knowledgeUrls').value.trim();if(!raw)return;
  const collection=$('knowledgeCollection').value.trim().slice(0,80);
  const urls=[...new Set(raw.split(/\s+/).filter(Boolean))].slice(0,20);
  if(!urls.length)return;
  const btn=$('importKnowledgeUrls');btn.disabled=true;
  let added=0,duplicates=0,failed=0;
  try{
    for(let i=0;i<urls.length;i++){
      $('knowledgeUrlStatus').textContent='Importing '+(i+1)+' / '+urls.length+'…';
      try{
        const d=await api('/api/knowledge/url',{method:'POST',body:JSON.stringify({url:urls[i],collection,conversation_id:state.activeId})});
        if(d.duplicate)duplicates++;else added++;
      }catch{failed++;}
    }
    $('knowledgeUrls').value='';
    $('knowledgeUrlStatus').textContent=added+' page'+(added===1?'':'s')+' queued'+(duplicates?' · '+duplicates+' duplicate'+(duplicates===1?'':'s')+' skipped':'')+(failed?' · '+failed+' failed':'')+'. You can close the tab while indexing continues.';
    await loadKnowledge();
    if(added)switchKnowledgeTab('library');
    toast(added?'Web knowledge added to this chat':'Website import finished',3500);
  }finally{btn.disabled=false;}
}
async function ingestOne(j,conversationId=state.activeId){
  if(!conversationId)throw new Error('Send one message first so this chat exists, then add Knowledge.')
  const collection=$('knowledgeCollection').value.trim().slice(0,80);
  const metadata=Object.assign({},j.metadata||{},{collection});
  const d=await api('/api/knowledge',{method:'POST',body:JSON.stringify({title:j.title,text:j.text,source_type:j.type,metadata,conversation_id:conversationId})});
  if(d.duplicate)return{chunks:0,duplicate:true,duplicateReason:d.duplicate_reason||'content',sourceId:d.source?.id||null,title:(d.source&&d.source.title)||j.title};
  return{chunks:Number(d.chunk_count||0),duplicate:false,sourceId:d.source_id||null,title:j.title};
}
async function ingestJobs(jobs,button){
  if(!jobs.length){toast('Nothing selected to add.');return;}
  button.disabled=true;$('ingestProgress').classList.remove('hidden');$('ingestProgressBar').style.width='15%';
  let queued=0,duplicates=0;
  try{
    for(let i=0;i<jobs.length;i++){
      $('ingestProgressText').textContent='Queueing '+(i+1)+' / '+jobs.length+': '+jobs[i].title;
      const r=await ingestOne(jobs[i]);queued+=r.chunks;if(r.duplicate)duplicates++;
      $('ingestProgressBar').style.width=Math.round(((i+1)/jobs.length)*90)+'%';
    }
    $('ingestProgressBar').style.width='100%';
    $('ingestProgressText').textContent=(queued?queued.toLocaleString()+' chunks queued. ':'')+(duplicates?duplicates+' duplicate source'+(duplicates===1?'':'s')+' skipped. ':'')+'Indexing continues in the background.';
    await loadKnowledge();switchKnowledgeTab('library');
    toast(duplicates&&duplicates===jobs.length?'Already existed — attached to this chat':'Added to this chat Knowledge',3500);
    setTimeout(()=>$('ingestProgress').classList.add('hidden'),3000);
  }catch(e){toast(e.message,4000);$('ingestProgress').classList.add('hidden');}
  finally{button.disabled=false;}
}
async function ingestTextKnowledge(){
  const pasted=$('knowledgeText').value.trim();if(!pasted){toast('Paste something first.');return;}
  const title=$('knowledgeTitleInput').value.trim()||'Pasted knowledge';
  await ingestJobs([{title,text:pasted,type:'paste'}],$('saveKnowledge'));
  $('knowledgeText').value='';$('knowledgeTitleInput').value='';
}
function cleanHtmlClient(raw){
  try{
    const doc=new DOMParser().parseFromString(raw,'text/html');
    doc.querySelectorAll('script,style,noscript,svg,canvas,iframe,link,meta,picture,source').forEach(n=>n.remove());
    return String(doc.body?.innerText||doc.body?.textContent||doc.documentElement?.textContent||'')
      .replace(/\S{500,}/g,' ')
      .replace(/[ \t]+\n/g,'\n')
      .replace(/\n{3,}/g,'\n\n')
      .replace(/[ \t]{2,}/g,' ')
      .trim();
  }catch{return raw;}
}
function signedUploadFile(file,url,onProgress){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('PUT',url,true);xhr.setRequestHeader('x-upsert','false');
    xhr.upload.onprogress=e=>{if(e.lengthComputable&&onProgress)onProgress(e.loaded/e.total);};
    xhr.onerror=()=>reject(new Error('Private upload failed'));
    xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve(true):reject(new Error('Private upload failed ('+xhr.status+')'));
    const fd=new FormData();fd.append('cacheControl','3600');fd.append('',file);xhr.send(fd);
  });
}
function setFilePickerLabel(inputId,labelId){
  const input=$(inputId),label=$(labelId);if(!input||!label)return;
  if(inputId==='knowledgeMediaFile'){
    const files=state.knowledgeMediaFiles||[];
    label.textContent=files.length>1?files.length+' media files ready':
      files.length===1?files[0].name:'Choose multiple videos · 100 MB/video · 16 MB/audio';
    return;
  }
  if(inputId==='knowledgeFile'){
    const staged=(state.knowledgeFileUploads||[]).filter(r=>r.status==='selected').length;
    label.textContent=staged
      ? staged+' file'+(staged===1?'':'s')+' staged · click to add more'
      : 'Select several at once, then choose more anytime · drag & drop works too';
    return;
  }
  const files=[...(input.files||[])];
  label.textContent=files.length?(files.length===1?files[0].name:files.length+' files selected'):(input.multiple?'or drag & drop multiple files here · up to 100 MB each':'or drag & drop it here · up to 100 MB');
}
function bindFileDropzone(inputId,zoneId,labelId,onFiles){
  const input=$(inputId),zone=$(zoneId);if(!input||!zone)return;
  const sanitize=(files)=>{
    if(inputId!=='knowledgeFile')return files;
    const good=files.filter(isSupportedKnowledgeTextFile),bad=files.filter(f=>!isSupportedKnowledgeTextFile(f));
    if(bad.length)toast('Unsupported archive/binary file: '+bad[0].name+'. Extract ZIPs and upload the TXT/HTML files inside.',5000);
    return good;
  };
  const deliver=(files)=>{
    const good=sanitize(files);if(!good.length){setFilePickerLabel(inputId,labelId);return;}
    onFiles&&onFiles(good);
    if(inputId==='knowledgeFile')input.value='';
    setFilePickerLabel(inputId,labelId);
  };
  input.addEventListener('change',()=>deliver([...(input.files||[])]));
  ['dragenter','dragover'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.add('dragging');}));
  ['dragleave','drop'].forEach(ev=>zone.addEventListener(ev,e=>{e.preventDefault();zone.classList.remove('dragging');}));
  zone.addEventListener('drop',e=>{deliver([...(e.dataTransfer?.files||[])]);});
}
function previewKnowledgeMedia(files){
  const root=$('knowledgeMediaPreview');
  if(!files?.length){root.classList.add('hidden');root.innerHTML='';return;}
  root.classList.remove('hidden');
  root.innerHTML='<strong>'+files.length+' media file'+(files.length===1?'':'s')+' ready to scan</strong>'+
    files.slice(0,8).map(file=>'<small>'+esc(file.name)+' · '+formatBytes(file.size)+'</small>').join('')+
    '<span>Keep this page open until the uploads finish. Processing continues in the background afterward.</span>';
}
async function ingestKnowledgeMedia(){
  const conversationId=state.activeId;
  if(!conversationId){toast('Open a chat first to add Knowledge.',4500);return;}
  const files=[...(state.knowledgeMediaFiles||[])];
  const mode=$('knowledgeMediaMode').value;
  if(!files.length){toast('Choose video or audio files first.');return;}
  if(files.length>10){toast('Upload up to 10 media files per batch.',4500);return;}
  const invalid=files.find(file=>file.size>100*1024*1024||
    (file.type.startsWith('audio/')&&file.size>16*1024*1024)||
    (file.type.startsWith('video/')&&mode==='transcript'&&file.size>16*1024*1024));
  if(invalid){
    toast(invalid.name+': '+(mode==='transcript'&&invalid.type.startsWith('video/')?
      'Transcript-only scanning needs a video under 16 MB. Switch to Full analysis or add subtitles.':
      'Exceeds the media size limit (100 MB/video, 16 MB/audio).'),6500);
    return;
  }
  let processed=0;
  for(let i=0;i<files.length;i++){
    $('ingestProgress').classList.remove('hidden');
    $('ingestProgressText').textContent='Uploading media '+(i+1)+' / '+files.length+': '+files[i].name;
    await ingestKnowledgeMediaOne(files[i],conversationId,mode);
    processed++;
    $('ingestProgressBar').style.width=Math.round(processed/files.length*100)+'%';
  }
  state.knowledgeMediaFiles=[];
  $('knowledgeMediaFile').value='';
  setFilePickerLabel('knowledgeMediaFile','knowledgeMediaFileLabel');
  previewKnowledgeMedia([]);
  $('ingestProgressText').textContent=processed+' media files checked · background indexing continues.';
  if(state.activeId===conversationId)switchKnowledgeTab('library');
}
async function ingestKnowledgeMediaOne(file,conversationId,mode){
  if(!conversationId){toast('Send one message first so this chat exists, then add media Knowledge.',4500);return;}
  if(file.size>100*1024*1024){toast('This upload is over the current 100 MB video limit.',4500);return;}
  if(file.type.startsWith('audio/')&&file.size>16*1024*1024){toast('Audio Knowledge is currently limited to 16 MB per file. Compress or split larger audio first.',5000);return;}
  if(file.type.startsWith('video/')&&file.size>16*1024*1024&&mode==='transcript'){
    toast('Transcript-only mode requires a video under 16 MB. Choose Full analysis for larger videos or upload a transcript file.',6000);return;
  }
  const btn=$('saveKnowledgeMedia');btn.disabled=true;
  let uploadedPath='',serverHandoffStarted=false;
  const [row]=stageKnowledgeFiles([file]);$('ingestProgress').classList.remove('hidden');
  try{
    setKnowledgeFileStatus(row,'fingerprinting',3,'Computing exact SHA-256','checking');
    const sha=await sha256File(file);row.sha256=sha;
    setKnowledgeFileStatus(row,'checking',7,'Checking for an identical source','duplicate check');
    const check=await api('/api/knowledge/file-check',{method:'POST',body:JSON.stringify({sha256:sha,name:file.name,size:file.size})});
    if(check.duplicate){await api('/api/knowledge/'+encodeURIComponent(check.source.id)+'/attach',{method:'POST',body:JSON.stringify({conversation_id:conversationId})});row.sourceIds=[check.source.id];setKnowledgeFileStatus(row,'ready',100,'Existing source attached to this chat','attached');if(state.activeId===conversationId){state.knowledgeScope='chat';await loadKnowledge();}toast('Existing media source attached to this chat.');return;}

    setKnowledgeFileStatus(row,'uploading',10,'Uploading into private Storage','uploading 0%');
    const signed=await api('/api/uploads/sign',{method:'POST',body:JSON.stringify({name:file.name,mime:file.type||'application/octet-stream',size:file.size,kind:file.type.startsWith('audio/')?'audio':'video'})});
    uploadedPath=signed.path||'';
    await signedUploadFile(file,signed.signed_url,p=>{
      const pct=10+Math.round(p*35);setKnowledgeFileStatus(row,'uploading',pct,'Uploading into private Storage','uploading '+Math.round(p*100)+'%');
    });

    setKnowledgeFileStatus(row,'queued',48,'Starting private media processing','queued');
    serverHandoffStarted=true;
    const created=await api('/api/knowledge/media',{method:'POST',body:JSON.stringify({
      title:file.name,path:signed.path,mime:file.type||'video/mp4',size:file.size,sha256:sha,
      mode,collection:$('knowledgeCollection').value.trim().slice(0,80),conversation_id:conversationId
    })});
    if(created.duplicate){
      await api('/api/uploads/discard',{method:'POST',body:JSON.stringify({path:signed.path})}).catch(()=>{});
      setKnowledgeFileStatus(row,'duplicate',100,'Already exists in Knowledge','duplicate blocked');return;
    }
    row.sourceIds=[created.source_id];
    setKnowledgeFileStatus(row,'processing',52,'Safe to close this browser — processing continues on the server','processing');
    if(state.activeId===conversationId)await loadKnowledge();toast('Media uploaded. Building timestamped Knowledge in the background.',4500);
  }catch(e){
    if(uploadedPath&&!serverHandoffStarted)await api('/api/uploads/discard',{method:'POST',body:JSON.stringify({path:uploadedPath})}).catch(()=>{});
    setKnowledgeFileStatus(row,'failed',100,e.message||'Media upload failed','failed');toast(e.message||'Media upload failed',4500);
  }finally{delete row.file;btn.disabled=false;scheduleKnowledgePoll();}
}

async function ingestKnowledgePdfPersistent(file,row,conversationId,fileSha256){
  let uploadedPath='',serverHandoffStarted=false;
  try{
    setKnowledgeFileStatus(row,'uploading',18,'Uploading PDF to private Storage','uploading 0%');
    const signed=await api('/api/uploads/sign',{method:'POST',body:JSON.stringify({
      name:file.name,mime:'application/pdf',size:file.size,kind:'pdf'
    })});
    uploadedPath=signed.path||'';
    await signedUploadFile(file,signed.signed_url,p=>{
      setKnowledgeFileStatus(row,'uploading',18+Math.round(p*30),'Uploading PDF to private Storage','uploading '+Math.round(p*100)+'%');
    });
    setKnowledgeFileStatus(row,'queued',50,'Creating persistent OCR job','server OCR queued');
    serverHandoffStarted=true;
    const created=await api('/api/knowledge/pdf',{method:'POST',body:JSON.stringify({
      title:file.name,path:signed.path,size:file.size,sha256:fileSha256,
      collection:$('knowledgeCollection').value.trim().slice(0,80),conversation_id:conversationId
    })});
    if(created.duplicate){
      row.sourceIds=created.source?.id?[created.source.id]:[];
      setKnowledgeFileStatus(row,'ready',100,'Existing PDF source attached to this chat','attached');
      return {duplicate:true,sourceId:created.source?.id||null};
    }
    row.sourceIds=[created.source_id];
    setKnowledgeFileStatus(row,'processing',55,'PDF saved · safe to refresh or close · server OCR continues','server OCR');
    return {duplicate:false,sourceId:created.source_id};
  }catch(e){
    if(uploadedPath&&!serverHandoffStarted){
      await api('/api/uploads/discard',{method:'POST',body:JSON.stringify({path:uploadedPath})}).catch(()=>{});
    }
    throw e;
  }
}

let pdfjsKnowledgePromise=null;
let tesseractKnowledgePromise=null;
const PDF_OCR_MIN_CHARS=220;
const PDF_OCR_MIN_WORDS=35;
const TESSERACT_SCRIPT='https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/6.0.1/tesseract.min.js';
const TESSERACT_WORKER='https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/6.0.1/worker.min.js';
function needsPdfOcr(text){
  const clean=String(text||'').replace(/\s+/g,' ').trim();
  const words=clean.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)||[];
  return clean.length<PDF_OCR_MIN_CHARS||words.length<PDF_OCR_MIN_WORDS;
}
async function loadKnowledgeOcr(){
  if(!tesseractKnowledgePromise){
    tesseractKnowledgePromise=new Promise((resolve,reject)=>{
      if(globalThis.Tesseract?.createWorker){resolve(globalThis.Tesseract);return;}
      const tag=document.createElement('script');
      let done=false;
      const finish=(err,ocrApi)=>{
        if(done)return;
        done=true;clearTimeout(timer);
        if(err)reject(err);else resolve(ocrApi);
      };
      const timer=setTimeout(()=>finish(new Error('Local OCR download timed out.')),20000);
      tag.async=true;
      tag.src=TESSERACT_SCRIPT;
      tag.crossOrigin='anonymous';
      tag.onload=()=>globalThis.Tesseract?.createWorker
        ?finish(null,globalThis.Tesseract)
        :finish(new Error('The local OCR reader did not initialize correctly.'));
      tag.onerror=()=>finish(new Error('Local OCR could not load.'));
      document.head.append(tag);
    }).catch(e=>{tesseractKnowledgePromise=null;throw e;});
  }
  return tesseractKnowledgePromise;
}
async function renderPdfPageCanvas(page,maxWidth=1800,maxHeight=2200){
  const original=page.getViewport({scale:1});
  const scale=Math.max(1.15,Math.min(2,maxWidth/original.width,maxHeight/original.height));
  const viewport=page.getViewport({scale});
  const canvas=document.createElement('canvas');
  canvas.width=Math.ceil(viewport.width);
  canvas.height=Math.ceil(viewport.height);
  const context=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
  if(!context){canvas.width=0;canvas.height=0;throw new Error('Your browser could not render this PDF page.');}
  await page.render({canvasContext:context,viewport}).promise;
  return canvas;
}
function releasePdfCanvas(canvas){try{canvas.width=0;canvas.height=0;}catch{}}
async function recognizePdfPage(page,worker){
  const canvas=await renderPdfPageCanvas(page,1800,2200);
  try{
    const result=await worker.recognize(canvas);
    return String(result?.data?.text||'').replace(/\r\n/g,'\n').replace(/[ \t]+\n/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim();
  }finally{releasePdfCanvas(canvas);}
}
async function recognizePdfPageWithAi(page,pageNumber){
  const canvas=await renderPdfPageCanvas(page,1350,1750);
  try{
    let imageData='';
    try{imageData=canvas.toDataURL('image/jpeg',0.78);}
    catch{imageData=canvas.toDataURL('image/png');}
    if(!imageData||imageData.length<100)throw new Error('Could not prepare the PDF page for fallback OCR.');
    const d=await api('/api/knowledge/ocr-page',{
      method:'POST',timeoutMs:120000,
      body:JSON.stringify({page_number:pageNumber,image_data:imageData})
    });
    const text=String(d?.text||'').replace(/\r\n/g,'\n').replace(/[ \t]+\n/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim();
    if(!text)throw new Error('AI OCR returned no readable text.');
    return text;
  }finally{releasePdfCanvas(canvas);}
}
async function loadPdfJs(){
  if(!pdfjsKnowledgePromise){
    pdfjsKnowledgePromise=Promise.race([
      import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs'),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('PDF reader load timed out')),15000))
    ]).catch(e=>{pdfjsKnowledgePromise=null;throw e;});
  }
  try{return await pdfjsKnowledgePromise;}
  catch{throw new Error('The PDF reader could not load. Check your connection and try the PDF again.');}
}
async function extractKnowledgePdf(file,onProgress){
  const pdfjs=await loadPdfJs();
  pdfjs.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  let pdfDoc;
  try{pdfDoc=await pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),useSystemFonts:true}).promise;}
  catch(e){
    const msg=String(e?.message||e||'');
    if(/password/i.test(msg))throw new Error('This PDF is password-protected. Remove the password and upload it again.');
    throw new Error('This PDF could not be opened. It may be damaged or use an unsupported format.');
  }
  const pages=[],stats={
    pages:pdfDoc.numPages,ocrPages:0,localOcrPages:0,aiOcrPages:0,selectablePages:0,
    readablePages:0,unreadablePages:[],weakOcrPages:[],aiFallbackPages:[],words:0,
    localOcrUnavailable:false
  };
  let ocrWorker=null,localOcrDisabled=false;
  const disableLocalOcr=async()=>{
    localOcrDisabled=true;stats.localOcrUnavailable=true;
    if(ocrWorker){try{await ocrWorker.terminate();}catch{}ocrWorker=null;}
  };
  try{
    for(let n=1;n<=pdfDoc.numPages;n++){
      const page=await pdfDoc.getPage(n);
      try{
        const content=await page.getTextContent();
        let extracted='',lastY=null;
        for(const item of content.items){
          if(typeof item.str!=='string')continue;
          const y=item.transform?.[5];
          if(lastY!==null&&y!==undefined&&Math.abs(y-lastY)>3)extracted+='\n';
          extracted+=item.str+(item.hasEOL?'\n':' ');
          if(y!==undefined)lastY=y;
        }
        let text=extracted.trim(),method='text',containsImage=false;
        if(needsPdfOcr(text)){
          const operators=await page.getOperatorList();
          const imageOps=new Set([
            pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintJpegXObject,
            pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageXObjectRepeat,
            pdfjs.OPS.paintImageMaskXObject
          ]);
          containsImage=operators.fnArray.some(op=>imageOps.has(op));
        }
        if(needsPdfOcr(text)&&(containsImage||!text)){
          stats.ocrPages++;
          let recognized='',usedAi=false,localError=null;
          if(!localOcrDisabled){
            if(!ocrWorker){
              try{
                if(onProgress)onProgress(n,pdfDoc.numPages,'ocr-loading',stats);
                const reader=await loadKnowledgeOcr();
                ocrWorker=await reader.createWorker('eng',1,{
                  workerPath:TESSERACT_WORKER,
                  workerBlobURL:false,
                });
              }catch(e){localError=e;await disableLocalOcr();}
            }
            if(ocrWorker){
              try{
                if(onProgress)onProgress(n,pdfDoc.numPages,'ocr',stats);
                recognized=await recognizePdfPage(page,ocrWorker);
                if(recognized)stats.localOcrPages++;
              }catch(e){localError=e;recognized='';await disableLocalOcr();}
            }
          }
          const localChars=recognized.replace(/\s/g,'').length;
          if(!recognized||(containsImage&&localChars<80)){
            try{
              if(onProgress)onProgress(n,pdfDoc.numPages,'ocr-ai',stats);
              const remote=await recognizePdfPageWithAi(page,n);
              if(remote){
                recognized=remote;usedAi=true;stats.aiOcrPages++;stats.aiFallbackPages.push(n);
              }
            }catch(e){
              if(!recognized){
                const localMsg=localError?(' Local OCR: '+String(localError?.message||localError)+'.'):'';
                throw new Error('Page '+n+' OCR failed.'+localMsg+' AI fallback: '+String(e?.message||e));
              }
            }
          }
          if(containsImage&&recognized.length<Math.max(45,text.length*1.1))stats.weakOcrPages.push(n);
          if(recognized.length>text.length*1.25||!text){
            text=recognized;
            method=usedAi?'ocr-ai':'ocr';
          }else if(recognized&&!text.includes(recognized)&&recognized.length>80){
            text+='\n'+recognized;
            method=usedAi?'text+ocr-ai':'text+ocr';
          }
        }else stats.selectablePages++;
        if(text.replace(/[^\p{L}\p{N}]/gu,'').length>=12)stats.readablePages++;
        else stats.unreadablePages.push(n);
        stats.words+=(text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)||[]).length;
        pages.push('[PDF page '+n+' | '+method+']\n'+text);
        if(onProgress)onProgress(n,pdfDoc.numPages,'complete',stats);
      }finally{try{page.cleanup();}catch{}}
      if(n%2===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
  }finally{
    if(ocrWorker)try{await ocrWorker.terminate();}catch{}
    try{await pdfDoc.destroy();}catch{}
  }
  const result=pages.join('\n\n');
  const requiredReadable=Math.max(1,Math.ceil(stats.pages*.90));
  if(stats.words<20||stats.readablePages<requiredReadable){
    throw new Error('PDF scanning could not read enough pages ('+stats.readablePages+'/'+stats.pages+'). No incomplete Knowledge was saved.');
  }
  if(stats.ocrPages>=4&&stats.weakOcrPages.length>Math.max(2,Math.floor(stats.ocrPages*.20))){
    throw new Error('OCR could not reliably read '+stats.weakOcrPages.length+' screenshot pages. Try a higher-quality PDF. No incomplete Knowledge was saved.');
  }
  return {text:result,stats};
}
async function ingestFileKnowledge(){
  if(!state.activeId){toast('Send one message first so this chat exists, then add file Knowledge.',4500);return;}
  const conversationId=state.activeId;
  const rowsToProcess=(state.knowledgeFileUploads||[]).filter(r=>r.status==='selected'&&r.file);
  const files=rowsToProcess.map(r=>r.file);
  if(!files.length){toast('Stage one or more PDF or text files first.');return;}
  const unsupported=files.find(f=>!isSupportedKnowledgeTextFile(f));
  if(unsupported){toast('Cannot index '+unsupported.name+'. Extract ZIP/archive files first and upload the TXT/HTML/JSON files inside.',5000);return;}
  const maxFileBytes=100*1024*1024;
  const segmentChars=3.5*1024*1024;
  for(const file of files){if(file.size>maxFileBytes){toast(file.name+' is over the 100 MB per-file limit.',4500);return;}}
  const btn=$('saveKnowledgeFiles');btn.disabled=true;
  $('ingestProgress').classList.remove('hidden');
  let queued=0,queuedSources=0,duplicates=0,failed=0;
  try{
    for(let fileIndex=0;fileIndex<files.length;fileIndex++){
      const file=files[fileIndex],row=rowsToProcess[fileIndex];
      try{
        setKnowledgeFileStatus(row,'fingerprinting',5,'Computing exact SHA-256','checking');
        const fileSha256=await sha256File(file);
        row.sha256=fileSha256;
        setKnowledgeFileStatus(row,'checking',10,'Checking your library','checking duplicate');
        const check=await api('/api/knowledge/file-check',{method:'POST',body:JSON.stringify({sha256:fileSha256,name:file.name,size:file.size})});
        if(check.duplicate){
          duplicates++;
          await api('/api/knowledge/'+encodeURIComponent(check.source.id)+'/attach',{method:'POST',body:JSON.stringify({conversation_id:conversationId})});
          row.sourceIds=[check.source.id];
          setKnowledgeFileStatus(row,'ready',100,'Existing source attached to this chat','attached');
          continue;
        }

        const html=/\.html?$/i.test(file.name); const pdf=/\.pdf$/i.test(file.name)||file.type==='application/pdf';
        let cleanedText=null,pdfStats=null;
        if(pdf){
          const persisted=await ingestKnowledgePdfPersistent(file,row,conversationId,fileSha256);
          if(persisted.duplicate)duplicates++;else queuedSources++;
          continue;
        }else if(html&&file.size<=25*1024*1024){
          setKnowledgeFileStatus(row,'cleaning',20,'Removing saved-page code, images, CSS, and scripts','cleaning HTML');
          cleanedText=cleanHtmlClient(await file.text());
        }else{
          setKnowledgeFileStatus(row,'reading',20,'Reading file contents','reading');
        }

        const totalUnits=cleanedText!==null?cleanedText.length:file.size;
        const parts=Math.max(1,Math.ceil(totalUnits/segmentChars));
        const group=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+fileIndex);
        let fileChunks=0,duplicateDuringAdd=false;
        for(let part=0;part<parts;part++){
          const from=Math.floor(part*segmentChars),to=Math.min(totalUnits,Math.floor((part+1)*segmentChars));
          const partPct=25+Math.round(((part+1)/parts)*40);
          setKnowledgeFileStatus(row,'adding',partPct,'Segment '+(part+1)+' / '+parts,'adding source');
          const text=cleanedText!==null?cleanedText.slice(from,to):await file.slice(from,to).text();
          const r=await ingestOne({
            title:file.name,text,type:'file',
            metadata:{
              file_group:group,file_name:file.name,file_size:file.size,file_sha256:fileSha256,
              part:part+1,parts,cleaned_html:html&&cleanedText!==null,pdf_extracted:pdf,
              ...(pdfStats?{pdf_pages:pdfStats.pages,pdf_ocr_pages:pdfStats.ocrPages,
                pdf_readable_pages:pdfStats.readablePages,pdf_words:pdfStats.words,pdf_local_ocr_pages:pdfStats.localOcrPages,pdf_ai_ocr_pages:pdfStats.aiOcrPages,pdf_ocr_fallback_pages:pdfStats.aiFallbackPages,ocr_engine:pdfStats.aiOcrPages?'tesseract-v6+private-vision-fallback':(pdfStats.ocrPages?'tesseract-v6':'not-needed')}:{})
            }
          },conversationId);
          if(r.duplicate){
            duplicates++;duplicateDuringAdd=true;
            setKnowledgeFileStatus(row,'duplicate',100,'An identical file already exists in Knowledge','duplicate blocked');
            break;
          }
          if(r.sourceId)row.sourceIds.push(r.sourceId);
          fileChunks+=r.chunks;queued+=r.chunks;
        }
        if(duplicateDuringAdd){
          if(row.sourceIds.length)await Promise.all(row.sourceIds.map(id=>api('/api/knowledge/'+encodeURIComponent(id),{method:'DELETE'}).catch(()=>{})));
          row.sourceIds=[];continue;
        }
        setKnowledgeFileStatus(row,'indexing',70,(pdfStats?pdfStats.words.toLocaleString()+' words extracted · ':'')+fileChunks+' chunks queued','indexing');
      }catch(e){
        if(row.sourceIds.length)await Promise.all(row.sourceIds.map(id=>api('/api/knowledge/'+encodeURIComponent(id),{method:'DELETE'}).catch(()=>{})));
        row.sourceIds=[];failed++;console.error('Knowledge file failed',file.name,e);
        setKnowledgeFileStatus(row,'failed',100,e.message||'File failed','failed');
      }
    }
    $('knowledgeFile').value='';setFilePickerLabel('knowledgeFile','knowledgeTextFileLabel');
    for(const row of rowsToProcess)if(row.status!=='failed')delete row.file;
    await loadKnowledge();
    switchKnowledgeTab('library');
    if(duplicates&&duplicates===files.length)toast('All selected files were already in your library.',4000);
    else if(failed)toast('Files added with '+failed+' failure'+(failed===1?'':'s')+'.',4000);
    else toast((files.length-duplicates)+' new file'+((files.length-duplicates)===1?'':'s')+' added'+(queuedSources?' · '+queuedSources+' PDF OCR job'+(queuedSources===1?'':'s')+' running on server':'')+' · '+duplicates+' duplicate'+(duplicates===1?'':'s')+' blocked',5000);
  }finally{btn.disabled=false;renderKnowledgeFileQueue();scheduleKnowledgePoll();}
}


async function runDiagnostics(showToast=true){
  const btn=$('runDiagnostics'),summary=$('diagnosticsSummary'),detail=$('diagnosticsDetail');
  if(!btn||!summary||!detail)return;
  btn.disabled=true;summary.textContent='Running checks…';detail.innerHTML='<div class="diagnostic-row"><span>Checking frontend and backend</span><strong>…</strong></div>';
  const local=[
    {name:'Backend URL',ok:Boolean(configuredApiBase()),detail:configuredApiBase()?'configured':'missing'},
    {name:'Secure browser context',ok:window.isSecureContext===true,detail:window.isSecureContext?'HTTPS active':'HTTPS required'},
    {name:'File hashing',ok:Boolean(globalThis.crypto?.subtle),detail:globalThis.crypto?.subtle?'available':'unavailable'},
    {name:'Private device session',ok:hasPrivateAuth(),detail:hasPrivateAuth()?'linked':'not linked'},
  ];
  try{
    if(!hasPrivateAuth())throw new Error('Link this device first to run private backend checks.');
    const d=await api('/api/diagnostics',{timeoutMs:20000});
    const remote=Array.isArray(d.checks)?d.checks:[];
    const checks=[...local,...remote];
    const failed=checks.filter(x=>!x.ok);
    summary.textContent=failed.length?failed.length+' check'+(failed.length===1?'':'s')+' need attention':'All '+checks.length+' checks passed';
    summary.classList.toggle('health-good',failed.length===0);summary.classList.toggle('health-bad',failed.length>0);
    detail.innerHTML=checks.map(x=>'<div class="diagnostic-row '+(x.ok?'ok':'bad')+'"><span>'+esc(x.name||x.id||'Check')+'<small>'+esc(x.detail||'')+'</small></span><strong>'+(x.ok?'PASS':'CHECK')+'</strong></div>').join('')+
      (clientErrors.length?'<details class="client-error-log"><summary>Recent local errors ('+clientErrors.length+')</summary>'+clientErrors.slice(0,8).map(x=>'<div><b>'+esc(x.scope)+'</b> · '+esc(x.message)+'<small>'+esc(new Date(x.at).toLocaleTimeString())+'</small></div>').join('')+'</details>':'');
    if(showToast)toast(failed.length?'Diagnostics found '+failed.length+' item'+(failed.length===1?'':'s')+' to check':'Diagnostics passed',3500);
  }catch(e){
    recordClientError('diagnostics',e);
    const checks=local;
    summary.textContent='Backend diagnostics unavailable';
    summary.classList.remove('health-good');summary.classList.add('health-bad');
    detail.innerHTML=checks.map(x=>'<div class="diagnostic-row '+(x.ok?'ok':'bad')+'"><span>'+esc(x.name)+'<small>'+esc(x.detail)+'</small></span><strong>'+(x.ok?'PASS':'CHECK')+'</strong></div>').join('')+'<div class="diagnostic-error">'+esc(e.message||'Diagnostics failed')+'</div>';
    if(showToast)toast(e.message||'Diagnostics failed',4500);
  }finally{btn.disabled=false;}
}

function renderMemories(){const root=$('memoryList');root.innerHTML='';const q=$('memorySearch').value.trim().toLowerCase();const rows=state.memories.filter(m=>!q||String(m.content||'').toLowerCase().includes(q)||String(m.category||'').toLowerCase().includes(q));$('memoryCount').textContent=state.memories.length+' memor'+(state.memories.length===1?'y':'ies');if(!rows.length){root.innerHTML='<div class="empty-list">'+(q?'No matching memories.':'No durable memories yet. The AI will build these automatically from chats.')+'</div>';return;}rows.forEach(m=>{const el=document.createElement('div');el.className='knowledge-item'+(m.active===false?' disabled':'');el.innerHTML='<div class="knowledge-item-head"><div><strong>'+esc(m.category||'memory')+(m.pinned?' · pinned':'')+'</strong><small style="line-height:1.45">'+esc(m.content||'')+'</small><small>importance '+Number(m.importance||5)+'/10 · '+Math.round(Number(m.confidence||0)*100)+'% confidence</small></div><div class="knowledge-actions"><button class="pin">'+(m.pinned?'★':'☆')+'</button><button class="toggle">'+(m.active===false?'○':'●')+'</button><button class="rename">✎</button><button class="delete danger-hover">×</button></div></div>';el.querySelector('.pin').onclick=async()=>{await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({pinned:!m.pinned})});loadMemories();};el.querySelector('.toggle').onclick=async()=>{await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({active:m.active===false})});loadMemories();};el.querySelector('.rename').onclick=async()=>{const n=prompt('Edit this memory',m.content||'');if(n&&n.trim()){await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({content:n.trim().slice(0,4000)})});loadMemories();}};el.querySelector('.delete').onclick=async()=>{if(confirm('Permanently delete this memory?')){await api('/api/memories/'+encodeURIComponent(m.id),{method:'DELETE'});await loadMemories();toast('Memory deleted');}};root.append(el);});}
async function loadMemories(){try{const d=await api('/api/memories');state.memories=d.memories||[];renderMemories();}catch(e){recordClientError('loadMemories',e);$('memoryCount').textContent=state.memories.length?state.memories.length+' memories · refresh failed':'Memory unavailable';if(!state.memories.length&&$('memoryList'))$('memoryList').innerHTML='<div class="error-list">'+esc(e.message)+'</div>';}}

function isLatestAssistantMessage(m){
  const last=state.messages[state.messages.length-1];
  return Boolean(m?.id&&last?.role==='assistant'&&last.id===m.id);
}
function openMessageActions(m){
  $('input')?.blur();
  state.messageActionTarget=m;
  $('messageActionSubtitle').textContent=isLatestAssistantMessage(m)?'Latest assistant response':'Assistant response';
  $('messageActionMain').classList.remove('hidden');$('messageSourcesPanel').classList.add('hidden');
  const sources=messageSources(m);
  $('messageSourcesAction').classList.toggle('hidden',sources.length===0);
  const latest=isLatestAssistantMessage(m);
  $('messageRegenerateAction').classList.toggle('hidden',!latest);
  $('messageDeleteAction').classList.toggle('hidden',!latest);
  openModal('messageActionSheet');
}
function closeMessageActions(){state.messageActionTarget=null;closeModal('messageActionSheet');}
function openSelectText(){
  const m=state.messageActionTarget;if(!m)return;
  $('selectTextContent').textContent=cleanMessageText(m.content||'');
  closeModal('messageActionSheet');openModal('selectTextModal');
}
async function shareMessage(){
  const m=state.messageActionTarget;if(!m)return;
  const text=cleanMessageText(m.content||'');
  try{
    if(navigator.share){await navigator.share({title:activeTitle(),text});closeMessageActions();return;}
  }catch(e){if(e?.name==='AbortError')return;}
  await copyText(text);closeMessageActions();toast('Sharing is unavailable here · copied instead',3500);
}
function wrapCanvasText(ctx,text,maxWidth){
  const out=[];
  for(const para of String(text||'').split('\n')){
    if(!para.trim()){out.push('');continue;}
    const words=para.split(/\s+/);let line='';
    for(const word of words){
      const test=line?line+' '+word:word;
      if(ctx.measureText(test).width>maxWidth&&line){out.push(line);line=word;}else line=test;
    }
    if(line)out.push(line);
  }
  return out;
}
async function saveMessageAsImage(){
  const m=state.messageActionTarget;if(!m)return;
  const text=cleanMessageText(m.content||''),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  const width=1200,pad=78;canvas.width=width;ctx.font='32px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
  const lines=wrapCanvasText(ctx,text,width-pad*2),lineH=48,maxLines=Math.floor((16384-260)/lineH),shown=lines.slice(0,maxLines);
  canvas.height=Math.min(16384,220+shown.length*lineH+pad);
  ctx.fillStyle='#07090e';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#67e3ff';ctx.beginPath();ctx.arc(pad+18,76,14,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#f5f7fb';ctx.font='700 34px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';ctx.fillText('Uncensor AI',pad+48,88);
  ctx.fillStyle='#8b95a8';ctx.font='24px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';ctx.fillText(activeTitle().slice(0,70),pad,136);
  ctx.fillStyle='#e8ebf1';ctx.font='32px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
  let y=205;for(const line of shown){if(line===''){y+=lineH*.55;continue;}ctx.fillText(line,pad,y);y+=lineH;}
  if(lines.length>shown.length){ctx.fillStyle='#8b95a8';ctx.fillText('… response continues beyond image limit',pad,y);}
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png',0.95));if(!blob){toast('Could not create image',3500);return;}
  const file=new File([blob],'uncensor-ai-response.png',{type:'image/png'});
  try{
    if(navigator.canShare?.({files:[file]})&&navigator.share){await navigator.share({files:[file],title:activeTitle()});closeMessageActions();return;}
  }catch(e){if(e?.name==='AbortError')return;}
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=file.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1200);closeMessageActions();toast('Response image created');
}
function renderMessageSources(){
  const m=state.messageActionTarget;if(!m)return;
  const sources=messageSources(m),root=$('messageSourcesList');root.innerHTML='';
  for(const s of sources){
    const u=safeHttpUrl(s.url),row=document.createElement('div');row.className='message-source-row';
    const detail=[s.page_number?'PDF page '+s.page_number:'',s.evidence_type&&s.evidence_type!=='unrated'?String(s.evidence_type).replaceAll('_',' '):'',s.author||''].filter(Boolean).join(' · ');
    row.innerHTML='<div><strong>'+esc(s.title||(u?new URL(u).hostname:'Knowledge source'))+'</strong><small>'+esc(detail||'Saved source')+'</small></div>';
    if(u){const a=document.createElement('a');a.href=u;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open';row.append(a);}
    else if(s.source_id){const b=document.createElement('button');b.type='button';b.textContent='Inspect';b.onclick=()=>{closeModal('messageActionSheet');openKnowledgeInspector({id:s.source_id,title:s.title||'Knowledge'});};row.append(b);}
    root.append(row);
  }
  if(!sources.length)root.innerHTML='<div class="empty-list">No source details were saved for this response.</div>';
  const web=sources.filter(s=>safeHttpUrl(s.url));$('saveMessageWebSources').classList.toggle('hidden',web.length===0);
  $('saveMessageWebSources').onclick=()=>saveWebSourcesToKnowledge(web);
  $('messageActionMain').classList.add('hidden');$('messageSourcesPanel').classList.remove('hidden');
}
async function regenerateLatestMessage(){
  const m=state.messageActionTarget;if(!m?.id||!state.activeId)return;
  closeModal('messageActionSheet');toast('Regenerating response…',5000);
  try{
    await api('/api/messages/'+encodeURIComponent(m.id)+'/regenerate',{method:'POST',body:JSON.stringify({
      model:$('modelSelect').value,use_knowledge:state.knowledgeEnabled,style_prompt:state.style,response_mode:state.mode
    }),timeoutMs:120000});
    await openChat(state.activeId);toast('Response regenerated');
  }catch(e){toast(e.message||'Could not regenerate response',5000);}
}
async function deleteLatestExchange(){
  const m=state.messageActionTarget;if(!m?.id||!state.activeId)return;
  if(!confirm('Delete this question and answer from the chat? This cannot be undone.'))return;
  closeModal('messageActionSheet');
  try{await api('/api/messages/'+encodeURIComponent(m.id)+'/delete-exchange',{method:'POST',body:'{}'});await openChat(state.activeId);await loadChats();toast('Exchange deleted');}
  catch(e){toast(e.message||'Could not delete exchange',4500);}
}
function syncMobileChatControls(){
  if(!$('mobileWebToggle'))return;
  $('mobileWebToggle').textContent=state.webResearch?'On':'Off';$('mobileWebToggle').classList.toggle('active',state.webResearch);
  $('mobileKnowledgeToggle').textContent=state.knowledgeEnabled?'On':'Off';$('mobileKnowledgeToggle').classList.toggle('active',state.knowledgeEnabled);
  $('chatControlsSubtitle').textContent=activeTitle();
}
function exportChat(){if(!state.messages.length)return;const title=activeTitle(),body=['# '+title,''].concat(state.messages.flatMap(m=>['## '+(m.role==='user'?'You':'Assistant'),'',m.role==='assistant'?cleanMessageText(m.content||''):(m.content||''),''])).join('\\n');const a=document.createElement('a'),blob=new Blob([body],{type:'text/markdown'});a.href=URL.createObjectURL(blob);a.download=(title.replace(/[^a-z0-9-_]+/gi,'-')||'chat')+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}
function openModal(id){$(id).classList.remove('hidden');if(id==='knowledgeModal'){switchKnowledgeTab(state.activeId?'library':'global');}if(id==='memoryModal')loadMemories();}
function closeModal(id){$(id).classList.add('hidden');if(id==='knowledgeModal'&&state.knowledgePollTimer){clearTimeout(state.knowledgePollTimer);state.knowledgePollTimer=null;}}
function openSidebar(){$('sidebar').classList.add('open');$('backdrop').classList.add('show');}
function closeSidebar(){$('sidebar').classList.remove('open');$('backdrop').classList.remove('show');}
function syncSettings(){$('accessKeyInput').value=accessKey();$('settingKnowledge').checked=state.knowledgeEnabled;$('stylePrompt').value=state.style;$('responseMode').value=state.mode;$('knowledgeToggle').classList.toggle('active',state.knowledgeEnabled);$('knowledgeToggle').textContent=state.knowledgeEnabled?'Knowledge on':'Knowledge off';$('webToggle').classList.toggle('active',state.webResearch);$('webToggle').textContent=state.webResearch?(state.webResearchEnabled?'Web on':'Web unavailable'):'Web off';$('modeLabel').textContent=(state.mode==='direct'?'Direct':state.mode.charAt(0).toUpperCase()+state.mode.slice(1))+' mode';const exp=localStorage.getItem('uncensor.sessionExpires');$('deviceSessionStatus').textContent=sessionToken()?'Enrolled'+(exp?' · expires '+new Date(exp).toLocaleDateString():''):accessKey()?'Recovery/master key entered — press Save settings':'Not enrolled';$('revokeThisDevice').disabled=!sessionToken();$('generatePairingCode').disabled=!sessionToken();syncMobileChatControls();}

$('composer').onsubmit=e=>{e.preventDefault();send($('input').value);};
$('sendBtn').onclick=e=>{const run=activeRun();if(run){e.preventDefault();run.controller.abort();}};
$('input').oninput=autoGrow;$('input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('composer').requestSubmit();}};
$('newChat').onclick=()=>newChat();$('chatSearch').oninput=renderConversations;$('menuBtn').onclick=openSidebar;$('closeSidebar').onclick=closeSidebar;$('backdrop').onclick=closeSidebar;
$('chatTitleButton').onclick=()=>renameChat();$('deleteChatTop').onclick=()=>deleteChat();$('exportChat').onclick=exportChat;
$('openMemory').onclick=()=>openModal('memoryModal');$('openKnowledge').onclick=()=>openModal('knowledgeModal');$('attachBtn').onclick=()=>openModal('attachSheet');$('openSettings').onclick=()=>{syncSettings();openModal('settingsModal');health();runDiagnostics(false);};
$('attachPhoto').onclick=()=>{$('photoInput').value='';$('photoInput').click();};
$('attachFile').onclick=()=>{$('fileInput').value='';$('fileInput').click();};
$('attachVideo').onclick=()=>{$('videoInput').value='';$('videoInput').click();};
$('attachWebsite').onclick=()=>{closeModal('attachSheet');openModal('websiteModal');setTimeout(()=>$('websiteUrlInput').focus(),50);};
$('attachKnowledge').onclick=()=>{closeModal('attachSheet');openModal('knowledgeModal');switchKnowledgeTab('add');};
$('photoInput').onchange=e=>addFiles(e.target.files);
$('fileInput').onchange=e=>addFiles(e.target.files);
$('videoInput').onchange=e=>addFiles(e.target.files);
$('addWebsiteAttachment').onclick=addWebsiteAttachment;
$('websiteUrlInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addWebsiteAttachment();}};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeModal(b.dataset.close));document.querySelectorAll('.modal').forEach(m=>m.onclick=e=>{if(e.target===m)closeModal(m.id);});
$('knowledgeLibraryTab').onclick=()=>switchKnowledgeTab('library');$('knowledgeGlobalTab').onclick=()=>switchKnowledgeTab('global');$('knowledgeAddTab').onclick=()=>switchKnowledgeTab('add');$('knowledgeViewAll').onclick=()=>setKnowledgeView('all');$('knowledgeViewProcessing').onclick=()=>setKnowledgeView('processing');$('knowledgeViewAttention').onclick=()=>setKnowledgeView('attention');$('useGlobalKnowledgeToggle').onchange=e=>setUseGlobalKnowledge(e.target.checked);$('importKnowledgeUrls').onclick=importKnowledgeUrls;$('saveKnowledge').onclick=ingestTextKnowledge;bindFileDropzone('knowledgeFile','knowledgeFileDropzone','knowledgeTextFileLabel',files=>stageTextKnowledgeFiles(files));$('saveKnowledgeFiles').onclick=ingestFileKnowledge;$('knowledgeSelectAll').onchange=e=>toggleAllVisibleKnowledge(e.target.checked);$('bulkMoveKnowledge').onclick=openBulkMoveKnowledge;$('clearKnowledgeSelection').onclick=()=>clearKnowledgeSelection();bindFileDropzone('knowledgeMediaFile','knowledgeMediaDropzone','knowledgeMediaFileLabel',files=>{if(files.length>10)toast('Only the first 10 files were selected. Upload the rest in another batch.',5000);state.knowledgeMediaFiles=files.slice(0,10);previewKnowledgeMedia(state.knowledgeMediaFiles);});$('saveKnowledgeMedia').onclick=ingestKnowledgeMedia;$('refreshKnowledge').onclick=loadKnowledge;$('knowledgeSearch').oninput=renderKnowledge;$('knowledgeTypeFilter').onchange=renderKnowledge;$('knowledgeStatusFilter').onchange=renderKnowledge;$('refreshMemory').onclick=loadMemories;$('memorySearch').oninput=renderMemories;
function toggleWebResearch(){state.webResearch=!state.webResearch;localStorage.setItem('uncensor.webResearch',String(state.webResearch));syncSettings();if(state.webResearch&&!state.webResearchEnabled)toast('Web Research is temporarily unavailable.',4500);}
function toggleKnowledge(){state.knowledgeEnabled=!state.knowledgeEnabled;localStorage.setItem('uncensor.knowledge',String(state.knowledgeEnabled));syncSettings();}
$('webToggle').onclick=toggleWebResearch;$('knowledgeToggle').onclick=toggleKnowledge;$('mobileWebToggle').onclick=toggleWebResearch;$('mobileKnowledgeToggle').onclick=toggleKnowledge;
$('saveInspectorMetadata').onclick=saveInspectorMetadata;$('testInspectorSource').onclick=testInspectorSource;$('retryInspectorSource').onclick=retryInspectorSource;$('suggestInspectorMetadata').onclick=suggestInspectorMetadata;$('askInspectorSource').onclick=()=>askInspectorSource();$('knowledgeInspectorAsk').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();askInspectorSource();}};$('searchInspectorSource').onclick=()=>loadKnowledgeInspector($('knowledgeInspectorSearch').value.trim()).catch(e=>toast(e.message||'Search failed'));$('knowledgeInspectorSearch').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('searchInspectorSource').click();}};$('runRetrievalDebug').onclick=runRetrievalDebugger;$('retrievalDebugQuery').onkeydown=e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();runRetrievalDebugger();}};
$('messageCopyAction').onclick=()=>{const m=state.messageActionTarget;if(m){copyText(cleanMessageText(m.content||''));closeMessageActions();}};
$('messageSelectAction').onclick=openSelectText;$('messageRegenerateAction').onclick=regenerateLatestMessage;$('messageShareAction').onclick=shareMessage;$('messageSourcesAction').onclick=renderMessageSources;$('messageImageAction').onclick=saveMessageAsImage;$('messageDeleteAction').onclick=deleteLatestExchange;$('messageSourcesBack').onclick=()=>{$('messageSourcesPanel').classList.add('hidden');$('messageActionMain').classList.remove('hidden');};
$('copySelectedAll').onclick=()=>copyText($('selectTextContent').textContent||'');
$('chatControlsBtn').onclick=()=>{$('input')?.blur();syncMobileChatControls();openModal('chatControlsSheet');};$('mobileExportChat').onclick=()=>{closeModal('chatControlsSheet');exportChat();};$('mobileRenameChat').onclick=()=>{closeModal('chatControlsSheet');renameChat();};$('mobileDeleteChat').onclick=()=>{closeModal('chatControlsSheet');deleteChat();};
$('jumpLatest').onclick=()=>scrollToLatest(true);$('messages').addEventListener('scroll',updateJumpLatest,{passive:true});
$('modelSelect').onchange=()=>localStorage.setItem('uncensor.model',$('modelSelect').value);$('runDiagnostics').onclick=()=>runDiagnostics(true);$('exportFullBackup').onclick=exportFullBackup;$('saveRenameChat').onclick=saveChatRename;$('cancelRenameChat').onclick=()=>closeModal('renameChatModal');$('renameChatInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();saveChatRename();}};$('confirmMoveKnowledge').onclick=confirmMoveKnowledge;$('cancelMoveKnowledge').onclick=()=>closeModal('moveKnowledgeModal');$('revokeThisDevice').onclick=revokeCurrentDevice;$('generatePairingCode').onclick=generatePairingCode;$('redeemPairingCode').onclick=redeemPairingCode;$('pairingCodeInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();redeemPairingCode();}};$('rotateRecoveryKey').onclick=rotateRecoveryKeyFromDevice;$('copyRecoveryKey').onclick=()=>{const v=$('recoveryKeyValue').textContent||'';if(v){navigator.clipboard.writeText(v);toast('Recovery key copied');}};
$('saveSettings').onclick=async()=>{state.knowledgeEnabled=$('settingKnowledge').checked;state.mode=$('responseMode').value;state.style=$('stylePrompt').value.trim()||DEFAULT_STYLE;const k=$('accessKeyInput').value.trim();if(k)localStorage.setItem('uncensor.accessKey',k);localStorage.setItem('uncensor.knowledge',String(state.knowledgeEnabled));localStorage.removeItem('uncensor.sources');localStorage.setItem('uncensor.mode',state.mode);localStorage.setItem('uncensor.style',state.style);try{if(accessKey())await enrollDeviceSession();syncSettings();closeModal('settingsModal');renderMessages();toast(sessionToken()?'Settings saved · device enrolled':'Settings saved');if(hasPrivateAuth()){await loadChats();const remembered=localStorage.getItem('uncensor.activeChatId');if(!state.activeId&&remembered&&state.conversations.some(c=>c.id===remembered))await openChat(remembered);await Promise.all([loadKnowledge(),loadMemories(),status(),health()]);}}catch(e){localStorage.removeItem('uncensor.accessKey');syncSettings();toast((e.message||'Could not enroll device')+' Use a one-time link code from your enrolled phone if needed.',5500);}};
window.addEventListener('error',e=>recordClientError('window',e.error||e.message));
window.addEventListener('unhandledrejection',e=>recordClientError('promise',e.reason));
document.querySelectorAll('.prompt-card').forEach(b=>b.onclick=()=>{$('input').value=b.dataset.prompt||'';autoGrow();$('input').focus();});

const composerObserver=new ResizeObserver(()=>updateLayoutMetrics());const composerWrap=document.querySelector('.composer-wrap');if(composerWrap)composerObserver.observe(composerWrap);
window.visualViewport?.addEventListener('resize',updateLayoutMetrics);window.visualViewport?.addEventListener('scroll',updateLayoutMetrics);window.addEventListener('resize',updateLayoutMetrics);
(async function(){const saved=localStorage.getItem('uncensor.model');if(saved&&[...$('modelSelect').options].some(o=>o.value===saved))$('modelSelect').value=saved;syncSettings();autoGrow();header();updateLayoutMetrics();await status();if(configuredApiBase()){if(!sessionToken()&&accessKey()){try{await enrollDeviceSession();}catch{localStorage.removeItem('uncensor.accessKey');syncSettings();}}if(hasPrivateAuth()){await loadChats();const lastId=localStorage.getItem('uncensor.activeChatId');if(!state.chatOpenSeq&&lastId&&state.conversations.some(c=>c.id===lastId))await openChat(lastId);else if(lastId&&!state.conversations.some(c=>c.id===lastId))localStorage.removeItem('uncensor.activeChatId');state.knowledgeScope=state.activeId?'chat':'global';await Promise.all([loadKnowledge(),loadMemories(),health()]);}else{authPromptShown=true;syncSettings();openModal('settingsModal');}}})();
