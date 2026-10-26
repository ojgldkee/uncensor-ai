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
const state={conversations:[],activeId:null,activeConversation:null,messages:[],knowledge:[],knowledgeScope:'global',knowledgeLoadSeq:0,knowledgeSelected:new Set(),knowledgeVisibleIds:[],moveKnowledgeSources:[],renameChatTarget:null,memories:[],pendingAttachments:[],knowledgeFileUploads:[],knowledgePollTimer:null,webResearch:localStorage.getItem('uncensor.webResearch')==='true',webResearchEnabled:false,sending:false,abort:null,knowledgeEnabled:localStorage.getItem('uncensor.knowledge')!=='false',showSources:localStorage.getItem('uncensor.sources')!=='false',mode:localStorage.getItem('uncensor.mode')||'direct',style:localStorage.getItem('uncensor.style')||DEFAULT_STYLE};

function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function md(v){let s=esc(v);s=s.replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h1>$1</h1>');s=s.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');return s.split(/\n{2,}/).map(p=>/^<h\d/.test(p)?p:'<p>'+p.replace(/\n/g,'<br>')+'</p>').join('');}
function toast(t,ms=2500){const e=$('toast');e.textContent=t;e.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.add('hidden'),ms);}
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
  try{
    const h=Object.assign(authHeaders(),opt.headers||{}),r=await fetch(endpoint(path),Object.assign({},opt,{headers:h}));
    const tx=await r.text();let d={};try{d=tx?JSON.parse(tx):{};}catch{d={error:tx||'Unexpected response'};}
    if(r.status===401&&d.requires_access_key&&sessionToken()){localStorage.removeItem('uncensor.sessionToken');localStorage.removeItem('uncensor.sessionId');localStorage.removeItem('uncensor.sessionExpires');syncSettings();}
    if(!r.ok){
      if(canRetry&&[408,425,429,500,502,503,504].includes(r.status)){await new Promise(x=>setTimeout(x,350*(attempt+1)));return api(path,opt,attempt+1);}
      throw Object.assign(new Error(d.error||('Request failed '+r.status)),{data:d,status:r.status});
    }
    return d;
  }catch(e){
    if(canRetry&&!(e&&e.status)){await new Promise(x=>setTimeout(x,350*(attempt+1)));return api(path,opt,attempt+1);}
    throw e;
  }
}
function autoGrow(){const e=$('input');e.style.height='auto';e.style.height=Math.min(200,e.scrollHeight)+'px';$('charCount').textContent=e.value.length.toLocaleString()+' / 50,000';}
function activeTitle(){return (state.activeConversation&&state.activeConversation.title)||(state.conversations.find(x=>x.id===state.activeId)||{}).title||'New chat';}
function header(){$('chatTitleButton').textContent=activeTitle();$('deleteChatTop').disabled=!state.activeId;$('exportChat').disabled=!state.messages.length;}
function setSending(v){state.sending=v;$('sendBtn').textContent=v?'■':'↑';$('sendBtn').classList.toggle('stop',v);$('typing').classList.toggle('hidden',!v);}
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

