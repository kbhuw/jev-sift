import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('standalone bundled MCP server: initialize, tools/list, status, classify and malformed output',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'classify-mcp-'));let requests=0;
  const http=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    assert.equal(req.url,'/v1/systemone');requests++;
    const input=JSON.parse(body);assert.equal(input.model,'jev-latest');assert.equal(input.questions.healthcare.type,'noul');
    const content=input.state==='bad-json'?'not JSON':JSON.stringify({answers:{healthcare:{type:'noul',noul:.93},sector:{type:'choice',choice:'health'},fit:{type:'score',score:1.7}}});
    res.setHeader('content-type','application/json');res.end(content==='not JSON'?content:JSON.stringify({...JSON.parse(content),usage:{input_tokens:10}}));
  });
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  const client=new Client({name:'integration-test',version:'1.0.0'});
  try{
    await mkdir(join(dir,'isolated'));await copyFile(resolve('dist/server.mjs'),join(dir,'isolated/server.mjs'));
    const configPath=join(dir,'config.json');const keyPath=join(dir,'key');await writeFile(keyPath,'test-key');await writeFile(configPath,JSON.stringify({apiKeyFile:keyPath,roots:[dir]}));
    const preload=join(dir,'preload.mjs');await writeFile(preload,`const original=globalThis.fetch;globalThis.fetch=(url,opts)=>{if(url!=='https://api.typesafe.ai/v1/systemone')throw Error('Unexpected endpoint');return original('http://127.0.0.1:${http.address().port}/v1/systemone',opts)};`);
    await writeFile(join(dir,'company.txt'),'Hospital software');
    await client.connect(new StdioClientTransport({command:process.execPath,args:['--import',preload,join(dir,'isolated/server.mjs')],cwd:join(dir,'isolated'),env:{PATH:process.env.PATH,HOME:process.env.HOME,JEV_SIFT_CONFIG:configPath}}));
    const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name).sort(),['classify','classify_status']);
    const status=await client.callTool({name:'classify_status',arguments:{}});assert.equal(status.structuredContent.configured,true);assert.equal(status.structuredContent.providerVerified,false);assert.equal(requests,0);
    const questions={healthcare:{type:'boolean',instructions:'Serves healthcare?'},sector:{type:'choice',instructions:'Pick industry',criteria:{health:'Healthcare',other:'Other'}},fit:{type:'score',instructions:'Match',criteria:['bad','okay','great']}};
    const out=await client.callTool({name:'classify',arguments:{items:[{id:'a',path:'company.txt'},{id:'b',text:'bad-json'}],questions}});
    assert.equal(out.isError,false);assert.equal(out.structuredContent.results[0].answers.fit.score,1.7);assert.match(out.structuredContent.results[1].error,/JSON/);assert.equal(requests,2);
    const invalid=await client.callTool({name:'classify',arguments:{items:[{id:'a',text:'x',path:'x'}],questions}});assert.equal(invalid.isError,true);assert.equal(requests,2);
    await writeFile(keyPath,'');const missing=await client.callTool({name:'classify_status',arguments:{}});assert.equal(missing.structuredContent.configured,false);
  }finally{await client.close();await new Promise(r=>http.close(r));await rm(dir,{recursive:true,force:true});}
});
