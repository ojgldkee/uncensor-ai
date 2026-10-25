const $=id=>document.getElementById(id);
const DEFAULT_STYLE='Be direct, specific, intellectually curious, and nonjudgmental. Do not avoid a topic merely because it is controversial, sensitive, adult, or unconventional. Correct false premises, distinguish facts from uncertainty, and give useful specifics. If the exact request cannot be fulfilled, give the closest useful answer instead of boilerplate.';
const state={conversations:[],activeId:null,activeConversation:null,messages:[],knowledge:[],memories:[],pendingAttachments:[],sending:false,abort:null,knowledgeEnabled:localStorage.getItem('uncensor.knowledge')!=='false',showSources:localStorage.getItem('uncensor.sources')!=='false',mode:localStorage.getItem('uncensor.mode')||'direct',style:localStorage.getItem('uncensor.style')||DEFAULT_STYLE};

function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
function md(v){let s=esc(v);s=s.replace(/^### (.*)$/gm,'<h3>$1</h3>').replace(/^## (.*)$/gm,'<h2>$1</h2>').replace(/^# (.*)$/gm,'<h1>$1</h1>');s=s.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');return s.split(/\n{2,}/).map(p=>/^<h\d/.test(p)?p:'<p>'+p.replace(/\n/g,'<br>')+'</p>').join('');}
function toast(t,ms=2500){const e=$('toast');e.textContent=t;e.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.add('hidden'),ms);}
function configuredApiBase(){return String(localStorage.getItem('uncensor.apiBase')||((window.UNCENSOR_CONFIG||{}).apiBase)||'').replace(/\/$/,'');}
function endpoint(path){const b=configuredApiBase();if(b)return b+path;const base=(location.pathname.includes('/uncensor-ai')?'/uncensor-ai':'');return base+path;}
function accessKey(){return localStorage.getItem('uncensor.accessKey')||'';}
function ensureAccessKey(){const key=accessKey();if(key)return key;syncSettings();openModal('settingsModal');toast('Enter your private access key once on this device.',3500);return'';}
async function api(path,opt={},retry=true){const h=Object.assign({'Content-Type':'application/json'},opt.headers||{});const key=accessKey();if(key)h['x-uncensor-key']=key;const r=await fetch(endpoint(path),Object.assign({},opt,{headers:h}));const tx=await r.text();let d={};try{d=tx?JSON.parse(tx):{};}catch{d={error:tx||'Unexpected response'};}if(r.status===401&&d.requires_access_key&&retry){const k=ensureAccessKey();if(k)return api(path,opt,false);}if(!r.ok)throw Object.assign(new Error(d.error||('Request failed '+r.status)),{data:d,status:r.status});return d;}
function autoGrow(){const e=$('input');e.style.height='auto';e.style.height=Math.min(200,e.scrollHeight)+'px';$('charCount').textContent=e.value.length.toLocaleString()+' / 50,000';}
function activeTitle(){return (state.activeConversation&&state.activeConversation.title)||(state.conversations.find(x=>x.id===state.activeId)||{}).title||'New chat';}
function header(){$('chatTitleButton').textContent=activeTitle();$('deleteChatTop').disabled=!state.activeId;$('exportChat').disabled=!state.messages.length;}
function setSending(v){state.sending=v;$('sendBtn').textContent=v?'■':'↑';$('sendBtn').classList.toggle('stop',v);$('typing').classList.toggle('hidden',!v);}
function when(v){if(!v)return'';const m=Math.floor((Date.now()-new Date(v).getTime())/60000);if(m<1)return'now';if(m<60)return m+'m';const h=Math.floor(m/60);if(h<24)return h+'h';const d=Math.floor(h/24);return d<7?d+'d':new Date(v).toLocaleDateString([], {month:'short',day:'numeric'});}

async function status(){if(!configuredApiBase()){$('statusDot').className='status-dot setup';$('providerStatus').textContent='Backend URL not connected';$('settingsStatus').textContent='Supabase backend URL has not been attached to this build yet.';$('sendBtn').disabled=true;$('input').disabled=true;$('input').placeholder='Backend connection pending';return;}try{const d=await api('/api/status');$('sendBtn').disabled=!d.openrouter_enabled;$('input').disabled=!d.openrouter_enabled;$('input').placeholder=d.openrouter_enabled?'Message Uncensor AI…':'Backend connected — add OpenRouter key to enable chat';$('statusDot').className='status-dot '+(d.openrouter_enabled?'online':'setup');$('providerStatus').textContent=d.openrouter_enabled?'Backend + OpenRouter ready':'Backend connected · model key pending';const spend=Number(d.rolling_24h_spend||0),cap=Number(d.rolling_24h_cap||0);$('settingsStatus').textContent='Supabase connected · Memory '+(d.memory_enabled?'on':'off')+' · Background indexing '+(d.background_indexing_enabled?'on':'off')+' · USD '+spend.toFixed(3)+' / '+(cap?'USD '+cap.toFixed(2):'no cap')+' (24h)';if(d.default_model&&!localStorage.getItem('uncensor.model')&&[...$('modelSelect').options].some(o=>o.value===d.default_model))$('modelSelect').value=d.default_model;}catch(e){$('statusDot').className='status-dot setup';$('providerStatus').textContent='Backend unreachable';$('settingsStatus').textContent=e.message||'Backend connection failed';$('sendBtn').disabled=true;$('input').disabled=true;$('input').placeholder='Backend temporarily unavailable';}}

function renderConversations(){const root=$('conversationList');root.innerHTML='';const q=$('chatSearch').value.trim().toLowerCase();const rows=state.conversations.filter(c=>!q||String(c.title||'').toLowerCase().includes(q));$('chatCount').textContent=String(state.conversations.length);if(!rows.length){root.innerHTML='<div class="empty-list">'+(q?'No matching chats.':'No saved chats yet.')+'</div>';return;}rows.forEach(c=>{const el=document.createElement('div');el.className='conversation-item'+(c.id===state.activeId?' active':'');const open=document.createElement('button');open.className='conversation-open';open.innerHTML='<span class="title">'+(c.pinned?'★ ':'')+esc(c.title||'New chat')+'</span><small>'+when(c.updated_at)+'</small>';open.onclick=()=>openChat(c.id);const a=document.createElement('div');a.className='conversation-actions';const pin=document.createElement('button');pin.textContent=c.pinned?'★':'☆';pin.title=c.pinned?'Unpin':'Pin';pin.onclick=e=>{e.stopPropagation();patchChat(c.id,{pinned:!c.pinned});};const ren=document.createElement('button');ren.textContent='✎';ren.title='Rename';ren.onclick=e=>{e.stopPropagation();renameChat(c.id,c.title);};const del=document.createElement('button');del.textContent='×';del.className='danger-hover';del.title='Delete permanently';del.onclick=e=>{e.stopPropagation();deleteChat(c.id,c.title);};a.append(pin,ren,del);el.append(open,a);root.append(el);});}
async function loadChats(){try{const d=await api('/api/conversations');state.conversations=d.conversations||[];if(state.activeId)state.activeConversation=state.conversations.find(x=>x.id===state.activeId)||state.activeConversation;renderConversations();header();}catch{state.conversations=[];renderConversations();}}
async function openChat(id){state.activeId=id;try{const d=await api('/api/conversations/'+encodeURIComponent(id));state.activeConversation=d.conversation;state.messages=d.messages||[];renderMessages();renderConversations();header();closeSidebar();}catch(e){toast(e.message);}}
async function patchChat(id,p){try{await api('/api/conversations/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify(p)});await loadChats();}catch(e){toast(e.message);}}
async function renameChat(id=state.activeId,current=activeTitle()){if(!id)return;const n=prompt('Rename this chat',current||'');if(n==null||!n.trim())return;await patchChat(id,{title:n.trim().slice(0,120)});if(id===state.activeId){state.activeConversation=Object.assign({},state.activeConversation||{},{title:n.trim().slice(0,120)});header();}}
async function deleteChat(id=state.activeId,title=activeTitle()){if(!id)return;if(!confirm('Permanently delete “'+(title||'this chat')+'”?\\n\\nEvery saved message in it will be deleted and this cannot be undone.'))return;try{await api('/api/conversations/'+encodeURIComponent(id),{method:'DELETE'});if(state.activeId===id)newChat(false);await loadChats();toast('Chat permanently deleted');}catch(e){toast(e.message);}}
function newChat(close=true){if(state.sending&&state.abort)state.abort.abort();clearPendingAttachments();state.activeId=null;state.activeConversation=null;state.messages=[];renderMessages();renderConversations();header();$('input').focus();if(close)closeSidebar();}

function fileKind(file){
  const type=String(file.type||'').toLowerCase(),name=String(file.name||'').toLowerCase();
  if(type.startsWith('image/'))return'image';
  if(type.startsWith('video/'))return'video';
  if(type.startsWith('audio/'))return'audio';
  if(type==='application/pdf'||name.endsWith('.pdf'))return'pdf';
  if(type.startsWith('text/')||/\.(txt|md|csv|json|html?|log|js|ts|tsx|jsx|py|sql|css)$/i.test(name))return'text';
  return'file';
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

function appendMessage(m,scroll=true){$('emptyState').classList.add('hidden');const root=$('messages'),el=document.createElement('article');el.className='message '+m.role;const atts=(m.attachments||[]).slice(0,12),attHtml=atts.length?'<div class="message-attachments">'+atts.map(a=>'<span class="message-attachment">'+attIcon(a.kind)+' '+esc(a.name||a.url||'Attachment')+'</span>').join('')+'</div>':'';if(m.role==='assistant'){const sources=(m.sources||[]).slice(0,8);el.innerHTML='<div class="avatar">U</div><div class="message-content"><div class="message-body">'+md(m.content||'')+'</div>'+attHtml+(state.showSources&&sources.length?'<div class="source-chips">'+sources.map(s=>'<span class="source-chip">'+esc(s.title||'Knowledge')+'</span>').join('')+'</div>':'')+'<div class="message-actions"><button class="copy">Copy</button></div></div>';const b=el.querySelector('.copy');b.onclick=()=>{navigator.clipboard.writeText(m.content||'');toast('Copied');};}else el.innerHTML='<div class="message-body">'+md(m.content||'')+'</div>'+attHtml;root.append(el);if(scroll)root.scrollTop=root.scrollHeight;return el;}
function renderMessages(){const root=$('messages');root.innerHTML='';$('emptyState').classList.toggle('hidden',state.messages.length>0);state.messages.forEach(m=>appendMessage(m,false));root.scrollTop=root.scrollHeight;header();}

async function send(text){
  if(state.sending){state.abort&&state.abort.abort();return;}
  const t=String(text||'').trim();if(!t&&!state.pendingAttachments.length)return;
  const sendingAttachments=state.pendingAttachments.map(a=>({...a}));
  const user={role:'user',content:t||'Please analyze the attached item.',attachments:sendingAttachments};state.messages.push(user);appendMessage(user);
  $('input').value='';autoGrow();setSending(true);state.abort=new AbortController();
  const assistant={role:'assistant',content:'',sources:[]};let node=null;
  const safeMobile=/iPhone|iPad|iPod/i.test(navigator.userAgent);
  try{
    const key=ensureAccessKey();if(!key)throw new Error('Private access key is required.');
    const r=await fetch(endpoint('/api/chat'),{
      method:'POST',
      signal:state.abort.signal,
      headers:{'Content-Type':'application/json','x-uncensor-key':key},
      body:JSON.stringify({
        conversation_id:state.activeId,
        message:t||'Please analyze the attached item.',
        attachments:sendingAttachments,
        model:$('modelSelect').value,
        use_knowledge:state.knowledgeEnabled,
        style_prompt:state.style,
        response_mode:state.mode,
        stream:!safeMobile
      })
    });
    if(!r.ok){const d=await r.json().catch(()=>({}));throw Object.assign(new Error(d.error||'Chat request failed'),{data:d,status:r.status});}

    if(safeMobile){
      const d=await r.json();
      assistant.content=String(d.content||'');
      assistant.sources=Array.isArray(d.sources)?d.sources:[];
      if(d.conversation_id)state.activeId=d.conversation_id;
      if(d.title)state.activeConversation=Object.assign({},state.activeConversation||{},{id:state.activeId,title:d.title});
      $('typing').classList.add('hidden');
      if(!assistant.content.trim())throw new Error('The model returned an empty response.');
      state.messages.push(assistant);
      appendMessage(assistant);
    }else{
      $('typing').classList.add('hidden');
      node=appendMessage(assistant);
      const reader=r.body.getReader(),dec=new TextDecoder();let buffer='';
      while(true){
        const part=await reader.read();if(part.done)break;
        buffer+=dec.decode(part.value,{stream:true});
        const events=buffer.split('\n\n');buffer=events.pop()||'';
        for(const raw of events){
          if(!raw.startsWith('data:'))continue;
          const p=raw.slice(5).trim();if(!p||p==='[DONE]')continue;
          let e;try{e=JSON.parse(p);}catch{continue;}
          if(e.type==='meta'){
            if(e.conversation_id)state.activeId=e.conversation_id;
            if(e.title)state.activeConversation=Object.assign({},state.activeConversation||{},{id:state.activeId,title:e.title});
            if(Array.isArray(e.sources))assistant.sources=e.sources;
          }
          if(e.type==='token'){
            assistant.content+=e.text||'';
            node.querySelector('.message-body').innerHTML=md(assistant.content);
            $('messages').scrollTop=$('messages').scrollHeight;
          }
          if(e.type==='error')throw new Error(e.error||'Model error');
        }
      }
      if(assistant.content.trim())state.messages.push(assistant);else node&&node.remove();
    }
    clearPendingAttachments();await loadChats();await status();
  }catch(e){
    $('typing').classList.add('hidden');
    if(e.name==='AbortError'){
      if(node&&assistant.content.trim()){assistant.content+='\n\n_[Stopped]_';state.messages.push(assistant);}
      else if(node)node.remove();
      toast('Generation stopped');
    }else{
      let recovered=false;
      try{
        await loadChats();
        if(state.activeId){
          const d=await api('/api/conversations/'+encodeURIComponent(state.activeId));
          const serverMessages=d.messages||[];
          const latest=[...serverMessages].reverse().find(m=>m.role==='assistant'&&m.content);
          if(latest){
            state.activeConversation=d.conversation;
            state.messages=serverMessages;
            renderMessages();
            recovered=true;
            toast('Connection recovered — answer restored from the server.',3500);
          }
        }
      }catch{}
      if(!recovered){
        assistant.content='Error: '+(e.message||'Request failed');
        state.messages.push(assistant);
        if(node)node.querySelector('.message-body').innerHTML=md(assistant.content);else appendMessage(assistant);
        toast(e.data&&e.data.setup_required?'OpenRouter is not configured.':(e.message||'Request failed'),3500);
      }
    }
  }finally{
    state.abort=null;setSending(false);header();$('input').focus();
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
function switchKnowledgeTab(tab){
  const library=tab!=='add';
  $('knowledgeLibraryPanel').classList.toggle('hidden',!library);
  $('knowledgeAddPanel').classList.toggle('hidden',library);
  $('knowledgeLibraryTab').classList.toggle('active',library);
  $('knowledgeAddTab').classList.toggle('active',!library);
  if(library){loadKnowledge();setTimeout(()=>$('knowledgeSearch').focus(),40);}
}
function renderKnowledge(){
  const root=$('knowledgeList');root.innerHTML='';
  const q=$('knowledgeSearch').value.trim().toLowerCase();
  const type=$('knowledgeTypeFilter').value;
  const statusFilter=$('knowledgeStatusFilter').value;
  const raw=state.knowledge||[],all=knowledgeLogicalSources(raw);
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
  if(!rows.length){
    root.innerHTML='<div class="knowledge-empty"><div class="knowledge-empty-icon">▤</div><strong>'+(all.length?'No matching sources':'Your global knowledge library is empty')+'</strong><p>'+(all.length?'Try a different search or filter.':'Add websites, notes, transcripts, or files. They will be available from every chat.')+'</p>'+(all.length?'':'<button id="emptyAddKnowledge" class="primary-btn">＋ Add your first source</button>')+'</div>';
    const b=$('emptyAddKnowledge');if(b)b.onclick=()=>switchKnowledgeTab('add');
    return;
  }
  rows.forEach(x=>{
    const total=Number(x.chunk_count||0),done=Number(x.embedded_chunk_count||0),pct=total?Math.round((done/total)*100):0,status=String(x.status||'queued'),collection=knowledgeCollection(x);
    const typeLabel=x.source_type==='website'?'Website':x.source_type==='file'?'File':'Notes';
    const partCount=(x._items||[]).length;
    const el=document.createElement('div');el.className='knowledge-item knowledge-library-item'+(x.enabled===false?' disabled':'');
    el.innerHTML='<div class="knowledge-item-main"><div class="knowledge-source-icon">'+(x.source_type==='website'?'↗':x.source_type==='file'?'▤':'✎')+'</div><div class="knowledge-source-copy"><div class="knowledge-source-title-row"><strong>'+esc(x.title||'Untitled')+'</strong>'+(collection?'<span class="knowledge-collection-chip">'+esc(collection)+'</span>':'')+'</div><small>'+typeLabel+(partCount>1?' · '+partCount+' segments':'')+' · '+Number(x.char_count||0).toLocaleString()+' chars · '+done.toLocaleString()+'/'+total.toLocaleString()+' chunks · '+esc(status)+'</small>'+(status==='processing'||status==='queued'?'<div class="mini-progress"><span style="width:'+Math.max(3,pct)+'%"></span></div>':'')+(x.last_error?'<small class="source-error">'+esc(x.last_error)+'</small>':'')+'</div></div><div class="knowledge-actions"><button class="toggle" title="'+(x.enabled===false?'Enable':'Disable')+'">'+(x.enabled===false?'○':'●')+'</button><button class="rename" title="Rename">✎</button><button class="delete danger-hover" title="Delete permanently">×</button></div>';
    const items=x._items||[x];
    el.querySelector('.toggle').onclick=async()=>{const value=x.enabled===false;await Promise.all(items.map(i=>api('/api/knowledge/'+encodeURIComponent(i.id),{method:'PATCH',body:JSON.stringify({enabled:value})})));loadKnowledge();};
    el.querySelector('.rename').onclick=async()=>{const n=prompt('Rename knowledge source',x.title||'');if(n&&n.trim()){await Promise.all(items.map(i=>api('/api/knowledge/'+encodeURIComponent(i.id),{method:'PATCH',body:JSON.stringify({title:n.trim().slice(0,160)})})));loadKnowledge();}};
    el.querySelector('.delete').onclick=async()=>{if(confirm('Permanently delete “'+x.title+'”'+(partCount>1?' and all '+partCount+' segments':'')+'?')){await Promise.all(items.map(i=>api('/api/knowledge/'+encodeURIComponent(i.id),{method:'DELETE'})));await loadKnowledge();toast('Knowledge source deleted');}};
    root.append(el);
  });
}

async function loadKnowledge(){try{const d=await api('/api/knowledge');state.knowledge=d.sources||[];renderKnowledge();}catch(e){$('knowledgeList').innerHTML='<div class="error-list">'+esc(e.message)+'</div>';$('knowledgeCount').textContent='Not configured';}}
async function importKnowledgeUrls(){
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
        const d=await api('/api/knowledge/url',{method:'POST',body:JSON.stringify({url:urls[i],collection})});
        if(d.duplicate)duplicates++;else added++;
      }catch{failed++;}
    }
    $('knowledgeUrls').value='';
    $('knowledgeUrlStatus').textContent=added+' page'+(added===1?'':'s')+' queued'+(duplicates?' · '+duplicates+' duplicate'+(duplicates===1?'':'s')+' skipped':'')+(failed?' · '+failed+' failed':'')+'. You can close the tab while indexing continues.';
    await loadKnowledge();
    if(added)switchKnowledgeTab('library');
    toast(added?'Web knowledge added':'Website import finished',3500);
  }finally{btn.disabled=false;}
}
async function ingestOne(j){
  const collection=$('knowledgeCollection').value.trim().slice(0,80);
  const metadata=Object.assign({},j.metadata||{},{collection});
  const d=await api('/api/knowledge',{method:'POST',body:JSON.stringify({title:j.title,text:j.text,source_type:j.type,metadata})});
  if(d.duplicate)return{chunks:0,duplicate:true,title:(d.source&&d.source.title)||j.title};
  return{chunks:Number(d.chunk_count||0),duplicate:false,title:j.title};
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
    toast(duplicates&&duplicates===jobs.length?'Already in your library':'Added to global Knowledge',3500);
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
async function ingestFileKnowledge(){
  const files=[...$('knowledgeFile').files];
  if(!files.length){toast('Choose one or more files first.');return;}
  const maxFileBytes=100*1024*1024;
  const segmentChars=3.5*1024*1024;
  for(const file of files){if(file.size>maxFileBytes){toast(file.name+' is over the 100 MB per-file limit.',4500);return;}}
  const btn=$('saveKnowledgeFiles');btn.disabled=true;
  $('ingestProgress').classList.remove('hidden');$('ingestProgressBar').style.width='2%';
  const totalBytes=files.reduce((n,f)=>n+f.size,0);let processedBytes=0,queued=0,duplicates=0,failed=0;
  try{
    for(let fileIndex=0;fileIndex<files.length;fileIndex++){
      const file=files[fileIndex];
      const html=/\.html?$/i.test(file.name);
      let cleanedText=null;
      if(html && file.size<=25*1024*1024){
        $('ingestProgressText').textContent='Cleaning '+file.name+'…';
        cleanedText=cleanHtmlClient(await file.text());
      }
      const totalUnits=cleanedText!==null?cleanedText.length:file.size;
      const parts=Math.max(1,Math.ceil(totalUnits/segmentChars));
      const group=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+fileIndex);
      for(let part=0;part<parts;part++){
        const from=Math.floor(part*segmentChars),to=Math.min(totalUnits,Math.floor((part+1)*segmentChars));
        $('ingestProgressText').textContent='Adding '+file.name+(parts>1?' · segment '+(part+1)+'/'+parts:'')+'…';
        try{
          const text=cleanedText!==null?cleanedText.slice(from,to):await file.slice(from,to).text();
          const r=await ingestOne({
            title:file.name,
            text,
            type:'file',
            metadata:{
              file_group:group,file_name:file.name,file_size:file.size,
              part:part+1,parts,cleaned_html:html&&cleanedText!==null
            }
          });
          queued+=r.chunks;if(r.duplicate)duplicates++;
        }catch(e){failed++;console.error('Knowledge file segment failed',file.name,part+1,e);}
      }
      processedBytes+=file.size;
      $('ingestProgressBar').style.width=Math.max(3,Math.round((processedBytes/Math.max(totalBytes,1))*94))+'%';
    }
    $('ingestProgressBar').style.width='100%';
    $('ingestProgressText').textContent=(queued?queued.toLocaleString()+' chunks queued. ':'')+(duplicates?duplicates+' duplicate segment'+(duplicates===1?'':'s')+' skipped. ':'')+(failed?failed+' segment'+(failed===1?'':'s')+' failed. ':'')+'Indexing continues in the background.';
    $('knowledgeFile').value='';
    await loadKnowledge();switchKnowledgeTab('library');
    toast(failed?'Files added with '+failed+' failed segment'+(failed===1?'':'s'):'Files added to global Knowledge',4000);
    setTimeout(()=>$('ingestProgress').classList.add('hidden'),3500);
  }finally{btn.disabled=false;}
}


function renderMemories(){const root=$('memoryList');root.innerHTML='';const q=$('memorySearch').value.trim().toLowerCase();const rows=state.memories.filter(m=>!q||String(m.content||'').toLowerCase().includes(q)||String(m.category||'').toLowerCase().includes(q));$('memoryCount').textContent=state.memories.length+' memor'+(state.memories.length===1?'y':'ies');if(!rows.length){root.innerHTML='<div class="empty-list">'+(q?'No matching memories.':'No durable memories yet. The AI will build these automatically from chats.')+'</div>';return;}rows.forEach(m=>{const el=document.createElement('div');el.className='knowledge-item'+(m.active===false?' disabled':'');el.innerHTML='<div class="knowledge-item-head"><div><strong>'+esc(m.category||'memory')+(m.pinned?' · pinned':'')+'</strong><small style="line-height:1.45">'+esc(m.content||'')+'</small><small>importance '+Number(m.importance||5)+'/10 · '+Math.round(Number(m.confidence||0)*100)+'% confidence</small></div><div class="knowledge-actions"><button class="pin">'+(m.pinned?'★':'☆')+'</button><button class="toggle">'+(m.active===false?'○':'●')+'</button><button class="rename">✎</button><button class="delete danger-hover">×</button></div></div>';el.querySelector('.pin').onclick=async()=>{await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({pinned:!m.pinned})});loadMemories();};el.querySelector('.toggle').onclick=async()=>{await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({active:m.active===false})});loadMemories();};el.querySelector('.rename').onclick=async()=>{const n=prompt('Edit this memory',m.content||'');if(n&&n.trim()){await api('/api/memories/'+encodeURIComponent(m.id),{method:'PATCH',body:JSON.stringify({content:n.trim().slice(0,4000)})});loadMemories();}};el.querySelector('.delete').onclick=async()=>{if(confirm('Permanently delete this memory?')){await api('/api/memories/'+encodeURIComponent(m.id),{method:'DELETE'});await loadMemories();toast('Memory deleted');}};root.append(el);});}
async function loadMemories(){try{const d=await api('/api/memories');state.memories=d.memories||[];renderMemories();}catch(e){state.memories=[];$('memoryCount').textContent='Memory unavailable';if($('memoryList'))$('memoryList').innerHTML='<div class="error-list">'+esc(e.message)+'</div>';}}

