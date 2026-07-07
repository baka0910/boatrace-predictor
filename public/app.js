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
  // 実力が平均より高いほど基礎勝率を押し上げるが、コースの序列が支配的
  const meanSkill = boats.reduce((a, x) => a + x.skill, 0) / boats.length;
  boats.forEach(x => {
    x.score = x.courseRate * Math.exp((x.skill - meanSkill) * 0.9);
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
      card.innerHTML = `
        <div class="rno">${race.race_number}R</div>
        <div class="rtitle">${race.race_subtitle || race.race_title || ''}</div>
        <div class="rtime">締切 ${time}${done ? ' <span class="done">結果あり</span>' : ''}</div>`;
      card.onclick = () => renderDetail(race);
      list.appendChild(card);
    });
}

function hideDetail() {
  $('#race-detail').classList.add('hidden');
  $('#stats-view').classList.add('hidden');
  $('#race-list').classList.remove('hidden');
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
        <div class="sub">${race.race_title || ''} / ${race.race_distance || 1800}m / 締切 ${(race.race_closed_at || '').slice(11, 16)}</div>
      </div>
      <button class="back-btn" id="back-btn">← レース一覧へ</button>
    </div>
    ${weatherHtml}
    ${hasPreviewData ? '' : '<div class="status">※ 直前情報(展示タイム・気象)は未発表です。出走表データのみで予想しています。締切前に「更新」してください。</div>'}
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
    ${resultHtml}`;

  $('#back-btn').onclick = hideDetail;
  detail.scrollIntoView({ behavior: 'smooth' });
}

// ===== 初期化 =====
$('#refresh-btn').onclick = loadAll;
$('#stats-btn').onclick = async () => {
  await loadAll(); // 最新の結果を取り込んでから集計
  renderStats();
};
loadAll();