function renderConversations(){const root=$('conversationList');root.innerHTML='';const q=$('chatSearch').value.trim().toLowerCase();const rows=state.conversations.filter(c=>!q||String(c.title||'').toLowerCase().includes(q));$('chatCount').textContent=String(state.conversations.length);if(!rows.length){root.innerHTML='<div class="empty-list">'+(q?'No matching chats.':'No saved chats yet.')+'</div>';return;}rows.forEach(c=>{const el=document.createElement('div');el.className='conversation-item'+(c.id===state.activeId?' active':'');const open=document.createElement('button');open.className='conversation-open';open.innerHTML='<span class="title">'+(c.pinned?'★ ':'')+esc(c.title||'New chat')+'</span><small>'+when(c.updated_at)+'</small>';open.onclick=()=>openChat(c.id);const a=document.createElement('div');a.className='conversation-actions';const pin=document.createElement('button');pin.textContent=c.pinned?'★':'☆';pin.title=c.pinned?'Unpin':'Pin';pin.onclick=e=>{e.stopPropagation();patchChat(c.id,{pinned:!c.pinned});};const ren=document.createElement('button');ren.textContent='✎';ren.title='Rename';ren.onclick=e=>{e.stopPropagation();renameChat(c.id,c.title);};const del=document.createElement('button');del.textContent='×';del.className='danger-hover';del.title='Delete permanently';del.onclick=e=>{e.stopPropagation();deleteChat(c.id,c.title);};a.append(pin,ren,del);el.append(open,a);root.append(el);});}
async function loadChats(){try{const d=await api('/api/conversations');state.conversations=d.conversations||[];if(state.activeId)state.activeConversation=state.conversations.find(x=>x.id===state.activeId)||state.activeConversation;renderConversations();header();}catch{state.conversations=[];renderConversations();}}
async function openChat(id){state.activeId=id;try{const d=await api('/api/conversations/'+encodeURIComponent(id));state.activeConversation=d.conversation;state.messages=d.messages||[];renderMessages();renderConversations();header();syncKnowledgeScopeUI();if(!$('knowledgeModal').classList.contains('hidden'))loadKnowledge();closeSidebar();}catch(e){toast(e.message);}}
async function patchChat(id,p){try{await api('/api/conversations/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(p)});await loadChats();return true;}catch(e){toast(e.message||'Could not update chat',4000);throw e;}}
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
async function deleteChat(id=state.activeId,title=activeTitle()){if(!id)return;if(!confirm('Permanently delete “'+(title||'this chat')+'”?\\n\\nEvery saved message in it will be deleted and this cannot be undone.'))return;try{await api('/api/conversations/'+encodeURIComponent(id),{method:'DELETE'});if(state.activeId===id)newChat(false);await loadChats();toast('Chat permanently deleted');}catch(e){toast(e.message);}}
function newChat(close=true){if(state.sending&&state.abort)state.abort.abort();clearPendingAttachments();state.activeId=null;state.activeConversation=null;state.messages=[];state.knowledgeScope='global';renderMessages();renderConversations();header();syncKnowledgeScopeUI();$('input').focus();if(close)closeSidebar();}

function fileKind(file){
  const type=String(file.type||'').toLowerCase(),name=String(file.name||'').toLowerCase();
  if(type.startsWith('image/'))return'image';
  if(type.startsWith('video/'))return'video';
  if(type.startsWith('audio/'))return'audio';
  if(type==='application/pdf'||name.endsWith('.pdf'))return'pdf';
  if(type.startsWith('text/')||/\.(txt|md|csv|json|html?|log|js|ts|tsx|jsx|py|sql|css)$/i.test(name))return'text';
  return'file';
}
function isSupportedKnowledgeTextFile(file){
  return /\.(txt|md|csv|json|html?|log|js|ts|tsx|jsx|py|sql|css)$/i.test(String(file?.name||'')) ||
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
  const max=kind==='video'||kind==='audio'?100*1024*1024:50*1024*1024;
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
function appendMessage(m,scroll=true){$('emptyState').classList.add('hidden');const root=$('messages'),el=document.createElement('article');el.className='message '+m.role;const atts=(m.attachments||[]).slice(0,12),attHtml=atts.length?'<div class="message-attachments">'+atts.map(a=>'<span class="message-attachment">'+attIcon(a.kind)+' '+esc(a.name||a.url||'Attachment')+'</span>').join('')+'</div>':'';if(m.role==='assistant'){const sources=(m.sources||[]).slice(0,12),webSources=sources.filter(s=>safeHttpUrl(s.url));const sourceHtml=state.showSources&&sources.length?'<div class="source-chips">'+sources.map(s=>{const u=safeHttpUrl(s.url),label=(s.ref?s.ref+' · ':'')+(s.title|| (u?new URL(u).hostname:'Knowledge'));return u?'<a class="source-chip web-source" href="'+esc(u)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+'</a>':'<span class="source-chip">'+esc(label)+'</span>';}).join('')+'</div>':'';el.innerHTML='<div class="avatar">U</div><div class="message-content"><div class="message-body">'+md(m.content||'')+'</div>'+attHtml+sourceHtml+'<div class="message-actions"><button class="copy">Copy</button>'+(webSources.length?'<button class="save-web">Save web sources to Knowledge</button>':'')+'</div></div>';el.querySelector('.copy').onclick=()=>copyText(m.content||'');const save=el.querySelector('.save-web');if(save)save.onclick=()=>saveWebSourcesToKnowledge(webSources);}else{el.innerHTML='<div class="message-content user-message-content"><div class="message-body">'+md(m.content||'')+'</div>'+attHtml+'<div class="message-actions user-message-actions"><button class="copy">Copy</button></div></div>';el.querySelector('.copy').onclick=()=>copyText(m.content||'');}root.append(el);if(scroll)root.scrollTop=root.scrollHeight;return el;}
function renderMessages(){const root=$('messages');root.innerHTML='';$('emptyState').classList.toggle('hidden',state.messages.length>0);state.messages.forEach(m=>appendMessage(m,false));root.scrollTop=root.scrollHeight;header();}

async function send(text){
  if(state.sending){state.abort&&state.abort.abort();return;}
  const t=String(text||'').trim();if(!t&&!state.pendingAttachments.length)return;
  if(!ensurePrivateAuth())return;
  const sendingAttachments=state.pendingAttachments.map(a=>({...a}));
  const useResearch=state.webResearch&&sendingAttachments.length===0;
  const user={role:'user',content:t||'Please analyze the attached item.',attachments:sendingAttachments};state.messages.push(user);appendMessage(user);
  $('input').value='';autoGrow();setSending(true);state.abort=new AbortController();
  const assistant={role:'assistant',content:'',sources:[]};let node=null;
  const safeMobile=/iPhone|iPad|iPod/i.test(navigator.userAgent);
  const typingLabel=$('typing').querySelector('em');if(typingLabel)typingLabel.textContent=useResearch?'Researching current web…':'Thinking…';
  try{
    const route=useResearch?'/api/research':'/api/chat';
    const r=await fetch(endpoint(route),{
      method:'POST',signal:state.abort.signal,headers:authHeaders(),
      body:JSON.stringify({
        conversation_id:state.activeId,
        message:t||'Please analyze the attached item.',
        attachments:sendingAttachments,
        model:$('modelSelect').value,
        use_knowledge:state.knowledgeEnabled,
        style_prompt:state.style,
        response_mode:state.mode,
        stream:useResearch?false:!safeMobile
      })
    });
    if(!r.ok){const d=await r.json().catch(()=>({}));throw Object.assign(new Error(d.error||'Request failed'),{data:d,status:r.status});}

    if(useResearch||safeMobile){
      const d=await r.json();
      assistant.content=String(d.content||'');assistant.sources=Array.isArray(d.sources)?d.sources:[];
      if(d.conversation_id)state.activeId=d.conversation_id;
      if(d.title)state.activeConversation=Object.assign({},state.activeConversation||{},{id:state.activeId,title:d.title});
      $('typing').classList.add('hidden');
      if(!assistant.content.trim())throw new Error('The model returned an empty response.');
      state.messages.push(assistant);appendMessage(assistant);
      if(useResearch&&d.external_search_query)toast('Privacy firewall query: '+d.external_search_query,5000);
    }else{
      $('typing').classList.add('hidden');node=appendMessage(assistant);
      const reader=r.body.getReader(),dec=new TextDecoder();let buffer='';
      while(true){const part=await reader.read();if(part.done)break;buffer+=dec.decode(part.value,{stream:true});const events=buffer.split('\n\n');buffer=events.pop()||'';for(const raw of events){if(!raw.startsWith('data:'))continue;const p=raw.slice(5).trim();if(!p||p==='[DONE]')continue;let e;try{e=JSON.parse(p);}catch{continue;}if(e.type==='meta'){if(e.conversation_id)state.activeId=e.conversation_id;if(e.title)state.activeConversation=Object.assign({},state.activeConversation||{},{id:state.activeId,title:e.title});if(Array.isArray(e.sources))assistant.sources=e.sources;}if(e.type==='token'){assistant.content+=e.text||'';node.querySelector('.message-body').innerHTML=md(assistant.content);$('messages').scrollTop=$('messages').scrollHeight;}if(e.type==='error')throw new Error(e.error||'Model error');}}
      if(assistant.content.trim())state.messages.push(assistant);else node&&node.remove();
    }
    clearPendingAttachments();await loadChats();await status();
  }catch(e){
    $('typing').classList.add('hidden');
    if(e.name==='AbortError'){if(node&&assistant.content.trim()){assistant.content+='\n\n_[Stopped]_';state.messages.push(assistant);}else if(node)node.remove();toast('Generation stopped');}
    else{let recovered=false;try{await loadChats();if(state.activeId){const d=await api('/api/conversations/'+encodeURIComponent(state.activeId));const serverMessages=d.messages||[];const latest=[...serverMessages].reverse().find(m=>m.role==='assistant'&&m.content);if(latest){state.activeConversation=d.conversation;state.messages=serverMessages;renderMessages();recovered=true;toast('Connection recovered — answer restored from the server.',3500);}}}catch{}if(!recovered){assistant.content='Error: '+(e.message||'Request failed');state.messages.push(assistant);if(node)node.querySelector('.message-body').innerHTML=md(assistant.content);else appendMessage(assistant);toast(e.message||'Request failed',4500);}}
  }finally{state.abort=null;setSending(false);if(typingLabel)typingLabel.textContent='Thinking…';header();$('input').focus();}
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
  $('knowledgeLibraryTab').classList.toggle('active',chat);
  $('knowledgeLibraryTab').disabled=!state.activeId;
  $('knowledgeGlobalTab').classList.toggle('active',global);
  const title=state.activeConversation?.title||'this chat';
  $('knowledgeScopeDescription').textContent=chat
    ? 'Everything "'+title+'" can retrieve: its chat-only sources plus all Global Knowledge.'
    : 'Global Knowledge is available to every chat automatically. Sources with no chat assignment live here.';
  $('knowledgeSearch').placeholder=chat?"Search everything this chat can use…":"Search Global Knowledge…";
  $('knowledgeAddScopeText').textContent=state.activeId
    ? 'New sources start as chat-only for "'+title+'". Use Move to make them Global or transfer them to another specialist chat.'
    : 'Send one message first so this chat exists, then add specialist Knowledge to it.';
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

function renderKnowledge(){
  const root=$('knowledgeList');root.innerHTML='';
  const q=$('knowledgeSearch').value.trim().toLowerCase();
  const type=$('knowledgeTypeFilter').value;
  const statusFilter=$('knowledgeStatusFilter').value;
  const raw=state.knowledge||[],all=knowledgeLogicalSources(raw);
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
    return matchesQ&&matchesType&&matchesStatus;
  });
  state.knowledgeVisibleIds=rows.map(x=>String(x.id));
  syncKnowledgeBulkUI();
  if(!rows.length){
    root.innerHTML='<div class="knowledge-empty"><div class="knowledge-empty-icon">▤</div><strong>'+(all.length?'No matching sources':(state.knowledgeScope==='chat'?'This chat has no usable Knowledge yet':'No Global Knowledge yet'))+'</strong><p>'+(all.length?'Try a different search or filter.':(state.knowledgeScope==='chat'?'Add specialist sources here or move general sources to Global.':'Sources without a specific chat assignment appear here automatically.'))+'</p>'+(all.length||state.knowledgeScope!=='chat'?'':'<button id="emptyAddKnowledge" class="primary-btn">＋ Add source to this chat</button>')+'</div>';
    const b=$('emptyAddKnowledge');if(b)b.onclick=()=>switchKnowledgeTab('add');
    return;
  }
  rows.forEach(x=>{
    const total=Number(x.chunk_count||0),done=Number(x.embedded_chunk_count||0),status=String(x.status||'queued'),collection=knowledgeCollection(x),meta=x.metadata||{};
    const media=['video','audio'].includes(String(x.source_type||''));
    const pct=media&&status!=='ready'?Math.max(3,Number(meta.media_progress||0)):(total?Math.round((done/total)*100):(status==='ready'?100:3));
    const typeLabel=x.source_type==='website'?'Website':x.source_type==='file'?'File':x.source_type==='video'?'Video':x.source_type==='audio'?'Audio':'Notes';
    const typeIcon=x.source_type==='website'?'↗':x.source_type==='file'?'▤':x.source_type==='video'?'▶':x.source_type==='audio'?'♪':'✎';
    const partCount=(x._items||[]).length;
    const mediaDetail=media?(' · '+esc(String(meta.media_stage||status).replaceAll('_',' '))+(meta.duration_seconds?' · '+Math.floor(Number(meta.duration_seconds)/60)+':'+String(Math.floor(Number(meta.duration_seconds)%60)).padStart(2,'0'):'')+(meta.reference_sections?' · '+Number(meta.reference_sections)+' refs':'')):'';
    const baseDetail=media?(formatBytes(Number(meta.file_size||0))+mediaDetail):(Number(x.char_count||0).toLocaleString()+' chars · '+done.toLocaleString()+'/'+total.toLocaleString()+' chunks');
    const globalSource=x.global_enabled===true||!(x.conversation_ids||[]).length;
    const scopeBadge='<span class="knowledge-scope-chip '+(globalSource?'global':'chat')+'">'+(globalSource?'GLOBAL':'CHAT ONLY')+'</span>';
    const selected=state.knowledgeSelected.has(String(x.id));
    const el=document.createElement('div');el.className='knowledge-item knowledge-library-item'+(x.enabled===false?' disabled':'')+(selected?' selected':'');
    el.innerHTML='<label class="knowledge-row-select" title="Select source"><input class="select-source" type="checkbox" '+(selected?'checked':'')+' /></label><div class="knowledge-item-main"><div class="knowledge-source-icon">'+typeIcon+'</div><div class="knowledge-source-copy"><div class="knowledge-source-title-row"><strong>'+esc(x.title||'Untitled')+'</strong>'+scopeBadge+(collection?'<span class="knowledge-collection-chip">'+esc(collection)+'</span>':'')+'</div><small>'+typeLabel+(partCount>1?' · '+partCount+' segments':'')+' · '+baseDetail+' · '+esc(status)+'</small>'+(status==='processing'||status==='queued'?'<div class="mini-progress"><span style="width:'+Math.max(3,pct)+'%"></span></div>':'')+(x.last_error?'<small class="source-error">'+esc(x.last_error)+'</small>':'')+'</div></div><div class="knowledge-actions"><button class="move-source" title="Move between Global and specialist chats">Move</button><button class="toggle" title="'+(x.enabled===false?'Enable':'Disable')+'">'+(x.enabled===false?'○':'●')+'</button><button class="rename" title="Rename">✎</button>'+((state.knowledgeScope==='chat'&&globalSource)?'':'<button class="delete danger-hover" title="'+(state.knowledgeScope==='chat'?'Remove from this chat':'Delete permanently')+'">×</button>')+'</div>';
    const items=x._items||[x];
    el.querySelector('.select-source').onchange=e=>{if(e.target.checked)state.knowledgeSelected.add(String(x.id));else state.knowledgeSelected.delete(String(x.id));renderKnowledge();};
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
    el.innerHTML='<div class="knowledge-upload-top"><div class="knowledge-upload-name">'+esc(r.name)+'</div><div class="knowledge-upload-row-actions"><div class="knowledge-upload-state '+esc(r.status)+'">'+esc(r.label||r.status)+'</div>'+(r.status==='selected'?'<button class="remove-staged" type="button" title="Remove before upload">×</button>':'')+'</div></div><div class="knowledge-upload-meta"><span>'+formatBytes(r.size)+'</span><span>'+esc(r.detail||'')+'</span></div><div class="knowledge-upload-bar"><span style="width:'+Math.max(0,Math.min(100,Number(r.pct||0)))+'%"></span></div>';
    const remove=el.querySelector('.remove-staged');if(remove)remove.onclick=()=>removeStagedKnowledgeFile(r.id);
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
    state.knowledge=d.sources||[];renderKnowledge();updateKnowledgeUploadRows();scheduleKnowledgePoll();
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
async function ingestOne(j){
  if(!state.activeId)throw new Error('Send one message first so this chat exists, then add Knowledge.')
  const collection=$('knowledgeCollection').value.trim().slice(0,80);
  const metadata=Object.assign({},j.metadata||{},{collection});
  const d=await api('/api/knowledge',{method:'POST',body:JSON.stringify({title:j.title,text:j.text,source_type:j.type,metadata,conversation_id:state.activeId})});
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
function previewKnowledgeMedia(file){
  const root=$('knowledgeMediaPreview');
  if(!file){root.classList.add('hidden');root.innerHTML='';return;}
  root.classList.remove('hidden');
  const kind=file.type.startsWith('audio/')?'Audio':'Video';
  root.innerHTML='<strong>'+esc(file.name)+'</strong><small>'+kind+' · '+formatBytes(file.size)+'</small><span>Will become a permanent timestamped reference source.</span>';
}
async function ingestKnowledgeMedia(){
  if(!state.activeId){toast('Send one message first so this chat exists, then add media Knowledge.',4500);return;}
  const file=$('knowledgeMediaFile').files?.[0];
  if(!file){toast('Choose a video or audio file first.');return;}
  if(file.size>100*1024*1024){toast('This upload is over the current 100 MB limit.',4500);return;}
  const btn=$('saveKnowledgeMedia');btn.disabled=true;
  const [row]=stageKnowledgeFiles([file]);$('ingestProgress').classList.remove('hidden');
  try{
    setKnowledgeFileStatus(row,'fingerprinting',3,'Computing exact SHA-256','checking');
    const sha=await sha256File(file);row.sha256=sha;
    setKnowledgeFileStatus(row,'checking',7,'Checking for an identical source','duplicate check');
    const check=await api('/api/knowledge/file-check',{method:'POST',body:JSON.stringify({sha256:sha,name:file.name,size:file.size})});
    if(check.duplicate){await api('/api/knowledge/'+encodeURIComponent(check.source.id)+'/attach',{method:'POST',body:JSON.stringify({conversation_id:state.activeId})});row.sourceIds=[check.source.id];setKnowledgeFileStatus(row,'ready',100,'Existing source attached to this chat','attached');state.knowledgeScope='chat';await loadKnowledge();toast('Existing media source attached to this chat.');return;}

    setKnowledgeFileStatus(row,'uploading',10,'Uploading into private Storage','uploading 0%');
    const signed=await api('/api/uploads/sign',{method:'POST',body:JSON.stringify({name:file.name,mime:file.type||'application/octet-stream',size:file.size,kind:file.type.startsWith('audio/')?'audio':'video'})});
    await signedUploadFile(file,signed.signed_url,p=>{
      const pct=10+Math.round(p*35);setKnowledgeFileStatus(row,'uploading',pct,'Uploading into private Storage','uploading '+Math.round(p*100)+'%');
    });

    setKnowledgeFileStatus(row,'queued',48,'Starting private media processing','queued');
    const created=await api('/api/knowledge/media',{method:'POST',body:JSON.stringify({
      title:file.name,path:signed.path,mime:file.type||'video/mp4',size:file.size,sha256:sha,
      mode:$('knowledgeMediaMode').value,collection:$('knowledgeCollection').value.trim().slice(0,80),conversation_id:state.activeId
    })});
    if(created.duplicate){
      await api('/api/uploads/discard',{method:'POST',body:JSON.stringify({path:signed.path})}).catch(()=>{});
      setKnowledgeFileStatus(row,'duplicate',100,'Already exists in Knowledge','duplicate blocked');return;
    }
    row.sourceIds=[created.source_id];
    setKnowledgeFileStatus(row,'processing',52,'Safe to close this browser — processing continues on the server','processing');
    $('knowledgeMediaFile').value='';setFilePickerLabel('knowledgeMediaFile','knowledgeMediaFileLabel');previewKnowledgeMedia(null);
    await loadKnowledge();switchKnowledgeTab('library');toast('Media uploaded. Building timestamped Knowledge in the background.',4500);
  }catch(e){
    setKnowledgeFileStatus(row,'failed',100,e.message||'Media upload failed','failed');toast(e.message||'Media upload failed',4500);
  }finally{btn.disabled=false;scheduleKnowledgePoll();}
}

async function ingestFileKnowledge(){
  if(!state.activeId){toast('Send one message first so this chat exists, then add file Knowledge.',4500);return;}
  const rowsToProcess=(state.knowledgeFileUploads||[]).filter(r=>r.status==='selected'&&r.file);
  const files=rowsToProcess.map(r=>r.file);
  if(!files.length){toast('Stage one or more supported text files first.');return;}
  const unsupported=files.find(f=>!isSupportedKnowledgeTextFile(f));
  if(unsupported){toast('Cannot index '+unsupported.name+'. Extract ZIP/archive files first and upload the TXT/HTML/JSON files inside.',5000);return;}
  const maxFileBytes=100*1024*1024;
  const segmentChars=3.5*1024*1024;
  for(const file of files){if(file.size>maxFileBytes){toast(file.name+' is over the 100 MB per-file limit.',4500);return;}}
  const btn=$('saveKnowledgeFiles');btn.disabled=true;
  $('ingestProgress').classList.remove('hidden');
  let queued=0,duplicates=0,failed=0;
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
          await api('/api/knowledge/'+encodeURIComponent(check.source.id)+'/attach',{method:'POST',body:JSON.stringify({conversation_id:state.activeId})});
          row.sourceIds=[check.source.id];
          setKnowledgeFileStatus(row,'ready',100,'Existing source attached to this chat','attached');
          continue;
        }

        const html=/\.html?$/i.test(file.name);
        let cleanedText=null;
        if(html&&file.size<=25*1024*1024){
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
              part:part+1,parts,cleaned_html:html&&cleanedText!==null
            }
          });
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
        setKnowledgeFileStatus(row,'indexing',70,fileChunks+' chunks queued','indexing');
      }catch(e){
        if(row.sourceIds.length)await Promise.all(row.sourceIds.map(id=>api('/api/knowledge/'+encodeURIComponent(id),{method:'DELETE'}).catch(()=>{})));
        row.sourceIds=[];failed++;console.error('Knowledge file failed',file.name,e);
        setKnowledgeFileStatus(row,'failed',100,e.message||'File failed','failed');
      }
    }
    $('knowledgeFile').value='';setFilePickerLabel('knowledgeFile','knowledgeTextFileLabel');
    for(const row of rowsToProcess)delete row.file;
    await loadKnowledge();
    switchKnowledgeTab('library');
    if(duplicates&&duplicates===files.length)toast('All selected files were already in your library.',4000);
    else if(failed)toast('Files added with '+failed+' failure'+(failed===1?'':'s')+'.',4000);
    else toast((files.length-duplicates)+' new file'+((files.length-duplicates)===1?'':'s')+' added · '+duplicates+' duplicate'+(duplicates===1?'':'s')+' blocked',4000);
  }finally{btn.disabled=false;renderKnowledgeFileQueue();scheduleKnowledgePoll();}
}


function renderMemories(){const root=$('memoryList');root.innerHTML='';const q=$('memorySearch').value.trim().toLowerCase();const rows=state.memories.filter(m=>!q||String(m.content||'').toLowerCase().includes(q)||String(m.category||'').toLowerCase().includes(q));$('memoryCount').textContent=state.memories.length+' memor'+(state.memories.length===1?'y':'ies');if(!rows.length){root.innerHTML='<div class="empty-list">'+(q?'No matching memories.':'No durable memories yet. The AI will build these automatically from chats.')+'</div>';return;}rows.forEach(m=>{const el=document.createElement('div');el.className='knowledge-item'+(m.active===false?' disabled':'');el.innerHTML='<div class="knowledge-item-head"><div><strong>'+esc(m.category||'memory')+(m.pinned?' · pinned':'')+'</strong><small style="line-height:1.45">'+esc(m.content||'')+'</small><small>importance '+Number(m.importance||5)+'/10 · '+Math.round(Number(m.confidence||0)*100)+'% confidence</small></div><div class="knowledge-actions"><button class="pin">'+(m.pinned?'★':'☆')+'</button><button class="toggle">'+(m.active===false?'○':'●')+'</button><button class="rename">✎</button><button class="delete danger-hover">×</button></div></div>';el.querySelector('.pin').onclick=async()=>{await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({pinned:!m.pinned})});loadMemories();};el.querySelector('.toggle').onclick=async()=>{await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({active:m.active===false})});loadMemories();};el.querySelector('.rename').onclick=async()=>{const n=prompt('Edit this memory',m.content||'');if(n&&n.trim()){await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({content:n.trim().slice(0,4000)})});loadMemories();}};el.querySelector('.delete').onclick=async()=>{if(confirm('Permanently delete this memory?')){await api('/api/memories/'+encodeURIComponent(m.id),{method:'DELETE'});await loadMemories();toast('Memory deleted');}};root.append(el);});}
async function loadMemories(){try{const d=await api('/api/memories');state.memories=d.memories||[];renderMemories();}catch(e){state.memories=[];$('memoryCount').textContent='Memory unavailable';if($('memoryList'))$('memoryList').innerHTML='<div class="error-list">'+esc(e.message)+'</div>';}}

