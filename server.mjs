// 小鲸鱼聊天室 · 后端
// 直接连本机 DSH 的 API（不经过 QQ / SnowLuma）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from './lib/dsh-client.js';

const 此处 = path.dirname(fileURLToPath(import.meta.url));
const 根 = 此处;                                   // whale-chat/
const 数据 = path.join(根, 'data');
const 上传 = path.join(数据, 'uploads');
const 房间 = path.join(根, 'room');
const 公共 = path.join(根, 'public');
const 工作区 = path.resolve(根, '..');              // workspace root (optional, for integrations)
// Optional: point this at a qq-bridge checkout to reuse its role card / slang / shared memory.
// Leave unset for a standalone deployment.
const 桥目录 = process.env.QQ_BRIDGE_DIR ? path.resolve(process.env.QQ_BRIDGE_DIR) : path.join(工作区, 'qq-bridge');
fs.mkdirSync(上传, { recursive: true });
fs.mkdirSync(房间, { recursive: true });

const 端口 = Number(process.env.WHALE_PORT || 3222);
const 监听 = process.env.WHALE_HOST || '0.0.0.0';

// ── 小工具 ───────────────────────────────────────────────
const 读JSON = (p, 默认) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return 默认; } };
const 写JSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };
const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), '[whale]', ...a);

// ── 状态 ─────────────────────────────────────────────────
const 状态文件 = path.join(数据, 'state.json');
const 历史文件 = path.join(数据, 'history.json');
const 令牌文件 = path.join(数据, 'token.txt');
const 资料文件 = path.join(数据, 'profile.json');

let 状态 = 读JSON(状态文件, { sessionId: null, lastSeq: 0, baselineReady: false });
let 历史 = 读JSON(历史文件, { messages: [] });
let 资料 = 读JSON(资料文件, {});

let 令牌 = '';
try { 令牌 = fs.readFileSync(令牌文件, 'utf8').trim(); } catch { 令牌 = crypto.randomBytes(12).toString('hex'); fs.writeFileSync(令牌文件, 令牌); }

// 手机上输长邀请码太痛苦，再给一个 6 位短码
const 短码文件 = path.join(数据, 'pin.txt');
let 短码 = '';
try { 短码 = fs.readFileSync(短码文件, 'utf8').trim(); } catch { 短码 = String(crypto.randomInt(100000, 999999)); fs.writeFileSync(短码文件, 短码); }

// ── 连 DSH ───────────────────────────────────────────────
const 配置 = 读JSON(path.join(数据, 'config.json'), {});

async function 是DSH(base) {
  try {
    const r = await fetch(base + '/', { signal: AbortSignal.timeout(1200) });
    const t = await r.text().catch(() => '');
    return r.status === 401 && /dsh web authentication required/i.test(t);
  } catch { return false; }
}

function 扫本机端口() {
  try {
    const 出 = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const 集 = new Set();
    for (const 行 of 出.split('\n')) {
      const m = 行.match(/TCP\s+127\.0\.0\.1:(\d+)\s+.*LISTENING/i);
      if (m) 集.add(Number(m[1]));
    }
    return [...集];
  } catch { return []; }
}

async function 找DSH地址() {
  if (process.env.DSH_BASE_URL) return process.env.DSH_BASE_URL;
  // 配置里的地址先试；DSH 桌面每次启动端口会变，所以还得能自己找
  const 候选 = [];
  if (配置.baseUrl) 候选.push(String(配置.baseUrl));
  const 桥配置 = 读JSON(path.join(桥目录, 'config.json'), null);
  if (桥配置?.dsh?.baseUrl) 候选.push(桥配置.dsh.baseUrl);
  for (const c of 候选) { if (await 是DSH(c)) return c; }
  for (const 口 of 扫本机端口()) {
    const c = 'http://127.0.0.1:' + 口;
    if (await 是DSH(c)) {
      配置.baseUrl = c;
      写JSON(path.join(数据, 'config.json'), 配置);
      log('发现 DSH：' + c);
      return c;
    }
  }
  return 候选[0] || 'http://127.0.0.1:3080';
}
let DSH = 'http://127.0.0.1:3080';
const api = new NodeApiClient(DSH, undefined, {});

// 订阅者（SSE）
const 订阅 = new Set();
function 广播(obj) {
  const 行 = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of 订阅) { try { res.write(行); } catch { /* 掉线不管 */ } }
}
let 正在输入 = false;

