'use strict';
/* 智能聊天 前端：注册登录 + 聊天 + WebRTC 视频/语音通话 */

const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem('token') || null,
  user: null,
  ws: null,
  friends: [],
  groups: [],
  online: new Set(),
  current: null, // {type:'user'|'group', id, name}
  pendingFile: null, // 待发送的文件 {name,size,mime,data}
  pc: null,      // RTCPeerConnection
  localStream: null,
  callPeer: null,
  callMedia: 'video',
  pendingOffer: null,
  pendingCandidates: [],
  wsQueue: [],   // WS 未连接时排队的待发消息
  micOn: true,   // 麦克风开关
  camOn: true,   // 摄像头开关
  peerMicOn: true,  // 对方麦克风状态
  peerCamOn: true,  // 对方摄像头状态
  screenStream: null, // 屏幕共享流（有值时表示正在共享）
  camTrack: null,     // 保存摄像头轨道，停止共享时恢复
};

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(translateError(data.error));
  return data;
}

// 后端返回错误码，前端翻译
function translateError(code) {
  if (!code) return t('err.server');
  if (code.startsWith('err.')) return t(code);
  return code; // 兼容旧的中文直返
}

function toggleLang() {
  setLang(getLang() === 'zh' ? 'en' : 'zh');
  refreshDynamicTexts();
}

// 语言切换后刷新动态生成的文案
function refreshDynamicTexts() {
  renderFriends();
  renderGroups();
  if (state.current) {
    const isUser = state.current.type === 'user';
    if (!isUser) $('chatTitle').textContent = state.current.name;
  } else {
    $('chatTitle').textContent = t('pickFriend');
  }
  if (state.callPeer) $('callStatus').textContent = t('calling');
}

// ---------- 认证界面 ----------
$('tabLogin').onclick = () => switchTab('login');
$('tabRegister').onclick = () => switchTab('register');
function switchTab(which) {
  const login = which === 'login';
  $('tabLogin').classList.toggle('active', login);
  $('tabRegister').classList.toggle('active', !login);
  $('loginForm').classList.toggle('hidden', !login);
  $('registerForm').classList.toggle('hidden', login);
  $('authError').textContent = '';
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('loginUsername').value.trim(), password: $('loginPassword').value }),
    });
    onAuthed(data);
  } catch (err) { $('authError').textContent = err.message; }
};

$('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        nickname: $('regNickname').value.trim(),
        username: $('regUsername').value.trim(),
        password: $('regPassword').value,
      }),
    });
    onAuthed(data);
  } catch (err) { $('authError').textContent = err.message; }
};

function onAuthed(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('token', data.token);
  enterApp();
}

$('logoutBtn').onclick = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('current');
  if (state.ws) state.ws.close();
  location.reload();
};

// ---------- 进入应用 ----------
async function enterApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  renderMe();
  await loadFriends();
  await loadGroups();
  connectWS();
  // 刷新后恢复上次打开的会话
  try {
    const saved = JSON.parse(localStorage.getItem('current') || 'null');
    if (saved && saved.id) {
      const exists = saved.type === 'user'
        ? state.friends.some((f) => f.id === saved.id)
        : state.groups.some((g) => g.id === saved.id);
      if (exists) openChat(saved.type, saved.id, saved.name);
      else localStorage.removeItem('current');
    }
  } catch {}
}

function renderMe() {
  const u = state.user;
  $('meName').textContent = u.nickname;
  $('meUser').textContent = '@' + u.username;
  applyAvatar($('meAvatar'), u);
}

// 把头像应用到元素（有图用图，没图用首字母+颜色）
function applyAvatar(el, user) {
  if (!el) return;
  if (user.avatar) {
    el.textContent = '';
    el.style.backgroundImage = `url(${user.avatar})`;
    el.style.background = `url(${user.avatar}) center/cover`;
  } else {
    el.style.backgroundImage = '';
    el.style.background = colorFor(user.id);
    el.textContent = (user.nickname || '?').slice(0, 1).toUpperCase();
  }
}