function exportChat(){if(!state.messages.length)return;const title=activeTitle(),body=['# '+title,''].concat(state.messages.flatMap(m=>['## '+(m.role==='user'?'You':'Assistant'),'',m.content||'',''])).join('\\n');const a=document.createElement('a'),blob=new Blob([body],{type:'text/markdown'});a.href=URL.createObjectURL(blob);a.download=(title.replace(/[^a-z0-9-_]+/gi,'-')||'chat')+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}
function openModal(id){$(id).classList.remove('hidden');if(id==='knowledgeModal'){switchKnowledgeTab(state.activeId?'library':'global');}if(id==='memoryModal')loadMemories();}
function closeModal(id){$(id).classList.add('hidden');if(id==='knowledgeModal'&&state.knowledgePollTimer){clearTimeout(state.knowledgePollTimer);state.knowledgePollTimer=null;}}
function openSidebar(){$('sidebar').classList.add('open');$('backdrop').classList.add('show');}
function closeSidebar(){$('sidebar').classList.remove('open');$('backdrop').classList.remove('show');}
function syncSettings(){$('accessKeyInput').value=accessKey();$('settingKnowledge').checked=state.knowledgeEnabled;$('settingSources').checked=state.showSources;$('stylePrompt').value=state.style;$('responseMode').value=state.mode;$('knowledgeToggle').classList.toggle('active',state.knowledgeEnabled);$('knowledgeToggle').textContent=state.knowledgeEnabled?'Knowledge on':'Knowledge off';$('webToggle').classList.toggle('active',state.webResearch);$('webToggle').textContent=state.webResearch?(state.webResearchEnabled?'Web on':'Web unavailable'):'Web off';$('modeLabel').textContent=(state.mode==='direct'?'Direct':state.mode.charAt(0).toUpperCase()+state.mode.slice(1))+' mode';const exp=localStorage.getItem('uncensor.sessionExpires');$('deviceSessionStatus').textContent=sessionToken()?'Enrolled'+(exp?' · expires '+new Date(exp).toLocaleDateString():''):accessKey()?'Recovery/master key entered — press Save settings':'Not enrolled';$('revokeThisDevice').disabled=!sessionToken();$('generatePairingCode').disabled=!sessionToken();}

