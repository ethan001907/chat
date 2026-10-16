'use strict';
/*
 * 零依赖聊天服务器
 * - 注册：昵称 + 用户名 + 密码（无手机号）
 * - 登录 / 会话 token
 * - 好友、单聊、群聊、消息历史
 * - WebSocket 实时推送（手写协议，无第三方库）
 * - WebRTC 信令（视频通话，局域网 P2P）
 * 存储：本地 JSON 文件（data/）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------- 存储 ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { users: {}, usernames: {}, tokens: {}, messages: [], groups: {}, nextMsgId: 1 };

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.error('loadDB failed:', e.message); }
}
function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) { console.error('saveDB failed:', e.message); }
}
loadDB();

// ---------- 工具 ----------
function id() { return crypto.randomBytes(12).toString('hex'); }
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const uid = db.tokens[token];
  if (!uid) return null;
  return db.users[uid] || null;
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, nickname: u.nickname, username: u.username, avatar: u.avatar || null, createdAt: u.createdAt };
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 开发阶段禁用缓存，避免改了前端不生效
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(data);
  });
}

// ---------- WebSocket（手写 RFC6455） ----------
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sockets = new Map(); // userId -> Set<ws>

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}
function wsEncode(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text
  return Buffer.concat([header, payload]);
}
function wsSend(ws, obj) {
  if (!ws || ws.__closed) return;
  try { ws.write(wsEncode(JSON.stringify(obj))); } catch {}
}
function broadcastToUser(userId, obj) {
  const set = sockets.get(userId);
  if (!set) return;
  for (const ws of set) wsSend(ws, obj);
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = wsAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.__closed = false;
  socket.on('close', () => { socket.__closed = true; });

  // 通过 URL query ?token=xxx 认证
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const uid = token && db.tokens[token];
  const user = uid && db.users[uid];
  if (!user) {
    wsSend(socket, { type: 'error', message: 'unauthorized' });
    socket.end();
    return;
  }
  if (!sockets.has(user.id)) sockets.set(user.id, new Set());
  sockets.get(user.id).add(socket);
  wsSend(socket, { type: 'ready', user: publicUser(user) });
  broadcastPresence(user.id, true);

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let frame;
    while ((frame = decodeFrame(buffer))) {
      buffer = buffer.slice(frame.totalLength);
      if (frame.opcode === 0x8) { socket.end(); return; }
      if (frame.opcode === 0x1) {
        let msg;
        try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
        handleWsMessage(user, msg);
      }
    }
  });
  socket.on('close', () => {
    const set = sockets.get(user.id);
    if (set) { set.delete(socket); if (!set.size) { sockets.delete(user.id); broadcastPresence(user.id, false); } }
  });
  socket.on('error', () => {});
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  let maskKey = null;
  if (masked) { if (buf.length < offset + 4) return null; maskKey = buf.slice(offset, offset + 4); offset += 4; }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }
  return { fin, opcode, payload, totalLength: offset + len };
}

function notifyProfileUpdate(u) {
  const payload = { type: 'user:updated', user: publicUser(u) };
  broadcastToUser(u.id, payload);
  for (const other of Object.values(db.users)) {
    if ((other.friends || []).includes(u.id)) broadcastToUser(other.id, payload);
  }
}

function broadcastPresence(userId, online) {
  // 通知该用户的好友
  for (const u of Object.values(db.users)) {
    if (u.id === userId) continue;
    if ((u.friends || []).includes(userId)) {
      broadcastToUser(u.id, { type: 'presence', userId, online });
    }
  }
}

// ---------- WebSocket 消息处理 ----------
function handleWsMessage(user, msg) {
  switch (msg.type) {
    case 'ping': return wsSendTo(user.id, { type: 'pong' });
    case 'chat:send': return handleChatSend(user, msg);
    case 'chat:history': return handleChatHistory(user, msg);
    case 'rtc:signal': return handleRtcSignal(user, msg);
    case 'rtc:call': return handleRtcCall(user, msg);
    default: return;
  }
}
function wsSendTo(userId, obj) { broadcastToUser(userId, obj); }

function conversationKey(a, b) {
  return [a, b].sort().join('::');
}
function handleChatSend(user, msg) {
  const { to, text, groupId, file } = msg;
  const hasFile = file && typeof file === 'object' && file.data;
  if ((!text || typeof text !== 'string') && !hasFile) return;
  const message = {
    id: db.nextMsgId++,
    from: user.id,
    text: (text || '').slice(0, 4000),
    ts: Date.now(),
  };
  if (hasFile) {
    // 文件消息：存文件名、大小、MIME、data URL（base64）
    const data = String(file.data);
    if (data.length > 40 * 1024 * 1024) return; // 限 40MB（base64 后）
    message.file = {
      name: String(file.name || 'file').slice(0, 200),
      size: Number(file.size) || 0,
      mime: String(file.mime || 'application/octet-stream').slice(0, 100),
      data,
    };
  }
  if (groupId) {
    const g = db.groups[groupId];
    if (!g || !g.members.includes(user.id)) return;
    message.groupId = groupId;
    db.messages.push(message);
    saveDB();
    for (const m of g.members) broadcastToUser(m, { type: 'chat:message', message });
  } else {
    if (!to || !db.users[to]) return;
    const key = conversationKey(user.id, to);
    message.to = to;
    message.key = key;
    db.messages.push(message);
    saveDB();
    broadcastToUser(to, { type: 'chat:message', message });
    broadcastToUser(user.id, { type: 'chat:message', message });
  }
}
function handleChatHistory(user, msg) {
  const { to, groupId, limit = 50 } = msg;
  let list;
  if (groupId) {
    list = db.messages.filter((m) => m.groupId === groupId).slice(-limit);
  } else {
    const key = conversationKey(user.id, to);
    list = db.messages.filter((m) => m.key === key).slice(-limit);
  }
  wsSendTo(user.id, { type: 'chat:history', to, groupId, messages: list });
}

// ---------- WebRTC 信令 ----------
function handleRtcCall(user, msg) {
  // 呼叫某用户
  const { to, media = 'video' } = msg;
  if (!to || !db.users[to]) return;
  broadcastToUser(to, { type: 'rtc:incoming', from: user.id, fromUser: publicUser(user), media });
}
function handleRtcSignal(user, msg) {
  const { to, signal } = msg;
  if (!to) return;
  broadcastToUser(to, { type: 'rtc:signal', from: user.id, signal });
}

// ---------- HTTP API ----------
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/api/register' && req.method === 'POST') {
      const { nickname, username, password } = await readBody(req);
      if (!nickname || !username || !password) return json(res, 400, { error: 'err.emptyFields' });
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return json(res, 400, { error: 'err.usernameFormat' });
      if (password.length < 6) return json(res, 400, { error: 'err.passwordShort' });
      const uname = username.toLowerCase();
      if (db.usernames[uname]) return json(res, 409, { error: 'err.usernameTaken' });
      const uid = id();
      const salt = crypto.randomBytes(16).toString('hex');
      db.users[uid] = {
        id: uid, nickname, username, salt,
        passwordHash: hashPassword(password, salt),
        friends: [], createdAt: Date.now(),
      };
      db.usernames[uname] = uid;
      const token = newToken();
      db.tokens[token] = uid;
      saveDB();
      return json(res, 200, { token, user: publicUser(db.users[uid]) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const uid = db.usernames[(username || '').toLowerCase()];
      const u = uid && db.users[uid];
      if (!u || hashPassword(password || '', u.salt) !== u.passwordHash)
        return json(res, 401, { error: 'err.badCredentials' });
      const token = newToken();
      db.tokens[token] = uid;
      saveDB();
      return json(res, 200, { token, user: publicUser(u) });
    }

    if (p === '/api/me' && req.method === 'GET') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      return json(res, 200, { user: publicUser(u) });
    }

    if (p === '/api/users/search' && req.method === 'GET') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const results = Object.values(db.users)
        .filter((x) => x.id !== u.id && (x.username.toLowerCase().includes(q) || x.nickname.toLowerCase().includes(q)))
        .slice(0, 20).map(publicUser);
      return json(res, 200, { results });
    }

    if (p === '/api/friends' && req.method === 'GET') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      const friends = (u.friends || []).map((fid) => publicUser(db.users[fid])).filter(Boolean);
      return json(res, 200, { friends });
    }

    if (p === '/api/friends/add' && req.method === 'POST') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      const { userId } = await readBody(req);
      if (!db.users[userId]) return json(res, 404, { error: 'err.userNotFound' });
      if (userId === u.id) return json(res, 400, { error: 'err.cantAddSelf' });
      if (!u.friends.includes(userId)) u.friends.push(userId);
      const other = db.users[userId];
      if (!other.friends.includes(u.id)) other.friends.push(u.id);
      saveDB();
      return json(res, 200, { ok: true });
    }

    // 更新资料（昵称/头像）
    if (p === '/api/profile' && req.method === 'POST') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      const { nickname, avatar } = await readBody(req);
      if (nickname !== undefined) {
        if (!nickname || nickname.length > 30) return json(res, 400, { error: 'err.nicknameInvalid' });
        u.nickname = nickname;
      }
      if (avatar !== undefined) {
        // avatar 为 data URL 或 null
        if (avatar && !/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(avatar))
          return json(res, 400, { error: 'err.avatarFormat' });
        if (avatar && avatar.length > 2 * 1024 * 1024) return json(res, 400, { error: 'err.avatarTooBig' });
        u.avatar = avatar || null;
      }
      saveDB();
      notifyProfileUpdate(u);
      return json(res, 200, { user: publicUser(u) });
    }

    // 修改用户名
    if (p === '/api/username' && req.method === 'POST') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      const { username } = await readBody(req);
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return json(res, 400, { error: 'err.usernameFormat' });
      const uname = username.toLowerCase();
      if (db.usernames[uname] && db.usernames[uname] !== u.id) return json(res, 409, { error: 'err.usernameTaken' });
      delete db.usernames[u.username.toLowerCase()];
      u.username = username;
      db.usernames[uname] = u.id;
      saveDB();
      notifyProfileUpdate(u);
      return json(res, 200, { user: publicUser(u) });
    }

    // 修改密码
    if (p === '/api/password' && req.method === 'POST') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      const { oldPassword, newPassword } = await readBody(req);
      if (hashPassword(oldPassword || '', u.salt) !== u.passwordHash) return json(res, 401, { error: 'err.oldPasswordWrong' });
      if (!newPassword || newPassword.length < 6) return json(res, 400, { error: 'err.newPasswordShort' });
      u.salt = crypto.randomBytes(16).toString('hex');
      u.passwordHash = hashPassword(newPassword, u.salt);
      // 使其他 token 失效（保留当前）
      const curToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      for (const t of Object.keys(db.tokens)) { if (db.tokens[t] === u.id && t !== curToken) delete db.tokens[t]; }
      saveDB();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/groups' && req.method === 'GET') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      const groups = Object.values(db.groups).filter((g) => g.members.includes(u.id));
      return json(res, 200, { groups });
    }

    if (p === '/api/groups/create' && req.method === 'POST') {
      const u = authUser(req);
      if (!u) return json(res, 401, { error: 'err.unauthorized' });
      const { name, memberIds = [] } = await readBody(req);
      if (!name) return json(res, 400, { error: 'err.groupNameEmpty' });
      const gid = id();
      const members = Array.from(new Set([u.id, ...memberIds.filter((m) => db.users[m])]));
      db.groups[gid] = { id: gid, name, owner: u.id, members, createdAt: Date.now() };
      saveDB();
      for (const m of members) broadcastToUser(m, { type: 'group:created', group: db.groups[gid] });
      return json(res, 200, { group: db.groups[gid] });
    }

    // 静态资源
    return serveStatic(req, res);
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'err.server' });
  }
});

server.on('upgrade', (req, socket) => {
  if (req.headers['upgrade'] && req.headers['upgrade'].toLowerCase() === 'websocket') {
    handleUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('聊天服务器已启动: http://localhost:' + PORT);
  console.log('局域网访问: http://<本机IP>:' + PORT);
});
