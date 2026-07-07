/* ボートレースAI予想 フロントエンド */
'use strict';

// ===== マスタデータ =====
const STADIUMS = {
  1: '桐生', 2: '戸田', 3: '江戸川', 4: '平和島', 5: '多摩川', 6: '浜名湖',
  7: '蒲郡', 8: '常滑', 9: '津', 10: '三国', 11: 'びわこ', 12: '住之江',
  13: '尼崎', 14: '鳴門', 15: '丸亀', 16: '児島', 17: '宮島', 18: '徳山',
  19: '下関', 20: '若松', 21: '芦屋', 22: '福岡', 23: '唐津', 24: '大村'
};

// 場ごとのイン(1コース)の強さ補正 (全国平均=1.0)
const IN_STRENGTH = {
  1: 0.95, 2: 0.75, 3: 0.8, 4: 0.8, 5: 1.0, 6: 1.0,
  7: 1.05, 8: 1.0, 9: 1.0, 10: 0.95, 11: 0.9, 12: 1.05,
  13: 1.05, 14: 0.9, 15: 1.05, 16: 1.05, 17: 1.0, 18: 1.15,
  19: 1.1, 20: 1.1, 21: 1.15, 22: 0.9, 23: 1.0, 24: 1.2
};

// コース別の全国平均1着率(枠なり想定の基礎点)
const COURSE_WIN_RATE = { 1: 0.55, 2: 0.14, 3: 0.12, 4: 0.10, 5: 0.06, 6: 0.02 };

const GRADES = { 1: 'SG', 2: 'G1', 3: 'G2', 4: 'G3', 5: '一般' };
const CLASSES = { 1: 'A1', 2: 'A2', 3: 'B1', 4: 'B2' };
const CLASS_SCORE = { 1: 1.0, 2: 0.7, 3: 0.4, 4: 0.2 };
const MARKS = ['◎', '○', '▲', '△', '✕', '　'];
const WEATHER = { 1: '晴', 2: '曇', 3: '雨', 4: '雪', 5: '霧', 6: '雷' };
const WIND_DIR = ['', '北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西', '無風'];

// ===== 予想スタイル =====
// courseExp: コース別基礎勝率に掛ける指数 (1.0=そのまま、小さいほどコース差を圧縮して実力重視に)
// skillW:    実力差の効き方 (大きいほど勝率・モーターの差を強く反映)
const STYLES = {
  honmei: { label: '🎯 本命重視', courseExp: 1.0, skillW: 0.9,
    desc: 'コースの有利不利をそのまま評価。実際の出目に最も忠実で、1コース中心の堅い予想。' },
  chuana: { label: '🌀 中穴狙い', courseExp: 0.55, skillW: 1.15,
    desc: 'コース差のウエイトを半分程度に圧縮し、実力・機力が上位の外枠を積極的に評価。' },
  ooana: { label: '💥 大穴狙い', courseExp: 0.3, skillW: 1.35,
    desc: 'コース差をほぼ無視して選手力・モーター力だけで波乱の目を探す。的中率は低いが高配当狙い。' }
};
let betStyle = localStorage.getItem('br_style') || 'honmei';
if (!STYLES[betStyle]) betStyle = 'honmei';

// ===== 状態 =====
let programs = [];
let previews = [];
let results = [];
let currentStadium = null;

const $ = (sel) => document.querySelector(sel);

// ===== データ取得 =====
// ローカルサーバー経由で取得し、失敗時(サーバー未起動・file://で直接開いた場合など)は
// データ元の BoatraceOpenAPI へ直接フォールバックする
const REMOTE_API = {
  '/api/programs': 'https://boatraceopenapi.github.io/programs/v2/today.json',
  '/api/previews': 'https://boatraceopenapi.github.io/previews/v2/today.json',
  '/api/results': 'https://boatraceopenapi.github.io/results/v2/today.json'
};

// ローカルサーバー(localhost)以外で動いている場合はデータ元へ直接アクセス
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

async function fetchJson(url) {
  if (!IS_LOCAL && REMOTE_API[url]) {
    const res = await fetch(REMOTE_API[url]);
    if (!res.ok) throw new Error(`データ元 HTTP ${res.status}`);
    return await res.json();
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    const remote = REMOTE_API[url];
    if (!remote) throw e;
    const res = await fetch(remote);
    if (!res.ok) throw new Error(`データ元 HTTP ${res.status}`);
    return await res.json();
  }
}

async function loadAll() {
  const status = $('#status');
  status.textContent = '最新データを取得中…';
  status.classList.remove('error');
  try {
    const [p, pv, r] = await Promise.all([
      fetchJson('/api/programs'),
      fetchJson('/api/previews').catch(() => ({ previews: [] })),
      fetchJson('/api/results').catch(() => ({ results: [] }))
    ]);
    programs = p.programs || [];
    previews = pv.previews || [];
    results = r.results || [];
    if (programs.length === 0) {
      status.textContent = '本日の開催データがありません。';
      return;
    }
    const d = programs[0].race_date;
    $('#today-date').textContent = `${d} 開催`;
    status.textContent = `本日 ${new Set(programs.map(x => x.race_stadium_number)).size} 場 ${programs.length} レースのデータを取得しました(${new Date().toLocaleTimeString('ja-JP')} 時点)`;
    renderStadiumTabs();
  } catch (e) {
    status.textContent = 'データ取得に失敗しました: ' + e.message;
    status.classList.add('error');
  }
}

function findPreview(jcd, rno) {
  return previews.find(p => p.race_stadium_number === jcd && p.race_number === rno);
}
function findResult(jcd, rno) {
  const r = results.find(x => x.race_stadium_number === jcd && x.race_number === rno);
  if (!r || !r.boats || !r.boats.some(b => b.racer_place_number)) return null;
  return r;
}