$('composer').onsubmit=e=>{e.preventDefault();send($('input').value);};
$('sendBtn').onclick=e=>{if(state.sending){e.preventDefault();state.abort&&state.abort.abort();}};
$('input').oninput=autoGrow;$('input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('composer').requestSubmit();}};
$('newChat').onclick=()=>newChat();$('chatSearch').oninput=renderConversations;$('menuBtn').onclick=openSidebar;$('closeSidebar').onclick=closeSidebar;$('backdrop').onclick=closeSidebar;
$('chatTitleButton').onclick=()=>renameChat();$('deleteChatTop').onclick=()=>deleteChat();$('exportChat').onclick=exportChat;
$('openMemory').onclick=()=>openModal('memoryModal');$('openKnowledge').onclick=()=>openModal('knowledgeModal');$('attachBtn').onclick=()=>openModal('attachSheet');$('openSettings').onclick=()=>{syncSettings();openModal('settingsModal');health();};
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
$('knowledgeLibraryTab').onclick=()=>switchKnowledgeTab('library');$('knowledgeGlobalTab').onclick=()=>switchKnowledgeTab('global');$('knowledgeAddTab').onclick=()=>switchKnowledgeTab('add');$('importKnowledgeUrls').onclick=importKnowledgeUrls;$('saveKnowledge').onclick=ingestTextKnowledge;bindFileDropzone('knowledgeFile','knowledgeFileDropzone','knowledgeTextFileLabel',files=>stageTextKnowledgeFiles(files));$('saveKnowledgeFiles').onclick=ingestFileKnowledge;$('knowledgeSelectAll').onchange=e=>toggleAllVisibleKnowledge(e.target.checked);$('bulkMoveKnowledge').onclick=openBulkMoveKnowledge;$('clearKnowledgeSelection').onclick=()=>clearKnowledgeSelection();bindFileDropzone('knowledgeMediaFile','knowledgeMediaDropzone','knowledgeMediaFileLabel',files=>previewKnowledgeMedia(files[0]||null));$('saveKnowledgeMedia').onclick=ingestKnowledgeMedia;$('refreshKnowledge').onclick=loadKnowledge;$('knowledgeSearch').oninput=renderKnowledge;$('knowledgeTypeFilter').onchange=renderKnowledge;$('knowledgeStatusFilter').onchange=renderKnowledge;$('refreshMemory').onclick=loadMemories;$('memorySearch').oninput=renderMemories;
$('webToggle').onclick=()=>{state.webResearch=!state.webResearch;localStorage.setItem('uncensor.webResearch',String(state.webResearch));syncSettings();if(state.webResearch&&!state.webResearchEnabled)toast('Web Research is temporarily unavailable.',4500);};$('knowledgeToggle').onclick=()=>{state.knowledgeEnabled=!state.knowledgeEnabled;localStorage.setItem('uncensor.knowledge',String(state.knowledgeEnabled));syncSettings();};
$('modelSelect').onchange=()=>localStorage.setItem('uncensor.model',$('modelSelect').value);$('exportFullBackup').onclick=exportFullBackup;$('saveRenameChat').onclick=saveChatRename;$('cancelRenameChat').onclick=()=>closeModal('renameChatModal');$('renameChatInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();saveChatRename();}};$('confirmMoveKnowledge').onclick=confirmMoveKnowledge;$('cancelMoveKnowledge').onclick=()=>closeModal('moveKnowledgeModal');$('revokeThisDevice').onclick=revokeCurrentDevice;$('generatePairingCode').onclick=generatePairingCode;$('redeemPairingCode').onclick=redeemPairingCode;$('pairingCodeInput').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();redeemPairingCode();}};$('rotateRecoveryKey').onclick=rotateRecoveryKeyFromDevice;$('copyRecoveryKey').onclick=()=>{const v=$('recoveryKeyValue').textContent||'';if(v){navigator.clipboard.writeText(v);toast('Recovery key copied');}};
$('saveSettings').onclick=async()=>{state.knowledgeEnabled=$('settingKnowledge').checked;state.showSources=$('settingSources').checked;state.mode=$('responseMode').value;state.style=$('stylePrompt').value.trim()||DEFAULT_STYLE;const k=$('accessKeyInput').value.trim();if(k)localStorage.setItem('uncensor.accessKey',k);localStorage.setItem('uncensor.knowledge',String(state.knowledgeEnabled));localStorage.setItem('uncensor.sources',String(state.showSources));localStorage.setItem('uncensor.mode',state.mode);localStorage.setItem('uncensor.style',state.style);try{if(accessKey())await enrollDeviceSession();syncSettings();closeModal('settingsModal');renderMessages();toast(sessionToken()?'Settings saved · device enrolled':'Settings saved');if(hasPrivateAuth())await Promise.all([loadChats(),loadKnowledge(),loadMemories(),status(),health()]);}catch(e){localStorage.removeItem('uncensor.accessKey');syncSettings();toast((e.message||'Could not enroll device')+' Use a one-time link code from your enrolled phone if needed.',5500);}};
document.querySelectorAll('.prompt-card').forEach(b=>b.onclick=()=>{$('input').value=b.dataset.prompt||'';autoGrow();$('input').focus();});

(async function(){const saved=localStorage.getItem('uncensor.model');if(saved&&[...$('modelSelect').options].some(o=>o.value===saved))$('modelSelect').value=saved;syncSettings();autoGrow();header();await status();if(configuredApiBase()){if(!sessionToken()&&accessKey()){try{await enrollDeviceSession();}catch{localStorage.removeItem('uncensor.accessKey');syncSettings();}}if(hasPrivateAuth()){await loadChats();state.knowledgeScope=state.activeId?'chat':'global';await Promise.all([loadKnowledge(),loadMemories(),health()]);}else{authPromptShown=true;syncSettings();openModal('settingsModal');}}})();