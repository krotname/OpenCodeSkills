import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRuntimeApi } from "./runtime-api.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "muse-private-api-"));
const fixture = path.join(directory, "fixture.mjs");
await writeFile(fixture, `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
let requests=0;
const server=createServer((req,res)=>{
 assert.equal(req.headers.authorization,'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64'));
 assert.equal(decodeURIComponent(req.headers['x-opencode-directory']),process.cwd());
 requests++;
 const status=req.url==='/denied'?403:req.url==='/timeout'||requests===1?503:200;
 res.writeHead(status,{'content-type':'application/json'});
 res.end(JSON.stringify(status===200?{data:[{id:'free'}]}:{service:'plugin',message:'Location plugins did not finish activating'}));
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port})));
const stdinGuardTimer = setTimeout(()=>process.exit(2),15000); stdinGuardTimer.unref();
process.stdin.resume();process.stdin.on('end',()=>server.close(()=>{writeFileSync('closed.json',JSON.stringify({requests}));process.exit(0);}));
`);
const command = [process.execPath, [fixture]];
try {
  assert.deepEqual(JSON.parse(await readRuntimeApi(command, directory, process.env, "/api/model")), { data: [{ id: "free" }] });
  assert.equal(JSON.parse(await readFile(path.join(directory, "closed.json"))).requests, 2);
  await assert.rejects(readRuntimeApi(command, directory, process.env, "/denied"), /HTTP 403/);
  assert.equal(JSON.parse(await readFile(path.join(directory, "closed.json"))).requests, 1);
  await assert.rejects(readRuntimeApi(command, directory, process.env, "/timeout", 1200));
  assert.ok(JSON.parse(await readFile(path.join(directory, "closed.json"))).requests >= 1);
  console.log("Private API readiness passed: same-server 503 retry, authenticated loopback, terminal HTTP errors, deadline and shutdown");
} finally {
  await unlink(fixture);
  await unlink(path.join(directory, "closed.json"));
  await rmdir(directory);
}