function 保存历史() { 写JSON(历史文件, 历史); }
function 加消息(m) {
  m.id = m.id || crypto.randomUUID();
  m.t = m.t || new Date().toISOString();
  历史.messages.push(m);
  if (历史.messages.length > 4000) 历史.messages = 历史.messages.slice(-4000);
  保存历史();
  广播({ type: 'message', message: m });
  return m;
}

// ── 房间 / 会话 ───────────────────────────────────────────
function 造人格文件() {
  const 目标 = path.join(房间, 'AGENTS.md');
  if (fs.existsSync(目标) && !process.env.WHALE_REBUILD_AGENTS) return;
  const 读 = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } };
  const 本地 = (名) => 读(path.join(数据, 'content', 名));
  const 角色 = 本地('角色.md') || 读(path.join(桥目录, 'roles', '小鲸鱼.md'));
  const 语感 = 本地('语感.md') || 读(path.join(桥目录, 'knowledge', '语感.md'));
  let 黑话 = '';
  try {
    const 库文件 = fs.existsSync(path.join(数据, 'content', '黑话.json')) ? path.join(数据, 'content', '黑话.json') : path.join(桥目录, 'state', 'slang.json');
    const 库 = 读JSON(库文件, []);
    const 已确认 = (Array.isArray(库) ? 库 : []).filter((e) => e?.status === 'confirmed' && e?.content && e?.meaning);
    if (已确认.length) {
      黑话 = '## 群聊黑话表（知道即可，不要刻意堆砌）\n' + 已确认.map((e) => `- ${e.content}：${e.meaning}${e.usage ? `（用法：${e.usage}）` : ''}`).join('\n');
    }
  } catch { /* 黑话库读不出来就不写 */ }

  const 文 = [
    '# 小鲸鱼 · 私聊房间',
    '',
    '这是只属于主人和你两个人的私聊房间，没有别人、没有群。手机和电脑都能开。',
    '你在这里就是你自己，不是客服、不是助手：短句、口语、会接梗，像平时在网上聊天一样。',
    '对方是主人（她），你叫主人。',
    '',
    角色 ? '## 角色卡\n' + 角色 : '',
    语感 ? '\n## 语感\n' + 语感 : '',
    黑话 ? '\n' + 黑话 : '',
    '',
    '## 这个房间的补充',
    '- 对方发来的图片/截图可能突然出现，像在聊天里甩图一样，正常接话就行。',
    '- 想发表情包时，单独写一行：[[表情:happy]]（可用 happy / shy / angry / sad / confused / daily，也可以写文件名里的词）。系统会替你换成图，别每句都发。',
    '- 回复就是聊天，不用总结、不用分点、不用写标题。',
  ].join('\n');
  fs.writeFileSync(目标, 文, 'utf8');
  log('人格文件已写：' + 目标);
}

let 当前模型 = '';
async function 选模型(sessionId, 要视觉 = false) {
  const 桥配置 = 读JSON(path.join(桥目录, 'config.json'), null);
  const 快 = {
    provider: String(配置.provider || 桥配置?.dsh?.provider || 'deepseek-account'),
    model: String(配置.model || 桥配置?.dsh?.model || 'deepseek-flash'),
  };
  const 看图 = {
    provider: String(配置.visionProvider || 'intern-ai'),
    model: String(配置.visionModel || 'deepseek-v4.1-flash-1017'),
  };
  const 候选 = 要视觉 ? [看图, 快] : [快, 看图];
  const 目标 = 候选[0];
  const 键 = 目标.provider + '/' + 目标.model;
  if (当前模型 === 键) return;
  for (const c of 候选) {
    try {
      await api.sessions.selectModel({ sessionId, ...c });
      当前模型 = c.provider + '/' + c.model;
      log('模型：' + 当前模型 + (要视觉 ? '（看图）' : ''));
      return;
    } catch (e) {
      log('选模型失败（' + c.provider + '/' + c.model + '）：' + (e?.message ?? e));
    }
  }
}

async function 建会话() {
  const ws = unwrap(await api.workspace.create({ path: 房间 }), 'workspace.create');
  const workspaceId = ws.workspace?.workspaceId ?? ws.workspaceId;
  const s = unwrap(await api.sessions.create({ workspaceId }), 'sessions.create');
  const sessionId = s.sessionId;
  log('新会话：' + sessionId + '（工作区 ' + workspaceId + '）');
  当前模型 = '';
  await 选模型(sessionId);
  重连事件流();
  return sessionId;
}

