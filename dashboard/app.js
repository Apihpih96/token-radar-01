// dashboard/app.js — board rendering, filtering, detail view
(function () {
  'use strict';

  const data = window.RADAR;
  if (!data || !data.rows) { console.error('RADAR data not loaded'); return; }

  const rows = data.rows;
  const model = data.model;
  const meta = data.meta;
  const watchSet = new Set();

  // Build watch set from rows that are in the watchlist (we need to know which are watchlisted)
  // The data.js carries watchlist indirectly; we infer from the meta or check if slug is in top
  // Actually, we need the watchlist. Let's mark rows that are in the watchlist.
  // The snapshot watchlist is available through meta if we passed it. Let me add it.
  // For now, we'll derive: all rows are pre-token, and the watchlist is known from the kit.
  // We need to pass watchlist to data.js. Let me handle this in the data for now.
  // The watchlist slugs are not directly in RADAR, so we check: if a row has tvl >= floor
  // and is pre-token, it might be on the watchlist. But we need exact.
  // Simple approach: embed watchlist in meta. main.ts should add it. Let me check.
  // main.ts writes meta: { as_of, floor, watchlist_size, total_pre_token } but NOT watchlist array.
  // I need to add it. For now, let me add a watchlist marker in data.js from main.ts.
  // Since data.js is generated, let me just mark watchlist rows in the row data.
  // I'll update main.ts later. For now, let's add it here by re-checking.
  // Actually, the simplest: check against the known 40 slugs. But that violates "no hardcoded names".
  // Better: main.ts should pass the watchlist. Let me add it.
  // I'll add watchlist to meta in main.ts. But I can't edit main.ts right now in the same turn...
  // Actually I can. Let me handle this properly: add watchlist to meta.
  // For now in app.js, I'll check: if meta.watchlist is an array, use it. Otherwise skip.

  // Reconstruct watchlist from the model: protocols with tvl >= floor that have no token
  // are potentially on the watchlist. But this is imprecise. Let me just embed it.
  // I'll fix main.ts to add watchlist to meta. For now, create the watchSet from meta if present.
  if (Array.isArray(meta.watchlist)) {
    meta.watchlist.forEach(s => watchSet.add(s));
  }

  // State
  let currentSort = { key: 'rank', dir: 'asc' };
  let searchQuery = '';
  let categoryFilter = '';
  let chainFilter = '';
  let watchlistOnly = false;

  // DOM refs
  const tbody = document.getElementById('board-body');
  const searchInput = document.getElementById('search');
  const categorySelect = document.getElementById('category-filter');
  const chainSelect = document.getElementById('chain-filter');
  const watchlistToggle = document.getElementById('watchlist-toggle');
  const resetBtn = document.getElementById('btn-reset');
  const metaInfo = document.getElementById('meta-info');
  const countBadge = document.getElementById('count-badge');
  const footerDate = document.getElementById('footer-date');
  const detailPanel = document.getElementById('detail-panel');
  const detailContent = document.getElementById('detail-content');
  const detailClose = document.getElementById('detail-close');

  // Populate filters
  const categories = new Set(rows.map(r => r.category).filter(Boolean));
  const allChains = new Set();
  rows.forEach(r => r.chains.forEach(c => allChains.add(c)));

  [...categories].sort().forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    categorySelect.appendChild(opt);
  });
  [...allChains].sort().forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    chainSelect.appendChild(opt);
  });

  // Helpers
  function fmtUSD(v) {
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(1) + 'T';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toLocaleString();
  }

  function fmtChange(v) {
    if (v === null || v === undefined) return { text: '—', cls: 'change-neutral' };
    const sign = v >= 0 ? '+' : '';
    return { text: sign + v.toFixed(2) + '%', cls: v > 0 ? 'change-positive' : v < 0 ? 'change-negative' : 'change-neutral' };
  }

  function fmtDays(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    const now = new Date(meta.as_of);
    const days = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    return days + ' days';
  }

  // Recompute implied value from model (TVL-anchored, score-dependent multiplier)
  // Formula: value = tvl_usd × (VALUE_MULT_MIN + (VALUE_MULT_MAX - VALUE_MULT_MIN) × normalized_score)
  function recomputeValue(row) {
    const p = model.params;
    const multMin = p.value_mult_min || 0.03;
    const multMax = p.value_mult_max || 0.47;
    const normalized = (row.score - p.minScore) / (p.maxScore - p.minScore);
    const mult = multMin + (multMax - multMin) * normalized;
    return Math.max(1, Math.round(row.tvl_usd * mult));
  }

  // Filter and sort
  function getFiltered() {
    let filtered = rows;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q) ||
        (r.category && r.category.toLowerCase().includes(q))
      );
    }
    if (categoryFilter) {
      filtered = filtered.filter(r => r.category === categoryFilter);
    }
    if (chainFilter) {
      filtered = filtered.filter(r => r.chains.includes(chainFilter));
    }
    if (watchlistOnly) {
      filtered = filtered.filter(r => watchSet.has(r.slug));
    }
    // Sort
    const key = currentSort.key;
    const dir = currentSort.dir === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      let va = a[key], vb = b[key];
      if (va === null) va = -Infinity;
      if (vb === null) vb = -Infinity;
      if (typeof va === 'string') {
        return dir * va.localeCompare(vb);
      }
      return dir * (va - vb);
    });
    return filtered;
  }

  function renderTable() {
    const filtered = getFiltered();
    tbody.innerHTML = '';

    if (filtered.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="8" style="text-align:center;padding:40px;color:var(--text-faint)">No protocols match the current filters.</td>';
      tbody.appendChild(tr);
      countBadge.textContent = '0 / ' + rows.length;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const row of filtered) {
      const tr = document.createElement('tr');
      if (watchSet.has(row.slug)) tr.classList.add('watchlist');
      const change = fmtChange(row.change_7d);
      const recomputed = recomputeValue(row);
      tr.innerHTML =
        '<td class="rank-cell' + (row.rank <= 3 ? ' rank-' + row.rank : '') + '">' + row.rank + '</td>' +
        '<td class="name-cell">' + escHtml(row.name) + '</td>' +
        '<td class="category-cell">' + escHtml(row.category || '—') + '</td>' +
        '<td class="tvl-cell">' + fmtUSD(row.tvl_usd) + '</td>' +
        '<td class="' + change.cls + '">' + change.text + '</td>' +
        '<td class="value-cell">' + fmtUSD(recomputed) + '</td>' +
        '<td class="chains-cell">' + escHtml(row.chains.slice(0, 3).join(', ')) + (row.chains.length > 3 ? ' +' + (row.chains.length - 3) : '') + '</td>' +
        '<td class="farm-count">' + row.farm_steps.length + ' steps</td>';
      tr.addEventListener('click', () => showDetail(row));
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    countBadge.textContent = filtered.length + ' / ' + rows.length;
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // Sort headers
  document.querySelectorAll('#board-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (currentSort.key === key) {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.key = key;
        currentSort.dir = key === 'rank' ? 'asc' : (key === 'implied_value_usd' || key === 'tvl_usd') ? 'desc' : 'asc';
      }
      document.querySelectorAll('#board-table th').forEach(t => t.classList.remove('sorted-asc', 'sorted-desc'));
      th.classList.add(currentSort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      renderTable();
    });
  });

  // Filters
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim();
    updateHash();
    renderTable();
  });

  categorySelect.addEventListener('change', () => {
    categoryFilter = categorySelect.value;
    updateHash();
    renderTable();
  });

  chainSelect.addEventListener('change', () => {
    chainFilter = chainSelect.value;
    updateHash();
    renderTable();
  });

  watchlistToggle.addEventListener('change', () => {
    watchlistOnly = watchlistToggle.checked;
    updateHash();
    renderTable();
  });

  resetBtn.addEventListener('click', () => {
    searchQuery = ''; searchInput.value = '';
    categoryFilter = ''; categorySelect.value = '';
    chainFilter = ''; chainSelect.value = '';
    watchlistOnly = false; watchlistToggle.checked = false;
    currentSort = { key: 'rank', dir: 'asc' };
    document.querySelectorAll('#board-table th').forEach(t => t.classList.remove('sorted-asc', 'sorted-desc'));
    document.querySelector('th[data-sort="rank"]').classList.add('sorted-asc');
    updateHash();
    renderTable();
  });

  // Detail view
  function showDetail(row) {
    const change = fmtChange(row.change_7d);
    const recomputed = recomputeValue(row);
    const isWatch = watchSet.has(row.slug);
    const factors = [
      { label: 'TVL (log scale)', value: row.tvl_score, cls: 'factor-tvl' },
      { label: '7d Growth', value: row.growth_score, cls: 'factor-growth' },
      { label: 'Age', value: row.age_score, cls: 'factor-age' },
      { label: 'Chain Diversity', value: row.chain_score, cls: 'factor-chain' },
      { label: 'Category', value: row.category_score, cls: 'factor-category' },
    ];

    let html = '';
    html += '<div class="detail-name">' + escHtml(row.name) + (isWatch ? ' <span style="font-size:12px;color:var(--accent)">Watchlist</span>' : '') + '</div>';
    html += '<div class="detail-slug">' + escHtml(row.slug) + ' · Rank #' + row.rank + '</div>';

    html += '<div class="detail-grid">';
    html += '<div class="detail-metric"><div class="detail-metric-label">TVL</div><div class="detail-metric-value">' + fmtUSD(row.tvl_usd) + '</div></div>';
    html += '<div class="detail-metric"><div class="detail-metric-label">7d Change</div><div class="detail-metric-value ' + change.cls + '">' + change.text + '</div></div>';
    html += '<div class="detail-metric"><div class="detail-metric-label">Implied Value</div><div class="detail-metric-value">' + fmtUSD(recomputed) + '</div></div>';
    html += '<div class="detail-metric"><div class="detail-metric-label">Listed</div><div class="detail-metric-value" style="font-size:14px">' + fmtDays(row.listed_at) + '</div></div>';
    html += '</div>';

    // Factor breakdown
    html += '<div class="detail-section-title">Score Breakdown</div>';
    html += '<div class="factor-bar">';
    factors.forEach(f => {
      html += '<div class="factor-segment ' + f.cls + '" style="width:' + (f.value * 100) + '%"></div>';
    });
    html += '</div>';
    html += '<div class="factor-legend">';
    factors.forEach(f => {
      const cls = f.cls.replace('factor-', 'fl-');
      html += '<span class="' + cls + '">' + f.label + ': ' + (f.value * 100).toFixed(0) + '%</span>';
    });
    html += '</div>';

    // Chains
    html += '<div class="detail-section-title">Chains (' + row.chains.length + ')</div>';
    html += '<div class="detail-chains">';
    row.chains.forEach(c => { html += '<span class="chain-tag">' + escHtml(c) + '</span>'; });
    html += '</div>';

    // Farm steps
    html += '<div class="detail-section-title">Farm Plan (' + row.farm_steps.length + ' steps)</div>';
    html += '<ol class="farm-steps">';
    row.farm_steps.forEach((step, i) => {
      html += '<li><strong>Step ' + (i + 1) + ':</strong> ' + escHtml(step) + '</li>';
    });
    html += '</ol>';

    detailContent.innerHTML = html;
    detailPanel.classList.remove('hidden');
    window.location.hash = 'detail=' + row.slug;
  }

  function hideDetail() {
    detailPanel.classList.add('hidden');
    detailContent.innerHTML = '';
    if (window.location.hash.startsWith('#detail=')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  detailClose.addEventListener('click', hideDetail);
  detailPanel.addEventListener('click', (e) => { if (e.target === detailPanel) hideDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideDetail(); });

  // Deep links
  function updateHash() {
    let hash = '';
    if (searchQuery) hash += (hash ? '&' : '') + 'filter=' + encodeURIComponent(searchQuery);
    window.location.hash = hash;
  }

  function loadHash() {
    const h = window.location.hash.slice(1);
    if (!h) return;
    const params = new URLSearchParams(h);
    const filter = params.get('filter');
    if (filter) {
      searchQuery = filter;
      searchInput.value = filter;
    }
    const detail = params.get('detail');
    if (detail) {
      const row = rows.find(r => r.slug === detail);
      if (row) showDetail(row);
    }
  }

  // Meta
  const exclusionNoteEl = document.getElementById('exclusion-note');
  metaInfo.textContent = 'As of ' + meta.as_of + ' · Floor $' + (meta.floor / 1e6).toFixed(0) + 'M';
  footerDate.textContent = meta.as_of;
  if (meta.exclusion_note && exclusionNoteEl) {
    exclusionNoteEl.textContent = meta.exclusion_note;
  }

  // Init
  loadHash();
  renderTable();
})();