// ===== 予想ロジック =====
// 各選手のスコア = 実力(勝率・級別・ST) + 機力(モーター・ボート) + コース + 直前情報
function predictRace(race, preview) {
  const jcd = race.race_stadium_number;
  const boats = race.boats.map(b => {
    const lane = b.racer_boat_number;
    const pvBoat = preview && preview.boats ? preview.boats[String(lane)] : null;
    const course = (pvBoat && pvBoat.racer_course_number) || lane; // 進入予定(不明なら枠なり)

    // --- 実力 ---
    const natWin = (b.racer_national_top_1_percent || 0) / 8;   // 全国勝率 (最大~8点)
    const localWin = (b.racer_local_top_1_percent || 0) / 8;    // 当地勝率
    const nat2 = (b.racer_national_top_2_percent || 0) / 100;   // 全国2連率
    const cls = CLASS_SCORE[b.racer_class_number] || 0.3;
    const st = Math.max(0, (0.22 - (b.racer_average_start_timing || 0.18)) * 8); // ST 0.10→0.96点

    // --- 機力 ---
    const motor = (b.racer_assigned_motor_top_2_percent || 30) / 100;
    const boat = (b.racer_assigned_boat_top_2_percent || 30) / 100;

    // --- コース別の基礎勝率 ---
    let courseRate = COURSE_WIN_RATE[course] || 0.05;
    if (course === 1) courseRate *= (IN_STRENGTH[jcd] || 1.0);

    // --- 直前情報(展示タイム) ---
    let exhibition = 0;
    if (pvBoat && pvBoat.racer_exhibition_time > 0) {
      exhibition = pvBoat.racer_exhibition_time; // あとで順位化
    }

    // --- ペナルティ ---
    const fPenalty = (b.racer_flying_count || 0) * 0.15; // F持ちはスタート慎重になる

    // 実力スコア(選手力 + 機力)
    const skill =
      natWin * 1.5 +
      localWin * 0.8 +
      nat2 * 1.2 +
      cls * 1.0 +
      st * 0.8 +
      motor * 1.5 +
      boat * 0.5 -
      fPenalty;

    return { b, lane, course, skill, courseRate, exhibition, pvBoat };
  });

  // 展示タイムがあれば順位ボーナス (1位+0.15 → 最下位-0.15)
  const withEx = boats.filter(x => x.exhibition > 0);
  if (withEx.length >= 4) {
    const sorted = [...withEx].sort((a, z) => a.exhibition - z.exhibition);
    sorted.forEach((x, i) => { x.skill += 0.15 - i * (0.3 / (sorted.length - 1)); });
  }

  // 勝率推定: コース別基礎勝率 × 実力補正(乗算型)
  // 予想スタイルに応じて「コース差の圧縮率」と「実力差の効き」を変える
  // (本命: コース序列が支配的 / 中穴・大穴: コース差を圧縮して実力・機力を重視)
  const stl = STYLES[betStyle] || STYLES.honmei;
  const meanSkill = boats.reduce((a, x) => a + x.skill, 0) / boats.length;
  boats.forEach(x => {
    x.score = Math.pow(x.courseRate, stl.courseExp) * Math.exp((x.skill - meanSkill) * stl.skillW);
  });
  const sum = boats.reduce((a, x) => a + x.score, 0);
  boats.forEach(x => { x.winProb = x.score / sum; });

  // 順位付け・予想印
  const ranked = [...boats].sort((a, z) => z.score - a.score);
  ranked.forEach((x, i) => { x.rank = i + 1; x.mark = MARKS[i] || '　'; });

  // 信頼度: 1位と2位の勝率差で判定
  const gap = ranked[0].winProb - ranked[1].winProb;
  let confidence;
  if (ranked[0].winProb > 0.45 && gap > 0.15) confidence = { level: '鉄板', cls: 'conf-high', note: '本命の信頼度が高いレースです。厚めに勝負も。' };
  else if (ranked[0].winProb > 0.3) confidence = { level: '本命', cls: 'conf-mid', note: '本命有力ですが相手選びが鍵です。' };
  else confidence = { level: '混戦', cls: 'conf-low', note: '混戦模様。手広く流すか見送りも検討を。' };

  // 買い目生成 (combos は回収率検証にも使う購入点そのもの・1点100円想定)
  const t = ranked.map(x => x.lane);
  const betGroups = [
    { group: '3連単 本線 (2点)', type: 'trifecta',
      combos: [[t[0], t[1], t[2]], [t[0], t[2], t[1]]] },
    { group: '3連単 フォーメーション (4点)', type: 'trifecta',
      combos: [[t[0], t[1], t[2]], [t[0], t[1], t[3]], [t[0], t[2], t[1]], [t[0], t[2], t[3]]],
      display: `${t[0]}-${t[1]},${t[2]}-${t[1]},${t[2]},${t[3]}` },
    { group: '3連単 抑え (2点)', type: 'trifecta',
      combos: [[t[1], t[0], t[2]], [t[0], t[3], t[1]]] },
    { group: '2連単 (2点)', type: 'exacta',
      combos: [[t[0], t[1]], [t[0], t[2]]] },
    { group: '3連複 (1点)', type: 'trio',
      combos: [[t[0], t[1], t[2]]] }
  ];
  const bets = betGroups.map(g => ({
    type: g.group,
    nums: g.display ? [g.display] : g.combos.map(c => comboKey(g.type, c))
  }));

  return { boats, ranked, confidence, bets, betGroups };
}

