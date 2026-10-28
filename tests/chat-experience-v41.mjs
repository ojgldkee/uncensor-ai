import assert from 'node:assert/strict';
import fs from 'node:fs';

const app=fs.readFileSync('app.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const css=fs.readFileSync('styles.css','utf8');
const api=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');

assert.ok(html.includes('id="messageActionSheet"'),'Assistant message action sheet is missing');
for(const id of ['messageCopyAction','messageSelectAction','messageRegenerateAction','messageShareAction','messageSourcesAction','messageImageAction','messageDeleteAction']){
  assert.ok(html.includes('id="'+id+'"'),'Missing message action '+id);
}
assert.ok(!/Listen/i.test(html.slice(html.indexOf('messageActionSheet'),html.indexOf('selectTextModal'))),'Listen must not appear in the message menu');
assert.ok(!/thumb|like|dislike/i.test(html.slice(html.indexOf('messageActionSheet'),html.indexOf('selectTextModal'))),'Rating controls must not appear in the message menu');
assert.ok(!html.includes('>Why these sources?<'),'Visible Why these sources text must be removed');
assert.ok(!html.includes('id="settingSources"'),'Source-chip visibility setting should be removed because source lists are menu-only');

assert.ok(!app.includes('sourceHtml=state.showSources'),'Assistant answers must not render source-chip lists');
assert.ok(app.includes('function renderMessageSources('),'View Sources must render inside the message menu');
assert.ok(app.includes('function openMessageActions('),'Three-dot message menu must be wired');
assert.ok(app.includes('function shareMessage(')&&app.includes('navigator.share'),'Native sharing must be supported');
assert.ok(app.includes('function saveMessageAsImage(')&&app.includes("canvas.toBlob"),'Save-as-image must be implemented');
assert.ok(app.includes('function openSelectText(')&&html.includes('id="selectTextContent"'),'Text selection view must be implemented');

assert.ok(app.includes('function md(v)')&&app.includes('message-table-wrap'),'Message renderer must support real tables');
assert.ok(app.includes("<ul>")&&app.includes("<ol>")&&app.includes("<blockquote>"),'Message renderer must support lists and blockquotes');
assert.ok(css.includes('.message-body pre')&&css.includes('.message-table-wrap'),'Code and tables must have mobile-safe styling');

assert.ok(css.includes('--composer-space')&&app.includes("updateLayoutMetrics"),'Composer height must drive chat bottom spacing');
assert.ok(css.includes('bottom:calc(var(--composer-space) + 10px)'),'Toasts must sit above the composer');
assert.ok(app.includes('visualViewport'),'iPhone visual viewport changes must update layout');
assert.ok(app.includes('nearMessageBottom')&&html.includes('id="jumpLatest"'),'Scroll-follow must stop when reading older content and expose Jump to latest');

assert.ok(api.includes('Do not narrate K-numbers'),'Model must not narrate raw K labels');
assert.ok(api.includes('Do not add an “Evidence strength,”'),'Model must avoid retrieval-debug report style by default');
assert.ok(api.includes('[[NEXT]]')&&app.includes('splitAssistantMeta'),'Guided follow-ups must be produced inside the same answer and hidden from prose');
assert.ok(app.includes('followup-chip'),'Guided next questions must be clickable');

assert.ok(api.includes('async function regenerateMessage'),'Real message regeneration endpoint is missing');
assert.ok(api.includes('async function deleteLatestExchange'),'Delete Exchange endpoint is missing');
assert.ok(api.includes("operation:'regenerate'"),'Regeneration cost must be metered');
assert.ok(api.includes('Regenerate/Delete Exchange is available on the latest response only'),'Destructive message actions must be limited to the latest response');
assert.ok(app.includes("/regenerate")&&app.includes("/delete-exchange"),'Frontend must call message action endpoints');

assert.ok(html.includes('id="chatControlsSheet"')&&html.includes('id="chatControlsBtn"'),'Mobile chat controls sheet is missing');
assert.ok(css.includes('.desktop-chat-toggle{display:none!important}'),'Web/Knowledge header chips must move out of the cramped mobile header');
assert.ok(html.includes('neural-mark')&&css.includes('.neural-mark'),'v41 neural-core branding mark is missing');

assert.ok(app.includes("localStorage.setItem('uncensor.clientErrors'"),'Client diagnostics should persist across refreshes');
assert.ok(html.includes('app.js?v=41.2')&&html.includes('styles.css?v=41'),'v41 cache URLs must be active');

console.log('v41 chat experience, message actions, hidden source UI and mobile layout tests passed');