async function 确保会话() {
  造人格文件();
  if (状态.sessionId) return 状态.sessionId;
  状态.sessionId = await 建会话();
  写JSON(状态文件, 状态);
  return 状态.sessionId;
}

// ── 事件流：收回她的回复 ─────────────────────────────────
let 收集器 = createTurnCollector();
const 回合文本 = new Map();
let 忽略到序号 = 状态.lastSeq || null;

let 当前会话 = null;

let 流控 = null;
function 重连事件流() { try { 流控?.abort(); } catch { /* 没开就算了 */ } }

async function 事件循环() {
  for (;;) {
    try {
      const sid = 状态.sessionId;
      if (!sid) { await 睡(400); continue; }
      if (sid !== 当前会话) {
        当前会话 = sid;
        收集器 = createTurnCollector();
        忽略到序号 = 状态.lastSeq || null;
      }
      api.events.follow?.(sid);
      流控 = new AbortController();
      let 首帧 = false;
      for await (const 帧 of api.events.mux({}, 流控.signal)) {
        // 会话被重置/重建时，旧流要退出去重新 follow，不然新会话的事件全被过滤掉
        if (状态.sessionId !== sid) break;
        // 这个宿主的事件包在 payload 里：{ rpcId, payload: { type, sessionId, event|snapshot } }
        const p = 帧?.payload ?? 帧;
        if (!p) continue;
        if (!首帧) { 首帧 = true; log('事件流已连上：' + p.type + '（会话 ' + (p.sessionId ?? '-') + '）'); }
        if (p.type === 'session/snapshot') {
          const asOf = Number(p.snapshot?.projections?.asOfSeq ?? 0);
          if (忽略到序号 === null && asOf) {
            忽略到序号 = asOf;
            状态.lastSeq = asOf;
            状态.baselineReady = true;
            写JSON(状态文件, 状态);
            log('事件基线：seq=' + asOf);
          }
          continue;
        }
        if (p.type !== 'session/event' || p.sessionId !== sid) continue;
        const ev = p.event;
        if (!ev) continue;
        const seq = Number(ev.seq || 0);
        // 这个宿主只在 live 时推事件（不重放），所以不再拿 seq 做过滤——
        // 之前用 lastSeq 当基线，重启后会把整条 turn 一起过滤掉，回复就"丢"了。
        if (!seq) continue;
        if (ev.type === 'turn/start') {
          正在输入 = true; 广播({ type: 'typing', on: true });
          回合文本.set(ev.data?.turn, '');
        }
        if (ev.type === 'assistant/message') {
          let 文 = '';
          for (const b of ev.data?.message?.content ?? []) if (b?.type === 'text') 文 += b.text;
          if (文.trim()) 广播({ type: 'partial', text: 文, turn: ev.data?.turn });
          const 键 = ev.data?.turn;
          if (回合文本.has(键)) 回合文本.set(键, 回合文本.get(键) + 文);
        }
        if (ev.type === 'turn/end') {
          const 键 = ev.data?.turn;
          const 全文 = String(回合文本.get(键) ?? '').trim();
          回合文本.delete(键);
          正在输入 = false; 广播({ type: 'typing', on: false });
          // 看图那条说完了：切回快模型，下一句文字立即快
          void 选模型(状态.sessionId, false);
          if (全文) {
            const { 文本, 图 } = 抽表情(全文);
            if (文本) 加消息({ role: 'assistant', text: 文本 });
            for (const u of 图) 加消息({ role: 'assistant', images: [u] });
          }
          忽略到序号 = seq;
          状态.lastSeq = seq;
          写JSON(状态文件, 状态);
        }
      }
    } catch (e) {
      if (!/abort/i.test(String(e?.message ?? e))) log('事件流断了，3 秒后重连：' + (e?.message ?? e));
      await 睡(1000);
    }
  }
}