// 券種ごとの組番表記 (払戻データの combination と同形式)
function comboKey(type, combo) {
  if (type === 'trio') return [...combo].sort((a, z) => a - z).join('=');
  return combo.join('-');
}

// 的中していれば払戻金(100円あたり)を返す
function payoutFor(result, type, key) {
  const list = (result.payouts && result.payouts[type]) || [];
  let total = 0;
  list.forEach(e => { if (e.combination === key) total += e.payout; });
  return total;
}

// 1レース分の購入シミュレーション (1点100円)
function simulateRace(race, preview, result) {
  const pred = predictRace(race, preview);
  let cost = 0;
  let payout = 0;
  const hits = [];
  const byType = {}; // 券種別集計
  pred.betGroups.forEach(g => {
    const t = byType[g.type] || (byType[g.type] = { cost: 0, payout: 0, hit: false });
    g.combos.forEach(c => {
      cost += 100;
      t.cost += 100;
      const key = comboKey(g.type, c);
      const p = payoutFor(result, g.type, key);
      if (p > 0) {
        payout += p;
        t.payout += p;
        t.hit = true;
        hits.push({ group: g.group, key, payout: p });
      }
    });
  });
  return { pred, cost, payout, hits, byType };
}

// ===== 描画 =====
function renderStyleBar() {
  const box = $('#style-buttons');
  box.innerHTML = '';
  Object.keys(STYLES).forEach(key => {
    const btn = document.createElement('button');
    btn.className = 'style-btn' + (key === betStyle ? ' active' : '');
    btn.textContent = STYLES[key].label;
    btn.onclick = () => {
      betStyle = key;
      localStorage.setItem('br_style', key);
      renderStyleBar();
      hideDetail();
      if (currentStadium !== null) renderRaceList(currentStadium); // 予想を新スタイルで再計算
    };
    box.appendChild(btn);
  });
  $('#style-desc').textContent = STYLES[betStyle].desc;
}

function renderStadiumTabs() {
  const tabs = $('#stadium-tabs');
  tabs.innerHTML = '';
  const byStadium = new Map();
  programs.forEach(r => {
    if (!byStadium.has(r.race_stadium_number)) byStadium.set(r.race_stadium_number, []);
    byStadium.get(r.race_stadium_number).push(r);
  });

  [...byStadium.keys()].sort((a, z) => a - z).forEach(jcd => {
    const races = byStadium.get(jcd);
    const grade = Math.min(...races.map(r => r.race_grade_number || 5));
    const btn = document.createElement('button');
    btn.className = 'stadium-tab' + (jcd === currentStadium ? ' active' : '');
    btn.innerHTML = `${STADIUMS[jcd] || '場' + jcd}<span class="grade">${GRADES[grade] || ''}</span>`;
    btn.onclick = () => { currentStadium = jcd; renderStadiumTabs(); renderRaceList(jcd); hideDetail(); };
    tabs.appendChild(btn);
  });

  if (currentStadium === null && byStadium.size > 0) {
    currentStadium = [...byStadium.keys()].sort((a, z) => a - z)[0];
    renderStadiumTabs();
    renderRaceList(currentStadium);
  }
}

// おすすめ度 (1〜5): 本命の推定勝率と2番手との差から予想の自信度を算出
function recommendStars(pred) {
  const p1 = pred.ranked[0].winProb;
  const gap = p1 - pred.ranked[1].winProb;
  let s = 1;
  if (p1 >= 0.25) s++;
  if (p1 >= 0.35) s++;
  if (p1 >= 0.45 && gap >= 0.10) s++;
  if (p1 >= 0.55 && gap >= 0.20) s++;
  return s;
}

function renderRaceList(jcd) {
  const list = $('#race-list');
  list.innerHTML = '';
  list.classList.remove('hidden');
  programs
    .filter(r => r.race_stadium_number === jcd)
    .sort((a, z) => a.race_number - z.race_number)
    .forEach(race => {
      const card = document.createElement('div');
      card.className = 'race-card';
      const time = (race.race_closed_at || '').slice(11, 16);
      const done = findResult(jcd, race.race_number);
      const pred = predictRace(race, findPreview(jcd, race.race_number));
      const stars = recommendStars(pred);
      card.innerHTML = `
        <div class="rno">${race.race_number}R</div>
        <div class="rtitle">${race.race_subtitle || race.race_title || ''}</div>
        <div class="rec rec-${stars}" title="おすすめ度(予想の自信度)">${'★'.repeat(stars)}<span class="star-dim">${'★'.repeat(5 - stars)}</span> ◎${pred.ranked[0].lane}</div>
        <div class="rtime">締切 ${time}${done ? ' <span class="done">結果あり</span>' : ''}</div>`;
      card.onclick = () => renderDetail(race);
      list.appendChild(card);
    });
}

function hideDetail() {
  $('#race-detail').classList.add('hidden');
  $('#stats-view').classList.add('hidden');
  $('#history-view').classList.add('hidden');
  $('#race-list').classList.remove('hidden');
}

// ===== 舟券データベース (実際に購入した買い目・金額を記録し localStorage に永続化) =====
const BET_DB_KEY = 'br_bet_db_v1';
const archiveResultCache = {}; // 日付 -> 結果配列

// 券種定義 (結果APIの payouts のキーと対応)
const BET_TYPES = {
  trifecta:       { label: '3連単',  need: 3, sep: '-' },
  trio:           { label: '3連複',  need: 3, sep: '=' },
  exacta:         { label: '2連単',  need: 2, sep: '-' },
  quinella:       { label: '2連複',  need: 2, sep: '=' },
  quinella_place: { label: '拡連複', need: 2, sep: '=' },
  win:            { label: '単勝',   need: 1, sep: '' },
  place:          { label: '複勝',   need: 1, sep: '' }
};

