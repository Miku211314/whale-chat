const $ = (s) => document.querySelector(s);
const 消息区 = $('#msgs');
const 输入 = $('#input');
const 发送键 = $('#send');
const 打字 = $('#typing');
let 临时气泡 = null;     // 流式草稿
let 自动滚 = true;
let 资料 = { her: '/uploads/avatar-her.png', me: '/uploads/avatar-me.png', background: '', dim: 0.35 };

async function 载资料() {
  try {
    const j = await (await fetch('/api/profile')).json();
    资料 = { ...资料, ...j };
    应用资料();
  } catch (e) { console.error(e); }
}

function 应用资料() {
  const bg = $('#bg');
  if (资料.background) bg.style.backgroundImage = `url("${资料.background}")`;
  else bg.style.backgroundImage = '';
  $('#bg-dim').style.background = `rgba(8,12,20,${typeof 资料.dim === 'number' ? 资料.dim : 0.35})`;
  const her = $('#ava-her img');
  if (her) her.src = 资料.her;
  $('#dim').value = Math.round((资料.dim ?? 0.35) * 100);
  for (const 图 of document.querySelectorAll('.msg .ava img')) {
    图.src = 图.closest('.msg').classList.contains('me') ? 资料.me : 资料.her;
  }
}


const 时间 = (iso) => {
  const d = new Date(iso || Date.now());
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
};

function 滚到底() { if (自动滚) 消息区.scrollTop = 消息区.scrollHeight; }
消息区.addEventListener('scroll', () => {
  自动滚 = 消息区.scrollHeight - 消息区.scrollTop - 消息区.clientHeight < 60;
});

function 画消息(m, 追加 = true) {
  const 行 = document.createElement('div');
  行.className = 'msg ' + (m.role === 'user' ? 'me' : 'her');
  const 头 = document.createElement('div');
  头.className = 'ava';
  const 脸 = document.createElement('img');
  脸.src = m.role === 'user' ? 资料.me : 资料.her;
  脸.alt = '';
  头.appendChild(脸);
  const 泡 = document.createElement('div');
  泡.className = 'bubble';
  if (m.text) {
    const 文 = document.createElement('div');
    const 段 = String(m.text).split(/\[\[表情[:：]\s*([^\]]+)\]\]/g);
    for (let i = 0; i < 段.length; i++) {
      if (i % 2 === 0) { if (段[i]) 文.appendChild(document.createTextNode(段[i])); }
      else {
        const img = document.createElement('img');
        img.src = '/api/sticker?tag=' + encodeURIComponent(段[i]);
        img.loading = 'lazy';
        文.appendChild(img);
      }
    }
    泡.appendChild(文);
  }
  for (const u of m.images || []) {
    const img = document.createElement('img');
    img.src = u;
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(u, '_blank'));
    泡.appendChild(img);
  }
  if (m.audio) {
    const a = document.createElement('audio');
    a.controls = true;
    a.preload = 'none';
    a.src = m.audio;
    泡.appendChild(a);
  }
  const 时 = document.createElement('div');
  时.className = 't';
  时.textContent = 时间(m.t);
  泡.appendChild(时);
  行.appendChild(头);
  行.appendChild(泡);
  if (追加) 消息区.appendChild(行);
  滚到底();
  return 行;
}

function 显示打字数(v) {
  打字.classList.toggle('hidden', !v);
  $('#sub').textContent = v ? '正在输入…' : '只属于我们俩 · 在线';
}

function 显示草稿(text) {
  if (!临时气泡) {
    临时气泡 = document.createElement('div');
    临时气泡.className = 'msg her';
    临时气泡.innerHTML = '<div class="bubble"><div class="draft"></div></div>';
    消息区.appendChild(临时气泡);
  }
  临时气泡.querySelector('.draft').textContent = text;
  滚到底();
}
function 清草稿() { if (临时气泡) { 临时气泡.remove(); 临时气泡 = null; } }

// ── 加载历史 ──────────────────────────────────────────────
async function 载历史() {
  try {
    const r = await fetch('/api/history');
    const j = await r.json();
    消息区.innerHTML = '';
    for (const m of j.messages || []) 画消息(m);
    滚到底();
  } catch (e) { console.error(e); }
}

// ── 发送 ─────────────────────────────────────────────────
async function 发送(payload) {
  try {
    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!j.ok) { alert('没发出去：' + (j.error || '未知')); }
  } catch (e) { alert('没发出去：' + e.message); }
}

function 发文字() {
  const t = 输入.value.trim();
  if (!t) return;
  输入.value = '';
  输入.style.height = 'auto';
  发送({ text: t });
}

发送键.addEventListener('click', 发文字);
输入.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); 发文字(); }
});
输入.addEventListener('input', () => {
  输入.style.height = 'auto';
  输入.style.height = Math.min(输入.scrollHeight, 130) + 'px';
});

// ── 图片 ─────────────────────────────────────────────────
async function 缩图(file, 最大 = 1600) {
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: file.type || 'image/png' });
  const bmp = await createImageBitmap(blob);
  let { width: w, height: h } = bmp;
  const 比 = Math.min(1, 最大 / Math.max(w, h));
  w = Math.round(w * 比); h = Math.round(h * 比);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: .86 });
  const base64 = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.readAsDataURL(out);
  });
  return { mediaType: 'image/jpeg', data: base64, name: file.name || 'image.jpg' };
}

