import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync('app.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const apiSource=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');
const begin=app.indexOf('let pdfjsKnowledgePromise=null;');
const end=app.indexOf('async function ingestFileKnowledge(){');
assert.ok(begin>=0&&end>begin,'PDF OCR implementation must be present');
const code=app.slice(begin,end);

const screenshotText='Expert discussion: testing creative hooks at the ad-set level and using landing page views as a diagnostic signal. '.repeat(7);
const nativeText='A complete searchable PDF article describing campaign analysis and supporting evidence with good detail. '.repeat(7);

function makeHarness({localWorks=true}={}){
  let rendered=0,recognized=0,terminated=0,destroyed=0,released=0,remoteCalls=0;
  const makePage=(n,image=true)=>({
    getTextContent:async()=>({items:[{str:n===1?'Creative testing questions':nativeText,transform:[1,0,0,1,0,100]}]}),
    getOperatorList:async()=>({fnArray:image?[3]:[]}),
    getViewport:({scale})=>({width:600*scale,height:800*scale}),
    render:()=>{rendered++;return{promise:Promise.resolve()};},
    cleanup:()=>{},
  });
  const pdfDoc={numPages:2,getPage:async n=>makePage(n),destroy:async()=>{destroyed++;}};
  const ctx={
    Uint8Array,Promise,setTimeout,clearTimeout,
    api:async(path)=>{
      assert.equal(path,'/api/knowledge/ocr-page');remoteCalls++;
      return{text:screenshotText,model:'vision-test'};
    },
    document:{
      createElement:tag=>{
        if(tag==='script')return{set async(v){},set src(v){},set crossOrigin(v){},onload:null,onerror:null};
        assert.equal(tag,'canvas');
        const canvas={getContext:()=>({}),toDataURL:()=> 'data:image/jpeg;base64,'+'A'.repeat(400)};
        Object.defineProperties(canvas,{
          width:{set(value){if(value===0)released++;},get(){return 1200;}},
          height:{set(value){if(value===0)released++;},get(){return 1600;}}
        });
        return canvas;
      },
      head:{append:()=>{throw new Error('Should use preloaded OCR mock');}}
    },
    Tesseract:{createWorker:async()=>{
      if(!localWorks)throw new Error('simulated local OCR load failure');
      return{recognize:async()=>{recognized++;return{data:{text:screenshotText}};},terminate:async()=>{terminated++;}};
    }}
  };
  vm.createContext(ctx);vm.runInContext(code,ctx);
  ctx.loadPdfJs=async()=>({
    OPS:{paintImageXObject:3,paintJpegXObject:4,paintInlineImageXObject:5,paintImageXObjectRepeat:6,paintImageMaskXObject:7},
    GlobalWorkerOptions:{},getDocument:()=>({promise:Promise.resolve(pdfDoc)})
  });
  return{ctx,stats:()=>({rendered,recognized,terminated,destroyed,released,remoteCalls})};
}

assert.ok(code.includes('cdnjs.cloudflare.com/ajax/libs/tesseract.js/6.0.1/tesseract.min.js'),'OCR loader must use a CSP-allowed pinned origin');
assert.ok(code.includes('workerBlobURL:false'),'OCR worker must avoid a parent-page fetch of a blocked worker CDN');
assert.ok(code.includes("'/api/knowledge/ocr-page'"),'Browser OCR must have a private AI fallback');

{
  const h=makeHarness({localWorks:true});
  assert.equal(h.ctx.needsPdfOcr('Only a heading'),true);
  assert.equal(h.ctx.needsPdfOcr(nativeText),false);
  const result=await h.ctx.extractKnowledgePdf({arrayBuffer:async()=>new ArrayBuffer(100)},()=>{});
  assert.ok(result.text.includes(screenshotText.trim()));
  assert.ok(result.text.includes(nativeText.trim()));
  assert.ok(result.text.includes('[PDF page 1 | ocr]'));
  assert.equal(result.stats.ocrPages,1);
  assert.equal(result.stats.localOcrPages,1);
  assert.equal(result.stats.aiOcrPages,0);
  assert.equal(h.stats().remoteCalls,0);
  assert.equal(h.stats().recognized,1);
  assert.equal(h.stats().destroyed,1);
  assert.ok(h.stats().released>=2);
}

{
  const h=makeHarness({localWorks:false});
  const result=await h.ctx.extractKnowledgePdf({arrayBuffer:async()=>new ArrayBuffer(100)},()=>{});
  assert.ok(result.text.includes('[PDF page 1 | ocr-ai]'));
  assert.equal(result.stats.aiOcrPages,1);
  assert.equal(result.stats.localOcrUnavailable,true);
  assert.equal(h.stats().remoteCalls,1);
}

assert.ok(/id="knowledgeMediaFile"[^>]+multiple/.test(html),'Video picker must support multi-select');
assert.ok(/\.srt,\.vtt/.test(html),'Subtitle files must be importable as Knowledge');
assert.ok(app.includes("r.status==='failed'&&r.file"),'Failed PDF uploads must be retryable without reselecting the file');
assert.ok(apiSource.includes("if (path === '/api/knowledge/ocr-page'"),'Authenticated OCR fallback route must exist');
assert.ok(apiSource.includes("operation:'pdf_ocr_fallback'"),'AI OCR usage must be metered');
assert.ok(apiSource.includes('knowledgePageNumber'),'PDF page markers must be exposed to retrieval citations');
assert.ok(apiSource.includes("part=currentMarker+'\\n'+part"),'Every PDF retrieval chunk must retain its page marker');
console.log('PDF OCR local path, AI fallback, retry flow, and page-aware retrieval tests passed');