function exportChat(){if(!state.messages.length)return;const title=activeTitle(),body=['# '+title,''].concat(state.messages.flatMap(m=>['## '+(m.role==='user'?'You':'Assistant'),'',m.content||'',''])).join('\\n');const a=document.createElement('a'),blob=new Blob([body],{type:'text/markdown'});a.href=URL.createObjectURL(blob);a.download=(title.replace(/[^a-z0-9-_]+/gi,'-')||'chat')+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);}
function openModal(id){$(id).classList.remove('hidden');if(id==='knowledgeModal'){switchKnowledgeTab('library');loadKnowledge();}if(id==='memoryModal')loadMemories();}
function closeModal(id){$(id).classList.add('hidden');}
function openSidebar(){$('sidebar').classList.add('open');$('backdrop').classList.add('show');}
function closeSidebar(){$('sidebar').classList.remove('open');$('backdrop').classList.remove('show');}
function syncSettings(){$('accessKeyInput').value=accessKey();$('settingKnowledge').checked=state.knowledgeEnabled;$('settingSources').checked=state.showSources;$('stylePrompt').value=state.style;$('responseMode').value=state.mode;$('knowledgeToggle').classList.toggle('active',state.knowledgeEnabled);$('knowledgeToggle').textContent=state.knowledgeEnabled?'Knowledge on':'Knowledge off';$('modeLabel').textContent=(state.mode==='direct'?'Direct':state.mode.charAt(0).toUpperCase()+state.mode.slice(1))+' mode';}

