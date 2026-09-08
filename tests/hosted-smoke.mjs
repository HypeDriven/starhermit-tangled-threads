import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(),'tangled-threads-'));
process.env.TT_DATA_DIR = dir;
const {server} = await import('../server.js');
await new Promise(r => server.listen(0,'127.0.0.1',r));
const env = {...process.env, APP_URL:`http://127.0.0.1:${server.address().port}`};
try {
  for (const test of ['browser.smoke.mjs']) {
    await new Promise((resolve,reject) => {
      const child = spawn(process.execPath,[new URL(test,import.meta.url).pathname],{env,stdio:'inherit'});
      child.once('error',reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${test}: ${code}`)));
    });
  }
} finally {
  server.closeAllConnections(); await new Promise(r=>server.close(r));
  await rm(dir,{recursive:true,force:true});
}