function colorFor(seed) {
  const colors = ['#4f8cff', '#3ecf8e', '#e5484d', '#f5a623', '#a855f7', '#06b6d4', '#ec4899'];
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 997;
  return colors[h % colors.length];
}

// ---------- WebSocket ----------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${state.token}`);
  state.ws = ws;
  ws.onopen = () => {
    // 连接建立后，补发连接期间排队的消息（避免刷新后手快丢历史请求）
    const q = state.wsQueue;
    state.wsQueue = [];
    for (const obj of q) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    handleWs(msg);
  };
  ws.onclose = () => { setTimeout(() => { if (state.token) connectWS(); }, 2000); };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  } else {
    // 未连接（CONNECTING/CLOSING/CLOSED）：排队，等 onopen 后补发
    state.wsQueue.push(obj);
  }
}

function handleWs(msg) {
  switch (msg.type) {
    case 'ready': break;
    case 'presence':
      if (msg.online) state.online.add(msg.userId); else state.online.delete(msg.userId);
      renderFriends(); break;
    case 'chat:message': onIncomingMessage(msg.message); break;
    case 'chat:history': renderHistory(msg.messages); break;
    case 'group:created': loadGroups(); break;
    case 'user:updated': onUserUpdated(msg.user); break;
    case 'rtc:incoming': onIncomingCall(msg); break;
    case 'rtc:signal': onRtcSignal(msg); break;
  }
}

// ---------- 好友 ----------
async function loadFriends() {
  const data = await api('/api/friends');
  state.friends = data.friends;
  renderFriends();
}
function renderFriends() {
  const el = $('friendList');
  el.innerHTML = '';
  if (!state.friends.length) { el.innerHTML = `<div class="item item-sub">${t('noFriends')}</div>`; return; }
  for (const f of state.friends) {
    const div = document.createElement('div');
    div.className = 'item' + (state.current && state.current.id === f.id ? ' active' : '');
    div.innerHTML = `
      <div class="avatar"></div>
      <div><div class="item-name">${esc(f.nickname)}</div><div class="item-sub">@${esc(f.username)}</div></div>
      ${state.online.has(f.id) ? '<div class="dot"></div>' : ''}`;
    applyAvatar(div.querySelector('.avatar'), f);
    div.onclick = () => openChat('user', f.id, f.nickname);
    el.appendChild(div);
  }
}

// ---------- 群聊 ----------
async function loadGroups() {
  const data = await api('/api/groups');
  state.groups = data.groups;
  renderGroups();
}
function renderGroups() {
  const el = $('groupList');
  if (!el) return;
  el.innerHTML = '';
  if (!state.groups.length) { el.innerHTML = `<div class="item item-sub">${t('noGroups')}</div>`; return; }
  for (const g of state.groups) {
    const div = document.createElement('div');
    div.className = 'item' + (state.current && state.current.id === g.id ? ' active' : '');
    div.innerHTML = `
      <div class="avatar" style="background:${colorFor(g.id)}">${t('group').slice(0,1)}</div>
      <div><div class="item-name">${esc(g.name)}</div><div class="item-sub">${t('members', { n: g.members.length })}</div></div>`;
    div.onclick = () => openChat('group', g.id, g.name);
    el.appendChild(div);
  }
}

