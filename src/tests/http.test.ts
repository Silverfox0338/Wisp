import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from '../compiler/parser.js';
import {execute,type Value} from '../runtime/interpreter.js';
import {HttpClient,createNodeTransport,isPrivateAddress,type HttpConfig,type HttpReply,type HttpRequest} from '../runtime/http.js';
import {initProject} from '../cli/scaffold.js';
import {runWispTests} from '../cli/test-runner.js';
import {discover} from '../project/discovery.js';
import {loadProject} from '../project/manifest.js';

function fakeTransport(handler:(request:HttpRequest)=>HttpReply){const seen:HttpRequest[]=[];return {seen,transport:async(request:HttpRequest)=>{seen.push(request);return handler(request);}};}
const jsonReply=(value:unknown,status=200):HttpReply=>({status,headers:{'content-type':'application/json'},body:JSON.stringify(value)});
async function run(source:string,client:HttpClient,limits={}):Promise<string[]>{const out:string[]=[];const {http,apis}=client.api(limits);await execute(parse(source).statements,{values:{http,apis},reply:async body=>{out.push(body.content!);}});return out;}
async function serve(handler:(request:IncomingMessage,response:ServerResponse)=>void):Promise<{base:string;close:()=>Promise<void>}>{
  const server=createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {base:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}

test('private, loopback, and metadata addresses are blocked',()=>{
  for(const address of ['10.1.2.3','127.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1','::1','fd00::1','fe80::1','::ffff:127.0.0.1','0.0.0.0'])assert.equal(isPrivateAddress(address),true,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPrivateAddress(address),false,address);
});

test('raw requests require an allowed https host',async()=>{
  const {seen,transport}=fakeTransport(()=>jsonReply({name:'wisp'}));
  const client=new HttpClient({allow:['api.example.com','*.example.org'],apis:{}},transport);
  assert.deepEqual(await run('let r = http.get("https://api.example.com/repo", {"query": {"page": 2}})\nreply "{r.status} {r.ok} {r.json.name}"\n',client),['200 true wisp']);
  assert.equal(seen[0]?.url.href,'https://api.example.com/repo?page=2');
  assert.deepEqual(await run('reply http.get("https://cdn.example.org/x").json.name\n',client),['wisp']);
  for(const url of ['https://evil.com/','https://example.org/','http://api.example.com/','https://user:pw@api.example.com/'])
    await assert.rejects(()=>run(`http.get("${url}")\n`,client),/not allowed|credentials/,url);
  await assert.rejects(()=>run('http.get("https://api.example.com/", {"headers": {"Host": "evil.com"}})\n',client),/cannot be set/);
  await assert.rejects(()=>run('http.get("https://api.example.com/", {"json": {"a": 1}})\n',client),/cannot have a body/);
});

test('HTTP errors are catchable with codes, and non-2xx responses do not throw',async()=>{
  const client=new HttpClient({allow:['api.example.com'],apis:{}},async request=>{if(request.url.pathname==='/down')throw new Error('connect ECONNREFUSED');return {status:404,headers:{'content-type':'text/plain'},body:'missing'};});
  assert.deepEqual(await run('let r = http.get("https://api.example.com/x")\nreply "{r.status} {r.ok} {r.text} {r.json}"\ntry:\n    http.get("https://evil.com/")\ncatch e:\n    reply e.code\ntry:\n    http.get("https://api.example.com/down")\ncatch e:\n    reply e.code\n',client),['404 false missing null','HTTP002','HTTP004']);
});

test('named APIs inject manifest headers and query that scripts cannot override or read',async()=>{
  const {seen,transport}=fakeTransport(()=>jsonReply({temp:21}));
  const config:HttpConfig={allow:[],apis:{weather:{baseUrl:'https://api.weather.test/v2/',headers:{'X-Api-Key':'secret-value'},query:{units:'metric'},timeoutMs:8000,cacheSeconds:60}}};
  const client=new HttpClient(config,transport);
  assert.deepEqual(await run('let r = apis.weather.get("/current", {"query": {"q": "Oslo", "units": "imperial"}, "headers": {"x-api-key": "stolen"}})\nreply "{r.json.temp}"\nreply "{len(r.headers)}"\n',client),['21','1']);
  assert.equal(seen[0]?.url.href,'https://api.weather.test/v2/current?q=Oslo&units=metric');
  assert.equal(seen[0]?.headers['x-api-key'],'secret-value');
  await run('apis.weather.get("current", {"query": {"q": "Oslo"}})\n',client);
  assert.equal(seen.length,1,'second identical GET is served from cache');
  for(const path of ['https://evil.com/x','//evil.com/x','../admin','/a/%2e%2e/b'])await assert.rejects(()=>run(`apis.weather.get("${path}")\n`,client),/relative|segments/,path);
  await assert.rejects(()=>run('http.get("https://api.weather.test/v2/current")\n',client),/not allowed/);
});

test('JSON responses are frozen and checked against Wisp limits',async()=>{
  const client=new HttpClient({allow:['api.example.com'],apis:{}},async()=>jsonReply(Array.from({length:10001},()=>1)));
  await assert.rejects(()=>run('http.get("https://api.example.com/")\n',client),/HTTP|limits/);
  const frozen=new HttpClient({allow:['api.example.com'],apis:{}},async()=>jsonReply({a:1,b:2}));
  await assert.rejects(()=>run('let r = http.get("https://api.example.com/")\nr.json.remove("a")\n',frozen),/read-only/);
});

test('node transport enforces redirects, response size, timeouts, and cancellation',async()=>{
  const server=await serve((request,response)=>{
    if(request.url==='/json'){response.setHeader('content-type','application/json');response.end(JSON.stringify({ok:true}));return;}
    if(request.url==='/echo'){let body='';request.on('data',chunk=>{body+=String(chunk);});request.on('end',()=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({method:request.method,type:request.headers['content-type'],body:JSON.parse(body) as unknown}));});return;}
    if(request.url==='/hop'){response.statusCode=302;response.setHeader('location','/json');response.end();return;}
    if(request.url==='/away'){response.statusCode=302;response.setHeader('location','https://evil.com/');response.end();return;}
    if(request.url==='/loop'){response.statusCode=302;response.setHeader('location','/loop');response.end();return;}
    if(request.url==='/huge'){response.end(Buffer.alloc(1024*1024+10,97));return;}
    if(request.url==='/slow'){setTimeout(()=>{if(!response.writableEnded)response.end('late');},2000);return;}
    response.statusCode=404;response.end();
  });
  try{
    const client=new HttpClient({allow:['http://127.0.0.1'],apis:{}},createNodeTransport({allowPrivate:true}));
    assert.deepEqual(await run(`reply "{http.get('${server.base}/json').json.ok}"\nlet r = http.post("${server.base}/echo", {"json": {"n": 3}})\nreply "{r.json.method} {r.json.type} {r.json.body.n}"\nreply "{http.get('${server.base}/hop').json.ok}"\n`,client),['true','POST application/json 3','true']);
    await assert.rejects(()=>run(`http.get("${server.base}/away")\n`,client),/Redirect to evil.com is not allowed/);
    await assert.rejects(()=>run(`http.get("${server.base}/loop")\n`,client),/Too many redirects/);
    await assert.rejects(()=>run(`http.get("${server.base}/huge")\n`,client),/exceeds 1 MiB/);
    await assert.rejects(()=>run(`http.get("${server.base}/slow", {"timeout_ms": 50})\n`,client),/timed out after 50 ms/);
    const controller=new AbortController();setTimeout(()=>controller.abort(),50);
    await assert.rejects(()=>run(`http.get("${server.base}/slow")\n`,client,{signal:controller.signal}),/cancelled/);
    const guarded=new HttpClient({allow:['http://127.0.0.1','http://localhost'],apis:{}});
    await assert.rejects(()=>run(`http.get("${server.base}/json")\n`,guarded),/private or reserved/);
    await assert.rejects(()=>run(`http.get("${server.base.replace('127.0.0.1','localhost')}/json")\n`,guarded),/private or reserved/);
  }finally{await server.close();}
});

