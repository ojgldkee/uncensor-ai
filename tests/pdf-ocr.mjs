import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync('app.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const api=fs.readFileSync('supabase/functions/uncensor-api/index.ts','utf8');
const begin=app.indexOf('let pdfjsKnowledgePromise=null;');
const end=app.indexOf('async function ingestFileKnowledge(){');
assert.ok(begin>=0&&end>begin,'PDF OCR implementation must be present');
const code=app.slice(begin,end);

let rendered=0,recognized=0,terminated=0,destroyed=0,released=0;
const screenshotText='Expert discussion: testing creative hooks at the ad-set level and using landing page views as a diagnostic signal. '.repeat(7);
const nativeText='A complete searchable PDF article describing campaign analysis and supporting evidence with good detail. '.repeat(7);
const makePage=(n,image=true)=>({
  getTextContent:async()=>({items:[{str:n===1?'Creative testing questions':nativeText,transform:[1,0,0,1,0,100]}]}),
  getOperatorList:async()=>({fnArray:image?[3]:[]}),
  getViewport:({scale})=>({width:600*scale,height:800*scale}),
  render:()=>{rendered++;return{promise:Promise.resolve()};},
  cleanup:()=>{},
});
const pdfDoc={
  numPages:2,getPage:async n=>makePage(n),destroy:async()=>{destroyed++;},
};
const ctx={
  Uint8Array,Promise,setTimeout,clearTimeout,
  document:{
    createElement:tag=>{
      assert.equal(tag,'canvas');
      const canvas={getContext:()=>({})};
      Object.defineProperties(canvas,{
        width:{set(value){if(value===0)released++;},get(){return 1200;}},
        height:{set(value){if(value===0)released++;},get(){return 1600;}}
      });
      return canvas;
    },
    head:{append:()=>{throw new Error('Should use preloaded OCR mock');}}
  },
  Tesseract:{createWorker:async()=>{
    return{
      recognize:async()=>{recognized++;return{data:{text:screenshotText}};},
      terminate:async()=>{terminated++;}
    };
  }}
};
vm.createContext(ctx);
vm.runInContext(code,ctx);
ctx.loadPdfJs=async()=>({
  OPS:{paintImageXObject:3,paintJpegXObject:4,paintInlineImageXObject:5,paintImageXObjectRepeat:6,paintImageMaskXObject:7},
  GlobalWorkerOptions:{},
  getDocument:()=>({promise:Promise.resolve(pdfDoc)})
});

assert.equal(ctx.needsPdfOcr('Only a heading'),true);
assert.equal(ctx.needsPdfOcr(nativeText),false);
assert.ok(code.includes("tag.integrity='sha384-"),'Third-party OCR script must have integrity pinning');
const stages=[];
const result=await ctx.extractKnowledgePdf({arrayBuffer:async()=>new ArrayBuffer(100)},(page,total,stage,stats)=>{
  stages.push({page,total,stage,ocrPages:stats.ocrPages});
});
assert.ok(result.text.includes(screenshotText.trim()),'Screenshots must become searchable text');
assert.ok(result.text.includes(nativeText.trim()),'Existing selectable text must be preserved');
assert.ok(result.text.includes('[PDF page 1 | ocr]'),'OCR pages must retain citation markers');
assert.equal(result.stats.pages,2);
assert.equal(result.stats.ocrPages,1,'Native pages should avoid unnecessary OCR');
assert.equal(result.stats.readablePages,2);
assert.ok(result.stats.words>100);
assert.equal(rendered,1);
assert.equal(recognized,1);
assert.equal(terminated,1,'The OCR worker must be cleaned up');
assert.equal(destroyed,1,'The PDF worker must be cleaned up');
assert.equal(released,2,'OCR canvas memory must be released');
assert.ok(stages.some(x=>x.stage==='ocr'));

assert.ok(/id="knowledgeMediaFile"[^>]+multiple/.test(html),'Video picker must support multi-select');
assert.ok(/\.srt,\.vtt/.test(html),'Subtitle files must be importable as Knowledge');
assert.ok(app.includes('state.knowledgeMediaFiles=files.slice(0,10)'),'Media drops must preserve staged files');
assert.ok(app.includes('Transcript-only mode requires a video under 16 MB'),'UI must prevent a known media processing failure');
assert.ok(api.includes("mode==='transcript'&&size>16*1024*1024"),'Backend must reject unsupported large transcript-only videos');
console.log('PDF OCR extraction, worker cleanup, quality metadata, and video ingestion regression tests passed');
