// RedPanel "process" runtime: runs Minecraft directly as a Java process.
// Used when Docker is not available (Railway, container VPS without dockerd, ...).
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = { 'User-Agent': 'RedPanel/1.0 (minecraft panel)' };
const MAX_LINES = 600;

// ---------- java discovery ----------
function discoverJava(extra = {}) {
  const found = {};
  const candidates = new Set();
  for (const base of ['/opt/java', '/usr/lib/jvm', '/usr/local/java']) {
    try { for (const d of fs.readdirSync(base)) candidates.add(path.join(base, d, 'bin', 'java')); } catch {}
  }
  if (process.env.JAVA_HOME) candidates.add(path.join(process.env.JAVA_HOME, 'bin', 'java'));
  candidates.add('java');
  for (const [v, p] of Object.entries(extra)) found[+v] = p;
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-version'], { timeout: 15000 });
      if (r.error) continue;
      const txt = (r.stderr || '').toString() + (r.stdout || '').toString();
      const m = /version "(\d+)(?:\.(\d+))?/.exec(txt);
      if (!m) continue;
      const major = m[1] === '1' ? +m[2] : +m[1];
      if (!found[major]) found[major] = bin;
    } catch {}
  }
  return found;
}

function requiredJava(version) {
  const m = /^1\.(\d+)(?:\.(\d+))?/.exec(version || '');
  if (!m) return 25; // year-style versions (26.x+) need Java 25
  const minor = +m[1], patch = +(m[2] || 0);
  if (minor <= 16) return 8;
  if (minor <= 19 || (minor === 20 && patch <= 4)) return 17;
  return 21;
}

