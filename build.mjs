// Génère dist/index.html : les matchs de foot du jour (heure de Paris) avec les cotes Betclic.
// Lancé chaque matin par GitHub Actions. Lit la clé dans la variable d'environnement ODDS_API_KEY.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.ODDS_API_KEY;
const BASE = process.env.ODDS_API_BASE || 'https://api.the-odds-api.com';
const BOOKMAKER = 'betclic_fr';
const RESERVE = Number(process.env.RESERVE_CREDITS || 25); // crédits laissés de côté
const DAILY_BUDGET = process.env.DAILY_BUDGET ? Number(process.env.DAILY_BUDGET) : null; // appels de cotes max par jour
const PHONE = (process.env.WHATSAPP_PHONE || '').replace(/\D/g, '');
const TZ = 'Europe/Paris';

if (!KEY) {
  console.error('ODDS_API_KEY est absente. Ajoute-la dans Settings > Secrets and variables > Actions.');
  process.exit(1);
}

// Championnats les plus suivis d'abord. Les autres suivent par ordre alphabétique.
const PRIORITY = [
  'soccer_france_ligue_one', 'soccer_france_ligue_two', 'soccer_epl', 'soccer_spain_la_liga',
  'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_uefa_champs_league',
  'soccer_uefa_europa_league', 'soccer_uefa_europa_conf_league', 'soccer_france_coupe_de_france',
  'soccer_efl_champ', 'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga',
  'soccer_belgium_first_div', 'soccer_turkey_super_league', 'soccer_spain_segunda_division',
  'soccer_italy_serie_b', 'soccer_germany_bundesliga2',
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
  const to = iso(parisMidnightUTC(addDays(today, 1)));

  // 1. Liste des championnats de foot actifs (ne consomme pas de crédits).
  const sports = await api('/v4/sports/');
  const leagues = sports
    .filter((s) => s.group === 'Soccer' && s.active && !s.has_outrights)
    .sort((a, b) => {
      const ia = PRIORITY.indexOf(a.key), ib = PRIORITY.indexOf(b.key);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.title.localeCompare(b.title);
    });
  console.log(`${leagues.length} championnats de foot actifs.`);

  // 2. Quels championnats ont des matchs aujourd'hui ? (liste des matchs sans cotes)
  const withGames = [];
  for (const lg of leagues) {
    try {
      const events = await api(`/v4/sports/${lg.key}/events`, {
        commenceTimeFrom: from, commenceTimeTo: to, dateFormat: 'iso',
      });
      if (events.length) withGames.push({ lg, count: events.length });
    } catch (e) {
      console.warn(`Matchs ignorés pour ${lg.key} : ${e.message}`);
    }
  }
  console.log(`${withGames.length} championnats ont des matchs aujourd'hui.`);

  // 3. Cotes Betclic, championnat par championnat, dans la limite du quota.
  const matches = [];
  const skipped = [];
  let budget = DAILY_BUDGET;
  let calls = 0;
  for (const { lg } of withGames) {
    if (remaining !== null && remaining <= RESERVE) { skipped.push(lg.title); continue; }
    if (budget !== null && calls >= budget) { skipped.push(lg.title); continue; }
    try {
      const data = await api(`/v4/sports/${lg.key}/odds/`, {
        bookmakers: BOOKMAKER, markets: 'h2h', oddsFormat: 'decimal', dateFormat: 'iso',
        commenceTimeFrom: from, commenceTimeTo: to,
      });
      calls += 1;
      if (budget === null && remaining !== null) {
        // Répartit les crédits restants sur les jours du mois qui restent.
        const [y, m, d] = today.split('-').map(Number);
        const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const daysLeft = daysInMonth - d + 1;
        budget = Math.max(3, Math.floor((remaining + lastCost) / daysLeft));
        console.log(`Budget du jour : ${budget} appels (${remaining} crédits restants).`);
      }
      const rows = [];
      for (const ev of data) {
        const bk = (ev.bookmakers || []).find((b) => b.key === BOOKMAKER);
        const mk = bk && (bk.markets || []).find((x) => x.key === 'h2h');
        if (!mk) continue;
        const price = (name) => { const o = mk.outcomes.find((x) => x.name === name); return o ? o.price : null; };
        const o = [price(ev.home_team), price('Draw'), price(ev.away_team)];
        if (o.some((x) => x == null)) continue;
        rows.push({ ts: ev.commence_time, t: parisParts(new Date(ev.commence_time)).hm, c: lg.title, h: ev.home_team, a: ev.away_team, o });
      }
      rows.sort((x, y) => x.ts.localeCompare(y.ts));
      for (const r of rows) { delete r.ts; matches.push(r); }
    } catch (e) {
      console.warn(`Cotes ignorées pour ${lg.key} : ${e.message}`);
    }
  }
  if (skipped.length) console.warn(`Quota atteint, non couverts : ${skipped.join(', ')}`);
  console.log(`${matches.length} matchs avec cotes Betclic. Crédits restants : ${remaining ?? 'inconnu'}.`);

  // 4. Page finale.
  const day = { date: today, updated: parisParts(new Date()).hm, matches };
  const json = JSON.stringify(day).replace(/</g, '\\u003c');
  const tpl = await readFile(new URL('./template.html', import.meta.url), 'utf8');
  const html = tpl.replace('__DAY_JSON__', () => json).replace('__PHONE__', PHONE);
  await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
  await writeFile(new URL('./dist/index.html', import.meta.url), html);
  console.log('dist/index.html écrit.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