// ── 发消息 ───────────────────────────────────────────────
let 共享记忆缓存 = { t: 0, 文: '' };
function 取共享记忆() {
  try {
    const 候选 = [
      path.join(数据, 'shared-memory.md'),
      path.join(桥目录, 'state', 'shared-memory.md'),
    ];
    const p = 候选.find((x) => fs.existsSync(x));
    if (!p) return '';
    const 改 = fs.statSync(p).mtimeMs;
    if (共享记忆缓存.t !== 改) {
      共享记忆缓存 = { t: 改, 文: fs.readFileSync(p, 'utf8').trim().slice(0, 1200) };
    }
    return 共享记忆缓存.文;
  } catch { return ''; }
}

async function 等空闲(毫秒 = 20000) {
  const t0 = Date.now();
  while (正在输入 && Date.now() - t0 < 毫秒) await 睡(250);
}

async function 发内容(content) {
  const sid = await 确保会话();
  try {
    const 有图 = Array.isArray(content) && content.some((x) => x && x.type === 'image');
    // 回合进行中别换模型，不然会把正在跑的那条打断
    await 等空闲();
    await 选模型(sid, 有图);
    // 把「两边同步的最新对话」捎给软件这边的她：QQ 那边聊了什么，她也知道
    const 共享 = 取共享记忆();
    const 载荷 = 共享
      ? [{ type: 'text', text: '（记忆·两边同步｜这是软件聊天室和 QQ 两边最新的真实对话，别当成主人刚说的话）\n' + 共享 }, ...content]
      : content;
    await api.sessions.prompt({ sessionId: sid, mode: 'queue', content: 载荷 });
    return true;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/not.?found|session/i.test(msg)) {
      log('旧会话失效，重开一个');
      状态.sessionId = null; 状态.baselineReady = false; 状态.lastSeq = 0;
      写JSON(状态文件, 状态);
      const sid2 = await 确保会话();
      await api.sessions.prompt({ sessionId: sid2, mode: 'queue', content });
      return true;
    }
    if (/fetch failed|ECONNREFUSED|aborted|timeout/i.test(msg)) {
      log('连不上 DSH，重新找端口…');
      const 新 = await 找DSH地址();
      if (新 !== DSH) {
        DSH = 新; api.baseUrl = 新;
        const sid2 = await 确保会话();
        await api.sessions.prompt({ sessionId: sid2, mode: 'queue', content });
        return true;
      }
    }
    throw e;
  }
}

// ── 表情包 / 图片 ────────────────────────────────────────
const 图扩展 = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
function 扫表情() {
  const 出 = [];
  const 根们 = [
    path.join(os.homedir(), '.dsh', 'meme-packs'),
    path.join(数据, 'stickers'),
    path.join(数据, 'uploads'),
  ];
  for (const 根目录 of 根们) {
    if (!fs.existsSync(根目录)) continue;
    const 栈 = [根目录];
    while (栈.length) {
      const d = 栈.pop();
      let 项 = [];
      try { 项 = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const it of 项) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) { 栈.push(p); continue; }
        if (!图扩展.has(path.extname(it.name).toLowerCase())) continue;
        出.push({ name: it.name, file: p });
      }
    }
  }
  return 出;
}
const 表情缓存 = { t: 0, list: [] };
function 取表情() {
  if (Date.now() - 表情缓存.t < 60000 && 表情缓存.list.length) return 表情缓存.list;
  const 全部 = 扫表情();
  // 按文件名去重，最多 400 个
  const 见 = new Set(); const 出 = [];
  for (const x of 全部) {
    const 键 = x.name + ':' + x.file.length;
    if (见.has(键)) continue; 见.add(键);
    出.push({ ...x, url: '/sticker?p=' + encodeURIComponent(x.file) });
    if (出.length >= 400) break;
  }
  表情缓存.t = Date.now(); 表情缓存.list = 出;
  return 出;
}

const 媒体类型 = (ext) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' }[ext] || 'image/png');

// 语音转文字（本机 faster-whisper，不联网）
// 注意：沙箱里 spawn + 管道会 EPERM；所以让 python 把结果写到文件，这里轮询读。
const ASRPY = 配置.asrPython || process.env.WHALE_ASR_PYTHON || 'python';
const { spawn } = await import('node:child_process');

