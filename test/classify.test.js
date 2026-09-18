import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, inputSchema, validateAnswers, formatOutput, CHAR_LIMIT } from '../src/classify.js';
import { createFileReader } from '../src/files.js';
import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/provider.js';
const questions = { relevant: { type: 'boolean', instructions: 'Relevant?' } };
const answer = { relevant: { type: 'boolean', probability: .9 } };

test('reject invalid inputs before doing any work', async () => {
  for (const item of [{ id:'a' }, {id:'a',text:'x',path:'x'}]) assert.throws(()=>inputSchema.parse({items:[item],questions}));
  assert.throws(()=>inputSchema.parse({items:[{id:'a',text:''},{id:'a',text:'x'}],questions}));
  assert.throws(()=>inputSchema.parse({items:[{id:'a',text:'x'}],questions:{}}));
  assert.throws(()=>inputSchema.parse({items:[{id:'a',text:'x'}],questions:{q:{type:'choice',instructions:'pick',criteria:{a:null}}}}));
});
test('bounds concurrency, preserves ordering and reports partial failure', async () => {
  let active=0,max=0;
  const output=await classify({items:Array.from({length:20},(_,i)=>({id:String(i),text:String(i)})),questions},{concurrency:3,evaluate:async({text})=>{
    active++; max=Math.max(max,active); await new Promise(r=>setTimeout(r,(20-Number(text))%4)); active--;
    if(text==='7') throw new Error('failed item');
    return {answers:answer,usage:{inputTokens:2}};
  }});
  assert.equal(max,3); assert.equal(output.results[7].error,'failed item'); assert.equal(output.ok,true);
  assert.deepEqual(output.results.map(r=>r.id),Array.from({length:20},(_,i)=>String(i)));
  assert.equal(output.usage.inputTokens,38);
});
test('truncates file content and keeps all failure identities',async()=>{
  let length;
  const out=await classify({items:[{id:'file',path:'a'}],questions},{readText:async()=> 'a'.repeat(CHAR_LIMIT+100),evaluate:async({text})=>{length=text.length;return {answers:answer};}});
  assert.equal(length,CHAR_LIMIT);assert.equal(out.results[0].truncated,true);
  const failed=await classify({items:[{id:'one',path:'a'},{id:'two',path:'b'}],questions},{evaluate:async()=>{throw Error('no');}});
  assert.equal(failed.ok,false);assert.equal(failed.results.length,2);
});
test('validates model answers against exact questions, options and score ranges',()=>{
  const qs={...questions,kind:{type:'choice',instructions:'pick',criteria:{yes:null,no:null}},fit:{type:'score',instructions:'rate',criteria:['bad','good','great']}};
  const valid={...answer,kind:{type:'choice',choice:'yes'},fit:{type:'score',score:1.4}};
  assert.deepEqual(validateAnswers(valid,qs),valid);
  for(const bad of [{...valid,extra:{type:'boolean',probability:.8}},{...valid,fit:{type:'score',score:3}},{...valid,kind:{type:'choice',choice:'unknown'}},{...valid,relevant:{type:'boolean',probability:-1}},{}]) assert.throws(()=>validateAnswers(bad,qs));
});
test('reports P(yes) unambiguously and rejects invalid model JSON',async()=>{
  const out=await classify({items:[{id:'a',text:'a'}],questions},{evaluate:async()=>({answers:{relevant:{type:'boolean',probability:.1}}})});
  assert.match(formatOutput(out),/no \(P\(yes\)=0.10\)/);
  const invalid=await classify({items:[{id:'a',text:'a'}],questions},{evaluate:async()=>({answers:{relevant:{type:'boolean',probability:99}}})});
  assert.equal(invalid.ok,false);
});
test('cancellation prevents subsequent items from starting',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(classify({items:[{id:'a',text:'a'},{id:'b',text:'b'}],questions},{concurrency:1,signal:controller.signal,evaluate:async()=>{calls++;controller.abort();throw controller.signal.reason;}}));
  assert.equal(calls,1);
});
test('files: root confinement, symlinks, bounded UTF-8, binary and directory rejection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'classify-test-'));
  try {
    const root=join(dir,'root');await mkdir(root);await writeFile(join(root,'ok.txt'),'hello');await writeFile(join(dir,'outside'),'private');
    await symlink(join(dir,'outside'),join(root,'link'));await writeFile(join(root,'big'),'😀'.repeat(40000));await writeFile(join(root,'binary'),'a\0b');
    const read=createFileReader([root]);assert.equal(await read('ok.txt'),'hello');assert.equal((await read('big')).length,CHAR_LIMIT+1);
    await assert.rejects(read('../outside'),/outside/);await assert.rejects(read('link'),/outside/);await assert.rejects(read('binary'),/Binary/);await assert.rejects(read('.'),/regular/);
    await assert.rejects(createFileReader([])('/x'),/disabled/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('configuration stays explicit and secrets are not inferred',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'classify-config-'));const p=join(dir,'config.json');
  try {
    await writeFile(p,JSON.stringify({baseUrl:'http://localhost:11434/v1',model:'local',roots:[]}));
    const c=await loadConfig({CLASSIFY_CONFIG:p});assert.equal(c.model,'local');assert.equal(c.apiKey,undefined);
    await assert.rejects(loadConfig({CLASSIFY_CONFIG:p,CLASSIFY_BASE_URL:'http://remote.example/v1'}),/HTTPS/);
    await assert.rejects(loadConfig({CLASSIFY_CONFIG:p,CLASSIFY_BASE_URL:'https://token@remote.example/v1'}),/credentials/);
    await assert.rejects(loadConfig({CLASSIFY_CONFIG:join(dir,'absent')}),/does not exist/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('provider uses configured model and suppresses upstream error text',async()=>{
  let request;
  const evaluate=createProvider({baseUrl:'https://example.com/v1/',model:'my-model',apiKey:'test-secret'},async(url,options)=>{
    request={url,options};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({answers:answer})}}],usage:{prompt_tokens:12}}));
  });
  const r=await evaluate({text:'untrusted',questions});assert.equal(r.usage.inputTokens,12);
  assert.equal(request.url,'https://example.com/v1/chat/completions');assert.equal(request.options.redirect,'error');
  assert.equal(JSON.parse(request.options.body).model,'my-model');assert.equal(JSON.parse(JSON.parse(request.options.body).messages[1].content).text,'untrusted');
  const failure=createProvider({baseUrl:'https://example.com',model:'x'},async()=>new Response('test-secret',{status:401}));
  await assert.rejects(failure({text:'x',questions}),e=>e.message.includes('401')&&!e.message.includes('test-secret'));
});