// ---------- 搜索 ----------
$('searchBtn').onclick = doSearch;
$('searchInput').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
async function doSearch() {
  const q = $('searchInput').value.trim();
  const box = $('searchResults');
  if (!q) { box.innerHTML = ''; return; }
  const data = await api('/api/users/search?q=' + encodeURIComponent(q));
  box.innerHTML = '';
  for (const u of data.results) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div class="avatar" style="width:28px;height:28px;font-size:12px"></div>
      <span>${esc(u.nickname)} <span class="item-sub">@${esc(u.username)}</span></span>`;
    applyAvatar(div.querySelector('.avatar'), u);
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = state.friends.some((f) => f.id === u.id) ? t('added') : t('add');
    btn.disabled = state.friends.some((f) => f.id === u.id);
    btn.onclick = async () => {
      await api('/api/friends/add', { method: 'POST', body: JSON.stringify({ userId: u.id }) });
      btn.textContent = t('added'); btn.disabled = true;
      await loadFriends();
    };
    div.appendChild(btn);
    box.appendChild(div);
  }
}

// ---------- 聊天 ----------
function openChat(type, id, name) {
  state.current = { type, id, name };
  try { localStorage.setItem('current', JSON.stringify(state.current)); } catch {}
  $('chatTitle').textContent = name;
  $('composer').classList.remove('hidden');
  $('messages').innerHTML = '';
  const isUser = type === 'user';
  $('voiceCallBtn').classList.toggle('hidden', !isUser);
  $('videoCallBtn').classList.toggle('hidden', !isUser);
  document.querySelector('.app-view').classList.add('chat-open');
  renderFriends(); renderGroups();
  wsSend({ type: 'chat:history', to: isUser ? id : undefined, groupId: isUser ? undefined : id, limit: 100 });
}

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('msgInput').value.trim();
  if ((!text && !state.pendingFile) || !state.current) return;
  const payload = { type: 'chat:send', text };
  if (state.pendingFile) payload.file = state.pendingFile;
  if (state.current.type === 'user') payload.to = state.current.id;
  else payload.groupId = state.current.id;
  wsSend(payload);
  state.pendingFile = null;
  $('msgInput').value = '';
};

// ---------- 文件发送 ----------
$('fileBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) { alert(t('fileTooBig')); return; }
  const reader = new FileReader();
  reader.onload = () => {
    state.pendingFile = {
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      data: reader.result,
    };
    // 在输入框提示已选文件
    $('msgInput').placeholder = t('fileSending') + ' ' + file.name;
    $('msgInput').focus();
  };
  reader.readAsDataURL(file);
};

function onIncomingMessage(m) {
  const cur = state.current;
  const relevant = cur && (
    (cur.type === 'user' && (m.to === cur.id || m.from === cur.id) && !m.groupId) ||
    (cur.type === 'group' && m.groupId === cur.id)
  );
  if (relevant) appendMessage(m);
}

function renderHistory(messages) {
  $('messages').innerHTML = '';
  for (const m of messages) appendMessage(m);
}

function appendMessage(m) {
  const box = $('messages');
  const mine = m.from === state.user.id;
  const div = document.createElement('div');
  div.className = 'msg ' + (mine ? 'me' : 'other');
  const senderName = mine ? '' : senderLabel(m.from);
  let body = '';
  if (m.file) {
    body = `<div class="bubble file-bubble">${fileBubbleHtml(m.file)}</div>`;
  } else {
    body = `<div class="bubble">${esc(m.text)}</div>`;
  }
  div.innerHTML = `${senderName ? `<div class="sender">${esc(senderName)}</div>` : ''}
    ${body}
    <div class="time">${new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function fileBubbleHtml(f) {
  const isImage = /^image\//.test(f.mime);
  const name = esc(f.name);
  const size = formatSize(f.size);
  if (isImage) {
    return `<a class="file-img" href="${f.data}" download="${name}" target="_blank"><img src="${f.data}" alt="${name}"></a>
      <div class="file-meta"><span class="file-name">${name}</span><span class="file-size">${size}</span></div>`;
  }
  return `<a class="file-card" href="${f.data}" download="${name}">
      <span class="file-icon">📄</span>
      <span class="file-info"><span class="file-name">${name}</span><span class="file-size">${size}</span></span>
      <span class="file-dl">⬇</span>
    </a>`;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function senderLabel(uid) {
  const f = state.friends.find((x) => x.id === uid);
  return f ? f.nickname : t('user');
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- 建群 ----------
$('newGroupBtn').onclick = () => {
  const pick = $('groupMemberPick');
  pick.innerHTML = '';
  for (const f of state.friends) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${f.id}"> ${esc(f.nickname)} <span class="item-sub">@${esc(f.username)}</span>`;
    pick.appendChild(label);
  }
  $('groupModal').classList.remove('hidden');
};
$('groupCancel').onclick = () => $('groupModal').classList.add('hidden');
$('groupCreate').onclick = async () => {
  const name = $('groupName').value.trim();
  if (!name) return;
  const memberIds = Array.from($('groupMemberPick').querySelectorAll('input:checked')).map((c) => c.value);
  await api('/api/groups/create', { method: 'POST', body: JSON.stringify({ name, memberIds }) });
  $('groupModal').classList.add('hidden');
  $('groupName').value = '';
  await loadGroups();
};

// ---------- WebRTC 通话 ----------
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

$('videoCallBtn').onclick = () => startCall('video');
$('voiceCallBtn').onclick = () => startCall('audio');
$('hangupBtn').onclick = () => endCall(true);
$('micBtn').onclick = toggleMic;
$('camBtn').onclick = toggleCam;
$('screenBtn').onclick = toggleScreen;
$('rejectBtn').onclick = () => { $('incomingOverlay').classList.add('hidden'); wsSend({ type: 'rtc:signal', to: state.pendingOffer.from, signal: { kind: 'reject' } }); state.pendingOffer = null; };
$('acceptBtn').onclick = () => acceptCall();

// ---------- 通话控制：静音 / 关摄像头 / 共享屏幕 ----------
function toggleMic() {
  if (!state.localStream) { $('callStatus').textContent = '无本地流（摄像头/麦克风未就绪）'; return; }
  const track = state.localStream.getAudioTracks()[0];
  if (!track) { $('callStatus').textContent = '无音频轨道'; return; }
  state.micOn = !state.micOn;
  track.enabled = state.micOn;
  $('micBtn').classList.toggle('off', !state.micOn);
  $('micBtn').textContent = state.micOn ? '🎤' : '🔇';
  $('micBtn').title = state.micOn ? t('muteMic') : t('unmuteMic');
  // 通知对方
  if (state.callPeer) wsSend({ type: 'rtc:signal', to: state.callPeer, signal: { kind: 'media', mic: state.micOn, cam: state.camOn } });
}

function toggleCam() {
  if (!state.localStream) { $('callStatus').textContent = '无本地流（摄像头/麦克风未就绪）'; return; }
  const track = state.localStream.getVideoTracks()[0];
  if (!track) { $('callStatus').textContent = '无视频轨道'; return; }
  state.camOn = !state.camOn;
  track.enabled = state.camOn;
  $('camBtn').classList.toggle('off', !state.camOn);
  $('camBtn').textContent = state.camOn ? '📷' : '🚫';
  $('camBtn').title = state.camOn ? t('toggleCam') : t('toggleCamOn');
  // 通知对方
  if (state.callPeer) wsSend({ type: 'rtc:signal', to: state.callPeer, signal: { kind: 'media', mic: state.micOn, cam: state.camOn } });
}

async function toggleScreen() {
  // 正在共享 → 停止
  if (state.screenStream) {
    stopScreenShare();
    return;
  }
  if (!state.pc) return;
  try {
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    state.screenStream = screen;
    const screenTrack = screen.getVideoTracks()[0];
    // 保存摄像头轨道，便于恢复
    const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) {
      state.camTrack = sender.track;
      await sender.replaceTrack(screenTrack);
    }
    // 本地预览显示屏幕
    $('localVideo').srcObject = screen;
    // 用户点浏览器自带的"停止共享"也要同步
    screenTrack.onended = () => stopScreenShare();
    $('screenBtn').classList.add('off');
    $('screenBtn').title = t('stopShare');
    $('callStatus').textContent = t('sharing');
  } catch (e) {
    // 用户取消选择，忽略
    console.warn('screen share cancelled:', e.message);
  }
}

function stopScreenShare() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
  }
  // 恢复摄像头轨道
  if (state.pc && state.camTrack) {
    const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(state.camTrack).catch(() => {});
  }
  if (state.localStream) $('localVideo').srcObject = state.localStream;
  $('screenBtn').classList.remove('off');
  $('screenBtn').title = t('shareScreen');
  $('callStatus').textContent = t('calling');
}

