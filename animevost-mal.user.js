// ==UserScript==
// @name         Animevost → MyAnimeList
// @namespace    animevost-mal
// @version      1.0
// @description  Находит аниме на MAL по названию с animevost, показывает карточки-кандидаты и даёт отмечать серии прямо на странице
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
      timeout: 20000,
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
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: form({
          client_id: GM_getValue('mal_client_id', ''),
          grant_type: 'authorization_code',
          code: p.get('code'),
          code_verifier: saved.verifier,
          redirect_uri: REDIRECT,
        }),
      });
      if (r.status !== 200) throw new Error('token ' + r.status + ' ' + r.responseText);
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
  GM_registerMenuCommand('MAL: войти', login);
  GM_registerMenuCommand('MAL: выйти', () => { GM_deleteValue('mal_tok'); location.reload(); });

  async function refreshTok() {
    const t = GM_getValue('mal_tok');
    if (!t) throw new Error('not-auth');
    const r = await gm({
      method: 'POST',
      url: TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: form({
        client_id: GM_getValue('mal_client_id', ''),
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token,
      }),
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
    eps: parseInt(field('Количество серий'), 10) || null,
  };

  const TYPE_MAP = {
    'ТВ': ['TV'],
    'ТВ-спэшл': ['TV Special', 'Special'],
    'OVA': ['OVA'],
    'ONA': ['ONA'],
    'Полнометражный фильм': ['Movie'],
    'Короткометражный фильм': ['Movie', 'Special', 'ONA'],
    'Дунхуа': ['ONA', 'TV'],
  };

  function buildQueries() {
    const clean = (s) => s.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = clean(h1.textContent).split(/\s+\/\s+/).map((s) => s.trim()).filter(Boolean);
    const latin = parts.filter((p) => /[A-Za-z]/.test(p) && !/[А-Яа-яЁё]/.test(p));
    const q = [];
    const add = (s) => { s = (s || '').replace(/\s+/g, ' ').trim(); if (s.length >= 3 && !q.includes(s)) q.push(s); };

    const main = latin.length ? latin[latin.length - 1] : '';
    add(main);
    add(main.replace(/\(\d{4}\)/g, ''));                 // Ranma ½ (2024) 3rd Season -> без года
    if (h4) {
      const t = h4.textContent.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]/.test(t)) {
        add(t.split(/\.\s/)[0]);                           // первое предложение (до подзаголовка)
        add(t.split(' ').slice(0, 7).join(' '));           // первые слова
      }
    }
    add(main.split(' ').slice(0, 6).join(' '));
    if (!q.length) add(parts[parts.length - 1]);
    return q;
  }

  const queries = buildQueries();
  const searchUrl = () => 'https://myanimelist.net/anime.php?cat=anime&q=' + encodeURIComponent(queries[0] || h1.textContent);

  /* ---------- Jikan ---------- */
  async function jikanGet(url) {
    for (let i = 0; i < 2; i++) {
      const r = await gm({ method: 'GET', url, headers: { Accept: 'application/json' } });
      if (r.status === 429) { await sleep(1300); continue; }
      if (r.status !== 200) return null;
      return JSON.parse(r.responseText).data;
    }
    return null;
  }

  async function findCandidates() {
    const seen = new Map();
    for (const q of queries) {
      const res = (await jikanGet(JIKAN + '?' + form({ q, limit: 6 }))) || [];
      res.forEach((a) => { if (!seen.has(a.mal_id)) seen.set(a.mal_id, a); });
      if (seen.size >= 5) break;
      await sleep(450);
    }
    return [...seen.values()];
  }

  function scoreOf(a) {
    let s = 0;
    const y = a.year || (a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year);
    if (info.year && y === info.year) s += 2;
    else if (info.year && y && Math.abs(y - info.year) === 1) s += 0.5;
    if ((TYPE_MAP[info.type] || []).includes(a.type)) s += 1;
    return s;
  }

  /* ---------- стили и панель ---------- */
  document.head.append(h('style', { text: `
    #mal-panel{background:#fff7ea;border:1px solid #feb94f;border-radius:6px;margin:10px 0;padding:10px 12px;font:13px/1.4 Arial,sans-serif;color:#5a3a00}
    #mal-panel a{color:#c47504}
    #mal-panel .mal-head{display:flex;justify-content:space-between;align-items:center;font-weight:bold;font-size:14px;margin-bottom:6px}
    #mal-panel .mal-btn{background:#ffb84d;border:0;color:#fff;font-weight:bold;padding:4px 10px;border-radius:4px;cursor:pointer}
    #mal-panel .mal-btn:disabled{opacity:.5;cursor:default}
    #mal-panel .mal-btn.ghost{background:#eee;color:#555}
    #mal-panel .mal-card{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;margin:3px 0;border:1px solid #f2d3a0;border-radius:4px;background:#fff}
    #mal-panel .mal-card.best{border-color:#3a9a3a;background:#f2fff2}
    #mal-panel .mal-meta{color:#8a6a30;font-size:12px}
    #mal-panel .mal-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0}
    #mal-panel input[type=number],#mal-panel input[type=text],#mal-panel select{padding:2px 4px;border:1px solid #d9b26a;border-radius:3px}
    #mal-panel input[type=number]{width:54px}
    #mal-panel .mal-msg{min-height:16px;font-size:12px}
    #mal-panel .mal-ok{color:#2a7a2a}#mal-panel .mal-err{color:#c02020}
  ` }));

  const panel = h('div', { id: 'mal-panel' });
  const body = h('div');
  const track = h('div');
  panel.append(
    h('div', { class: 'mal-head' },
      h('span', { text: 'MyAnimeList' }),
      h('a', { href: searchUrl(), target: '_blank', rel: 'noopener', text: 'Поиск на MAL ↗' })),
    body, track);
  (document.querySelector('.staticInfo') || h1).after(panel);

  /* ---------- выбор тайтла ---------- */
  const mapKey = 'map:' + postId;
  const offKey = 'off:' + postId;

  function choose(id) { GM_setValue(mapKey, id); render(); }

  function pasteRow() {
    const inp = h('input', { type: 'text', placeholder: 'ссылка на MAL, если не нашлось', size: '34' });
    return h('div', { class: 'mal-row' }, inp,
      h('button', {
        class: 'mal-btn ghost', text: 'Указать',
        onclick: () => {
          const m = inp.value.match(/myanimelist\.net\/anime\/(\d+)/);
          if (m) choose(+m[1]); else inp.style.borderColor = 'red';
        },
      }));
  }

  async function renderCandidates() {
    body.textContent = 'Ищу на MAL…';
    let list = [];
    try { list = await findCandidates(); } catch (e) { /* ignore */ }
    list = list.map((a, i) => ({ a, i, s: scoreOf(a) })).sort((x, y) => y.s - x.s || x.i - y.i);
    body.textContent = '';
    if (!list.length) body.append(h('div', { class: 'mal-msg', text: 'Ничего не нашлось автоматически — попробуйте «Поиск на MAL» или вставьте ссылку.' }));
    list.forEach(({ a, s }, idx) => {
      const best = idx === 0 && s >= 3;
      const y = a.year || (a.aired && a.aired.prop && a.aired.prop.from && a.aired.prop.from.year) || '?';
      const eng = a.title_english && a.title_english !== a.title ? ' · ' + a.title_english : '';
      body.append(h('div', { class: 'mal-card' + (best ? ' best' : '') },
        h('div', null,
          h('a', { href: a.url, target: '_blank', rel: 'noopener', text: a.title }),
          h('div', { class: 'mal-meta', text: `${a.type || '?'} · ${y} · ${a.episodes != null ? a.episodes : '?'} эп. · ★${a.score != null ? a.score : '–'}${eng}${best ? ' · похоже на оно' : ''}` })),
        h('button', { class: 'mal-btn', text: 'Это оно', onclick: () => choose(a.mal_id) })));
    });
    body.append(pasteRow());
  }

  async function renderChosen(id) {
    body.textContent = '';
    const link = h('a', { href: 'https://myanimelist.net/anime/' + id, target: '_blank', rel: 'noopener', text: 'MAL #' + id });
    body.append(h('div', { class: 'mal-row' }, link,
      h('button', { class: 'mal-btn ghost', text: 'Сменить', onclick: () => { GM_deleteValue(mapKey); render(); } })));
    jikanGet(JIKAN + '/' + id).then((a) => { if (a) link.textContent = a.title + ' (' + (a.type || '?') + ', ' + (a.episodes != null ? a.episodes : '?') + ' эп.)'; }).catch(() => {});
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

  async function renderTracker(id) {
    track.textContent = '';
    if (!GM_getValue('mal_client_id')) {
      track.append(h('div', { class: 'mal-row' }, 'Чтобы отмечать серии отсюда, подключите MAL: ',
        h('button', { class: 'mal-btn', text: 'Ввести Client ID', onclick: setupClientId })));
      return;
    }
    if (!GM_getValue('mal_tok')) {
      track.append(h('div', { class: 'mal-row' }, h('button', { class: 'mal-btn', text: 'Войти в MAL', onclick: login })));
      return;
    }
    track.append('Загружаю ваш список…');
    let d;
    try {
      d = await malApi('GET', '/anime/' + id + '?fields=num_episodes,my_list_status');
    } catch (e) {
      track.textContent = '';
      track.append(h('div', { class: 'mal-msg mal-err', text: e.message === 'not-auth' ? 'Нужно заново войти в MAL (меню Tampermonkey → MAL: войти).' : e.message }));
      return;
    }
    const ls = d.my_list_status || {};
    const total = d.num_episodes || 0;

    const statusSel = h('select', null, STATUSES.map(([v, t]) => h('option', { value: v, text: t })));
    statusSel.value = ls.status || '';
    const scoreSel = h('select', null, Array.from({ length: 11 }, (_, i) => h('option', { value: i, text: i === 0 ? '—' : i })));
    scoreSel.value = ls.score || 0;
    const watched = h('input', { type: 'number', min: '0', value: ls.num_episodes_watched || 0 });
    const offset = h('input', { type: 'number', value: GM_getValue(offKey, 0), title: 'Если на animevost нумерация сквозная (13–24), а на MAL part 2 (1–12): сдвиг 12' });
    const msg = h('div', { class: 'mal-msg' });
    const markBtn = h('button', { class: 'mal-btn' });

    const say = (t, ok) => { msg.className = 'mal-msg ' + (ok ? 'mal-ok' : 'mal-err'); msg.textContent = t; };

    async function save() {
      const b = {
        status: statusSel.value || 'watching',
        score: scoreSel.value,
        num_watched_episodes: watched.value,
      };
      statusSel.value = b.status;
      try {
        const r = await malApi('PATCH', '/anime/' + id + '/my_list_status', b);
        say('Сохранено: ' + r.status + ', серий ' + r.num_episodes_watched + (total ? '/' + total : '') + ' ✓', true);
      } catch (e) { say(e.message, false); }
    }

    function updateMark() {
      const n = currentEp();
      const off = parseInt(offset.value, 10) || 0;
      if (n == null) { markBtn.disabled = true; markBtn.textContent = 'Выберите серию в плеере'; return; }
      markBtn.disabled = false;
      markBtn.textContent = '✓ Серия ' + n + ' просмотрена' + (off ? ' (MAL: ' + (n - off) + ')' : '');
    }

    markBtn.addEventListener('click', async () => {
      const n = currentEp();
      if (n == null) return;
      const m = n - (parseInt(offset.value, 10) || 0);
      if (m < 1) { say('Номер на MAL получился ' + m + ' — проверьте сдвиг.', false); return; }
      if (total && m > total) { say('На MAL всего ' + total + ' эп. — проверьте сдвиг нумерации.', false); return; }
      if (m < (parseInt(watched.value, 10) || 0) && !confirm('Это меньше текущего прогресса (' + watched.value + '). Уменьшить?')) return;
      watched.value = m;
      if (!statusSel.value || statusSel.value === 'plan_to_watch') statusSel.value = 'watching';
      if (total && m >= total) statusSel.value = 'completed';
      await save();
    });
    offset.addEventListener('change', () => { GM_setValue(offKey, parseInt(offset.value, 10) || 0); updateMark(); });
    epListeners.length = 0;
    epListeners.push(updateMark);
    updateMark();

    track.textContent = '';
    track.append(
      h('div', { class: 'mal-row' }, markBtn),
      h('div', { class: 'mal-row' },
        'Статус', statusSel, 'Оценка', scoreSel, 'Серий',
        h('button', { class: 'mal-btn ghost', text: '−', onclick: () => { watched.value = Math.max(0, (+watched.value || 0) - 1); } }),
        watched,
        h('button', { class: 'mal-btn ghost', text: '+', onclick: () => { watched.value = (+watched.value || 0) + 1; } }),
        total ? '/ ' + total : '',
        h('button', { class: 'mal-btn', text: 'Сохранить', onclick: save }),
        'Сдвиг', offset),
      msg);
  }

  /* ---------- запуск ---------- */
  function render() {
    track.textContent = '';
    const id = GM_getValue(mapKey);
    if (id) { renderChosen(id); renderTracker(id); } else { renderCandidates(); }
  }
  render();
})();
