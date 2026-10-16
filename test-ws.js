// 零依赖 WebSocket 客户端测试：用两个账号互发消息
const http = require('http');
const crypto = require('crypto');

function wsConnect(token, onMessage) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: 'localhost', port: 3000, path: '/ws?token=' + token,
      headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': 13 },
    });
    req.on('upgrade', (res, socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        let frame;
        while ((frame = decode(buffer))) {
          buffer = buffer.slice(frame.totalLength);
          if (frame.opcode === 0x1) onMessage(JSON.parse(frame.payload.toString('utf8')));
        }
      });
      resolve({
        send(obj) { socket.write(encode(JSON.stringify(obj))); },
        close() { socket.end(); },
      });
    });
    req.end();
  });
}
function encode(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len | 0x80; }
  else { header = Buffer.alloc(4); header[1] = 126 | 0x80; header.writeUInt16BE(len, 2); }
  header[0] = 0x81;
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
function decode(buf) {
  if (buf.length < 2) return null;
  let len = buf[1] & 0x7f, offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  if (buf.length < offset + len) return null;
  return { opcode: buf[0] & 0x0f, payload: buf.slice(offset, offset + len), totalLength: offset + len };
}

async function api(path, body, token) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: 'localhost', port: 3000, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(token ? { Authorization: 'Bearer ' + token } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d)));
    });
    req.write(data); req.end();
  });
}

(async () => {
  const suffix = Date.now().toString().slice(-6);
  const a = await api('/api/register', { nickname: '测试A', username: 'ta' + suffix, password: 'pass1234' });
  const b = await api('/api/register', { nickname: '测试B', username: 'tb' + suffix, password: 'pass1234' });
  console.log('注册成功:', a.user.username, b.user.username);

  const received = [];
  const wsA = await wsConnect(a.token, (m) => { console.log('A 收到:', m.type, m.message ? m.message.text : ''); received.push(m); });
  const wsB = await wsConnect(b.token, (m) => { console.log('B 收到:', m.type, m.message ? m.message.text : ''); received.push(m); });
  await new Promise((r) => setTimeout(r, 300));

  wsA.send({ type: 'chat:send', to: b.user.id, text: '你好 B！' });
  await new Promise((r) => setTimeout(r, 300));
  wsB.send({ type: 'chat:send', to: a.user.id, text: '你好 A，收到！' });
  await new Promise((r) => setTimeout(r, 500));

  wsA.send({ type: 'chat:history', to: b.user.id, limit: 10 });
  await new Promise((r) => setTimeout(r, 500));

  const chatMsgs = received.filter((m) => m.type === 'chat:message');
  const hist = received.find((m) => m.type === 'chat:history');
  console.log('\n--- 结果 ---');
  console.log('实时消息数:', chatMsgs.length, '(期望 4: A发B收 + B发A收 各2端)');
  console.log('历史记录数:', hist ? hist.messages.length : 0, '(期望 2)');
  console.log(chatMsgs.length === 4 && hist && hist.messages.length === 2 ? '✅ WebSocket 测试通过' : '❌ 测试失败');

  wsA.close(); wsB.close();
  process.exit(0);
})();