async function startCall(media) {
  if (!state.current || state.current.type !== 'user') return;
  state.callPeer = state.current.id;
  state.callMedia = media;
  $('callPeerName').textContent = state.current.name;
  $('callStatus').textContent = t('connecting');
  $('callOverlay').classList.remove('hidden');
  $('localVideo').classList.toggle('hidden', media === 'audio');
  $('remoteVideo').classList.toggle('hidden', media === 'audio');
  // 音频通话隐藏摄像头/共享屏幕按钮
  $('camBtn').classList.toggle('hidden', media === 'audio');
  $('screenBtn').classList.toggle('hidden', media === 'audio');
  resetCallControls();
  try {
    await setupLocalStream(media);
  } catch (e) {
    $('callStatus').textContent = t('mediaError') + e.message;
    return;
  }
  createPeerConnection(state.current.id, true);
  wsSend({ type: 'rtc:call', to: state.current.id, media });
}

async function acceptCall() {
  const inc = state.pendingOffer;
  if (!inc) return;
  // 若 offer 还没到（rtc:call 先于 rtc:signal 到达），等一小会儿
  if (!inc.offer) {
    for (let i = 0; i < 20 && !state.pendingOffer?.offer; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const inc2 = state.pendingOffer;
  if (!inc2 || !inc2.offer) {
    $('callStatus').textContent = t('callFailed');
    return;
  }
  $('incomingOverlay').classList.add('hidden');
  state.callPeer = inc2.from;
  state.callMedia = inc2.media;
  $('callPeerName').textContent = (inc2.fromUser && inc2.fromUser.nickname) || t('user');
  $('callStatus').textContent = t('connecting');
  $('callOverlay').classList.remove('hidden');
  $('localVideo').classList.toggle('hidden', inc2.media === 'audio');
  $('remoteVideo').classList.toggle('hidden', inc2.media === 'audio');
  $('camBtn').classList.toggle('hidden', inc2.media === 'audio');
  $('screenBtn').classList.toggle('hidden', inc2.media === 'audio');
  resetCallControls();
  try {
    await setupLocalStream(inc2.media);
  } catch (e) {
    $('callStatus').textContent = t('mediaError') + e.message;
    return;
  }
  createPeerConnection(inc2.from, false);
  const pc = state.pc;
  console.log('[RTC] 接听方设置远程描述，创建 answer...');
  await pc.setRemoteDescription(new RTCSessionDescription(inc2.offer));
  for (const c of state.pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(c));
  state.pendingCandidates = [];
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: 'rtc:signal', to: inc2.from, signal: { kind: 'answer', sdp: pc.localDescription } });
  state.pendingOffer = null;
}

