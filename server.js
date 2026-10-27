'use strict';
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');
const { WebSocketServer } = require('ws');
const PORT = Number(process.env.PORT) || 3000;
const sessions = new Map();
const app = express();

app.use(express.json({ limit: '32kb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
function sshConnect(session) {
  if (session.client) return Promise.resolve(session.client);
  if (session.pending) return session.pending;
  session.pending = new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      session.pending = null;
      reject(new Error(`SSH 连接失败: ${err.message}`));
    };
    client.on('ready', () => {
      settled = true;
      session.pending = null;
      session.client = client;
      resolve(client);
    });
    client.on('keyboard-interactive', (_name, _instr, _lang, prompts, done) => {
      done(prompts.map(() => session.config.password));
    });
    client.on('error', fail);
    client.on('close', () => {
      session.client = null;
      session.stream = null;
    });
    client.connect({
      ...session.config,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
    });
  });
  return session.pending;
}
function sessionFor(req, res) {
  const session = sessions.get(String(req.query.sessionId || ''));
  if (!session) res.status(404).json({ error: '会话不存在或已过期' });
  return session;
}
function getSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}
function run(conn, command) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer;
    const finish = (err, output) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(output);
    };
    timer = setTimeout(() => finish(new Error('远程命令执行超时')), 12000);
    conn.exec(command, (err, stream) => {
      if (err) return finish(err);
      let output = '';
      stream.on('data', (chunk) => { output += chunk; });
      stream.stderr.resume();
      stream.on('close', () => finish(null, output));
      stream.on('error', finish);
    });
  });
}
function parseMetrics(output) {
  const idle = output.match(/([\d.]+)\s*id/);
  const mem = output.match(/^Mem:\s+(\d+)\s+(\d+)/m);
  const diskParts = output.split('\n').map((line) => line.trim().split(/\s+/))
    .find((parts) => parts.length >= 5 && parts[parts.length - 1] === '/');
  const offset = diskParts && diskParts.length > 5 ? 1 : 0;
  const percent = (used, total) => total ? +(used * 100 / total).toFixed(1) : 0;
  return {
    cpu: idle ? +(Math.max(0, 100 - Number(idle[1])).toFixed(1)) : null,
    mem: mem ? {
      used: Number(mem[2]),
      total: Number(mem[1]),
      percent: percent(Number(mem[2]), Number(mem[1])),
    } : null,
    disk: diskParts ? {
      used: diskParts[1 + offset],
      total: diskParts[offset],
      percent: Number.parseInt(diskParts[3 + offset], 10),
    } : null,
    time: new Date().toISOString(),
  };
}
app.post('/connect', async (req, res) => {
  const { host, port = 22, username, password } = req.body || {};
  if (!host || !username || password === undefined) {
    return res.status(400).json({ error: '请填写 host、username 和 password' });
  }
  const session = {
    id: crypto.randomUUID(),
    config: { host: String(host), port: Number(port) || 22, username: String(username), password: String(password) },
    client: null,
    pending: null,
    stream: null,
  };
  try {
    await sshConnect(session);
    sessions.set(session.id, session);
    res.json({ sessionId: session.id });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/disconnect', (req, res) => {
  const session = sessions.get(String(req.body?.sessionId || ''));
  if (session) {
    if (session.stream) session.stream.end();
    if (session.client) session.client.end();
    sessions.delete(session.id);
  }
  res.json({ ok: true });
});

app.get('/metrics', async (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  try {
    const conn = await sshConnect(session);
    const output = await run(conn, 'top -bn1 | grep "Cpu(s)" ; free -m ; df -h /');
    res.json(parseMetrics(output));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/upload', express.raw({ type: () => true, limit: '2gb' }), async (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  const name = path.posix.basename(String(req.query.name || ''));
  const dir = String(req.query.dir || '/tmp');
  if (!name || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: '请选择文件并填写远程目录' });
  }
  const local = path.join(os.tmpdir(), `webssh-${crypto.randomUUID()}`);
  try {
    await fs.promises.writeFile(local, req.body);
    const conn = await sshConnect(session);
    const sftp = await getSftp(conn);
    const remote = path.posix.join(dir, name);
    await new Promise((resolve, reject) => {
      sftp.fastPut(local, remote, { mode: 0o644 }, (err) => (err ? reject(err) : resolve()));
    });
    sftp.end();
    res.json({ ok: true, path: remote, size: req.body.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  } finally {
    fs.promises.unlink(local).catch(() => { });
  }
});

app.get('/download', async (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  const remote = String(req.query.path || '').trim();
  if (!remote) return res.status(400).json({ error: '请填写远程文件路径' });
  const local = path.join(os.tmpdir(), `webssh-${crypto.randomUUID()}`);
  try {
    const conn = await sshConnect(session);
    const sftp = await getSftp(conn);
    await new Promise((resolve, reject) => {
      sftp.fastGet(remote, local, (err) => (err ? reject(err) : resolve()));
    });
    sftp.end();
    res.download(local, path.posix.basename(remote), () => {
      fs.promises.unlink(local).catch(() => { });
    });
  } catch (err) {
    fs.promises.unlink(local).catch(() => { });
    if (!res.headersSent) res.status(502).json({ error: err.message });
    else res.end();
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const session = sessions.get(new URL(req.url, 'http://localhost').searchParams.get('sessionId'));
  if (!session) return ws.close(4001, 'Session not found');
  const send = (data) => {
    if (ws.readyState === 1) ws.send(data);
  };
  sshConnect(session).then((conn) => {
    if (ws.readyState !== 1) return;
    conn.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, stream) => {
      if (err) {
        console.error('shell error:', err.message);
        return ws.close(1011, 'Could not open shell');
      }
      if (session.stream) session.stream.end();
      session.stream = stream;
      stream.on('data', send);
      stream.stderr.on('data', send);
      stream.on('close', () => {
        if (ws.readyState === 1) ws.close(1000, 'Remote shell closed');
        if (session.stream === stream) session.stream = null;
      });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          stream.write(msg.data);
        } else if (msg.type === 'resize') {
          stream.setWindow(Number(msg.rows) || 24, Number(msg.cols) || 80, 0, 0);
        }
      });
      ws.on('close', () => {
        if (session.stream === stream) session.stream = null;
        stream.end();
      });
      ws.on('error', () => { });
    });
  }).catch((err) => {
    console.error('SSH connection error:', err.message);
    if (ws.readyState === 1) ws.close(1011, 'SSH connection failed');
  });
});

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message });
});

server.listen(PORT, () => {
  console.log(`Web SSH running at http://localhost:${PORT}`);
});
