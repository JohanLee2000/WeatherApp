/* Skycast — forecast data from Open-Meteo (fetched in metric, converted locally),
   radar from RainViewer, US alerts from the National Weather Service. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- storage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('sky.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sky.' + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const usLike = /^en-(US|LR|MM)$/i.test(navigator.language || '');
const settings = Object.assign({
  temp: usLike ? 'fahrenheit' : 'celsius',
  wind: usLike ? 'mph' : 'kmh',
  precip: usLike ? 'inch' : 'mm',
  clock: usLike ? '12' : '24',
}, store.get('settings', {}));

let place = store.get('place', null);   // {name, sub, lat, lon, cc, gps}
let saved = store.get('saved', []);
let wx = null;                           // {data, aq, alerts, ts, key}
let hourlyDay = 0;                       // index into forecast days (0 = today)
let showPast = false;
let tab = 'now';

/* ---------- units ---------- */
const imperial = () => settings.temp === 'fahrenheit';
const T = c => c == null ? null : (imperial() ? c * 9 / 5 + 32 : c);
const t = c => c == null ? '–' : Math.round(T(c)) + '°';
const windConv = { mph: 1 / 1.609344, kmh: 1, ms: 1 / 3.6, kn: 1 / 1.852 };
const windLbl = { mph: 'mph', kmh: 'km/h', ms: 'm/s', kn: 'kn' };
const w = k => k == null ? '–' : Math.round(k * windConv[settings.wind]);
const wu = () => windLbl[settings.wind];
const pr = mm => {
  if (mm == null) return '–';
  if (mm === 0) return settings.precip === 'inch' ? '0 in' : '0 mm';
  if (settings.precip === 'inch') { const v = mm / 25.4; return (v > 0 && v < 0.01 ? '<0.01' : v.toFixed(2)) + ' in'; }
  return (mm > 0 && mm < 0.1 ? '<0.1' : mm.toFixed(1)) + ' mm';
};
const snow = cm => settings.precip === 'inch' ? (cm / 2.54).toFixed(1) + ' in' : cm.toFixed(1) + ' cm';
const vis = m => {
  if (m == null) return '–';
  if (imperial()) { const mi = m / 1609.34; return mi >= 10 ? '10+ mi' : mi.toFixed(1) + ' mi'; }
  const km = m / 1000; return km >= 20 ? '20+ km' : km.toFixed(1) + ' km';
};
const press = h => h == null ? '–' : imperial() ? (h * 0.02953).toFixed(2) + ' inHg' : Math.round(h) + ' hPa';
const card = d => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((d % 360) + 360) % 360 / 22.5) % 16];