test('manifest http section validates hosts and keeps secrets in the environment',()=>{
  const root=mkdtempSync(join(tmpdir(),'wisp-http-manifest-'));
  try{
    const dir=initProject('apibot',root);
    const manifest=JSON.parse(readFileSync(join(dir,'wisp.json'),'utf8')) as Record<string,unknown>;
    const write=(http:unknown)=>writeFileSync(join(dir,'wisp.json'),JSON.stringify({...manifest,http}));
    process.env.WISP_TEST_WEATHER_KEY='from-env';
    write({allow:['api.github.com','*.example.org'],apis:{weather:{base_url:'https://api.weather.test/v2',headers:{Authorization:'Bearer ${WISP_TEST_WEATHER_KEY}',Accept:'application/json'},query:{units:'metric'},cache_seconds:30}}});
    const http=loadProject(dir).manifest.http!;
    assert.deepEqual(http.allow,['api.github.com','*.example.org']);
    assert.equal(http.apis.weather!.headers.Authorization,'Bearer from-env');
    assert.equal(http.apis.weather!.cacheSeconds,30);assert.equal(http.apis.weather!.timeoutMs,8000);
    write({apis:{weather:{base_url:'https://api.weather.test',headers:{'X-Api-Key':'literal-secret'}}}});
    assert.throws(()=>loadProject(dir),/environment reference/);
    write({apis:{weather:{base_url:'http://api.weather.test'}}});
    assert.throws(()=>loadProject(dir),/https URL/);
    write({allow:['https://api.github.com/path']});
    assert.throws(()=>loadProject(dir),/http.allow entry/);
    write({apis:{weather:{base_url:'https://api.weather.test',retries:3}}});
    assert.throws(()=>loadProject(dir),/Unknown/);
  }finally{delete process.env.WISP_TEST_WEATHER_KEY;rmSync(root,{recursive:true,force:true});}
});