function loadBetDb() {
  try { return JSON.parse(localStorage.getItem(BET_DB_KEY)) || []; }
  catch (e) { return []; }
}
function saveBetDb(list) { localStorage.setItem(BET_DB_KEY, JSON.stringify(list)); }

// 旧形式 (推奨買い目の一括記録) からの移行: 1点100円の購入として取り込む
(function migrateOldHistory() {
  const old = localStorage.getItem('br_bet_history_v1');
  if (!old) return;
  try {
    const db = loadBetDb();
    (JSON.parse(old) || []).forEach(e => {
      (e.tickets || []).forEach((tk, i) => {
        db.push({
          id: `${e.id}_${i}`,
          race_date: e.race_date, jcd: e.jcd, rno: e.rno,
          type: tk.type, key: tk.key, amount: 100,
          settled: false, payout: 0, actual: null,
          recordedAt: e.recordedAt
        });
      });
    });
    saveBetDb(db);
  } catch (err) { /* 変換できない場合は破棄 */ }
  localStorage.removeItem('br_bet_history_v1');
})();

// 入力された買い目を正規化 ("1 2 3"や"1=2=3"も受け付けて正式表記へ)。不正なら null
function normalizeCombo(type, raw) {
  const t = BET_TYPES[type];
  if (!t) return null;
  const nums = String(raw).split(/[^1-6]/).filter(Boolean).map(Number);
  if (nums.length !== t.need || new Set(nums).size !== nums.length) return null;
  if (t.sep === '=') return [...nums].sort((a, z) => a - z).join('=');
  return nums.join(t.sep);
}

function addBetRecord(race, type, key, amount) {
  const db = loadBetDb();
  db.push({
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    race_date: race.race_date,
    jcd: race.race_stadium_number,
    rno: race.race_number,
    type, key, amount,
    settled: false, payout: 0, actual: null,
    recordedAt: new Date().toISOString()
  });
  saveBetDb(db);
}

