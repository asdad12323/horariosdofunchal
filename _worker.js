// Autocarros do Funchal em tempo real — Cloudflare Pages (_worker.js). Serve /api/* e /tiles/* e deixa o resto para os ficheiros estáticos.
const BASE = 'https://www.horariosdofunchal.pt/index.php?option=com_ajax&module=transporte&format=json&task=';
const TZ = 'Atlantic/Madeira';
const TILES = 'https://www.horariosdofunchal.pt/tiles/styles/basic-preview/512/';
const UA = { 'user-agent': 'Mozilla/5.0', referer: 'https://www.horariosdofunchal.pt/' };

const cache = new Map(), memo = new Map(), vcache = new Map(), veh = new Map(), trips = new Map();
const once = async (k, f) => { if (memo.has(k)) return memo.get(k); const v = await f(); memo.set(k, v); return v; };
const pool = async (items, n, fn) => { const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } }));
  return out; };

async function api(task, params = {}, ttl = 0) {
  const url = BASE + task + Object.entries(params).map(([k, v]) => '&' + k + '=' + encodeURIComponent(v)).join('');
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const r = await fetch(url, { headers: { ...UA, accept: 'application/json' }, cf: ttl ? { cacheTtl: Math.round(ttl / 1000), cacheEverything: true } : undefined });
  if (!r.ok) throw new Error(task + ' HTTP ' + r.status);
  let t = await r.text(); const i = t.indexOf('}{"success"'); if (i > 0) t = t.slice(0, i + 1); // a API devolve 2 JSONs colados
  const v = JSON.parse(t).data; cache.set(url, { t: Date.now(), v }); return v;
}

const DAY = 6 * 3600e3;
const parts = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(new Date());
const localSec = () => { const p = parts(), g = t => +p.find(x => x.type === t).value; return (g('hour') % 24) * 3600 + g('minute') * 60 + g('second'); };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()).replace(/-/g, '');
const sec = s => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + (x || 0); };
const hms = s => [Math.floor(s / 3600) % 24, Math.floor(s % 3600 / 60), Math.round(s) % 60].map(n => String(n).padStart(2, '0')).join(':');
const hav = (a, b, c, d) => { const R = 6371e3, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

const lines = () => api('getCarreiras', { search: '' }, DAY);
const service = () => api('getServicoAtivo', { date: today() }, DAY);

const lineData = id => once('line:' + id + today(), async () => {
  const sid = await service(), ps = await api('getPercursos', { line: id, service_id: sid }, DAY);
  const patterns = await Promise.all((ps || []).map(async p => {
    const q = { route_id: p.route_id, pattern_id: p.pattern_id };
    const [st, sh] = await Promise.all([api('getParagens', q, DAY), api('getLinhaPercurso', q, DAY)]);
    return { id: p.pattern_id, route: p.route_id, headsign: p.pattern_short_name,
      stops: (st || []).map(s => ({ id: s.stop_id, num: s.num_paragem, name: s.nome_publico.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' '), lat: s.latitude, lon: s.longitude })),
      shape: (sh || []).map(s => [s.shape_pt_lat, s.shape_pt_lon]) };
  }));
  return { id, sid, patterns };
});

const timetable = (route, pat, sid) => once('tt:' + pat + sid, async () => {
  const d = await api('getHorariosPercurso', { route_id: route, pattern_id: pat, time: '00:00:00', service_id: sid });
  const m = {}; for (const t of d || []) m[t.trip_id] = t.horarios.map(h => [h.stop_id, sec(h.arrival_time)]); return m;
});