function resetCallControls() {
  state.micOn = true;
  state.camOn = true;
  state.peerMicOn = true;
  state.peerCamOn = true;
  state.screenStream = null;
  state.camTrack = null;
  $('peerMediaBadge').classList.add('hidden');
  $('peerMediaBadge').textContent = '';
  $('micBtn').classList.remove('off');
  $('micBtn').textContent = '🎤';
  $('camBtn').classList.remove('off');
  $('camBtn').textContent = '📷';
  $('screenBtn').classList.remove('off');
  $('screenBtn').textContent = '🖥️';
  $('micBtn').title = t('muteMic');
  $('camBtn').title = t('toggleCam');
  $('screenBtn').title = t('shareScreen');
}

function updatePeerMediaUI() {
  const badge = $('peerMediaBadge');
  const parts = [];
  if (!state.peerCamOn) parts.push('📷 ' + t('camOff'));
  if (!state.peerMicOn) parts.push('🎤 ' + t('micMuted'));
  if (parts.length) {
    badge.textContent = parts.join('   ');
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
    badge.textContent = '';
  }
}

async function setupLocalStream(media) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('当前地址不支持摄像头/麦克风（需要 localhost 或 HTTPS）');
  }
  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: media === 'video' ? { width: 1280, height: 720 } : false,
  });
  $('localVideo').srcObject = state.localStream;
}