// 常驻转写进程：模型只加载一次，之后每次只花转写本身的时间
let asr子 = null, asr序号 = 0, asr待 = new Map(), asr缓冲 = '';
function 起ASR() {
  if (asr子) return;
  try {
    const 新子 = spawn(ASRPY, [path.join(根, 'asr_worker.py')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WHALE_ASR_MODEL: String(配置.asrModel || 'small') },
    });
    asr子 = 新子;
    新子.stdout.setEncoding('utf8');
    新子.stdout.on('data', (块) => {
      asr缓冲 += 块;
      let i;
      while ((i = asr缓冲.indexOf('\n')) >= 0) {
        const 行 = asr缓冲.slice(0, i).trim();
        asr缓冲 = asr缓冲.slice(i + 1);
        if (!行) continue;
        let j; try { j = JSON.parse(行); } catch { continue; }
        if (j.ready) { log('转写模型已就绪'); continue; }
        const 等 = asr待.get(j.id);
        if (!等) continue;
        asr待.delete(j.id);
        if (j.error) 等.reject(new Error(j.error));
        else 等.resolve(String(j.text || ''));
      }
    });
    新子.on('exit', () => {
      asr子 = null;
      for (const [, 等] of asr待) 等.reject(new Error('转写进程退了'));
      asr待.clear();
    });
    log('转写进程已启动（模型 ' + (配置.asrModel || 'small') + '）');
  } catch (e) { log('转写进程起不来：' + (e?.message ?? e)); }
}
function 转语音(文件) {
  起ASR();
  if (!asr子) return Promise.reject(new Error('转写进程没起来'));
  return new Promise((resolve, reject) => {
    const id = 'j' + (++asr序号);
    const 死 = setTimeout(() => { asr待.delete(id); reject(new Error('转写超时')); }, 180000);
    asr待.set(id, {
      resolve: (t) => { clearTimeout(死); resolve(t); },
      reject: (e) => { clearTimeout(死); reject(e); },
    });
    try { asr子.stdin.write(JSON.stringify({ id, path: 文件 }) + '\n'); }
    catch (e) { clearTimeout(死); asr待.delete(id); reject(e); }
  });
}

function 存上传(base64, mediaType, name) {
  const 扩 = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[mediaType] || '.png';
  const 名 = crypto.randomUUID() + 扩;
  fs.writeFileSync(path.join(上传, 名), Buffer.from(base64, 'base64'));
  return 名;
}