$('composer').onsubmit=e=>{e.preventDefault();send($('input').value);};
$('sendBtn').onclick=e=>{if(state.sending){e.preventDefault();state.abort&&state.abort.abort();}};
$('input').oninput=autoGrow;$('input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('composer').requestSubmit();}};
$('newChat').onclick=()=>newChat();$('chatSearch').oninput=renderConversations;$('menuBtn').onclick=openSidebar;$('closeSidebar').onclick=closeSidebar;$('backdrop').onclick=closeSidebar;
$('chatTitleButton').onclick=()=>renameChat();$('deleteChatTop').onclick=()=>deleteChat();$('exportChat').onclick=exportChat;
$('openMemory').onclick=()=>openModal('memoryModal');$('openKnowledge').onclick=()=>openModal('knowledgeModal');$('attachBtn').onclick=()=>openModal('attachSheet');$('openSettings').onclick=()=>{syncSettings();openModal('settingsModal');};
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
$('knowledgeLibraryTab').onclick=()=>switchKnowledgeTab('library');$('knowledgeAddTab').onclick=()=>switchKnowledgeTab('add');$('importKnowledgeUrls').onclick=importKnowledgeUrls;$('saveKnowledge').onclick=ingestTextKnowledge;$('saveKnowledgeFiles').onclick=ingestFileKnowledge;$('refreshKnowledge').onclick=loadKnowledge;$('knowledgeSearch').oninput=renderKnowledge;$('knowledgeTypeFilter').onchange=renderKnowledge;$('knowledgeStatusFilter').onchange=renderKnowledge;$('refreshMemory').onclick=loadMemories;$('memorySearch').oninput=renderMemories;
$('knowledgeToggle').onclick=()=>{state.knowledgeEnabled=!state.knowledgeEnabled;localStorage.setItem('uncensor.knowledge',String(state.knowledgeEnabled));syncSettings();};
$('modelSelect').onchange=()=>localStorage.setItem('uncensor.model',$('modelSelect').value);
$('saveSettings').onclick=()=>{state.knowledgeEnabled=$('settingKnowledge').checked;state.showSources=$('settingSources').checked;state.mode=$('responseMode').value;state.style=$('stylePrompt').value.trim()||DEFAULT_STYLE;const k=$('accessKeyInput').value.trim();if(k)localStorage.setItem('uncensor.accessKey',k);else localStorage.removeItem('uncensor.accessKey');localStorage.setItem('uncensor.knowledge',String(state.knowledgeEnabled));localStorage.setItem('uncensor.sources',String(state.showSources));localStorage.setItem('uncensor.mode',state.mode);localStorage.setItem('uncensor.style',state.style);syncSettings();closeModal('settingsModal');renderMessages();toast('Settings saved');loadChats();loadKnowledge();loadMemories();status();};
document.querySelectorAll('.prompt-card').forEach(b=>b.onclick=()=>{$('input').value=b.dataset.prompt||'';autoGrow();$('input').focus();});

(async function(){const saved=localStorage.getItem('uncensor.model');if(saved&&[...$('modelSelect').options].some(o=>o.value===saved))$('modelSelect').value=saved;syncSettings();autoGrow();header();await status();if(configuredApiBase()){if(accessKey()){await Promise.all([loadChats(),loadKnowledge(),loadMemories()]);}else{syncSettings();openModal('settingsModal');}}})();