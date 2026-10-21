/** Trusted container init child. Only its framed stdio reaches the host proxy. */
export const containerRunner = String.raw`
const {createServer} = require('node:net');
const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const sockets = new Map(); let next = 0, started = false;
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const input = createInterface({input:process.stdin});
input.on('close',()=>process.exit(125));
input.on('line', line => {
  const m = JSON.parse(line);
  if(m.type === 'data') sockets.get(m.id)?.write(Buffer.from(m.data,'base64'));
  if(m.type === 'end') sockets.get(m.id)?.end();
  if(m.type === 'start' && !started) {
    started = true;
    const proxy = createServer(socket => {
      const id = ++next; sockets.set(id,socket); send({type:'open',id});
      socket.on('data',data=>send({type:'data',id,data:data.toString('base64')}));
      socket.on('end',()=>send({type:'end',id}));
      socket.on('error',()=>{}); socket.on('close',()=>sockets.delete(id));
    });
    proxy.listen(0,'127.0.0.1',()=>{
      const url = 'http://'+m.auth+'@127.0.0.1:'+proxy.address().port;
      const env = {PATH:'/usr/local/bin:/usr/bin:/bin',HOME:m.scratch,TMPDIR:m.scratch,LANG:'C.UTF-8',
        http_proxy:url,https_proxy:url,HTTP_PROXY:url,HTTPS_PROXY:url,ALL_PROXY:url,NO_PROXY:'',no_proxy:'',
        SSL_CERT_FILE:'/run/egress-ca.pem',CURL_CA_BUNDLE:'/run/egress-ca.pem',NODE_EXTRA_CA_CERTS:'/run/egress-ca.pem',OPENSSL_CONF:'/dev/null'};
      const child = spawn('/usr/local/bin/guanxi-exec-guard',['/bin/sh','-c',m.command],{cwd:m.scratch,env,stdio:['ignore','pipe','pipe']});
      let bytes = 0, truncated = false;
      for(const channel of ['stdout','stderr']) child[channel].on('data',data=>{
        const remaining = Math.max(0,m.limit-bytes); bytes += data.length;
        truncated ||= data.length > remaining;
        if(remaining) send({type:'output',channel,data:data.subarray(0,remaining).toString('base64')});
      });
      child.once('error',()=>process.exit(125));
      // Exit on the shell's exit, not pipe close: detached children may retain pipes.
      child.once('exit',code=>{process.stdout.write(JSON.stringify({type:'result',code,truncated})+'\n',()=>process.exit(0))});
    });
  }
});
`
