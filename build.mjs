// Génère dist/index.html : les matchs de foot à venir avec les cotes Betclic (1N2 et Totals multiples).
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.ODDS_API_KEY;
const BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com';
const BOOKMAKER = 'betclic_fr';
const RESERVE = Number(process.env.RESERVE_CREDITS || 25);
const DAILY_BUDGET = process.env.DAILY_BUDGET ? Number(process.env.DAILY_BUDGET) : null;
const PHONE = (process.env.WHATSAPP_PHONE || '').replace(/\D/g, '');
const TZ = 'Europe/Paris';

if (!KEY) {
  console.error('ODDS_API_KEY est absente.');
  process.exit(1);
}

const PRIORITY = [
  'soccer_france_ligue_one', 'soccer_france_ligue_two', 'soccer_epl', 'soccer_spain_la_liga',
  'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_uefa_champs_league',
];

function parisParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hm: `${g('hour')}:${g('minute')}` };
}
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function parisMidnightUTC(day) {
  const [y, m, d] = day.split('-').map(Number);
  for (const off of [1, 2, 0, 3]) {
    const t = new Date(Date.UTC(y, m - 1, d) - off * 3600e3);
    const p = parisParts(t);
    if (p.day === day && p.hm === '00:00') return t;
  }
  throw new Error('Fuseau horaire de Paris introuvable');
}
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

let remaining = null;
let lastCost = 1;

async function api(path, params = {}) {
  const url = new URL(path, BASE);
  url.searchParams.set('apiKey', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const rem = res.headers.get('x-requests-remaining');
  if (rem !== null && rem !== '') remaining = Number(rem);
  const cost = res.headers.get('x-requests-last');
  if (cost !== null && cost !== '') lastCost = Number(cost);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`${res.status} sur ${path} : ${body}`);
  }
  return res.json();
}

async function main() {
  const now = new Date();
  const today = parisParts(now).day;
  const from = iso(parisMidnightUTC(today));
  // Élargi à 7 jours pour capturer tous les matchs de la semaine
  const to = iso(parisMidnightUTC(addDays(today, 7)));

  const sports = await api('/v4/sports/');
  const leagues = sports
    .filter((s) => s.group === 'Soccer' && s.active && !s.has_outrights)
    .sort((a, b) => {
      const ia = PRIORITY.indexOf(a.key), ib = PRIORITY.indexOf(b.key);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.title.localeCompare(b.title);
    });

  const withGames = [];
  for (const lg of leagues) {
    try {
      const events = await api(`/v4/sports/${lg.key}/events`, {
        commenceTimeFrom: from, commenceTimeTo: to, dateFormat: 'iso',
      });
      if (events.length) withGames.push({ lg, count: events.length });
    } catch (e) {}
  }

  const matches = [];
  let budget = DAILY_BUDGET;
  let calls = 0;

  for (const { lg } of withGames) {
    if (remaining !== null && remaining <= RESERVE) break;
    if (budget !== null && calls >= budget) break;
    try {
      const data = await api(`/v4/sports/${lg.key}/odds/`, {
        bookmakers: BOOKMAKER, 
        markets: 'h2h,totals', 
        oddsFormat: 'decimal', 
        dateFormat: 'iso',
        commenceTimeFrom: from, 
        commenceTimeTo: to,
      });
      calls += 1;

      const rows = [];
      for (const ev of data) {
        const bk = (ev.bookmakers || []).find((b) => b.key === BOOKMAKER);
        if (!bk) continue;

        const mkH2h = (bk.markets || []).find((x) => x.key === 'h2h');
        if (!mkH2h) continue;
        const priceH2h = (name) => { const o = mkH2h.outcomes.find((x) => x.name === name); return o ? o.price : null; };
        const o = [priceH2h(ev.home_team), priceH2h('Draw'), priceH2h(ev.away_team)];
        if (o.some((x) => x == null)) continue;

        const mkTotals = (bk.markets || []).find((x) => x.key === 'totals');
        const totalsLines = {};
        if (mkTotals && mkTotals.outcomes) {
          mkTotals.outcomes.forEach(outcome => {
            const point = outcome.point;
            if (!totalsLines[point]) totalsLines[point] = {};
            if (outcome.name === 'Over') totalsLines[point].over = outcome.price;
            if (outcome.name === 'Under') totalsLines[point].under = outcome.price;
          });
        }

        // On inclut la date dans l'affichage ou le tri si besoin
        rows.push({ 
          ts: ev.commence_time, 
          t: parisParts(new Date(ev.commence_time)).hm, 
          date: parisParts(new Date(ev.commence_time)).day,
          c: lg.title, 
          h: ev.home_team, 
          a: ev.away_team, 
          o,
          totals: totalsLines
        });
      }
      rows.sort((x, y) => x.ts.localeCompare(y.ts));
      for (const r of rows) { delete r.ts; matches.push(r); }
    } catch (e) {}
  }

  const day = { date: today, updated: parisParts(new Date()).hm, matches };
  const json = JSON.stringify(day).replace(/</g, '\\u003c');
  const tpl = await readFile(new URL('./template.html', import.meta.url), 'utf8');
  const html = tpl.replace('__DAY_JSON__', () => json).replace('__PHONE__', PHONE);
  await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
  await writeFile(new URL('./dist/index.html', import.meta.url), html);
  console.log('dist/index.html écrit avec succès.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