function cmpVer(a, b) {
  const pa = a.split(/[.-]/).map((x) => +x || 0), pb = b.split(/[.-]/).map((x) => +x || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

module.exports = function createProcessRuntime({ DATA, meta, saveMeta, javaPaths }) {
  const javas = discoverJava(javaPaths || {});
  console.log('[node] process runtime - java found:', Object.keys(javas).map((k) => 'java' + k).join(', ') || 'NONE');

  function javaFor(version) {
    const need = requiredJava(version);
    const have = Object.keys(javas).map(Number).sort((a, b) => a - b);
    if (!have.length) throw new Error('Java is not installed on this node');
    if (javas[need]) return javas[need];
    const higher = have.find((v) => v >= need);
    return javas[higher ?? have[have.length - 1]];
  }

  const S = {}; // id -> runtime state
  const st = (id) => S[id] || (S[id] = { child: null, installing: false, error: null, buf: [], partial: '', subs: new Set(), cpu: null });

  function emit(id, text) {
    const s = st(id);
    for (const fn of s.subs) { try { fn(text); } catch {} }
    const lines = (s.partial + text).split(/\r?\n/);
    s.partial = lines.pop();
    s.buf.push(...lines);
    if (s.buf.length > MAX_LINES) s.buf.splice(0, s.buf.length - MAX_LINES);
  }
  const log = (id, msg) => emit(id, `[RedPanel] ${msg}\n`);

  async function getJson(url) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.json();
  }
  async function download(id, url, dest) {
    log(id, 'Downloading ' + url);
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest + '.part'));
    await fsp.rename(dest + '.part', dest);
  }
  function run(id, bin, args, cwd) {
    return new Promise((resolve, reject) => {
      const c = spawn(bin, args, { cwd });
      c.stdout.on('data', (d) => emit(id, d.toString()));
      c.stderr.on('data', (d) => emit(id, d.toString()));
      c.on('error', reject);
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited with code ${code}`))));
    });
  }
  async function latestRelease() {
    const m = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    return m.latest.release;
  }

  // ---------- installers ----------
  async function installPaper(id, dir, version) {
    if (version === 'LATEST') version = await latestRelease();
    let url = null;
    try {
      const builds = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`);
      const list = (Array.isArray(builds) ? builds : builds.builds || []).sort((a, b) => b.id - a.id);
      const pick = list.find((b) => b.channel === 'STABLE') || list[0];
      url = pick && pick.downloads && pick.downloads['server:default'] && pick.downloads['server:default'].url;
    } catch {}
    if (!url) {
      const j = await getJson(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`);
      const b = j.builds[j.builds.length - 1];
      url = `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${b.build}/downloads/${b.downloads.application.name}`;
    }
    await download(id, url, path.join(dir, 'server.jar'));
    return { type: 'jar', jar: 'server.jar', resolved: version };
  }
  async function installPurpur(id, dir, version) {
    if (version === 'LATEST') { const j = await getJson('https://api.purpurmc.org/v2/purpur'); version = j.versions[j.versions.length - 1]; }
    await download(id, `https://api.purpurmc.org/v2/purpur/${version}/latest/download`, path.join(dir, 'server.jar'));
    return { type: 'jar', jar: 'server.jar', resolved: version };
  }
  async function installFabric(id, dir, version) {
    if (version === 'LATEST') version = (await getJson('https://meta.fabricmc.net/v2/versions/game')).find((g) => g.stable).version;
    const loaders = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${version}`);
    if (!loaders.length) throw new Error('Fabric does not support ' + version);
    const loader = (loaders.find((l) => l.loader.stable) || loaders[0]).loader.version;
    const installer = (await getJson('https://meta.fabricmc.net/v2/versions/installer')).find((i) => i.stable).version;
    await download(id, `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`, path.join(dir, 'server.jar'));
    return { type: 'jar', jar: 'server.jar', resolved: version };
  }
  async function installForge(id, dir, version) {
    const promos = (await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    if (version === 'LATEST') {
      version = Object.keys(promos).map((k) => k.replace(/-(latest|recommended)$/, '')).sort(cmpVer).pop();
    }
    const fv = promos[`${version}-recommended`] || promos[`${version}-latest`];
    if (!fv) throw new Error('Forge has no build for Minecraft ' + version);
    const full = `${version}-${fv}`;
    const inst = path.join(dir, 'forge-installer.jar');
    await download(id, `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`, inst);
    log(id, 'Running Forge installer (this takes a few minutes)...');
    await run(id, javaFor(version), ['-jar', 'forge-installer.jar', '--installServer'], dir);
    await fsp.rm(inst, { force: true });
    await fsp.rm(inst + '.log', { force: true });
    const argsFile = `libraries/net/minecraftforge/forge/${full}/unix_args.txt`;
    if (fs.existsSync(path.join(dir, argsFile))) return { type: 'args', argsFile, resolved: version };
    const jar = (await fsp.readdir(dir)).find((f) => /^forge-.*\.jar$/.test(f) && !/installer/.test(f));
    if (!jar) throw new Error('Forge installed but no server jar was found');
    return { type: 'jar', jar, resolved: version };
  }
  async function installSpigot(id, dir, version) {
    if (version === 'LATEST') version = await latestRelease();
    const bt = path.join(path.dirname(DATA), 'buildtools');
    await fsp.mkdir(bt, { recursive: true });
    await download(id, 'https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar', path.join(bt, 'BuildTools.jar'));
    log(id, 'Compiling Spigot with BuildTools (5-10 minutes, needs git)...');
    await run(id, javaFor(version), ['-jar', 'BuildTools.jar', '--rev', version, '--output-dir', dir, '--final-name', 'server.jar'], bt);
    return { type: 'jar', jar: 'server.jar', resolved: version };
  }

  async function install(id) {
    const m = meta[id], dir = path.join(DATA, id);
    await fsp.mkdir(dir, { recursive: true });
    const fn = { paper: installPaper, purpur: installPurpur, fabric: installFabric, forge: installForge, spigot: installSpigot }[m.software];
    if (!fn) throw new Error('Unknown software ' + m.software);
    log(id, `Installing ${m.software} ${m.version}...`);
    const launch = await fn(id, dir, m.version);
    m.installed = { software: m.software, version: m.version, launch };
    saveMeta();
    log(id, `Installed ${m.software} ${launch.resolved}`);
  }

  // ---------- server.properties ----------
  function propEscape(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  async function writeProps(id) {
    const m = meta[id], file = path.join(DATA, id, 'server.properties');
    let lines = [];
    try { lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/); } catch {}
    const set = {
      'server-port': m.port,
      'query.port': m.port,
      motd: propEscape((m.motd || 'A RedPanel Minecraft Server').replace(/&([0-9a-fk-or])/gi, '§$1')),
    };
    for (const [k, v] of Object.entries(set)) {
      const i = lines.findIndex((l) => l.startsWith(k + '='));
      if (i >= 0) lines[i] = `${k}=${v}`; else lines.push(`${k}=${v}`);
    }
    await fsp.writeFile(file, lines.filter((l, i) => l || i < lines.length - 1).join('\n') + '\n');
    await fsp.writeFile(path.join(DATA, id, 'eula.txt'), 'eula=true\n');
  }

  // ---------- lifecycle ----------
  async function start(id) {
    const s = st(id), m = meta[id];
    if (!m || s.child || s.installing) return;
    s.error = null;
    const ins = m.installed;
    if (!ins || ins.software !== m.software || ins.version !== m.version) {
      s.installing = true;
      try { await install(id); }
      catch (e) { s.error = 'Install failed: ' + e.message; log(id, s.error); s.installing = false; return; }
      s.installing = false;
    }
    await writeProps(id);
    const L = m.installed.launch;
    const mem = Math.max(512, +m.memory || 1024);
    const jvm = [`-Xms${Math.min(1024, mem)}M`, `-Xmx${mem}M`, '-XX:+UseG1GC', '-Dfile.encoding=UTF-8'];
    const args = L.type === 'args' ? [...jvm, '@' + L.argsFile, 'nogui'] : [...jvm, '-jar', L.jar, 'nogui'];
    let java;
    try { java = javaFor(m.version); } catch (e) { s.error = e.message; log(id, e.message); return; }
    log(id, `Starting: ${path.basename(path.dirname(path.dirname(java))) || 'java'} ${args.join(' ')}`);
    const child = spawn(java, args, { cwd: path.join(DATA, id), stdio: ['pipe', 'pipe', 'pipe'] });
    s.child = child; s.startedAt = new Date().toISOString(); s.cpu = null;
    m.wantRunning = true; saveMeta();
    child.stdout.on('data', (d) => emit(id, d.toString()));
    child.stderr.on('data', (d) => emit(id, d.toString()));
    child.on('error', (e) => { s.error = 'Could not start Java: ' + e.message; log(id, s.error); });
    child.on('exit', (code, sig) => {
      s.child = null;
      log(id, `Server stopped (${sig || 'exit code ' + code})`);
      (s.exitWaiters || []).forEach((r) => r()); s.exitWaiters = [];
    });
  }
  function waitExit(id, ms) {
    const s = st(id);
    if (!s.child) return Promise.resolve(true);
    return new Promise((r) => {
      const t = setTimeout(() => r(false), ms);
      (s.exitWaiters = s.exitWaiters || []).push(() => { clearTimeout(t); r(true); });
    });
  }
  async function stop(id, keepWant) {
    const s = st(id), m = meta[id];
    if (m && !keepWant) { m.wantRunning = false; saveMeta(); }
    if (!s.child) return;
    try { s.child.stdin.write('stop\n'); } catch {}
    if (!(await waitExit(id, 45000)) && s.child) { log(id, 'Server did not stop in time - killing'); s.child.kill('SIGKILL'); await waitExit(id, 5000); }
  }

  async function power(id, action) {
    const s = st(id);
    if (s.installing) throw Object.assign(new Error('Server is still installing, please wait'), { status: 409 });
    if (action === 'start') { start(id); return; }
    if (action === 'stop') return stop(id);
    if (action === 'restart') { await stop(id, true); start(id); return; }
    if (action === 'kill') { if (meta[id]) { meta[id].wantRunning = false; saveMeta(); } if (s.child) s.child.kill('SIGKILL'); return; }
    throw Object.assign(new Error('bad action'), { status: 400 });
  }

  function procStats(pid, s) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      const ticks = +stat[11] + +stat[12]; // utime + stime
      const now = Date.now();
      let cpu = 0;
      if (s.cpu) cpu = ((ticks - s.cpu.ticks) / 100) / ((now - s.cpu.at) / 1000) * 100;
      s.cpu = { ticks, at: now };
      const rss = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return { cpu: +Math.max(0, cpu).toFixed(1), memory: rss ? +rss[1] * 1024 : 0 };
    } catch { return { cpu: 0, memory: 0 }; }
  }

  function status(id) {
    const s = st(id), m = meta[id];
    const out = { state: s.installing ? 'installing' : s.child ? 'running' : 'exited', installing: s.installing, error: s.error, cpu: 0, memory: 0, memLimit: (m.memory || 1024) * 1048576, startedAt: s.child ? s.startedAt : null, runtime: 'process' };
    if (s.child) Object.assign(out, procStats(s.child.pid, s));
    return out;
  }

  async function command(id, cmd) {
    const s = st(id);
    if (!s.child) throw new Error('Server is offline');
    s.child.stdin.write(cmd + '\n');
    return '';
  }

  // console: send recent history, then live output. Stays open across restarts.
  function attach(id, say) {
    const s = st(id);
    const hist = s.buf.join('\n');
    if (hist) say(hist + '\n');
    if (!s.child && !s.installing) say('[RedPanel] Server is offline. Press Start.\n');
    s.subs.add(say);
    return () => s.subs.delete(say);
  }

  async function rebuild(id) {
    const s = st(id);
    if (s.child) { await stop(id, true); start(id); }
  }

  async function remove(id) {
    const s = st(id);
    if (s.child) { s.child.kill('SIGKILL'); await waitExit(id, 5000); }
    delete S[id];
  }

  function autostart() {
    for (const [id, m] of Object.entries(meta)) if (m.wantRunning) { console.log('[node] auto-starting', id); start(id); }
  }

  async function shutdown() {
    await Promise.all(Object.keys(S).map(async (id) => { if (S[id].child) await stop(id, true); }));
  }

  return { start, power, status, command, attach, rebuild, remove, autostart, shutdown, javas };
};