async function 发图文件(files) {
  const 图 = [];
  for (const f of [...files].slice(0, 6)) {
    if (!f.type.startsWith('image/')) continue;
    图.push(await 缩图(f));
  }
  if (图.length) 发送({ images: 图 });
}

$('#btn-img').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { 发图文件(e.target.files); e.target.value = ''; });
document.addEventListener('paste', (e) => {
  const 项 = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!项.length) return;
  e.preventDefault();
  发图文件(项.map((i) => i.getAsFile()).filter(Boolean));
});

// ── 语音 ─────────────────────────────────────────────────
const 录音键 = $('#btn-voice');
let 录音器 = null, 音块 = [];

录音键.addEventListener('click', async () => {
  if (录音器 && 录音器.state === 'recording') { 录音器.stop(); return; }
  try {
    const 流 = await navigator.mediaDevices.getUserMedia({ audio: true });
    录音器 = new MediaRecorder(流, { mimeType: 'audio/webm;codecs=opus' });
    音块 = [];
    录音器.ondataavailable = (e) => { if (e.data.size) 音块.push(e.data); };
    录音器.onstop = async () => {
      流.getTracks().forEach((t) => t.stop());
      录音器 = null;
      录音键.classList.remove('rec');
      录音键.textContent = '…';
      const blob = new Blob(音块, { type: 'audio/webm' });
      try {
        if (blob.size > 800) {
          录音键.textContent = '…';
          $('#sub').textContent = '正在听…';
          const r = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: blob });
          const j = await r.json();
          if (!j.ok) alert('没发出去：' + (j.error || ''));
        }
      } catch (e) { alert('语音发送失败：' + e.message); }
      $('#sub').textContent = '只属于我们俩 · 在线';
      录音键.textContent = '🎤';
    };
    录音器.start();
    录音键.classList.add('rec');
    录音键.textContent = '●';
  } catch (e) {
    alert('麦克风打不开：' + e.message + '\n（手机上需要 https 或原生 App 才能录音）');
  }
});

// ── 表情包 ───────────────────────────────────────────────
const 表情面板 = $('#stickers');
$('#btn-st').addEventListener('click', async () => {
  表情面板.classList.toggle('hidden');
  if (表情面板.classList.contains('hidden')) return;
  if ($('#st-grid').childElementCount) return;
  try {
    const j = await (await fetch('/api/stickers')).json();
    for (const s of j.stickers || []) {
      const img = document.createElement('img');
      img.src = s.url;
      img.loading = 'lazy';
      img.title = s.name;
      img.addEventListener('click', () => {
        const 绝对 = new URL(s.url, location.origin).searchParams.get('p');
        发送({ sticker: 绝对 });
        表情面板.classList.add('hidden');
      });
      $('#st-grid').appendChild(img);
    }
  } catch (e) { console.error(e); }
});
$('#st-close').addEventListener('click', () => 表情面板.classList.add('hidden'));

// ── 设置：头像 / 背景 ───────────────────────────────────
const 设置面板 = $('#settings');
$('#btn-settings').addEventListener('click', () => 设置面板.classList.toggle('hidden'));
$('#set-close').addEventListener('click', () => 设置面板.classList.add('hidden'));

let 设置目标 = '';
const 头像输入 = $('#file-avatar');

document.querySelectorAll('.set-item').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const t = btn.dataset.target;
    if (t === 'background-clear') {
      await fetch('/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'background', clear: true }) });
      资料.background = '';
      应用资料();
      设置面板.classList.add('hidden');
      return;
    }
    设置目标 = t;
    头像输入.click();
  });
});

头像输入.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f || !设置目标) return;
  try {
    const 大 = 设置目标 === 'background' ? 2000 : 900;
    const 图 = await 缩图(f, 大);
    const r = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 设置目标, mediaType: 图.mediaType, data: 图.data }),
    });
    const j = await r.json();
    if (j.ok) {
      资料[设置目标] = j.url;
      应用资料();
      设置面板.classList.add('hidden');
    } else alert('保存失败：' + (j.error || ''));
  } catch (err) { alert('保存失败：' + err.message); }
});

$('#dim').addEventListener('change', async (e) => {
  const v = Number(e.target.value) / 100;
  await fetch('/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dim: v }) });
  资料.dim = v;
  应用资料();
});

// ── 实时 ─────────────────────────────────────────────────
function 连流() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    let j; try { j = JSON.parse(e.data); } catch { return; }
    if (j.type === 'typing') 显示打字数(!!j.on);
    else if (j.type === 'partial') 显示草稿(j.text);
    else if (j.type === 'profile') 载资料();
    else if (j.type === 'message') {
      if (j.message.role === 'assistant') { 清草稿(); 显示打字数(false); }
      画消息(j.message);
    } else if (j.type === 'reset') { 清草稿(); 载历史(); }
  };
  es.onerror = () => { /* EventSource 自己重连 */ };
}
连流();
载资料().then(载历史);

$('#menu').addEventListener('click', async () => {
  if (confirm('重新开始？会清掉这个房间的聊天记录（她的记忆不受影响）。')) {
    await fetch('/api/reset');
    消息区.innerHTML = ''; 清草稿();
  }
});

// 手机键盘顶起来时滚到底
window.visualViewport?.addEventListener('resize', () => 滚到底());