function createPeerConnection(peerId, isCaller) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.pc = pc;
  state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));

  pc.ontrack = (e) => {
    $('remoteVideo').srcObject = e.streams[0];
    // 正在共享屏幕时不要被"通话中"覆盖状态文字
    if (!state.screenStream) $('callStatus').textContent = t('calling');
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) { console.log('[RTC] 本地 ICE candidate:', e.candidate.candidate.slice(0, 30)); wsSend({ type: 'rtc:signal', to: peerId, signal: { kind: 'ice', candidate: e.candidate } }); }
  };
  pc.onconnectionstatechange = () => {
    console.log('[RTC] connectionState:', pc.connectionState);
    if (pc.connectionState === 'connected') { if (!state.screenStream) $('callStatus').textContent = t('calling'); }
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      if (pc.connectionState === 'failed') $('callStatus').textContent = t('callFailed');
    }
  };

  if (isCaller) {
    pc.onnegotiationneeded = async () => {
      try {
        console.log('[RTC] 主叫方创建 offer...');
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        wsSend({ type: 'rtc:signal', to: peerId, signal: { kind: 'offer', sdp: pc.localDescription } });
      } catch (e) { console.error('[RTC] offer 失败:', e); }
    };
  }
}

async function onIncomingCall(msg) {
  // rtc:call 只负责响铃；SDP 随后通过 rtc:signal(offer) 到达，合并到同一个 pendingOffer
  state.pendingOffer = { from: msg.from, fromUser: msg.fromUser, media: msg.media, offer: null };
  $('incomingName').textContent = t('incomingCall', { name: msg.fromUser.nickname });
  $('incomingType').textContent = msg.media === 'video' ? t('videoCall') : t('voiceCall');
  $('incomingOverlay').classList.remove('hidden');
}

async function onRtcSignal(msg) {
  const sig = msg.signal;
  if (!sig) return;
  console.log('[RTC] 收到 signal:', sig.kind, 'from:', msg.from, 'pc存在:', !!state.pc);
  if (sig.kind === 'reject') { endCall(false); return; }
  if (sig.kind === 'offer') {
    // 若已有来电（rtc:call 先到），把 SDP 合并进去；否则新建
    if (state.pendingOffer) {
      state.pendingOffer.offer = sig.sdp;
      if (msg.from && !state.pendingOffer.from) state.pendingOffer.from = msg.from;
      return;
    }
    state.pendingOffer = { from: msg.from, fromUser: { nickname: t('user') }, media: state.callMedia || 'video', offer: sig.sdp };
    $('incomingName').textContent = t('incoming');
    $('incomingType').textContent = t('clickToAccept');
    $('incomingOverlay').classList.remove('hidden');
    return;
  }
  if (!state.pc) {
    // 若 pc 还没建好，media 状态也要更新（静音/关摄像头不依赖 pc）
    if (sig.kind === 'media') {
      state.peerMicOn = sig.mic !== false;
      state.peerCamOn = sig.cam !== false;
      updatePeerMediaUI();
    }
    return;
  }
  if (sig.kind === 'media') {
    // 对方静音/关摄像头
    state.peerMicOn = sig.mic !== false;
    state.peerCamOn = sig.cam !== false;
    updatePeerMediaUI();
    return;
  }
  if (sig.kind === 'answer') {
    console.log('[RTC] 主叫方收到 answer，设置远程描述...');
    await state.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
    for (const c of state.pendingCandidates) await state.pc.addIceCandidate(new RTCIceCandidate(c));
    state.pendingCandidates = [];
    $('callStatus').textContent = t('connecting');
  } else if (sig.kind === 'ice') {
    console.log('[RTC] 收到 ice candidate');
    if (state.pc.remoteDescription && state.pc.remoteDescription.type) {
      await state.pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
    } else {
      state.pendingCandidates.push(sig.candidate);
    }
  }
}