test('wisp test mocks HTTP requests and rejects unmocked ones',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wisp-http-runner-'));
  try{
    const root=initProject('sample',temp);
    const manifest=JSON.parse(readFileSync(join(root,'wisp.json'),'utf8')) as Record<string,unknown>;
    writeFileSync(join(root,'wisp.json'),JSON.stringify({...manifest,http:{allow:['api.github.com'],apis:{weather:{base_url:'https://api.weather.test/v2',headers:{'X-Api-Key':'${WEATHER_KEY}'}}}}}));
    writeFileSync(join(root,'commands','weather.wisp'),'command "weather":\n    description "Weather"\n    option city:\n        type: string\n        required: true\n    execute:\n        let r = apis.weather.get("/current", {"query": {"q": options.city}})\n        if r.ok:\n            reply "{options.city}: {r.json.temp}C"\n        else:\n            reply "Weather unavailable ({r.status})"\n');
    writeFileSync(join(root,'tests','http.test.wisp'),`mock.httpRespond("GET", "https://api.weather.test/v2/current", {"json": {"temp": 21}})
mock.httpRespond("GET", "https://api.weather.test/v2/*", {"status": 503})
assert.equal(mock.run("weather", {"city": "Oslo"})[0].content, "Oslo: 21C")
assert.equal(mock.run("weather", {"city": "Rome"})[0].content, "Weather unavailable (503)")
let calls = mock.httpCalls()
assert.equal(calls[0].url, "https://api.weather.test/v2/current?q=Oslo")
assert.equal(calls[0].headers["x-api-key"], "[redacted]")
mock.httpFail("GET", "https://api.github.com/*")
try:
    http.get("https://api.github.com/zen")
    assert.ok(false)
catch e:
    assert.equal(e.code, "HTTP004")
`);
    writeFileSync(join(root,'tests','unmocked.test.wisp'),'http.get("https://api.github.com/zen")\n');
    const project=loadProject(root),compiled=discover(project);
    const errors:string[]=[],original=console.error;console.error=(message:unknown)=>{errors.push(String(message));};
    try{await assert.rejects(()=>runWispTests(project,compiled),/1 of 3 Wisp tests failed/);}finally{console.error=original;}
    assert.equal(errors.length,1);assert.match(errors[0]!,/unmocked\.test\.wisp.*Unmocked HTTP request: GET https:\/\/api\.github\.com\/zen/s);
  }finally{rmSync(temp,{recursive:true,force:true});}
});

test('http values cross into Wisp as read-only records',async()=>{
  const client=new HttpClient({allow:['api.example.com'],apis:{}},async()=>jsonReply({items:[{id:1},{id:2}]}));
  const out=await run('let r = http.get("https://api.example.com/")\nfor item in r.json.items:\n    reply "{item.id}"\n',client);
  assert.deepEqual(out,['1','2']);
  const value=client.api().http as Record<string,Value>;assert.ok(Object.isFrozen(value));
});

test('editor completes http verbs, named APIs, and response fields',async()=>{
  const {analyze,completion,signature}=await import('../editor/service.js');
  const root=mkdtempSync(join(tmpdir(),'wisp-http-editor-'));
  try{
    const dir=initProject('apibot',root),manifest=JSON.parse(readFileSync(join(dir,'wisp.json'),'utf8')) as Record<string,unknown>;
    writeFileSync(join(dir,'wisp.json'),JSON.stringify({...manifest,http:{apis:{weather:{base_url:'https://api.weather.test'}}}}));
    const file=join(dir,'commands','ping.wisp'),labels=(source:string,line:number,character:number)=>completion(analyze(source,file),{line,character}).map(item=>item.label).sort();
    assert.deepEqual(labels('http.',0,5),['delete','get','patch','post','put','request']);
    assert.deepEqual(labels('apis.',0,5),['weather']);
    assert.deepEqual(labels('apis.weather.',0,13),['delete','get','patch','post','put','request']);
    assert.match(signature(analyze('apis.weather.get(',file),{line:0,character:17})?.signature??'',/httpResponse/);
    assert.deepEqual(analyze('let r = http.get("https://x")\nreply "{r.status}"\n',file).diagnostics,[]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