async function vehicles(ids) {
  const key = ids.join(','), hit = vcache.get(key), many = ids.length > 6;
  if (hit && Date.now() - hit.t < (many ? 20000 : 8000)) return hit.v;
  const ld = await Promise.all(ids.map(lineData)), jobs = [];
  for (const l of ld) for (const p of l.patterns) { const s = p.stops; if (!s.length) continue;
    for (const st of many ? [s[s.length - 1]] : [s[s.length - 1], s[s.length >> 1]]) jobs.push({ l, p, st }); }
  const res = await pool(jobs, 8, async j => ({ j, rows: ((await api('getTempoRealParagem', { stop_id: j.st.id })) || {}).data || [] }));
  const found = new Map();
  for (const r of res) if (r) for (const x of r.rows) {
    if (!x.has_real_time_data || x.vehicle_lat == null || !x.trip_id.startsWith(r.j.p.id + '_')) continue;
    const k = x.vehicle_number + '|' + x.trip_id, prev = found.get(k);
    if (!prev || x.eta_seconds > prev.x.eta_seconds) found.set(k, { x, j: r.j }); // a paragem mais longe = destino
  }
  const now = localSec(), tn = Date.now(), out = [];
  for (const { x, j } of found.values()) {
    const p = j.p, tt = await timetable(p.route, p.id, j.l.sid).catch(() => ({})), sched = tt[x.trip_id] || [];
    const idx = p.stops.findIndex(s => s.id === x.last_visited_stop_code), lat = +x.vehicle_lat, lon = +x.vehicle_lon;
    // velocidade estimada entre duas posições diferentes
    let v = veh.get(x.vehicle_number);
    if (!v) veh.set(x.vehicle_number, v = { lat, lon, t: tn, speed: null });
    else { const d = hav(v.lat, v.lon, lat, lon), dt = (tn - v.t) / 1000;
      if (d >= 8 || dt >= 30) { const s = Math.min(d / dt * 3.6, 110); v.speed = v.speed == null ? s : v.speed * .4 + s * .6; Object.assign(v, { lat, lon, t: tn }); } }
    // saída real: instante em que vimos o autocarro passar a 1ª paragem, recuado pelo tempo programado até lá
    let ts = trips.get(x.trip_id); if (!ts) trips.set(x.trip_id, ts = { pass: {}, last: null });
    if (idx >= 0 && ts.last !== idx) { if (ts.last != null && idx > ts.last) ts.pass[idx] = now; ts.last = idx; }
    const dep0 = sched.length ? sched[0][1] : null, obs = Object.keys(ts.pass).map(Number).sort((a, b) => a - b)[0];
    let real = null, kind = null;
    if (obs != null && sched[obs] && dep0 != null) { real = ts.pass[obs] - (sched[obs][1] - dep0); kind = 'observada'; }
    else if (dep0 != null && x.delay_seconds != null) { real = dep0 + x.delay_seconds; kind = 'estimada'; }
    const ls = idx >= 0 ? p.stops[idx] : null;
    out.push({ vehicle: x.vehicle_number, line: x.numero_novo, short: x.line_id, color: '#' + x.route_color, headsign: x.headsign, dir: x.direction_id,
      lat, lon, speed: v.speed == null ? null : Math.round(v.speed), delay: x.delay_seconds, etaDest: x.eta_seconds, schedDest: x.scheduled_time,
      displayDest: x.display_time, destName: j.st.name, destNum: j.st.num, last: ls && { num: ls.num, name: ls.name }, idx, total: p.stops.length,
      depSched: dep0 == null ? null : hms(dep0), depReal: real == null ? null : hms(real), depKind: kind });
  }
  const v = { at: hms(now), vehicles: out.sort((a, b) => a.short.localeCompare(b.short, 'pt', { numeric: true }) || a.vehicle - b.vehicle) };
  vcache.set(key, { t: Date.now(), v }); return v;
}

const stopInfo = async id => (((await api('getTempoRealParagem', { stop_id: id }, 5000)) || {}).data || []).map(x => ({
  line: x.numero_novo, short: x.line_id, color: '#' + x.route_color, headsign: x.headsign, sched: x.scheduled_time, display: x.display_time,
  live: !!x.has_real_time_data, eta: x.eta_seconds ?? null, delay: x.delay_seconds ?? null, vehicle: x.vehicle_number, atStop: !!x.at_stop }));

const J = (b, c = 200) => new Response(JSON.stringify(b), { status: c, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });

export default {
  async fetch(req, env) {
    const u = new URL(req.url), q = Object.fromEntries(u.searchParams);
    try {
      const m = u.pathname.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
      if (m) {
        const r = await fetch(TILES + m[1] + '/' + m[2] + '/' + m[3] + '.png', { headers: UA, cf: { cacheTtl: 86400, cacheEverything: true } });
        if (!r.ok) return new Response('tile ' + r.status, { status: 502 });
        return new Response(r.body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
      }
      if (u.pathname === '/api/lines') return J((await lines()).map(x => ({ id: x.line_short_name, num: x.numero_novo, name: x.nome, color: '#' + x.route_color })));
      if (u.pathname === '/api/line') return J(await lineData(q.line));
      if (u.pathname === '/api/vehicles') return J(await vehicles((q.lines || '').split(',').filter(Boolean)));
      if (u.pathname === '/api/stop') return J(await stopInfo(q.id));
      if (u.pathname.startsWith('/api/')) return J({ error: 'not found' }, 404);
      return env.ASSETS.fetch(req);
    } catch (e) { return J({ error: String(e.message || e) }, 502); }
  }
};