/* ---------- time helpers (forecast times are local wall-clock strings) ---------- */
const hh = s => +s.slice(11, 13);
const mm_ = s => +s.slice(14, 16);
function clock(h, m = 0, short = true) {
  if (settings.clock === '24') return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  const ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12;
  return short && m === 0 ? `${h12} ${ap}` : `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}
const hourLbl = s => clock(hh(s), 0);
const timeLbl = s => clock(hh(s), mm_(s), false);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dparts = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }; };
const dateLbl = s => { const p = dparts(s); return `${MON[p.m - 1]} ${p.d}`; };
function nowKey(tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  } catch { return wx.data.current.time; }
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'Just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/* ---------- weather codes & icons ---------- */
const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Rain showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorms', 96: 'Thunderstorms, hail', 99: 'Severe thunderstorms',
};
const desc = (c, day = 1) => (!day && c <= 1) ? (c === 0 ? 'Clear' : 'Mostly clear') : (c === 0 && day ? 'Sunny' : c === 1 && day ? 'Mostly sunny' : WMO[c] || '—');
const isWet = c => c >= 51;

const SUN = '#F5B342', MOON = '#F2D27A', CLOUD = '#D3DCE8', CLOUD2 = '#A9B6C8', DROP = '#4A90E2', FLAKE = '#8FB8E8';
function rays(cx, cy, r1, r2, sw = 3.2) {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, c = Math.cos(a), n = Math.sin(a);
    s += `<line x1="${(cx + c * r1).toFixed(1)}" y1="${(cy + n * r1).toFixed(1)}" x2="${(cx + c * r2).toFixed(1)}" y2="${(cy + n * r2).toFixed(1)}"/>`;
  }
  return `<g stroke="${SUN}" stroke-width="${sw}" stroke-linecap="round">${s}</g>`;
}
const sunFull = `<circle cx="32" cy="32" r="11" fill="${SUN}"/>${rays(32, 32, 16, 23)}`;
const moonPath = `<path d="M36 10A22 22 0 1 0 56 40 17 17 0 0 1 36 10Z" fill="${MOON}"/>`;
const sunSmall = `<circle cx="22" cy="22" r="8" fill="${SUN}"/>${rays(22, 22, 12, 17, 2.6)}`;
const moonSmall = `<g transform="translate(4 3) scale(.55)">${moonPath}</g>`;
const cloud = (fill = CLOUD, dy = 0, dx = 0, s = 1) => `<path transform="translate(${dx} ${dy}) scale(${s})" d="M20 50h26a11 11 0 0 0 2-21.8A15 15 0 0 0 19.5 30 10 10 0 0 0 20 50z" fill="${fill}" stroke="rgba(15,27,45,.10)" stroke-width="1"/>`;
const drops = (n, len = 7) => {
  const xs = n === 3 ? [24, 34, 44] : n === 2 ? [28, 40] : [20, 29, 38, 47];
  return `<g stroke="${DROP}" stroke-width="3" stroke-linecap="round">${xs.map(x => `<line x1="${x}" y1="50" x2="${x - 3}" y2="${50 + len}"/>`).join('')}</g>`;
};
const flakes = `<g fill="${FLAKE}">${[[22, 52], [32, 58], [42, 52], [27, 60], [37, 50]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6"/>`).join('')}</g>`;
function icon(code, day = 1) {
  const sm = day ? sunSmall : moonSmall;
  let b;
  if (code === 0) b = day ? sunFull : moonPath;
  else if (code === 1) b = sm.replace(/translate\(4 3\) scale\(.55\)/, 'translate(2 1) scale(.7)') + cloud(CLOUD, 6, 14, .7);
  else if (code === 2) b = sm + cloud(CLOUD, 4);
  else if (code === 3) b = cloud(CLOUD2, -4, 6, .8) + cloud(CLOUD, 2);
  else if (code === 45 || code === 48) b = cloud(CLOUD, -8) + `<g stroke="${CLOUD2}" stroke-width="3" stroke-linecap="round"><line x1="12" y1="50" x2="52" y2="50"/><line x1="16" y1="57" x2="48" y2="57"/></g>`;
  else if (code >= 51 && code <= 57) b = cloud(CLOUD, -6) + drops(2, 5);
  else if (code === 61 || code === 63 || code === 66) b = cloud(CLOUD2, -6) + drops(3);
  else if (code === 65 || code === 67 || code === 82) b = cloud(CLOUD2, -6) + drops(4, 10);
  else if (code === 80 || code === 81) b = sm + cloud(CLOUD, -4) + drops(3);
  else if (code >= 71 && code <= 77 || code === 85 || code === 86) b = cloud(CLOUD, -6) + flakes;
  else if (code >= 95) b = cloud(CLOUD2, -6) + `<path d="M35 44l-9 11h6l-4 9 12-13h-6l4-7z" fill="${SUN}"/>` + drops(2, 5);
  else b = cloud();
  return `<svg class="w" viewBox="0 0 64 64" aria-hidden="true">${b}</svg>`;
}
const DROP_I = '<svg viewBox="0 0 24 24" class="drop-i"><path d="M12 2.7S5 10.4 5 15a7 7 0 0 0 14 0c0-4.6-7-12.3-7-12.3z" fill="currentColor"/></svg>';
const arrow = deg => `<svg class="compass" viewBox="0 0 24 24" style="transform:rotate(${deg + 180}deg)"><path d="M12 3l5 14-5-3-5 3z" fill="currentColor"/></svg>`;

/* ---------- smooth line for charts ---------- */
function smooth(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/* ---------- network ---------- */
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
const HOURLY = 'temperature_2m,apparent_temperature,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,rain,showers,snowfall,weather_code,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,is_day,pressure_msl';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,sunrise,sunset,daylight_duration,uv_index_max,precipitation_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant';
const CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m';

async function fetchWeather(p) {
  const q = `latitude=${p.lat.toFixed(4)}&longitude=${p.lon.toFixed(4)}`;
  const fc = getJSON(`https://api.open-meteo.com/v1/forecast?${q}&current=${CURRENT}&hourly=${HOURLY}&daily=${DAILY}&minutely_15=precipitation&timezone=auto&past_days=1&forecast_days=10`);
  const aq = getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=us_aqi,european_aqi,pm2_5,pm10,ozone&timezone=auto`).catch(() => null);
  const inUS = p.cc ? p.cc === 'US' : (p.lat > 18 && p.lat < 72 && p.lon > -180 && p.lon < -64);
  const al = inUS ? getJSON(`https://api.weather.gov/alerts/active?point=${p.lat.toFixed(4)},${p.lon.toFixed(4)}`, { headers: { Accept: 'application/geo+json' } })
    .then(j => (j.features || []).map(f => f.properties)).catch(() => []) : Promise.resolve([]);
  const [data, aqd, alerts] = await Promise.all([fc, aq, al]);
  return { data, aq: aqd, alerts, ts: Date.now(), key: placeKey(p) };
}
const placeKey = p => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;

let loading = false;
async function load(force = false) {
  if (!place || loading) return;
  const cached = store.get('cache', null);
  if (!wx && cached && cached.key === placeKey(place)) { wx = cached; renderAll(); }
  if (!force && wx && wx.key === placeKey(place) && Date.now() - wx.ts < 10 * 60000) return;
  loading = true; $('#refreshBtn').classList.add('spin');
  try {
    wx = await fetchWeather(place);
    store.set('cache', wx);
    banner(null);
    renderAll();
  } catch (e) {
    if (wx) banner(`Couldn't refresh — showing data from ${ago(wx.ts).toLowerCase()}. Check your connection and tap refresh.`, true);
    else banner(`Couldn't load the forecast (${esc(e.message)}). Check your connection and tap refresh.`, true);
  } finally {
    loading = false; $('#refreshBtn').classList.remove('spin');
  }
}
function banner(msg, err) {
  const b = $('#banner');
  b.hidden = !msg; b.className = 'banner' + (err ? ' err' : ''); if (msg) b.innerHTML = msg;
}

/* ---------- derived data ---------- */
function ctx() {
  const d = wx.data, H = d.hourly, D = d.daily;
  const nk = nowKey(d.timezone);
  let hi = H.time.findIndex(x => x.slice(0, 13) === nk.slice(0, 13));
  if (hi < 0) hi = H.time.findIndex(x => x.slice(0, 13) === d.current.time.slice(0, 13));
  if (hi < 0) hi = 0;
  let di = D.time.indexOf(nk.slice(0, 10));
  if (di < 0) di = D.time.indexOf(d.current.time.slice(0, 10));
  if (di < 0) di = 0;
  return { d, H, D, hi, di, nk, cur: d.current };
}
const dayHours = (H, date) => H.time.reduce((a, x, i) => (x.startsWith(date) && a.push(i), a), []);

function rainWindows(H, idxs) {
  const wins = []; let s = null;
  idxs.forEach((i, k) => {
    const wet = H.precipitation_probability[i] >= 40 || H.precipitation[i] >= 0.2;
    if (wet && s == null) s = i;
    if ((!wet || k === idxs.length - 1) && s != null) { wins.push([s, wet ? i : idxs[k - 1]]); s = null; }
  });
  return wins;
}
function daySummary(c, dayIdx, fromIdx) {
  const { H, D } = c; const date = D.time[dayIdx];
  const idxs = dayHours(H, date).filter(i => fromIdx == null || i >= fromIdx);
  const parts = [];
  const hiT = D.temperature_2m_max[dayIdx], loT = D.temperature_2m_min[dayIdx];
  if (dayIdx > 0 && D.temperature_2m_max[dayIdx - 1] != null) {
    const diff = Math.round(T(hiT) - T(D.temperature_2m_max[dayIdx - 1]));
    const ref = dayIdx === c.di ? 'yesterday' : dayIdx === c.di + 1 ? 'today' : DOWL[dparts(D.time[dayIdx - 1]).dow];
    parts.push(Math.abs(diff) <= 1 ? `Similar to ${ref}, high ${t(hiT)}, low ${t(loT)}.` : `${Math.abs(diff)}° ${diff > 0 ? 'warmer' : 'cooler'} than ${ref}, high ${t(hiT)}, low ${t(loT)}.`);
  } else parts.push(`High ${t(hiT)}, low ${t(loT)}.`);
  const code = D.weather_code[dayIdx];
  const wins = rainWindows(H, idxs);
  const isSnow = code >= 71 && code <= 86 && code !== 80 && code !== 81 && code !== 82;
  const word = isSnow ? 'Snow' : code >= 95 ? 'Storms' : 'Rain';
  if (wins.length) {
    const [a, b] = wins.reduce((m, x) => (x[1] - x[0] > m[1] - m[0] ? x : m));
    const peak = Math.max(...idxs.map(i => H.precipitation_probability[i] ?? 0));
    const endH = hh(H.time[b]) + 1;
    parts.push(b - a >= 20 ? `${word} likely most of the day (${peak}%).`
      : `${word} likely ${hh(H.time[a]) === hh(H.time[b]) ? 'around ' + hourLbl(H.time[a]) : 'from ' + hourLbl(H.time[a]) + ' to ' + clock(endH % 24)} (up to ${peak}%).`);
  } else {
    const peak = idxs.length ? Math.max(...idxs.map(i => H.precipitation_probability[i] ?? 0)) : 0;
    parts.push(peak >= 20 ? `Slight chance of ${isSnow ? 'snow' : 'showers'} (${peak}%).` : 'No rain expected.');
  }
  const gust = D.wind_gusts_10m_max[dayIdx];
  if (gust >= 45) parts.push(`Windy, gusts to ${w(gust)} ${wu()}.`);
  const uv = D.uv_index_max[dayIdx];
  if (uv >= 8) parts.push(`UV ${uvLabel(uv).toLowerCase()} (${Math.round(uv)}) — wear sunscreen.`);
  return parts.join(' ');
}
function nowcast(c) {
  const M = c.d.minutely_15; if (!M) return '';
  const key = c.nk.slice(0, 14) + String(Math.floor(mm_(c.nk) / 15) * 15).padStart(2, '0');
  let i = M.time.indexOf(key); if (i < 0) return '';
  const next = M.precipitation.slice(i, i + 9); const wet = v => v >= 0.05;
  if (wet(next[0]) || c.cur.precipitation > 0) {
    const stop = next.findIndex(v => !wet(v));
    return stop < 0 ? `${isSnowy(c.cur.weather_code) ? 'Snow' : 'Rain'} continuing for the next 2 hours` : `${isSnowy(c.cur.weather_code) ? 'Snow' : 'Rain'} stopping in about ${Math.max(15, stop * 15)} min`;
  }
  const start = next.findIndex(wet);
  return start > 0 ? `Rain starting in about ${start * 15} min` : '';
}
const isSnowy = c => (c >= 71 && c <= 77) || c === 85 || c === 86;
const uvLabel = u => u < 3 ? 'Low' : u < 6 ? 'Moderate' : u < 8 ? 'High' : u < 11 ? 'Very high' : 'Extreme';
const aqiLabel = a => a <= 50 ? 'Good' : a <= 100 ? 'Moderate' : a <= 150 ? 'Unhealthy for sensitive groups' : a <= 200 ? 'Unhealthy' : a <= 300 ? 'Very unhealthy' : 'Hazardous';
const dur = s => `${Math.floor(s / 3600)}h ${Math.round(s % 3600 / 60)}m`;

/* ---------- render ---------- */
function renderAll() {
  if (!wx) return;
  $('#locName').textContent = place.name;
  $('#updated').textContent = ago(wx.ts);
  const c = ctx();
  renderHero(c); renderAlerts(); renderStrip(c); renderWeekCompact(c); renderDetails(c);
  renderHourly(c); renderWeek(c);
  if (map) { placeMarker(); if (mapMode !== 'radar') loadGrid(true); }
}

function renderHero(c) {
  const { cur, D, di } = c;
  const el = $('#hero');
  el.className = 'hero' + (!cur.is_day ? ' night' : isWet(cur.weather_code) || cur.weather_code === 3 ? ' rainy' : '');
  const nc = nowcast(c);
  const late = hh(c.nk) >= 19;
  const sumTxt = late ? `<b>Tomorrow:</b> ${esc(daySummary(c, di + 1))}` : `<b>Today:</b> ${esc(daySummary(c, di, c.hi))}`;
  el.innerHTML = `
    <div class="row1">
      <div>
        <div class="temp num">${Math.round(T(cur.temperature_2m))}<sup>°${imperial() ? 'F' : 'C'}</sup></div>
        <div class="cond">${esc(desc(cur.weather_code, cur.is_day))}</div>
        <div class="sub num">Feels like ${t(cur.apparent_temperature)} · H ${t(D.temperature_2m_max[di])} · L ${t(D.temperature_2m_min[di])}</div>
      </div>
      <div class="wx-ico">${icon(cur.weather_code, cur.is_day).replace('class="w"', 'width="104" height="104"')}</div>
    </div>
    ${nc ? `<div class="nowcast">☂ ${esc(nc)}</div>` : ''}
    <div class="summary">${sumTxt}</div>`;
}

function renderAlerts() {
  const el = $('#alerts');
  const list = (wx.alerts || []).filter(a => a && a.event);
  el.innerHTML = list.map(a => {
    const sev = /Extreme|Severe/.test(a.severity) ? ' severe' : '';
    const ends = a.ends || a.expires;
    const endTxt = ends ? `Until ${new Date(ends).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
    return `<details class="alert${sev}"><summary><span>⚠</span><span>${esc(a.event)}<small>${esc(endTxt)}</small></span></summary>
      <p>${esc(a.headline || '')}\n\n${esc(a.description || '')}${a.instruction ? '\n\n' + esc(a.instruction) : ''}</p></details>`;
  }).join('');
}

function stripHTML(H, idxs, opts = {}) {
  const W = 58, n = idxs.length, h = 46;
  const temps = idxs.map(i => T(H.temperature_2m[i]));
  const mn = Math.min(...temps), mx = Math.max(...temps), span = Math.max(mx - mn, 4);
  const pts = temps.map((v, k) => [k * W + W / 2, 40 - (v - mn) / span * 20]);
  const svg = `<svg class="curve" width="${n * W}" height="${h}" viewBox="0 0 ${n * W} ${h}">
    <path d="${smooth(pts)}" fill="none" stroke="var(--sun)" stroke-width="2.5" stroke-linecap="round"/>
    ${pts.map(([x, y], k) => `<circle cx="${x}" cy="${y}" r="3" fill="var(--surface)" stroke="var(--sun)" stroke-width="2"/><text x="${x}" y="${y - 9}" text-anchor="middle" style="fill:var(--ink);font:600 13px var(--body)">${Math.round(temps[k])}°</text>`).join('')}
  </svg>`;
  const row = f => `<div class="strip">${idxs.map((i, k) => f(i, k)).join('')}</div>`;
  return `<div class="strip-temps">
    ${row((i, k) => `<div class="hr${k === 0 && opts.now ? ' now' : ''}"><span class="t">${k === 0 && opts.now ? 'Now' : hourLbl(H.time[i])}</span></div>`)}
    ${row(i => `<div class="hr">${icon(H.weather_code[i], H.is_day[i])}</div>`)}
    ${svg}
    ${row(i => { const p = H.precipitation_probability[i] ?? 0; return `<div class="hr"><span class="pop${p < 10 ? ' lo' : ''}">${DROP_I}${p}%</span></div>`; })}
    ${row(i => `<div class="hr"><span class="t num">${H.relative_humidity_2m[i]}% RH</span></div>`)}
    ${row(i => `<div class="hr"><span class="t num">${w(H.wind_speed_10m[i])} ${wu()}</span></div>`)}
  </div>`;
}
function renderStrip(c) {
  const idxs = []; for (let i = c.hi; i < Math.min(c.hi + 25, c.H.time.length); i++) idxs.push(i);
  $('#nowStrip').innerHTML = stripHTML(c.H, idxs, { now: true });
}

function weekRows(c, count = 10) {
  const { D, di, cur } = c;
  const days = []; for (let i = di; i < Math.min(di + count, D.time.length); i++) days.push(i);
  const mn = Math.min(...days.map(i => D.temperature_2m_min[i])), mx = Math.max(...days.map(i => D.temperature_2m_max[i]));
  const sp = Math.max(mx - mn, 1);
  return days.map(i => {
    const lo = D.temperature_2m_min[i], hi = D.temperature_2m_max[i];
    const p = D.precipitation_probability_max[i] ?? 0;
    const dot = i === di ? `<b style="left:${((Math.min(Math.max(cur.temperature_2m, lo), hi) - mn) / sp * 100).toFixed(1)}%"></b>` : '';
    return `<div class="wk-row" data-day="${i - di}" role="button" tabindex="0">
      <span class="d">${i === di ? 'Today' : DOW[dparts(D.time[i]).dow]}</span>
      ${icon(D.weather_code[i], 1)}
      <span class="p">${p >= 10 ? p + '%' : ''}</span>
      <span class="lo">${t(lo)}</span>
      <span class="range"><i style="left:${((lo - mn) / sp * 100).toFixed(1)}%;right:${((mx - hi) / sp * 100).toFixed(1)}%"></i>${dot}</span>
      <span class="hi">${t(hi)}</span>
    </div>`;
  }).join('');
}
function renderWeekCompact(c) { $('#nowWeek').innerHTML = weekRows(c); }

function tile(k, v, n = '', extra = '') { return `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${n ? `<div class="n">${n}</div>` : ''}${extra}</div>`; }
function renderDetails(c) {
  const { cur, H, hi, D, di } = c;
  const uv = H.uv_index[hi] ?? 0;
  const aqi = wx.aq?.current?.us_aqi;
  const todayIdx = dayHours(H, D.time[di]);
  const restPop = Math.max(0, ...todayIdx.filter(i => i >= hi).map(i => H.precipitation_probability[i] ?? 0));
  const sr = D.sunrise[di], ss = D.sunset[di];
  const sunTxt = c.nk < sr ? `Sunrise ${timeLbl(sr)}` : c.nk < ss ? `Sunset ${timeLbl(ss)}` : `Sunrise ${timeLbl(D.sunrise[di + 1] || sr)}`;
  const snowToday = D.snowfall_sum[di];
  $('#details').innerHTML = [
    tile('Humidity', `${cur.relative_humidity_2m}%`, `Dew point ${t(H.dew_point_2m[hi])}`),
    tile('Wind', `${w(cur.wind_speed_10m)} <small>${wu()}</small>`, `${arrow(cur.wind_direction_10m)} ${card(cur.wind_direction_10m)} · gusts ${w(cur.wind_gusts_10m)}`),
    tile('Rain chance', `${restPop}%`, `Rest of today`),
    tile('Rain today', pr(D.precipitation_sum[di]), snowToday > 0 ? `Snow ${snow(snowToday)}` : `${D.precipitation_hours[di]} h of precipitation`),
    tile('UV index', `${Math.round(uv)}`, `${uvLabel(uv)} · max ${Math.round(D.uv_index_max[di])}`, `<div class="meter"><b style="left:${Math.min(uv / 11, 1) * 100}%"></b></div>`),
    aqi != null ? tile('Air quality', `${aqi}`, `${aqiLabel(aqi)} · PM2.5 ${Math.round(wx.aq.current.pm2_5)}`, `<div class="meter"><b style="left:${Math.min(aqi / 300, 1) * 100}%"></b></div>`) : '',
    tile('Sun', sunTxt.split(' ').slice(1).join(' '), `${sunTxt.split(' ')[0]} · ${dur(D.daylight_duration[di])} daylight`),
    tile('Pressure', press(cur.pressure_msl), pressureTrend(H, hi)),
    tile('Visibility', vis(H.visibility[hi]), H.visibility[hi] < 1000 ? 'Poor — drive carefully' : H.visibility[hi] < 5000 ? 'Reduced' : 'Clear view'),
    tile('Cloud cover', `${cur.cloud_cover}%`, cur.cloud_cover < 20 ? 'Clear skies' : cur.cloud_cover < 60 ? 'Some clouds' : 'Mostly cloudy'),
  ].join('');
}
function pressureTrend(H, hi) {
  const a = H.pressure_msl[Math.max(0, hi - 3)], b = H.pressure_msl[hi];
  if (a == null || b == null) return '';
  const d = b - a; return d > 1 ? 'Rising' : d < -1 ? 'Falling' : 'Steady';
}

/* Hourly tab */
function renderHourly(c) {
  const { D, di, H, hi } = c;
  const nDays = D.time.length - di;
  hourlyDay = Math.min(hourlyDay, nDays - 1);
  $('#dayChips').innerHTML = Array.from({ length: nDays }, (_, k) => {
    const i = di + k, p = dparts(D.time[i]);
    return `<button class="chip${k === hourlyDay ? ' on' : ''}" data-hday="${k}">${k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : DOW[p.dow]}<small>${MON[p.m - 1]} ${p.d}</small></button>`;
  }).join('');
  const date = D.time[di + hourlyDay];
  const idxs = dayHours(H, date);
  // chart
  const CW = 40, n = idxs.length, Wd = n * CW, Ht = 190;
  const temps = idxs.map(i => T(H.temperature_2m[i])), feels = idxs.map(i => T(H.apparent_temperature[i]));
  const mn = Math.min(...temps, ...feels), mx = Math.max(...temps, ...feels), sp = Math.max(mx - mn, 4);
  const y = v => 104 - (v - mn) / sp * 76;
  const tp = temps.map((v, k) => [k * CW + CW / 2, y(v)]), fp = feels.map((v, k) => [k * CW + CW / 2, y(v)]);
  const bars = idxs.map((i, k) => { const p = H.precipitation_probability[i] ?? 0, bh = p / 100 * 44; return `<rect x="${k * CW + 8}" y="${160 - bh}" width="${CW - 16}" height="${bh}" rx="3" fill="var(--rain)" opacity=".75"/>${p >= 10 ? `<text x="${k * CW + CW / 2}" y="${154 - bh}" text-anchor="middle" style="fill:var(--rain)">${p}</text>` : ''}`; }).join('');
  const nowX = hourlyDay === 0 && idxs.includes(hi) ? (idxs.indexOf(hi) * CW + CW / 2) : null;
  $('#hourChart').innerHTML = `<svg width="${Wd}" height="${Ht}" viewBox="0 0 ${Wd} ${Ht}">
    <line x1="0" x2="${Wd}" y1="160" y2="160" stroke="var(--line)"/>
    ${nowX != null ? `<line x1="${nowX}" x2="${nowX}" y1="10" y2="160" stroke="var(--rain)" stroke-dasharray="3 3"/>` : ''}
    ${bars}
    <path d="${smooth(fp)}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 4"/>
    <path d="${smooth(tp)}" fill="none" stroke="var(--sun)" stroke-width="2.5"/>
    ${tp.map(([x, yy], k) => k % 2 === 0 ? `<text x="${x}" y="${yy - 8}" text-anchor="middle" style="fill:var(--ink);font-weight:600">${Math.round(temps[k])}°</text>` : '').join('')}
    ${idxs.map((i, k) => k % 2 === 0 ? `<text x="${k * CW + CW / 2}" y="178" text-anchor="middle">${hourLbl(H.time[i])}</text>` : '').join('')}
  </svg>
  <div class="chart-legend"><span><i style="background:var(--sun)"></i>Temperature</span><span><i style="background:var(--muted)"></i>Feels like</span><span><i style="background:var(--rain)"></i>Chance of rain %</span></div>`;
  // table
  const hidePast = hourlyDay === 0 && !showPast && idxs.includes(hi) && idxs[0] < hi;
  const tIdxs = hidePast ? idxs.filter(i => i >= hi) : idxs;
  const rows = (hidePast ? `<tr><td colspan="14" style="text-align:left"><button class="link" id="showPast">Show earlier hours ›</button></td></tr>` : '') + tIdxs.map(i => {
    const cls = hourlyDay === 0 ? (i < hi ? 'past' : i === hi ? 'now' : '') : '';
    const sn = H.snowfall[i];
    return `<tr class="${cls}" ${i === hi ? 'id="nowRow"' : ''}>
      <td>${i === hi ? '<b>Now</b>' : hourLbl(H.time[i])}</td>
      <td class="c">${icon(H.weather_code[i], H.is_day[i])}${esc(desc(H.weather_code[i], H.is_day[i]))}</td>
      <td class="temp">${t(H.temperature_2m[i])}</td>
      <td>${t(H.apparent_temperature[i])}</td>
      <td class="pop">${H.precipitation_probability[i] ?? 0}%</td>
      <td>${sn > 0 ? snow(sn) + ' snow' : pr(H.precipitation[i])}</td>
      <td>${H.relative_humidity_2m[i]}%</td>
      <td>${t(H.dew_point_2m[i])}</td>
      <td>${arrow(H.wind_direction_10m[i])} ${card(H.wind_direction_10m[i])} ${w(H.wind_speed_10m[i])}</td>
      <td>${w(H.wind_gusts_10m[i])}</td>
      <td>${Math.round(H.uv_index[i] ?? 0)}</td>
      <td>${H.cloud_cover[i]}%</td>
      <td>${vis(H.visibility[i])}</td>
      <td>${press(H.pressure_msl[i])}</td>
    </tr>`;
  }).join('');
  $('#hourTable').innerHTML = `<thead><tr><th>Time</th><th style="text-align:left">Conditions</th><th>Temp</th><th>Feels</th><th>Rain</th><th>Amount</th><th>Humidity</th><th>Dew pt</th><th>Wind ${wu()}</th><th>Gusts</th><th>UV</th><th>Clouds</th><th>Visibility</th><th>Pressure</th></tr></thead><tbody>${rows}</tbody>`;
}

/* Week tab */
function renderWeek(c) {
  const { D, di, H } = c;
  const out = [];
  for (let i = di; i < D.time.length; i++) {
    const p = dparts(D.time[i]), k = i - di;
    const name = k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : DOWL[p.dow];
    const idxs = dayHours(H, D.time[i]).filter((_, j) => j % 3 === 0);
    const sn = D.snowfall_sum[i];
    out.push(`<details class="day-card" data-wday="${k}" ${k === 0 ? 'open' : ''}>
      <summary>
        <span class="dname">${name}<small>${MON[p.m - 1]} ${p.d}</small></span>
        <span class="dright">${icon(D.weather_code[i], 1)}<span class="dtemps"><b>${t(D.temperature_2m_max[i])}</b><span>${t(D.temperature_2m_min[i])}</span></span></span>
        <span class="dcond">${esc(desc(D.weather_code[i], 1))}</span>
        <span class="dpop">${DROP_I}${D.precipitation_probability_max[i] ?? 0}% <span>${pr(D.precipitation_sum[i])}</span> <span>${arrow(D.wind_direction_10m_dominant[i])} ${w(D.wind_speed_10m_max[i])} ${wu()}</span></span>
      </summary>
      <div class="day-body">
        <p style="margin:0">${esc(daySummary(c, i, k === 0 ? c.hi : null))}</p>
        <div class="strip-wrap">${stripHTML(H, idxs)}</div>
        <div class="details">
          ${tile('Feels like', `${t(D.apparent_temperature_max[i])}`, `Low ${t(D.apparent_temperature_min[i])}`)}
          ${tile('Precip', pr(D.precipitation_sum[i]), sn > 0 ? `Snow ${snow(sn)}` : `${D.precipitation_hours[i]} h`)}
          ${tile('Wind', `${w(D.wind_speed_10m_max[i])}`, `Gusts ${w(D.wind_gusts_10m_max[i])} ${wu()}`)}
          ${tile('UV max', `${Math.round(D.uv_index_max[i] ?? 0)}`, uvLabel(D.uv_index_max[i] ?? 0))}
          ${tile('Sunrise', timeLbl(D.sunrise[i]))}
          ${tile('Sunset', timeLbl(D.sunset[i]), dur(D.daylight_duration[i]))}
        </div>
        <button class="link open-hourly" data-goto-day="${k}">Hour-by-hour for ${name} ›</button>
      </div>
    </details>`);
  }
  $('#weekList').className = 'week-list';
  $('#weekList').innerHTML = out.join('');
}

/* ---------- tabs ---------- */
function show(name) {
  tab = name;
  $$('.view').forEach(v => v.hidden = v.dataset.view !== name);
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === 'radar') initMap();
  else stopPlay();
  if (name === 'hourly') requestAnimationFrame(() => {
    const cw = $('#hourChart'); if (hourlyDay === 0 && wx) { const c = ctx(); const k = dayHours(c.H, c.D.time[c.di]).indexOf(c.hi); cw.scrollLeft = Math.max(0, k * 40 - 60); }
  });
  try { history.replaceState(null, '', '#' + name); } catch { }
}
$('#tabbar').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.tab); });
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]'); if (g) { show(g.dataset.goto); return; }
  const gd = e.target.closest('[data-goto-day]'); if (gd) { hourlyDay = +gd.dataset.gotoDay; renderHourly(ctx()); show('hourly'); return; }
  const wr = e.target.closest('.wk-row'); if (wr) { openWeekDay(+wr.dataset.day); return; }
  if (e.target.closest('#showPast')) { showPast = true; renderHourly(ctx()); return; }
  const ch = e.target.closest('[data-hday]'); if (ch) { hourlyDay = +ch.dataset.hday; renderHourly(ctx()); if (hourlyDay === 0) show('hourly'); }
});
function openWeekDay(k) {
  show('week');
  $$('.day-card').forEach(d => d.open = +d.dataset.wday === k);
  const el = $(`.day-card[data-wday="${k}"]`); if (el) el.scrollIntoView({ block: 'start' });
  window.scrollBy(0, -64);
}

/* ---------- location sheet ---------- */
function openSheet() {
  $('#sheet').hidden = false; $('#sheetBackdrop').hidden = false;
  renderSaved(); $('#searchResults').innerHTML = '';
  ['Temp', 'Wind', 'Precip', 'Clock'].forEach(k => $('#set' + k).value = settings[k.toLowerCase()]);
}
function closeSheet() { $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true; $('#searchInput').value = ''; }
$('#locBtn').addEventListener('click', openSheet);
$('#sheetBackdrop').addEventListener('click', closeSheet);
$('#refreshBtn').addEventListener('click', () => load(true));

const isSaved = p => saved.some(s => placeKey(s) === placeKey(p));
function placeRow(p, i, from) {
  const cur = place && placeKey(p) === placeKey(place);
  return `<div class="place">
    <button class="pick${cur ? ' cur' : ''}" data-pick="${from}:${i}">${esc(p.name)}<small>${esc(p.sub || '')}</small></button>
    <span class="ptemp" data-ptemp="${placeKey(p)}"></span>
    <button class="star${isSaved(p) ? ' on' : ''}" data-star="${from}:${i}" aria-label="${isSaved(p) ? 'Remove from saved' : 'Save place'}">${isSaved(p) ? '★' : '☆'}</button>
  </div>`;
}
let results = [];
function renderSaved() {
  const el = $('#savedList');
  el.innerHTML = saved.length ? saved.map((p, i) => placeRow(p, i, 's')).join('') : '<div class="empty">Tap ☆ next to a place to save it here.</div>';
  if (saved.length) {
    getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${saved.map(p => p.lat.toFixed(3)).join(',')}&longitude=${saved.map(p => p.lon.toFixed(3)).join(',')}&current=temperature_2m,weather_code,is_day`)
      .then(j => { const arr = Array.isArray(j) ? j : [j]; arr.forEach((r, i) => { const s = $(`[data-ptemp="${placeKey(saved[i])}"]`, el); if (s) s.innerHTML = t(r.current.temperature_2m); }); })
      .catch(() => { });
  }
}
$('#sheet').addEventListener('click', e => {
  const pk = e.target.closest('[data-pick]');
  if (pk) { const [f, i] = pk.dataset.pick.split(':'); setPlace((f === 's' ? saved : results)[+i]); closeSheet(); return; }
  const st = e.target.closest('[data-star]');
  if (st) {
    const [f, i] = st.dataset.star.split(':'); const p = (f === 's' ? saved : results)[+i];
    saved = isSaved(p) ? saved.filter(s => placeKey(s) !== placeKey(p)) : [...saved, { ...p, gps: false }];
    store.set('saved', saved); renderSaved(); renderResults();
  }
});
function renderResults() {
  $('#searchResults').innerHTML = results.length ? '<h3 class="sheet-h">Results</h3>' + results.map((p, i) => placeRow(p, i, 'r')).join('') : '';
}
let searchT;
$('#searchInput').addEventListener('input', e => { clearTimeout(searchT); searchT = setTimeout(() => search(e.target.value), 300); });
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); search($('#searchInput').value); $('#searchInput').blur(); });
async function search(q) {
  q = q.trim(); if (q.length < 2) { results = []; renderResults(); return; }
  try {
    if (/^\d{5}$/.test(q)) {
      const j = await getJSON(`https://api.zippopotam.us/us/${q}`).catch(() => null);
      if (j && j.places) { results = j.places.map(p => ({ name: p['place name'], sub: `${p['state abbreviation']} ${q}, United States`, lat: +p.latitude, lon: +p.longitude, cc: 'US' })); renderResults(); return; }
    }
    const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=en&format=json`);
    results = (j.results || []).map(r => ({ name: r.name, sub: [r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude, cc: r.country_code }));
    renderResults();
    if (!results.length) $('#searchResults').innerHTML = '<div class="empty">No places found. Try a city name, or a 5-digit US ZIP code.</div>';
  } catch { $('#searchResults').innerHTML = '<div class="empty">Search is unavailable offline. Check your connection.</div>'; }
}
$('#gpsBtn').addEventListener('click', () => { closeSheet(); locate(true); });

function locate(userAsked) {
  if (!navigator.geolocation) { if (userAsked) banner('Location isn’t available in this browser. Search for your city instead.', true); else openSheet(); return; }
  banner('Finding your location…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    let name = 'My location', sub = '', cc = '';
    try {
      const r = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      name = r.city || r.locality || name; sub = [r.principalSubdivision, r.countryName].filter(Boolean).join(', '); cc = r.countryCode || '';
    } catch { }
    banner(null);
    const near = place?.gps && Math.hypot(place.lat - lat, (place.lon - lon) * Math.cos(lat * Math.PI / 180)) < 0.02;
    if (near) { place = { ...place, lat, lon }; store.set('place', place); load(); }
    else setPlace({ name, sub, lat, lon, cc, gps: true });
  }, err => {
    banner(err.code === 1 ? 'Location permission is off. Allow location for this site in your browser settings, or tap the place name above to search.' : 'Couldn’t get your location. Tap the place name above to search.', true);
    if (!place) openSheet();
  }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 10 * 60000 });
}
function setPlace(p) {
  place = p; store.set('place', p); wx = null; hourlyDay = 0;
  $('#locName').textContent = p.name;
  skeleton(); load(true);
  if (map) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 6));
}
function skeleton() {
  $('#hero').className = 'hero'; $('#hero').innerHTML = '<div style="height:170px"></div>';
  ['#nowStrip', '#nowWeek', '#details'].forEach(s => $(s).innerHTML = '<div class="skel" style="height:120px"></div>');
}

['Temp', 'Wind', 'Precip', 'Clock'].forEach(k => $('#set' + k).addEventListener('change', e => {
  settings[k.toLowerCase()] = e.target.value; store.set('settings', settings); renderAll(); renderSaved();
}));

/* ---------- map ---------- */
let map, baseLayer, labelLayer, marker, mapMode = 'radar', radarFrames = [], radarLayers = [], frameIdx = 0, playTimer = null;
let grid = null, gridLayer = null, gridIdx = 0, gridKey = '';
const dark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
  if (typeof L === 'undefined') { $('#map').innerHTML = '<div class="map-loading">Map needs an internet connection.</div>'; return; }
  const c = place || { lat: 39.5, lon: -98.35 };
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([c.lat, c.lon], 7);
  L.control.zoom({ position: 'topright' }).addTo(map);
  map.createPane('labels'); map.getPane('labels').style.zIndex = 450; map.getPane('labels').style.pointerEvents = 'none';
  setBase();
  placeMarker();
  map.on('moveend', () => { if (mapMode !== 'radar') loadGrid(); });
  loadRadar();
  setInterval(() => { if (tab === 'radar' && mapMode === 'radar' && !playTimer) loadRadar(); }, 10 * 60000);
  setTimeout(() => map.invalidateSize(), 50);
}
function setBase() {
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) map.removeLayer(labelLayer);
  const v = dark() ? 'Dark' : 'Light';
  const esri = n => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${v}_Gray_${n}/MapServer/tile/{z}/{y}/{x}`;
  baseLayer = L.tileLayer(esri('Base'), { maxZoom: 12, attribution: 'Tiles © Esri, HERE, Garmin, © OpenStreetMap · Radar © RainViewer' }).addTo(map);
  labelLayer = L.tileLayer(esri('Reference'), { maxZoom: 12, pane: 'labels' }).addTo(map);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => map && setBase());
function placeMarker() {
  if (!map || !place) return;
  const ll = [place.lat, place.lon];
  if (marker) marker.setLatLng(ll);
  else marker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="you-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
}

async function loadRadar() {
  try {
    const j = await getJSON('https://api.rainviewer.com/public/weather-maps.json');
    const frames = [...(j.radar.past || []), ...(j.radar.nowcast || [])];
    radarLayers.forEach(l => map.removeLayer(l));
    radarFrames = frames; radarLayers = frames.map(f => L.tileLayer(`${j.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 12, zIndex: 300 }));
    if (mapMode === 'radar') { radarLayers.forEach(l => l.addTo(map)); setupSlider(); showFrame(frames.length - 1); }
  } catch { $('#timeLabel').textContent = 'Radar offline'; }
}
function showFrame(i) {
  if (!radarLayers.length) return;
  frameIdx = (i + radarLayers.length) % radarLayers.length;
  radarLayers.forEach((l, k) => l.setOpacity(k === frameIdx ? .75 : 0));
  $('#timeSlider').value = frameIdx;
  const f = radarFrames[frameIdx], mins = Math.round((f.time * 1000 - Date.now()) / 60000);
  const tz = wx?.data?.timezone;
  let tl; try { tl = new Date(f.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: settings.clock === '12', timeZone: tz }); } catch { tl = new Date(f.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  $('#timeLabel').textContent = `${tl} ${Math.abs(mins) < 6 ? '· now' : `· ${mins < 0 ? '' : '+'}${mins}m`}`;
}
function setupSlider() {
  const s = $('#timeSlider');
  if (mapMode === 'radar') { s.max = Math.max(0, radarLayers.length - 1); s.value = frameIdx; }
  else { s.max = grid ? grid.hours.length - 1 : 0; s.value = gridIdx; }
  renderLegend();
}
$('#timeSlider').addEventListener('input', e => { stopPlay(); mapMode === 'radar' ? showFrame(+e.target.value) : showGridHour(+e.target.value); });
$('#playBtn').addEventListener('click', () => playTimer ? stopPlay() : startPlay());
function startPlay() {
  $('#playIco').innerHTML = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';
  const step = () => {
    if (mapMode === 'radar') { showFrame(frameIdx + 1); playTimer = setTimeout(step, frameIdx === radarLayers.length - 1 ? 1500 : 450); }
    else { showGridHour((gridIdx + 1) % (grid?.hours.length || 1)); playTimer = setTimeout(step, 600); }
  };
  step();
}
function stopPlay() { clearTimeout(playTimer); playTimer = null; $('#playIco').innerHTML = '<path d="M8 5v14l11-7z"/>'; }

$('#mapMode').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.mode === mapMode) return;
  stopPlay(); mapMode = b.dataset.mode;
  $$('#mapMode button').forEach(x => x.classList.toggle('on', x === b));
  if (mapMode === 'radar') {
    if (gridLayer) map.removeLayer(gridLayer);
    radarLayers.forEach(l => l.addTo(map)); setupSlider(); showFrame(frameIdx);
  } else {
    radarLayers.forEach(l => map.removeLayer(l));
    if (grid) { setupSlider(); showGridHour(gridIdx); }
    loadGrid();
  }
});

/* Forecast grid: an 8×8 lattice of Open-Meteo point forecasts across the visible map */
const GN = 8;
async function loadGrid(force) {
  if (!map || mapMode === 'radar') return;
  const b = map.getBounds(), z = map.getZoom();
  const key = `${z}:${b.getCenter().lat.toFixed(1)},${b.getCenter().lng.toFixed(1)}`;
  if (!force && key === gridKey && grid) { showGridHour(gridIdx); return; }
  gridKey = key;
  const s = b.getSouth(), n = b.getNorth(), wv = b.getWest(), e = b.getEast();
  const dLat = (n - s) / GN, dLon = (e - wv) / GN;
  const lats = [], lons = [];
  for (let r = 0; r < GN; r++) for (let c = 0; c < GN; c++) { lats.push((s + dLat * (r + .5)).toFixed(3)); lons.push((((wv + dLon * (c + .5)) + 540) % 360 - 180).toFixed(3)); }
  const tz = wx?.data?.timezone || 'auto';
  const lbl = document.createElement('div'); lbl.className = 'map-loading'; lbl.textContent = 'Loading area forecast…'; $('#view-radar').appendChild(lbl);
  try {
    const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&hourly=temperature_2m,precipitation_probability,precipitation&forecast_days=3&timezone=${encodeURIComponent(tz === 'auto' ? 'auto' : tz)}`);
    if (key !== gridKey) return;
    const arr = Array.isArray(j) ? j : [j];
    const times = arr[0].hourly.time;
    const nk = wx ? nowKey(wx.data.timezone).slice(0, 13) : times[0].slice(0, 13);
    let start = times.findIndex(x => x.slice(0, 13) === nk); if (start < 0) start = 0;
    const hours = times.slice(start, start + 48);
    grid = { s, wv, dLat, dLon, hours, start, cells: arr.map(r => r.hourly) };
    gridIdx = Math.min(gridIdx, hours.length - 1);
    setupSlider(); showGridHour(gridIdx);
  } catch { $('#timeLabel').textContent = 'Area forecast offline'; }
  finally { lbl.remove(); }
}
const SCALES = {
  rain: { stops: [[0, 'rgba(90,162,255,0)'], [20, 'rgba(90,162,255,.15)'], [40, 'rgba(60,130,240,.4)'], [60, 'rgba(40,100,230,.55)'], [80, 'rgba(30,70,200,.68)'], [100, 'rgba(60,30,170,.8)']], lbl: ['0%', '50%', '100%'], unit: '%' },
  precip: { stops: [[0, 'rgba(0,0,0,0)'], [0.1, 'rgba(120,220,120,.5)'], [1, 'rgba(40,170,60,.65)'], [2.5, 'rgba(250,210,40,.7)'], [5, 'rgba(250,130,30,.75)'], [10, 'rgba(220,40,40,.8)'], [20, 'rgba(160,40,160,.85)']], lbl: ['Light', 'Moderate', 'Heavy'] },
  temp: { stops: [[-20, 'rgba(120,60,200,.55)'], [-5, 'rgba(60,110,230,.55)'], [5, 'rgba(70,180,230,.5)'], [15, 'rgba(110,200,120,.5)'], [22, 'rgba(240,210,70,.55)'], [30, 'rgba(245,140,50,.6)'], [38, 'rgba(220,50,50,.65)']], lbl: [] },
};
function scaleColor(stops, v) {
  if (v == null) return 'rgba(0,0,0,0)';
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) {
    const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (v - a) / (b - a);
    const pa = ca.match(/[\d.]+/g).map(Number), pb = cb.match(/[\d.]+/g).map(Number);
    const m = pa.map((x, k) => x + (pb[k] - x) * f);
    return `rgba(${m[0] | 0},${m[1] | 0},${m[2] | 0},${m[3].toFixed(2)})`;
  }
  return stops[stops.length - 1][1];
}
function showGridHour(i) {
  if (!grid || !map) return;
  gridIdx = Math.max(0, Math.min(i, grid.hours.length - 1));
  $('#timeSlider').value = gridIdx;
  const hIdx = grid.start + gridIdx, ts = grid.hours[gridIdx];
  const p = dparts(ts);
  $('#timeLabel').textContent = `${gridIdx === 0 ? 'Now' : DOW[p.dow]} ${hourLbl(ts)}`;
  if (gridLayer) map.removeLayer(gridLayer);
  gridLayer = L.layerGroup();
  const sc = SCALES[mapMode];
  const showLabels = true;
  grid.cells.forEach((h, k) => {
    const r = Math.floor(k / GN), c = k % GN;
    const s = grid.s + r * grid.dLat, wv = grid.wv + c * grid.dLon;
    const v = mapMode === 'rain' ? h.precipitation_probability[hIdx] : mapMode === 'precip' ? h.precipitation[hIdx] : h.temperature_2m[hIdx];
    L.rectangle([[s, wv], [s + grid.dLat, wv + grid.dLon]], { stroke: false, fillColor: scaleColor(sc.stops, v), fillOpacity: 1, interactive: false }).addTo(gridLayer);
    if (showLabels && v != null) {
      const txt = mapMode === 'rain' ? `${v}%` : mapMode === 'precip' ? (v > 0 ? pr(v).replace(' in', '″').replace(' mm', '') : '') : `${Math.round(T(v))}°`;
      if (txt) L.marker([s + grid.dLat / 2, wv + grid.dLon / 2], { icon: L.divIcon({ className: 'grid-label', html: txt, iconSize: [48, 16], iconAnchor: [24, 8] }), interactive: false }).addTo(gridLayer);
    }
  });
  gridLayer.addTo(map);
}
function renderLegend() {
  const el = $('#legend');
  if (mapMode === 'radar') { el.innerHTML = `<span>Light</span><span class="bar" style="background:linear-gradient(90deg,#cec087,#88ddee,#00a3e0,#007fb4,#ffee00,#ffaa00,#ff4400,#c10000,#ff77ff)"></span><span>Heavy</span><span class="snow-key"></span><span>Snow</span>`; return; }
  const sc = SCALES[mapMode];
  const g = sc.stops.map(([, c]) => c.replace(/,[\d.]+\)$/, ',1)')).join(',');
  const ends = mapMode === 'temp' ? [t(sc.stops[0][0]), t(sc.stops[sc.stops.length - 1][0])] : mapMode === 'rain' ? ['0%', '100%'] : ['Light', 'Heavy'];
  el.innerHTML = `<span>${ends[0]}</span><span class="bar" style="background:linear-gradient(90deg,${g})"></span><span>${ends[1]}</span><span>· next 48 h</span>`;
}

/* ---------- lifecycle ---------- */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (wx) { $('#updated').textContent = ago(wx.ts); renderAll(); }
    if (place?.gps && wx && Date.now() - wx.ts > 30 * 60000) locate(false); else load();
  }
});
setInterval(() => { if (document.visibilityState === 'visible') { if (wx) $('#updated').textContent = ago(wx.ts); load(); } }, 60000);

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $('#installBtn').hidden = true; });
if (matchMedia('(display-mode: standalone)').matches) $('#installHint').hidden = true;

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });

// boot
(function boot() {
  const h = (location.hash || '').slice(1);
  if (place) {
    $('#locName').textContent = place.name;
    const cached = store.get('cache', null);
    if (cached && cached.key === placeKey(place)) { wx = cached; renderAll(); } else skeleton();
    if (place.gps) locate(false); else load();
  } else {
    skeleton(); $('#locName').textContent = 'Choose location';
    locate(false);
  }
  if (['hourly', 'week', 'radar'].includes(h)) show(h);
})();