// 指定日の結果を取得 (当日はメモリ上の results、過去日はアーカイブAPI)
async function fetchResultsForDate(dateStr) {
  const today = programs.length ? programs[0].race_date : null;
  if (dateStr === today) return results;
  if (archiveResultCache[dateStr]) return archiveResultCache[dateStr];
  const ymd = dateStr.replace(/-/g, '');
  try {
    const res = await fetch(`https://boatraceopenapi.github.io/results/v2/${ymd.slice(0, 4)}/${ymd}.json`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    archiveResultCache[dateStr] = data.results || [];
  } catch (e) {
    archiveResultCache[dateStr] = [];
  }
  return archiveResultCache[dateStr];
}

// 未確定の舟券に結果を突き合わせ、実際の払戻金額を確定させる
// (払戻データは100円あたりなので、購入金額に応じて換算)
async function settleBets() {
  const db = loadBetDb();
  let changed = false;
  for (const b of db) {
    if (b.settled) continue;
    const dayResults = await fetchResultsForDate(b.race_date);
    const r = dayResults.find(x => x.race_stadium_number === b.jcd && x.race_number === b.rno);
    if (!r || !r.payouts || !(r.payouts.trifecta || []).length) continue;
    const per100 = payoutFor(r, b.type, b.key);
    b.payout = Math.round(per100 * b.amount / 100);
    b.settled = true;
    b.actual = r.payouts.trifecta[0].combination;
    changed = true;
  }
  if (changed) saveBetDb(db);
  return db;
}

// ===== エクスポート / バックアップ =====
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCsv(db) {
  const lines = [['日付', '場', 'R', '券種', '買い目', '購入金額', '結果(3連単)', '回収金額', '収支', '状態'].join(',')];
  [...db].sort((a, z) => a.race_date.localeCompare(z.race_date) || a.jcd - z.jcd || a.rno - z.rno)
    .forEach(b => {
      lines.push([
        b.race_date, STADIUMS[b.jcd] || b.jcd, b.rno,
        BET_TYPES[b.type] ? BET_TYPES[b.type].label : b.type,
        '"' + b.key + '"', b.amount,
        b.actual ? '"' + b.actual + '"' : '',
        b.settled ? b.payout : '',
        b.settled ? b.payout - b.amount : '',
        b.settled ? '確定' : '未確定'
      ].join(','));
    });
  downloadFile('boatrace_bets.csv', '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8'); // BOM付き(Excel対応)
}

// レース詳細画面: このレースで購入した舟券の一覧
function renderMyBetsList(race) {
  const el = $('#my-bets-list');
  if (!el) return;
  const mine = loadBetDb().filter(b =>
    b.race_date === race.race_date &&
    b.jcd === race.race_stadium_number &&
    b.rno === race.race_number);
  const yen = n => n.toLocaleString('ja-JP');

  if (mine.length === 0) {
    el.innerHTML = '<div class="status">このレースの購入記録はまだありません。</div>';
    return;
  }
  const total = mine.reduce((a, b) => a + b.amount, 0);
  const settled = mine.filter(b => b.settled);
  const payout = settled.reduce((a, b) => a + b.payout, 0);
  const sumHtml = settled.length === mine.length
    ? ` / 回収 ${yen(payout)}円 / 収支 <b class="${payout - total >= 0 ? 'plus' : 'minus'}">${payout - total >= 0 ? '+' : ''}${yen(payout - total)}円</b>(回収率 ${(payout / total * 100).toFixed(1)}%)`
    : '(結果待ちあり)';

  el.innerHTML = `
    <table>
      <thead><tr><th>券種</th><th>買い目</th><th>購入</th><th>回収</th><th>収支</th><th></th></tr></thead>
      <tbody>${mine.map(b => {
        const diff = b.payout - b.amount;
        return `<tr>
          <td>${BET_TYPES[b.type] ? BET_TYPES[b.type].label : b.type}</td>
          <td><b>${b.key}</b></td>
          <td>${yen(b.amount)}円</td>
          <td>${b.settled ? (b.payout > 0 ? '<span class="hit">🎯 </span>' : '') + yen(b.payout) + '円' : '<span class="pending">結果待ち</span>'}</td>
          <td class="${diff >= 0 ? 'plus' : 'minus'}">${b.settled ? (diff >= 0 ? '+' : '') + yen(diff) + '円' : '-'}</td>
          <td><button class="del-btn" data-id="${b.id}" title="削除">🗑</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    <div class="status">このレース合計: 購入 ${yen(total)}円${sumHtml}</div>`;

  el.querySelectorAll('.del-btn').forEach(btn => {
    btn.onclick = () => {
      saveBetDb(loadBetDb().filter(b => b.id !== btn.dataset.id));
      renderMyBetsList(race);
    };
  });
}

function renderBetDb(db) {
  $('#race-list').classList.add('hidden');
  $('#race-detail').classList.add('hidden');
  $('#stats-view').classList.add('hidden');
  const view = $('#history-view');
  view.classList.remove('hidden');

  const yen = n => n.toLocaleString('ja-JP');
  const entries = [...db].sort((a, z) =>
    z.race_date.localeCompare(a.race_date) || a.jcd - z.jcd || a.rno - z.rno || a.recordedAt.localeCompare(z.recordedAt));

  if (entries.length === 0) {
    view.innerHTML = `
      <div class="detail-header">
        <h2>📝 舟券データベース</h2>
        <button class="back-btn" id="history-back-btn">← レース一覧へ</button>
      </div>
      <div class="status">まだ記録がありません。レース詳細画面の「🎫 買った舟券を記録」から、実際に購入した買い目と金額を入力してください。</div>`;
    $('#history-back-btn').onclick = hideDetail;
    return;
  }

  const settled = entries.filter(b => b.settled);
  const totalCost = settled.reduce((a, b) => a + b.amount, 0);
  const totalPayout = settled.reduce((a, b) => a + b.payout, 0);
  const roi = totalCost > 0 ? (totalPayout / totalCost * 100) : 0;
  const profit = totalPayout - totalCost;
  const hitCount = settled.filter(b => b.payout > 0).length;
  const pendingCost = entries.filter(b => !b.settled).reduce((a, b) => a + b.amount, 0);

  const rows = entries.map(b => {
    const diff = b.payout - b.amount;
    const resultHtml = !b.settled
      ? '<span class="pending">結果待ち</span>'
      : (b.payout > 0 ? `<span class="hit">🎯 的中</span>` : '不的中');
    return `<tr>
      <td>${b.race_date.slice(5)}</td>
      <td class="name">${STADIUMS[b.jcd] || b.jcd} ${b.rno}R</td>
      <td>${BET_TYPES[b.type] ? BET_TYPES[b.type].label : b.type}</td>
      <td><b>${b.key}</b></td>
      <td>${yen(b.amount)}円</td>
      <td>${b.settled ? b.actual : '-'}</td>
      <td class="name">${resultHtml}</td>
      <td>${b.settled ? yen(b.payout) + '円' : '-'}</td>
      <td class="${diff >= 0 ? 'plus' : 'minus'}">${b.settled ? (diff >= 0 ? '+' : '') + yen(diff) + '円' : '-'}</td>
      <td><button class="del-btn" data-id="${b.id}" title="この記録を削除">🗑</button></td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>📝 舟券データベース</h2>
        <div class="sub">記録 ${entries.length} 件(確定 ${settled.length} 件・的中 ${hitCount} 件)。回収率・収支は確定分のみで計算。${pendingCost ? `未確定の購入額 ${yen(pendingCost)}円` : ''}</div>
      </div>
      <button class="back-btn" id="history-back-btn">← レース一覧へ</button>
    </div>
    <div class="stats-summary">
      <div class="summary-card"><div class="label">回収率</div><div class="value ${roi >= 100 ? 'plus' : 'minus'}">${settled.length ? roi.toFixed(1) + '%' : '-'}</div></div>
      <div class="summary-card"><div class="label">回収金額</div><div class="value">${yen(totalPayout)}円</div></div>
      <div class="summary-card"><div class="label">収支</div><div class="value ${profit >= 0 ? 'plus' : 'minus'}">${settled.length ? (profit >= 0 ? '+' : '') + yen(profit) + '円' : '-'}</div></div>
      <div class="summary-card"><div class="label">総購入</div><div class="value">${yen(totalCost)}円</div></div>
      <div class="summary-card"><div class="label">的中率</div><div class="value">${settled.length ? (hitCount / settled.length * 100).toFixed(1) + '%' : '-'}</div></div>
    </div>
    <table>
      <thead><tr><th>日付</th><th>レース</th><th>券種</th><th>買い目</th><th>購入</th><th>結果<br>(3連単)</th><th>的中</th><th>回収</th><th>収支</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="history-footer">
      <button class="back-btn" id="csv-btn">📥 CSVダウンロード</button>
      <button class="back-btn" id="backup-btn">💾 バックアップ(JSON)</button>
      <button class="back-btn" id="restore-btn">📤 復元</button>
      <input type="file" id="restore-file" accept=".json" style="display:none">
      <button class="back-btn" id="history-clear-btn">🗑 全削除</button>
    </div>`;

  $('#history-back-btn').onclick = hideDetail;
  $('#csv-btn').onclick = () => exportCsv(loadBetDb());
  $('#backup-btn').onclick = () =>
    downloadFile('boatrace_bets_backup.json', JSON.stringify(loadBetDb(), null, 1), 'application/json');
  $('#restore-btn').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error('形式が不正です');
        const db = loadBetDb();
        const ids = new Set(db.map(b => b.id));
        imported.forEach(b => { if (b && b.id && !ids.has(b.id)) db.push(b); });
        saveBetDb(db);
        renderBetDb(db);
        alert('復元しました(既存の記録とマージ)');
      } catch (e) {
        alert('復元に失敗しました: ' + e.message);
      }
    };
    reader.readAsText(file);
  };
  $('#history-clear-btn').onclick = () => {
    if (confirm('舟券データベースをすべて削除します。よろしいですか?(事前にバックアップ推奨)')) {
      saveBetDb([]);
      renderBetDb([]);
    }
  };
  view.querySelectorAll('.del-btn').forEach(btn => {
    btn.onclick = () => {
      const next = loadBetDb().filter(b => b.id !== btn.dataset.id);
      saveBetDb(next);
      renderBetDb(next);
    };
  });
}

// ===== 回収率集計 =====
const TYPE_LABEL = { trifecta: '3連単', exacta: '2連単', trio: '3連複' };

function renderStats() {
  $('#race-list').classList.add('hidden');
  $('#race-detail').classList.add('hidden');
  const view = $('#stats-view');
  view.classList.remove('hidden');

  // 確定済み(払戻あり)の全レースを予想通りに買った場合を集計
  const rows = [];
  let totalCost = 0;
  let totalPayout = 0;
  let hitRaces = 0;
  const typeTotal = {}; // 券種別: cost/payout/hit回数/対象数

  results.forEach(result => {
    if (!result.payouts || !(result.payouts.trifecta || []).length) return; // 未確定・返還は除外
    const race = programs.find(p =>
      p.race_stadium_number === result.race_stadium_number && p.race_number === result.race_number);
    if (!race) return;
    const preview = findPreview(result.race_stadium_number, result.race_number);
    const sim = simulateRace(race, preview, result);

    totalCost += sim.cost;
    totalPayout += sim.payout;
    if (sim.payout > 0) hitRaces++;
    Object.keys(sim.byType).forEach(type => {
      const t = typeTotal[type] || (typeTotal[type] = { cost: 0, payout: 0, hits: 0, n: 0 });
      t.cost += sim.byType[type].cost;
      t.payout += sim.byType[type].payout;
      t.n++;
      if (sim.byType[type].hit) t.hits++;
    });

    const actual = (result.payouts.trifecta[0] || {}).combination || '-';
    const predicted = sim.pred.ranked.slice(0, 3).map(x => x.lane).join('-');
    rows.push({
      jcd: result.race_stadium_number,
      rno: result.race_number,
      predicted, actual,
      hits: sim.hits,
      cost: sim.cost,
      payout: sim.payout
    });
  });

  if (rows.length === 0) {
    view.innerHTML = `
      <div class="detail-header">
        <h2>📊 本日の予想成績・回収率</h2>
        <button class="back-btn" id="stats-back-btn">← レース一覧へ</button>
      </div>
      <div class="status">まだ確定したレースがありません。レース終了後に「🔄 更新」してから再度開いてください。</div>`;
    $('#stats-back-btn').onclick = hideDetail;
    return;
  }

  rows.sort((a, z) => a.jcd - z.jcd || a.rno - z.rno);
  const yen = n => n.toLocaleString('ja-JP');
  const roi = totalCost > 0 ? (totalPayout / totalCost * 100) : 0;
  const profit = totalPayout - totalCost;

  const typeRows = Object.keys(typeTotal).map(type => {
    const t = typeTotal[type];
    const r = t.cost > 0 ? (t.payout / t.cost * 100) : 0;
    return `<tr>
      <td class="name">${TYPE_LABEL[type] || type}</td>
      <td>${t.hits} / ${t.n} (${(t.hits / t.n * 100).toFixed(1)}%)</td>
      <td>${yen(t.cost)}円</td>
      <td>${yen(t.payout)}円</td>
      <td class="${r >= 100 ? 'plus' : 'minus'}">${r.toFixed(1)}%</td>
    </tr>`;
  }).join('');

  const raceRows = rows.map(r => `<tr>
    <td class="name">${STADIUMS[r.jcd]} ${r.rno}R</td>
    <td>${r.predicted}</td>
    <td>${r.actual}</td>
    <td class="name">${r.hits.length ? r.hits.map(h => `🎯 ${h.group.replace(/ \(.+\)/, '')} ${h.key} ${yen(h.payout)}円`).join('<br>') : '-'}</td>
    <td>${yen(r.cost)}円</td>
    <td>${yen(r.payout)}円</td>
    <td class="${r.payout - r.cost >= 0 ? 'plus' : 'minus'}">${r.payout - r.cost >= 0 ? '+' : ''}${yen(r.payout - r.cost)}円</td>
  </tr>`).join('');

  view.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>📊 本日の予想成績・回収率</h2>
        <div class="sub">確定済み ${rows.length} レースを推奨買い目(1点100円・1レース1,100円)で購入した場合のシミュレーション</div>
      </div>
      <button class="back-btn" id="stats-back-btn">← レース一覧へ</button>
    </div>
    <div class="stats-summary">
      <div class="summary-card"><div class="label">回収率</div><div class="value ${roi >= 100 ? 'plus' : 'minus'}">${roi.toFixed(1)}%</div></div>
      <div class="summary-card"><div class="label">収支</div><div class="value ${profit >= 0 ? 'plus' : 'minus'}">${profit >= 0 ? '+' : ''}${yen(profit)}円</div></div>
      <div class="summary-card"><div class="label">総購入</div><div class="value">${yen(totalCost)}円</div></div>
      <div class="summary-card"><div class="label">総払戻</div><div class="value">${yen(totalPayout)}円</div></div>
      <div class="summary-card"><div class="label">的中レース</div><div class="value">${hitRaces} / ${rows.length}</div></div>
    </div>
    <h3 class="stats-h3">券種別成績</h3>
    <table>
      <thead><tr><th>券種</th><th>的中率</th><th>購入</th><th>払戻</th><th>回収率</th></tr></thead>
      <tbody>${typeRows}</tbody>
    </table>
    <h3 class="stats-h3">レース別明細</h3>
    <table>
      <thead><tr><th>レース</th><th>予想</th><th>結果<br>(3連単)</th><th>的中</th><th>購入</th><th>払戻</th><th>収支</th></tr></thead>
      <tbody>${raceRows}</tbody>
    </table>`;

  $('#stats-back-btn').onclick = hideDetail;
  view.scrollIntoView({ behavior: 'smooth' });
}

function renderDetail(race) {
  const jcd = race.race_stadium_number;
  const preview = findPreview(jcd, race.race_number);
  const result = findResult(jcd, race.race_number);
  const pred = predictRace(race, preview);

  const detail = $('#race-detail');
  $('#race-list').classList.add('hidden');
  detail.classList.remove('hidden');

  // 気象情報
  let weatherHtml = '';
  if (preview && (preview.race_wind !== null || preview.race_weather_number)) {
    const parts = [];
    if (preview.race_weather_number) parts.push(`天候 <b>${WEATHER[preview.race_weather_number] || '-'}</b>`);
    if (preview.race_wind !== null) parts.push(`風 <b>${preview.race_wind}m</b> ${WIND_DIR[preview.race_wind_direction_number] || ''}`);
    if (preview.race_wave !== null) parts.push(`波 <b>${preview.race_wave}cm</b>`);
    if (preview.race_temperature) parts.push(`気温 <b>${preview.race_temperature}℃</b>`);
    if (preview.race_water_temperature) parts.push(`水温 <b>${preview.race_water_temperature}℃</b>`);
    if (parts.length) weatherHtml = `<div class="weather-bar">${parts.join('<span>|</span>')}</div>`;
  }
  const hasPreviewData = preview && preview.boats &&
    Object.values(preview.boats).some(b => b.racer_exhibition_time > 0);

  // 選手テーブル (枠順)
  const rows = pred.boats.map(x => {
    const b = x.b;
    const cls = CLASSES[b.racer_class_number] || '-';
    const ex = x.pvBoat && x.pvBoat.racer_exhibition_time > 0 ? x.pvBoat.racer_exhibition_time.toFixed(2) : '-';
    const exSt = x.pvBoat && x.pvBoat.racer_start_timing !== null && x.pvBoat.racer_start_timing !== undefined
      ? x.pvBoat.racer_start_timing : null;
    const f = b.racer_flying_count > 0 ? `<span class="fcount">F${b.racer_flying_count}</span>` : '';
    return `<tr>
      <td class="mark">${x.mark}</td>
      <td><span class="lane lane-${x.lane}">${x.lane}</span></td>
      <td class="name">${b.racer_name} ${f}</td>
      <td class="class-${cls}">${cls}</td>
      <td>${(b.racer_national_top_1_percent || 0).toFixed(2)}</td>
      <td>${(b.racer_local_top_1_percent || 0).toFixed(2)}</td>
      <td>${(b.racer_assigned_motor_top_2_percent || 0).toFixed(1)}%</td>
      <td>${(b.racer_average_start_timing || 0).toFixed(2)}</td>
      <td>${ex}${exSt !== null ? `<br><small>ST ${exSt}</small>` : ''}</td>
      <td><div class="score-bar-wrap"><div class="score-bar" style="width:${(x.winProb / Math.max(...pred.boats.map(v => v.winProb)) * 100).toFixed(0)}%"></div></div></td>
      <td class="prob">${(x.winProb * 100).toFixed(1)}%</td>
    </tr>`;
  }).join('');

  // 買い目
  const betsHtml = pred.bets.map(bet => `
    <div class="bet-box">
      <div class="bet-type">${bet.type}</div>
      <div class="bet-nums">${bet.nums.join('<br>')}</div>
    </div>`).join('');

  // 結果 (確定していれば答え合わせ)
  let resultHtml = '';
  if (result) {
    const order = result.boats
      .filter(b => b.racer_place_number)
      .sort((a, z) => a.racer_place_number - z.racer_place_number)
      .slice(0, 3);
    const actual = order.map(b => b.racer_boat_number).join('-');
    const predicted = pred.ranked.slice(0, 3).map(x => x.lane).join('-');
    let payoutHtml = '';
    if (result.payouts && (result.payouts.trifecta || []).length) {
      const sim = simulateRace(race, preview, result);
      const yen = n => n.toLocaleString('ja-JP');
      const diff = sim.payout - sim.cost;
      const tri = result.payouts.trifecta[0];
      payoutHtml = `
        <p>3連単払戻: <b>${tri.combination}</b> ${yen(tri.payout)}円</p>
        <p>${sim.hits.length
          ? sim.hits.map(h => `<span class="hit">🎯 ${h.group.replace(/ \(.+\)/, '')} ${h.key} 的中 ${yen(h.payout)}円</span>`).join('<br>')
          : '推奨買い目は不的中でした。'}</p>
        <p>収支: 購入 ${yen(sim.cost)}円 / 払戻 ${yen(sim.payout)}円 /
        <b class="${diff >= 0 ? 'plus' : 'minus'}">${diff >= 0 ? '+' : ''}${yen(diff)}円</b></p>`;
    }
    resultHtml = `
      <div class="result-box">
        <h3>🏁 レース結果(確定)</h3>
        <p>着順: <b>${actual}</b>(予想本線: ${predicted})</p>
        <p><small>${order.map(b => `${b.racer_place_number}着 ${b.racer_boat_number}号艇 ${b.racer_name || ''}`).join(' / ')}</small></p>
        ${payoutHtml}
      </div>`;
  }

  detail.innerHTML = `
    <div class="detail-header">
      <div>
        <h2>${STADIUMS[jcd]} ${race.race_number}R ${race.race_subtitle || ''}</h2>
        <div class="sub">${race.race_title || ''} / ${race.race_distance || 1800}m / 締切 ${(race.race_closed_at || '').slice(11, 16)} / ${STYLES[betStyle].label}</div>
      </div>
      <button class="back-btn" id="back-btn">← レース一覧へ</button>
    </div>
    ${weatherHtml}
    ${hasPreviewData ? '' : '<div class="status">※ 直前情報(展示タイム・気象)は未発表です。出走表データのみで予想しています。締切前に「更新」してください。</div>'}
    ${betStyle === 'honmei' ? '' : `<div class="status">※ ${STYLES[betStyle].label}スタイル適用中。「予想勝率」は実際の勝率ではなく狙い度の目安です。</div>`}
    <table>
      <thead><tr>
        <th>印</th><th>枠</th><th>選手</th><th>級</th><th>全国<br>勝率</th><th>当地<br>勝率</th>
        <th>モーター<br>2連率</th><th>平均<br>ST</th><th>展示</th><th>スコア</th><th>予想<br>勝率</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="confidence ${pred.confidence.cls}">
      信頼度: <span class="level">${pred.confidence.level}</span> — ${pred.confidence.note}
    </div>
    <div class="bets">
      <h3>💰 推奨買い目</h3>
      <div class="bet-grid">${betsHtml}</div>
    </div>
    <div class="my-bets">
      <h3>🎫 買った舟券を記録</h3>
      <div class="bet-form">
        <select id="bet-type-input">${Object.keys(BET_TYPES).map(k => `<option value="${k}">${BET_TYPES[k].label}</option>`).join('')}</select>
        <input id="bet-combo-input" placeholder="買い目 (例: 1-2-3)">
        <input id="bet-amount-input" type="number" inputmode="numeric" min="100" step="100" value="100">
        <span class="yen-label">円</span>
        <button id="bet-add-btn">追加</button>
      </div>
      <div id="bet-form-error" class="pin-error"></div>
      <div id="my-bets-list"></div>
    </div>
    ${resultHtml}`;

  $('#back-btn').onclick = hideDetail;
  renderMyBetsList(race);
  $('#bet-add-btn').onclick = async () => {
    const type = $('#bet-type-input').value;
    const key = normalizeCombo(type, $('#bet-combo-input').value);
    const amount = Math.round(Number($('#bet-amount-input').value));
    const err = $('#bet-form-error');
    if (!key) {
      err.textContent = `買い目の形式が正しくありません(${BET_TYPES[type].label}は艇番を${BET_TYPES[type].need}つ、例: ${BET_TYPES[type].need === 3 ? '1-2-3' : BET_TYPES[type].need === 2 ? '1-2' : '1'})`;
      return;
    }
    if (!(amount >= 100)) {
      err.textContent = '金額は100円以上で入力してください';
      return;
    }
    err.textContent = '';
    addBetRecord(race, type, key, amount);
    $('#bet-combo-input').value = '';
    await settleBets(); // 結果が既に確定していれば即答え合わせ
    renderMyBetsList(race);
  };
  detail.scrollIntoView({ behavior: 'smooth' });
}

// ===== 簡易PINロック =====
// コードには暗証番号そのものではなく SHA-256(ソルト+暗証番号) のみを保持。
// ※本格的な認証ではないため、機密情報は扱わないこと。
const PIN_SALT = 'br-salt-v1:';
const PIN_HASH = '58482ba9b4e2b34338bb08783604e999ab326d5062963b8ed54ce96b8395d50f';
const PIN_STORE_KEY = 'br_pin_ok';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ensurePin() {
  // secure context 以外 (LAN の IP 直打ちなど) では crypto.subtle が使えないためスキップ
  if (!window.crypto || !crypto.subtle) return;
  if (localStorage.getItem(PIN_STORE_KEY) === PIN_HASH) return;

  const lock = $('#lock-screen');
  lock.classList.add('visible');
  const input = $('#pin-input');
  input.focus();

  await new Promise(resolve => {
    const tryUnlock = async () => {
      const hash = await sha256Hex(PIN_SALT + input.value.trim());
      if (hash === PIN_HASH) {
        localStorage.setItem(PIN_STORE_KEY, PIN_HASH);
        resolve();
      } else {
        $('#pin-error').textContent = '暗証番号が違います';
        input.value = '';
        input.focus();
      }
    };
    $('#pin-submit').onclick = tryUnlock;
    input.onkeydown = e => { if (e.key === 'Enter') tryUnlock(); };
  });
}

// ===== 初期化 =====
$('#refresh-btn').onclick = loadAll;
$('#stats-btn').onclick = async () => {
  await loadAll(); // 最新の結果を取り込んでから集計
  renderStats();
};
$('#history-btn').onclick = async () => {
  await loadAll();
  const db = await settleBets(); // 確定した結果を突き合わせて回収金額を反映
  renderBetDb(db);
};
(async () => {
  await ensurePin();
  $('#lock-screen').remove();
  renderStyleBar();
  loadAll();
})();