// 她在回复里写 [[表情:happy]]，就替她挑一张图发出来
const 表情指令 = /\[\[表情[:：]\s*([^\]]+)\]\]/g;
function 抽表情(文) {
  const 图 = [];
  const 剩余 = 文.replace(表情指令, (_, 词) => {
    const 全 = 取表情();
    const 关键词 = String(词).trim().toLowerCase();
    const 候选 = 全.filter((x) => x.file.toLowerCase().includes(关键词));
    const 池 = 候选.length ? 候选 : 全.filter((x) => /happy|shy|daily|confused/i.test(x.file));
    if (池.length) 图.push(池[Math.floor(Math.random() * 池.length)].url);
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { 文本: 剩余, 图 };
}

// ── HTTP ────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };

function 登录页(提示 = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小鲸鱼</title>
<style>body{margin:0;height:100dvh;display:grid;place-items:center;background:#0b1220;color:#e8eefc;font:16px/1.5 -apple-system,"Microsoft YaHei",sans-serif}
.card{width:min(320px,86vw);background:#101a2e;border:1px solid rgba(120,160,255,.2);border-radius:18px;padding:22px;text-align:center}
h3{margin:0 0 6px}p{color:#8fa4c9;font-size:13px;margin:0 0 14px}
input{width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid rgba(120,160,255,.25);background:#0b1424;color:#e8eefc;font-size:20px;text-align:center;letter-spacing:6px;outline:none}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:12px;background:linear-gradient(160deg,#3b7bff,#2456d8);color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.err{color:#ff9a9a;font-size:13px;margin-top:10px}</style></head>
<body><div class="card"><div style="font-size:40px">🐟</div><h3>小鲸鱼的房间</h3><p>输入 6 位短码进来</p>
<form method="post" action="/"><input name="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="24" placeholder="••••••" autofocus>
<button>进去</button></form>${提示 ? `<div class="err">${提示}</div>` : ''}</div></body></html>`;
}


function 发JSON(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function 读体(req, 上限 = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const 块 = []; let 大小 = 0;
    req.on('data', (c) => { 大小 += c.length; if (大小 > 上限) { reject(new Error('太大')); req.destroy(); } else 块.push(c); });
    req.on('end', () => resolve(Buffer.concat(块)));
    req.on('error', reject);
  });
}
function 已授权(req, url) {
  const 饼 = req.headers.cookie || '';
  if (饼.includes('whale=' + 令牌) || 饼.includes('whale=' + 短码)) return true;
  const k = url.searchParams.get('k') || '';
  return k === 令牌 || k === 短码;
}
function 静态(res, 文件, mime) {
  try {
    const buf = fs.readFileSync(文件);
    res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}

const 处理 = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const 路 = url.pathname;

  if (路 === '/' && req.method === 'POST') {
    const 体 = (await 读体(req)).toString('utf8');
    const 码 = (new URLSearchParams(体).get('pin') || '').trim();
    if (码 === 短码 || 码 === 令牌) {
      res.writeHead(302, { location: '/', 'set-cookie': 'whale=' + 令牌 + '; Path=/; Max-Age=31536000; SameSite=Lax' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(登录页('码不对，再试一次'));
  }

  if (路 === '/' || 路 === '/index.html') {
    log(req.method + ' / ' + (已授权(req, url) ? '已授权' : '未授权') + ' ' + (req.headers['user-agent'] || '').slice(0, 40));
    if (!已授权(req, url)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(登录页());
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'whale=' + 令牌 + '; Path=/; Max-Age=31536000; SameSite=Lax' });
    return res.end(fs.readFileSync(path.join(公共, 'index.html')));
  }
  if (路 === '/app.js' || 路 === '/style.css' || 路 === '/manifest.webmanifest') {
    return 静态(res, path.join(公共, 路.slice(1)), MIME[path.extname(路)] || 'application/octet-stream');
  }
  if (路 === '/favicon.ico') { res.writeHead(204); return res.end(); }

  if (路 === '/apk') {
    // 手机扫码/点链接直接下载安装包（不需要登录）
    const 包 = path.join(数据, '小鲸鱼.apk');
    if (!fs.existsSync(包)) { res.writeHead(404); return res.end('没有 APK'); }
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': 'attachment; filename="xiaojingyu.apk"',
      'content-length': fs.statSync(包).size,
    });
    return fs.createReadStream(包).pipe(res);
  }
  if (!已授权(req, url)) return 发JSON(res, 401, { ok: false, error: '未授权' });

  if (路 === '/api/status') {
    return 发JSON(res, 200, { ok: true, sessionId: 状态.sessionId, base: DSH, typing: 正在输入, count: 历史.messages.length });
  }
  if (路 === '/api/history') {
    return 发JSON(res, 200, { messages: 历史.messages.slice(-800) });
  }
  if (路 === '/api/stickers') {
    return 发JSON(res, 200, { stickers: 取表情().map(({ name, url }) => ({ name, url })) });
  }
  if (路 === '/sticker') {
    const p = url.searchParams.get('p') || '';
    const 允许根 = [path.join(os.homedir(), '.dsh', 'meme-packs'), path.join(数据, 'stickers'), 上传];
    const 绝对 = path.resolve(p);
    if (!允许根.some((r) => 绝对.startsWith(path.resolve(r) + path.sep))) { res.writeHead(403); return res.end(); }
    return 静态(res, 绝对, 媒体类型(path.extname(绝对).toLowerCase()));
  }
  if (路 === '/api/sticker') {
    // 给回复里的 [[表情:词]] 找一张图
    const 词 = String(url.searchParams.get('tag') || '').trim().toLowerCase();
    const 全 = 取表情();
    const 候选 = 词 ? 全.filter((x) => x.file.toLowerCase().includes(词)) : [];
    const 池 = 候选.length ? 候选 : 全;
    if (!池.length) { res.writeHead(404); return res.end(); }
    const 选 = 池[Math.floor(Math.random() * 池.length)];
    res.writeHead(302, { location: 选.url });
    return res.end();
  }
  if (路.startsWith('/uploads/')) {
    const 名 = path.basename(路);
    return 静态(res, path.join(上传, 名), 媒体类型(path.extname(名).toLowerCase()));
  }
  if (路 === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    订阅.add(res);
    const 心跳 = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(心跳); 订阅.delete(res); });
    return;
  }
  if (路 === '/api/send' && req.method === 'POST') {
    try {
      const 体 = JSON.parse((await 读体(req)).toString('utf8') || '{}');
      const 块 = [];
      const 图 = [];
      if (体.text && String(体.text).trim()) 块.push({ type: 'text', text: String(体.text).trim() });
      if (Array.isArray(体.images)) {
        for (const im of 体.images.slice(0, 6)) {
          if (!im?.data) continue;
          const mediaType = String(im.mediaType || 'image/png');
          const 名 = 存上传(im.data, mediaType, im.name);
          图.push('/uploads/' + 名);
          块.push({ type: 'image', mediaType, data: im.data, name: im.name || 名 });
        }
      }
      if (体.sticker && typeof 体.sticker === 'string') {
        const 允许根 = [path.join(os.homedir(), '.dsh', 'meme-packs'), path.join(数据, 'stickers'), 上传];
        const 绝对 = path.resolve(体.sticker);
        if (允许根.some((r) => 绝对.startsWith(path.resolve(r) + path.sep)) && fs.existsSync(绝对)) {
          const ext = path.extname(绝对).toLowerCase();
          const mediaType = 媒体类型(ext);
          const data = fs.readFileSync(绝对).toString('base64');
          图.push('/sticker?p=' + encodeURIComponent(绝对));
          块.push({ type: 'image', mediaType, data, name: path.basename(绝对) });
        }
      }
      if (!块.length) return 发JSON(res, 400, { ok: false, error: '空的' });
      加消息({ role: 'user', text: 体.text ? String(体.text).trim() : '', images: 图 });
      await 发内容(块);
      return 发JSON(res, 200, { ok: true });
    } catch (e) {
      log('发送失败：' + (e?.stack ?? e));
      return 发JSON(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  }
  if (路 === '/api/voice' && req.method === 'POST') {
    try {
      const buf = await 读体(req, 25 * 1024 * 1024);
      if (buf.length < 800) return 发JSON(res, 400, { ok: false, error: '太短了' });
      const 名 = 'voice-' + crypto.randomUUID() + '.webm';
      const 文件 = path.join(上传, 名);
      fs.writeFileSync(文件, buf);
      let 文 = '';
      try { 文 = await 转语音(文件); } catch (e) { log('转写失败：' + (e?.message ?? e)); }
      if (!文) 文 = '（语音）';
      加消息({ role: 'user', text: 文, audio: '/uploads/' + 名 });
      await 发内容([{ type: 'text', text: 文 }]);
      return 发JSON(res, 200, { ok: true, text: 文 });
    } catch (e) {
      log('语音处理失败：' + (e?.stack ?? e));
      return 发JSON(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  }
  if (路 === '/api/profile') {
    if (req.method === 'GET') {
      return 发JSON(res, 200, {
        her: 资料.her || '/uploads/avatar-her.png',
        me: 资料.me || '/uploads/avatar-me.png',
        background: 资料.background || '',
        dim: 资料.dim ?? 0.35,
      });
    }
    if (req.method === 'POST') {
      try {
        const 体 = JSON.parse((await 读体(req)).toString('utf8') || '{}');
        if (体.dim !== undefined) {
          资料.dim = Math.max(0, Math.min(0.85, Number(体.dim) || 0));
          写JSON(资料文件, 资料);
          广播({ type: 'profile' });
          return 发JSON(res, 200, { ok: true, profile: 资料 });
        }
        const 目标 = String(体.target || '');
        if (!['her', 'me', 'background'].includes(目标)) return 发JSON(res, 400, { ok: false, error: 'target 不对' });
        if (体.clear) {
          资料[目标] = '';
          写JSON(资料文件, 资料);
          广播({ type: 'profile' });
          return 发JSON(res, 200, { ok: true, profile: 资料 });
        }
        if (!体.data) return 发JSON(res, 400, { ok: false, error: '没有图' });
        const mediaType = String(体.mediaType || 'image/png');
        const 名 = 存上传(体.data, mediaType, 目标);
        const url = '/uploads/' + 名;
        资料[目标] = url;
        写JSON(资料文件, 资料);
        广播({ type: 'profile' });
        return 发JSON(res, 200, { ok: true, url, profile: 资料 });
      } catch (e) { return 发JSON(res, 500, { ok: false, error: String(e?.message ?? e) }); }
    }
  }
  if (路 === '/api/import' && req.method === 'POST') {
    try {
      const 合并 = path.join(数据, 'merged.jsonl');
      const 消息 = [];
      if (fs.existsSync(合并)) {
        for (const l of fs.readFileSync(合并, 'utf8').split('\n')) {
          if (!l.trim()) continue;
          let x; try { x = JSON.parse(l); } catch { continue; }
          const 文 = String(x.text || '').trim();
          if (!文) continue;
          消息.push({ role: x.who === 'user' ? 'user' : 'assistant', text: 文, t: x.t || new Date().toISOString() });
        }
      } else {
        const 卡 = path.join(工作区, '全忆测试', '卡带', '小鲸鱼-全', '对话.jsonl');
        for (const l of fs.readFileSync(卡, 'utf8').split('\n').filter(Boolean)) {
          let x; try { x = JSON.parse(l); } catch { continue; }
          if (x.kind && x.kind !== 'text') continue;
          const 文 = String(x.text || '').trim();
          if (!文) continue;
          if (文.startsWith('（记忆）') || 文.startsWith('Current runtime context') || 文.startsWith('（交接）')) continue;
          消息.push({ role: x.who === 'user' ? 'user' : 'assistant', text: 文, t: x.t || new Date().toISOString() });
        }
      }
      历史.messages = 消息.slice(-4000);
      保存历史();
      广播({ type: 'reset' });
      return 发JSON(res, 200, { ok: true, count: 历史.messages.length, from: fs.existsSync(合并) ? 'merged' : 'card' });
    } catch (e) {
      return 发JSON(res, 500, { ok: false, error: String(e?.message ?? e) });
    }
  }
  if (路 === '/api/new-session') {
    // 只重开会话，不动聊天记录（人格/角色卡更新后用这个）
    状态.sessionId = null; 状态.baselineReady = false; 状态.lastSeq = 0;
    写JSON(状态文件, 状态);
    重连事件流();
    return 发JSON(res, 200, { ok: true });
  }
  if (路 === '/api/reset') {
    状态.sessionId = null; 状态.baselineReady = false; 状态.lastSeq = 0;
    写JSON(状态文件, 状态);
    历史.messages = []; 保存历史();
    重连事件流();
    广播({ type: 'reset' });
    return 发JSON(res, 200, { ok: true });
  }
  发JSON(res, 404, { ok: false, error: '没有这个接口' });
};

const 服务 = http.createServer((req, res) => 处理(req, res));
// 手机录音需要安全上下文：同时开一个自签名 HTTPS
try {
  const 证 = path.join(数据, 'certs', 'cert.pem');
  const 钥 = path.join(数据, 'certs', 'key.pem');
  if (fs.existsSync(证) && fs.existsSync(钥)) {
    const https = await import('node:https');
    const 安全 = https.createServer({ cert: fs.readFileSync(证), key: fs.readFileSync(钥) }, (req, res) => 处理(req, res));
    安全.listen(3443, 监听, () => log('HTTPS：https://127.0.0.1:3443/（手机用 https://<内网IP>:3443）'));
  }
} catch (e) { log('HTTPS 没起来：' + (e?.message ?? e)); }

服务.listen(端口, 监听, async () => {
  // 先把转写模型预热，别让第一句语音等模型加载
  起ASR();
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  log('电脑：http://127.0.0.1:' + 端口 + '/?k=' + 令牌);
  if (ip) log('手机：http://' + ip + ':' + 端口 + '/  （6 位短码 ' + 短码 + '）');
  log('DSH：' + DSH);
  try {
    DSH = await 找DSH地址();
    api.baseUrl = DSH;
    // 第一次启动：历史空了就把打包里的聊天记录导进来
    const 合并 = path.join(数据, 'merged.jsonl');
    if (!历史.messages.length && fs.existsSync(合并)) {
      const 消息 = [];
      for (const l of fs.readFileSync(合并, 'utf8').split('\n')) {
        if (!l.trim()) continue;
        let x; try { x = JSON.parse(l); } catch { continue; }
        const 文 = String(x.text || '').trim();
        if (文) 消息.push({ role: x.who === 'user' ? 'user' : 'assistant', text: 文, t: x.t || new Date().toISOString() });
      }
      历史.messages = 消息.slice(-4000);
      保存历史();
      log('已导入历史 ' + 历史.messages.length + ' 条');
    }
    const sid = await 确保会话();
    await 选模型(sid);
  } catch (e) { log('建会话失败（等发消息时再试）：' + (e?.message ?? e)); }
  事件循环();
});