function endCall(notify) {
  if (notify && state.callPeer) wsSend({ type: 'rtc:signal', to: state.callPeer, signal: { kind: 'reject' } });
  if (state.screenStream) { state.screenStream.getTracks().forEach((t) => t.stop()); state.screenStream = null; }
  state.camTrack = null;
  if (state.pc) { state.pc.close(); state.pc = null; }
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('callOverlay').classList.add('hidden');
  $('incomingOverlay').classList.add('hidden');
  state.callPeer = null;
  state.pendingCandidates = [];
}

// ---------- 设置 ----------
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = () => $('settingsModal').classList.add('hidden');

function openSettings() {
  const u = state.user;
  $('setNickname').value = u.nickname;
  $('setUsername').value = u.username;
  $('setOldPassword').value = '';
  $('setNewPassword').value = '';
  $('settingsMsg').textContent = '';
  $('settingsMsg').className = 'settings-msg';
  applyAvatar($('settingsAvatar'), u);
  $('settingsModal').classList.remove('hidden');
}

function setSettingsMsg(text, ok) {
  const el = $('settingsMsg');
  el.textContent = text;
  el.className = 'settings-msg ' + (ok ? 'ok' : 'err');
}

$('avatarFile').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 1.5 * 1024 * 1024) { setSettingsMsg(t('imageTooBig'), false); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    // 压缩到合适尺寸
    const compressed = await compressImage(reader.result, 256);
    try {
      const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ avatar: compressed }) });
      state.user = data.user;
      applyAvatar($('settingsAvatar'), state.user);
      renderMe();
      setSettingsMsg(t('avatarUpdated'), true);
    } catch (err) { setSettingsMsg(err.message, false); }
  };
  reader.readAsDataURL(file);
};

$('avatarRemove').onclick = async () => {
  try {
    const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ avatar: null }) });
    state.user = data.user;
    applyAvatar($('settingsAvatar'), state.user);
    renderMe();
    setSettingsMsg(t('avatarRemoved'), true);
  } catch (err) { setSettingsMsg(err.message, false); }
};

// 用 canvas 压缩图片
function compressImage(dataUrl, maxSize) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxSize / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

$('saveNickname').onclick = async () => {
  const nickname = $('setNickname').value.trim();
  if (!nickname) return setSettingsMsg(t('err.nicknameInvalid'), false);
  try {
    const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ nickname }) });
    state.user = data.user;
    renderMe();
    setSettingsMsg(t('nicknameUpdated'), true);
  } catch (err) { setSettingsMsg(err.message, false); }
};

$('saveUsername').onclick = async () => {
  const username = $('setUsername').value.trim();
  if (!username) return setSettingsMsg(t('err.usernameFormat'), false);
  try {
    const data = await api('/api/username', { method: 'POST', body: JSON.stringify({ username }) });
    state.user = data.user;
    renderMe();
    setSettingsMsg(t('usernameUpdated'), true);
  } catch (err) { setSettingsMsg(err.message, false); }
};

$('savePassword').onclick = async () => {
  const oldPassword = $('setOldPassword').value;
  const newPassword = $('setNewPassword').value;
  if (!oldPassword || !newPassword) return setSettingsMsg(t('err.newPasswordShort'), false);
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
    $('setOldPassword').value = '';
    $('setNewPassword').value = '';
    setSettingsMsg(t('passwordUpdated'), true);
  } catch (err) { setSettingsMsg(err.message, false); }
};

// 别人更新了资料
function onUserUpdated(user) {
  if (user.id === state.user.id) {
    state.user = user;
    renderMe();
    return;
  }
  const f = state.friends.find((x) => x.id === user.id);
  if (f) { f.nickname = user.nickname; f.username = user.username; f.avatar = user.avatar; renderFriends(); }
}

// ---------- 启动 ----------
applyI18n();
async function boot() {
  if (state.token) {
    try {
      const data = await api('/api/me');
      state.user = data.user;
      enterApp();
      return;
    } catch { localStorage.removeItem('token'); state.token = null; }
  }
  switchTab('login');
}
boot();
