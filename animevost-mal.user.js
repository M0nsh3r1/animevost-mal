// ==UserScript==
// @name         Animevost → MyAnimeList
// @namespace    animevost-mal
// @version      2.0
// @description  Находит аниме на MAL по названию с animevost и даёт отмечать серии прямо на странице
// @match        https://animevost.org/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      api.jikan.moe
// @connect      api.myanimelist.net
// @connect      myanimelist.net
// ==/UserScript==

(function () {
  'use strict';

  const REDIRECT = 'https://animevost.org/mal-auth';
  const JIKAN = 'https://api.jikan.moe/v4/anime';
  const TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';

  /* ---------- утилиты ---------- */
  const gm = (opts) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest(Object.assign({
      timeout: 15000,
      onload: resolve,
      onerror: reject,
      ontimeout: () => reject(new Error('timeout')),
    }, opts));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const form = (o) => new URLSearchParams(o).toString();

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    kids.flat().forEach((c) => { if (c != null) e.append(c); });
    return e;
  }

  /* ---------- OAuth (PKCE) ---------- */
  function rand(n) {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => c[x % c.length]).join('');
  }

  function setupClientId() {
    const v = prompt('Client ID приложения MAL:', GM_getValue('mal_client_id', ''));
    if (v !== null) { GM_setValue('mal_client_id', v.trim()); location.reload(); }
  }

  function setupSecret() {
    const v = prompt('Client Secret приложения MAL (оставьте пустым, если тип приложения "other"):', GM_getValue('mal_client_secret', ''));
    if (v !== null) { GM_setValue('mal_client_secret', v.trim()); alert('Сохранено. Теперь нажмите «Войти в MAL» ещё раз.'); }
  }

  function clientAuth() {
    const s = GM_getValue('mal_client_secret', '');
    return s ? { client_secret: s } : {};
  }

  // Для приложений типа web отправляем секрет и в теле, и в заголовке Basic
  function tokHeaders() {
    const hd = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const s = GM_getValue('mal_client_secret', '');
    if (s) hd.Authorization = 'Basic ' + btoa(GM_getValue('mal_client_id', '') + ':' + s);
    return hd;
  }

  function diag() {
    const id = GM_getValue('mal_client_id', '');
    const s = GM_getValue('mal_client_secret', '');
    return ' [client_id: ' + (id ? id.slice(0, 4) + '…' + id.slice(-4) + ' (' + id.length + ' симв.)' : 'нет')
      + '; secret: ' + (s ? 'задан (' + s.length + ' симв.)' : 'НЕ задан') + ']';
  }

  function login() {
    const cid = GM_getValue('mal_client_id', '');
    if (!cid) { setupClientId(); return; }
    const verifier = rand(100);
    const state = rand(16);
    GM_setValue('mal_pkce', { verifier, state, back: location.href });
    location.href = 'https://myanimelist.net/v1/oauth2/authorize?' + form({
      response_type: 'code',
      client_id: cid,
      code_challenge: verifier,
      code_challenge_method: 'plain',
      state,
      redirect_uri: REDIRECT,
    });
  }

  function saveTok(t) {
    GM_setValue('mal_tok', {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + (t.expires_in || 3600) * 1000 - 60000,
    });
  }

  async function handleCallback() {
    document.body.innerHTML = '';
    const msg = h('p', { text: 'Подключаю MAL…', style: 'font:16px sans-serif;padding:24px' });
    document.body.append(msg);
    const p = new URLSearchParams(location.search);
    const saved = GM_getValue('mal_pkce');
    try {
      if (!saved || p.get('state') !== saved.state || !p.get('code')) {
        throw new Error(p.get('error') || 'неверный state/code');
      }
      const r = await gm({
        method: 'POST',
        url: TOKEN_URL,
        headers: tokHeaders(),
        data: form(Object.assign({
          client_id: GM_getValue('mal_client_id', ''),
          grant_type: 'authorization_code',
          code: p.get('code'),
          code_verifier: saved.verifier,
          redirect_uri: REDIRECT,
        }, clientAuth())),
      });
      if (r.status !== 200) throw new Error('token ' + r.status + ' ' + r.responseText + diag());
      saveTok(JSON.parse(r.responseText));
      GM_deleteValue('mal_pkce');
      msg.textContent = 'Готово, возвращаю на страницу…';
      location.href = saved.back || 'https://animevost.org/';
    } catch (e) {
      msg.textContent = 'Ошибка входа в MAL: ' + e.message;
    }
  }

  if (location.pathname === '/mal-auth') { handleCallback(); return; }

  GM_registerMenuCommand('MAL: ввести Client ID', setupClientId);
  GM_registerMenuCommand('MAL: ввести Client Secret', setupSecret);
  GM_registerMenuCommand('MAL: войти', login);
  GM_registerMenuCommand('MAL: выйти', () => { GM_deleteValue('mal_tok'); location.reload(); });

  async function refreshTok() {
    const t = GM_getValue('mal_tok');
    if (!t) throw new Error('not-auth');
    const r = await gm({
      method: 'POST',
      url: TOKEN_URL,
      headers: tokHeaders(),
      data: form(Object.assign({
        client_id: GM_getValue('mal_client_id', ''),
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
      }, clientAuth())),
    });
    if (r.status !== 200) { GM_deleteValue('mal_tok'); throw new Error('not-auth'); }
    saveTok(JSON.parse(r.responseText));
    return GM_getValue('mal_tok');
  }

  async function malApi(method, path, body) {
    let tok = GM_getValue('mal_tok');
    if (!tok) throw new Error('not-auth');
    if (tok.expires_at < Date.now()) tok = await refreshTok();
    const call = (t) => gm({
      method,
      url: 'https://api.myanimelist.net/v2' + path,
      headers: Object.assign(
        { Authorization: 'Bearer ' + t.access_token },
        body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}
      ),
      data: body ? form(body) : undefined,
    });
    let r = await call(tok);
    if (r.status === 401) { tok = await refreshTok(); r = await call(tok); }
    if (r.status < 200 || r.status >= 300) throw new Error('MAL ' + r.status + ': ' + r.responseText.slice(0, 200));
    return JSON.parse(r.responseText);
  }

  /* ---------- разбор страницы animevost ---------- */
  const h1 = document.querySelector('.shortstoryHead h1');
  const postId = (location.pathname.match(/\/(\d+)-/) || [])[1];
  if (!h1 || !postId) return;

  const h4 = document.querySelector('.shortstoryContent h4');

  function field(label) {
    for (const s of document.querySelectorAll('.shortstoryContent p > strong')) {
      if (s.textContent.trim().startsWith(label)) {
        return s.parentElement.textContent.replace(s.textContent, '').trim();
      }
    }
    return '';
  }

  const info = {
    year: parseInt(field('Год выхода'), 10) || null,
    type: field('Тип'),
  };

  // типы MAL в виде media_type API (в нижнем регистре)
  const TYPE_MAP = {
    'ТВ': ['tv'],
    'ТВ-спэшл': ['tv_special', 'special'],
    'OVA': ['ova'],
    'ONA': ['ona'],
    'Полнометражный фильм': ['movie'],
    'Короткометражный фильм': ['movie', 'special', 'ona'],
    'Дунхуа': ['ona', 'tv'],
  };

  function buildQueries() {
    const clean = (s) => s.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = clean(h1.textContent).split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
    const latin = parts.filter((p) => /[A-Za-z]/.test(p) && !/[А-Яа-яЁё]/.test(p));
    const q = [];
    const add = (s) => {
      s = (s || '').replace(/\s+/g, ' ').trim().slice(0, 64).trim();
      if (s.length >= 3 && !q.includes(s)) q.push(s);
    };

    const main = latin.length ? latin[latin.length - 1] : '';
    add(main);
    add(main.replace(/\(\d{4}\)/g, ''));
    if (h4) {
      const t = h4.textContent.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]/.test(t)) {
        add(t.split(/\.\s/)[0]);                       // романдзи до подзаголовка
        add(t.split(' ').slice(0, 7).join(' '));
      }
    }
    add(main.split(':')[0]);                            // «Nia Liston: The Merciless Maiden» → «Nia Liston»
    if (!q.length) add(parts[parts.length - 1]);
    return q.slice(0, 4);
  }

  const queries = buildQueries();
  const searchUrl = () => 'https://myanimelist.net/anime.php?cat=anime&q=' + encodeURIComponent(queries[0] || h1.textContent);

  /* ---------- поиск кандидатов ---------- */
  const normType = (t) => (t || '').toLowerCase().replace(/\s+/g, '_');
  const yearOf = (d) => (d ? parseInt(d, 10) || null : null);

  async function searchMal(q) {
    const d = await malApi('GET', '/anime?' + form({
      q, limit: 6,
      fields: 'media_type,start_season,start_date,num_episodes,mean,alternative_titles',
    }));
    return (d.data || []).map(({ node: n }) => ({
      id: n.id,
      title: n.title,
      eng: n.alternative_titles && n.alternative_titles.en,
      type: n.media_type,
      year: (n.start_season && n.start_season.year) || yearOf(n.start_date),
      eps: n.num_episodes,
      score: n.mean,
    }));
  }

  async function searchJikan(q) {
    for (let i = 0; i < 2; i++) {
      const r = await gm({ method: 'GET', url: JIKAN + '?' + form({ q, limit: 6 }), headers: { Accept: 'application/json' } });
      if (r.status === 429) { await sleep(1200); continue; }
      if (r.status !== 200) return [];
      return (JSON.parse(r.responseText).data || []).map((a) => ({
        id: a.mal_id,
        title: a.title,
        eng: a.title_english,
        type: normType(a.type),
        year: a.year || (a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year) || null,
        eps: a.episodes,
        score: a.score,
      }));
    }
    return [];
  }

  async function findCandidates() {
    let lists = [];
    if (GM_getValue('mal_tok')) {
      lists = await Promise.all(queries.map((q) => searchMal(q).catch(() => [])));
    }
    if (!lists.some((l) => l.length)) {
      lists = [];
      for (const q of queries.slice(0, 2)) {
        lists.push(await searchJikan(q).catch(() => []));
        await sleep(350);
      }
    }
    const seen = new Map();
    lists.forEach((l) => l.forEach((a) => { if (!seen.has(a.id)) seen.set(a.id, a); }));
    return [...seen.values()];
  }

  function scoreOf(a) {
    let s = 0;
    if (info.year && a.year === info.year) s += 2;
    else if (info.year && a.year && Math.abs(a.year - info.year) === 1) s += 0.5;
    if ((TYPE_MAP[info.type] || []).includes(a.type)) s += 1;
    return s;
  }

  /* ---------- стили и панель ---------- */
  document.head.append(h('style', { text: `
    iframe[src*="html5banner"]{display:none!important}
    #mal-panel{margin:10px 0;border:1px solid #f0b050;border-radius:6px;overflow:hidden;background:#fff3de;color:#6b4300;font:12px/1.35 Arial,sans-serif;text-align:left}
    #mal-panel *{box-sizing:border-box}
    #mal-panel .mal-head{display:flex;justify-content:space-between;align-items:center;padding:4px 10px;background:linear-gradient(#ffc969,#f8a931);color:#fff;font-weight:bold;font-size:13px;text-shadow:0 1px 0 rgba(120,70,0,.45)}
    #mal-panel .mal-head a{color:#fff;text-decoration:none;border-bottom:1px dotted #fff;font-weight:normal;font-size:12px}
    #mal-panel .mal-body{padding:8px 10px}
    #mal-panel a{color:#b86d00}
    #mal-panel .mal-row{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;margin:5px 0}
    #mal-panel .mal-btn{background:linear-gradient(#ffdc9b,#fbb94f);border:1px solid #e09a2e;color:#7a4600;font-weight:bold;font-size:12px;padding:3px 9px;border-radius:4px;cursor:pointer;text-shadow:0 1px 0 #ffeccb}
    #mal-panel .mal-btn:hover{filter:brightness(1.05)}
    #mal-panel .mal-btn:disabled{opacity:.55;cursor:default}
    #mal-panel .mal-btn.big{font-size:13px;padding:5px 14px}
    #mal-panel .mal-btn.ghost{background:#fbe8c8;border-color:#e8c68e;color:#8a5a10;font-weight:normal;text-shadow:none}
    #mal-panel .mal-card{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;margin:4px 0;border:1px solid #f0cd94;border-radius:4px;background:#fff9ee}
    #mal-panel .mal-card.best{border-color:#e2a03a;background:#fff0cf;box-shadow:inset 3px 0 0 #f0a020}
    #mal-panel .mal-meta{color:#98702c;font-size:11px}
    #mal-panel input[type=number],#mal-panel input[type=text],#mal-panel select{padding:2px 4px;border:1px solid #e0b567;border-radius:3px;background:#fffdf8;color:#5a3a00;font-size:12px}
    #mal-panel input[type=number]{width:50px}
    #mal-panel .mal-msg{font-size:12px}
    #mal-panel .mal-ok{color:#2f7d2f}#mal-panel .mal-err{color:#c02020}
    #mal-panel details{margin-top:4px;color:#98702c}
    #mal-panel summary{cursor:pointer;font-size:11px}
  ` }));

  const panel = h('div', { id: 'mal-panel' });
  const body = h('div');
  const track = h('div');
  panel.append(
    h('div', { class: 'mal-head' },
      h('span', { text: 'MyAnimeList' }),
      h('a', { href: searchUrl(), target: '_blank', rel: 'noopener', text: 'Поиск на MAL ↗' })),
    h('div', { class: 'mal-body' }, body, track));

  // вместо рекламного баннера (если он есть) — иначе под шапкой тайтла
  const ad = document.querySelector('iframe[src*="html5banner"], iframe[src*="loliland"]');
  if (ad) (ad.closest('center') || ad).replaceWith(panel);
  else (document.querySelector('.staticInfo') || h1).after(panel);

  /* ---------- выбор тайтла ---------- */
  const mapKey = 'map:' + postId;
  const offKey = 'off:' + postId;
  const candKey = 'cand:' + postId;

  function choose(id) { GM_setValue(mapKey, id); render(); }

  function pasteRow() {
    const inp = h('input', { type: 'text', placeholder: 'ссылка на страницу MAL', size: '30' });
    return h('div', { class: 'mal-row' }, inp,
      h('button', {
        class: 'mal-btn ghost', text: 'Указать',
        onclick: () => {
          const m = inp.value.match(/myanimelist\.net\/anime\/(\d+)/);
          if (m) choose(+m[1]); else inp.style.borderColor = 'red';
        },
      }),
      h('button', { class: 'mal-btn ghost', text: 'Искать заново', onclick: () => { GM_deleteValue(candKey); render(); } }));
  }

  function showCands(list) {
    list = list.map((a, i) => ({ a, i, s: scoreOf(a) })).sort((x, y) => y.s - x.s || x.i - y.i);
    body.textContent = '';
    if (!list.length) body.append(h('div', { class: 'mal-msg', text: 'Автоматически не нашлось — откройте «Поиск на MAL» и вставьте ссылку на нужную страницу.' }));
    list.forEach(({ a, s }, idx) => {
      const best = idx === 0 && s >= 3;
      const eng = a.eng && a.eng !== a.title ? ' · ' + a.eng : '';
      body.append(h('div', { class: 'mal-card' + (best ? ' best' : '') },
        h('div', null,
          h('a', { href: 'https://myanimelist.net/anime/' + a.id, target: '_blank', rel: 'noopener', text: a.title }),
          h('div', { class: 'mal-meta', text: `${(a.type || '?').toUpperCase()} · ${a.year || '?'} · ${a.eps ? a.eps : '?'} эп. · ★${a.score != null ? a.score : '–'}${eng}${best ? ' · похоже на оно' : ''}` })),
        h('button', { class: 'mal-btn', text: 'Это оно', onclick: () => choose(a.id) })));
    });
    body.append(pasteRow());
  }

  async function renderCandidates() {
    const c = GM_getValue(candKey);
    if (c && Date.now() - c.t < 12 * 3600 * 1000) { showCands(c.list); return; }
    body.textContent = 'Ищу на MAL…';
    let list = [];
    try { list = await findCandidates(); } catch (e) { /* ignore */ }
    if (list.length) GM_setValue(candKey, { t: Date.now(), list });
    showCands(list);
  }

  /* ---------- отметка серий ---------- */
  const STATUSES = [['', 'не в списке'], ['watching', 'Watching'], ['completed', 'Completed'], ['on_hold', 'On hold'], ['dropped', 'Dropped'], ['plan_to_watch', 'Plan to watch']];
  const epListeners = [];

  function currentEp() {
    const a = document.querySelector('#items .epizode.active');
    const n = a ? parseInt(a.textContent, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  const items = document.querySelector('#items');
  if (items) {
    new MutationObserver(() => epListeners.forEach((f) => f()))
      .observe(items, { attributes: true, subtree: true, childList: true, attributeFilter: ['class'] });
  }

  function buildTracker(id, data, state) {
    const total = data.total || 0;
    const ls = data.ls || {};
    const detKey = 'det:' + id;

    const statusSel = h('select', null, STATUSES.map(([v, t]) => h('option', { value: v, text: t })));
    statusSel.value = ls.status || '';
    const scoreSel = h('select', null, Array.from({ length: 11 }, (_, i) => h('option', { value: i, text: i === 0 ? '—' : i })));
    scoreSel.value = ls.score || 0;
    const watched = h('input', { type: 'number', min: '0', value: ls.num_episodes_watched || 0 });
    const offset = h('input', { type: 'number', value: GM_getValue(offKey, 0) });
    const msg = h('span', { class: 'mal-msg' });
    const hint = h('div', { class: 'mal-msg' });
    const markBtn = h('button', { class: 'mal-btn big' });
    const det = h('details', null,
      h('summary', { text: 'Нумерация не совпадает с MAL?' }),
      h('div', { class: 'mal-row' },
        'Сдвиг:', offset,
        h('span', { class: 'mal-meta', text: 'Нужен, если на animevost серии идут подряд (13–24), а на MAL это 2-й part (1–12): тогда 12.' })),
      hint);

    const say = (t, ok) => { msg.className = 'mal-msg ' + (ok ? 'mal-ok' : 'mal-err'); msg.textContent = t; };

    function normalize() {
      let w = Math.max(0, parseInt(watched.value, 10) || 0);
      if (total && w > total) w = total;
      watched.value = w;
      if (total && w >= total) statusSel.value = 'completed';
      else if (w > 0 && ['', 'plan_to_watch', 'completed'].includes(statusSel.value)) statusSel.value = 'watching';
    }

    let chain = Promise.resolve();
    function save() {
      state.dirty = true;
      chain = chain.then(async () => {
        const b = {
          status: statusSel.value || 'watching',
          score: scoreSel.value,
          num_watched_episodes: watched.value,
        };
        statusSel.value = b.status;
        say('Сохраняю…', true);
        try {
          const r = await malApi('PATCH', '/anime/' + id + '/my_list_status', b);
          data.ls = { status: r.status, score: r.score, num_episodes_watched: r.num_episodes_watched };
          GM_setValue(detKey, data);
          say('✓ Сохранено: ' + r.num_episodes_watched + (total ? '/' + total : '') + ' эп.', true);
        } catch (e) { say(e.message, false); }
      });
    }
    let timer;
    const saveLater = () => { state.dirty = true; clearTimeout(timer); timer = setTimeout(save, 700); };

    function updateMark() {
      const n = currentEp();
      const off = parseInt(offset.value, 10) || 0;
      if (n == null) { markBtn.disabled = true; markBtn.textContent = 'Выберите серию в плеере'; return; }
      markBtn.disabled = false;
      markBtn.textContent = '✓ Серия ' + n + ' просмотрена' + (off ? ' (на MAL: ' + (n - off) + ')' : '');
      if (total && n - off > total) {
        hint.className = 'mal-msg mal-err';
        hint.textContent = 'На MAL всего ' + total + ' эп., а у вас серия ' + (n - off) + ' — возможно, нужен сдвиг.';
        det.open = true;
      } else hint.textContent = '';
    }

    markBtn.addEventListener('click', () => {
      const n = currentEp();
      if (n == null) return;
      const m = n - (parseInt(offset.value, 10) || 0);
      if (m < 1) { say('Номер на MAL получился ' + m + ' — проверьте сдвиг.', false); det.open = true; return; }
      if (total && m > total) { say('На MAL всего ' + total + ' эп. — проверьте сдвиг.', false); det.open = true; return; }
      if (m < (parseInt(watched.value, 10) || 0) && !confirm('Это меньше текущего прогресса (' + watched.value + '). Уменьшить?')) return;
      watched.value = m;
      normalize();
      clearTimeout(timer);
      save();
    });

    statusSel.addEventListener('change', save);
    scoreSel.addEventListener('change', save);
    watched.addEventListener('change', () => { normalize(); saveLater(); });
    offset.addEventListener('change', () => { GM_setValue(offKey, parseInt(offset.value, 10) || 0); updateMark(); });
    epListeners.length = 0;
    epListeners.push(updateMark);
    updateMark();

    const step = (d) => () => { watched.value = (parseInt(watched.value, 10) || 0) + d; normalize(); saveLater(); };

    track.textContent = '';
    track.append(
      h('div', { class: 'mal-row' }, markBtn, msg),
      h('div', { class: 'mal-row' },
        'Статус', statusSel, 'Оценка', scoreSel, 'Серий',
        h('button', { class: 'mal-btn ghost', text: '−', onclick: step(-1) }),
        watched,
        h('button', { class: 'mal-btn ghost', text: '+', onclick: step(1) }),
        total ? '/ ' + total : ''),
      det);
  }

  async function renderChosen(id) {
    body.textContent = '';
    track.textContent = '';
    const link = h('a', { href: 'https://myanimelist.net/anime/' + id, target: '_blank', rel: 'noopener', text: 'MAL #' + id });
    body.append(h('div', { class: 'mal-row' }, link,
      h('button', { class: 'mal-btn ghost', text: 'Сменить', onclick: () => { GM_deleteValue(mapKey); render(); } })));
    const setTitle = (d) => { link.textContent = d.title + ' (' + (d.type || '?') + ', ' + (d.total ? d.total : '?') + ' эп.)'; };

    if (!GM_getValue('mal_client_id')) {
      track.append(h('div', { class: 'mal-row' }, 'Чтобы отмечать серии отсюда, подключите MAL: ',
        h('button', { class: 'mal-btn', text: 'Ввести Client ID', onclick: setupClientId })));
      return;
    }
    if (!GM_getValue('mal_tok')) {
      track.append(h('div', { class: 'mal-row' }, h('button', { class: 'mal-btn', text: 'Войти в MAL', onclick: login })));
      return;
    }

    const detKey = 'det:' + id;
    const state = { dirty: false };
    const cached = GM_getValue(detKey);
    if (cached) { setTitle(cached); buildTracker(id, cached, state); }
    else track.textContent = 'Загружаю ваш список…';

    try {
      const d = await malApi('GET', '/anime/' + id + '?fields=title,media_type,num_episodes,my_list_status');
      const data = { title: d.title, type: (d.media_type || '').toUpperCase(), total: d.num_episodes || 0, ls: d.my_list_status || {} };
      GM_setValue(detKey, data);
      setTitle(data);
      if (!state.dirty) buildTracker(id, data, state);
    } catch (e) {
      if (!cached) {
        track.textContent = '';
        track.append(h('div', { class: 'mal-msg mal-err', text: e.message === 'not-auth' ? 'Нужно заново войти в MAL (меню Tampermonkey → MAL: войти).' : e.message }));
      }
    }
  }

  /* ---------- запуск ---------- */
  function render() {
    epListeners.length = 0;
    track.textContent = '';
    const id = GM_getValue(mapKey);
    if (id) renderChosen(id); else renderCandidates();
  }
  render();
})();
