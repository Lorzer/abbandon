/**
 * ABBADON - Frontend Logic
 */

// ---- State ----
let gameState = null;
let hexagons = [];
let config = null;
let editConfig = null; // working copy bound to the config controls
let selectedHex = null;
let ws = null;
let overlayMode = 'population';
let popHistory = []; // [{ round, total }]

const canvas = document.getElementById('hexCanvas');
const ctx = canvas.getContext('2d');
const spark = document.getElementById('sparkline');

// ---- Config schema (curated subset of SimConfig) ----
const CONFIG_GROUPS = [
  {
    title: 'Simulation',
    items: [
      { path: 'seed', label: 'Seed', min: 1, max: 9999, step: 1, int: true, reinit: true },
      { path: 'totalRounds', label: 'Total rounds', min: 12, max: 240, step: 12, int: true },
      { path: 'useLLM', label: 'Use LLM director', type: 'bool' },
    ],
  },
  {
    title: 'Pacing',
    items: [
      { path: 'consumption.perCapitaTonsPerMonth', label: 'Food / person·mo (t)', min: 0.0005, max: 0.005, step: 0.0005 },
      { path: 'production.urbanBaselineSupplyTons', label: 'Urban supply (t/mo)', min: 0, max: 120, step: 5 },
      { path: 'production.urbanBaselineSupplyDecay', label: 'Supply decay /round', min: 0.5, max: 1, step: 0.01 },
      { path: 'production.farmersNeeded', label: 'Farmers needed', min: 0, max: 1000, step: 50, int: true },
    ],
  },
  {
    title: 'Force weights',
    items: [
      { path: 'forces.foodSurplus.weight', label: 'Food surplus →', min: 0, max: 2, step: 0.1 },
      { path: 'forces.foodShortage.weight', label: 'Food shortage ⊘', min: 0, max: 3, step: 0.1 },
      { path: 'forces.waterAttract.weight', label: 'Water →', min: 0, max: 2, step: 0.1 },
      { path: 'forces.waterShortage.weight', label: 'Water shortage ⊘', min: 0, max: 3, step: 0.1 },
      { path: 'forces.security.weight', label: 'Security ±', min: 0, max: 2, step: 0.1 },
      { path: 'forces.infraAttract.weight', label: 'Infrastructure →', min: 0, max: 2, step: 0.1 },
      { path: 'forces.infraCollapse.weight', label: 'Infra collapse ⊘', min: 0, max: 3, step: 0.1 },
      { path: 'forces.overcrowding.weight', label: 'Overcrowding ⊘', min: 0, max: 2, step: 0.1 },
    ],
  },
  {
    title: 'Migration',
    items: [
      { path: 'migration.maxLeavePct', label: 'Max leave /round', min: 0, max: 0.5, step: 0.01 },
      { path: 'migration.leaveNetThreshold', label: 'Leave threshold (net)', min: -100, max: 0, step: 5, int: true },
      { path: 'migration.leaveScale', label: 'Leave scale', min: 100, max: 1000, step: 50, int: true },
      { path: 'migration.transitMortality', label: 'Transit mortality', min: 0, max: 0.3, step: 0.01 },
    ],
  },
  {
    title: 'Decay & Starvation',
    items: [
      { path: 'decay.baseInfraPct', label: 'Infra decay %/mo', min: 0, max: 3, step: 0.1 },
      { path: 'starvation.deathRate', label: 'Starvation death rate', min: 0, max: 0.5, step: 0.01 },
      { path: 'starvation.foodThresholdTons', label: 'Starvation threshold (t)', min: 0, max: 5, step: 0.1 },
    ],
  },
];

// ---- Path helpers ----
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof o[keys[i]] !== 'object' || o[keys[i]] === null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

// ---- WebSocket ----
function connectWebSocket() {
  ws = new WebSocket(`ws://${window.location.host}`);
  ws.onopen = () => logToConsole('Connected to server');
  ws.onmessage = (event) => handleWebSocketMessage(JSON.parse(event.data));
  ws.onerror = () => logToConsole('Connection error');
  ws.onclose = () => {
    logToConsole('Disconnected - retrying...');
    setTimeout(connectWebSocket, 2000);
  };
}

function handleWebSocketMessage(message) {
  const d = message.data || {};
  switch (message.type) {
    case 'init':
      gameState = d.gameState;
      hexagons = d.hexagons;
      if (d.config) setConfig(d.config);
      resetPopHistory();
      renderAll();
      logToConsole('Simulation initialized');
      break;
    case 'update':
      gameState = d.gameState;
      hexagons = d.hexagons;
      pushPopPoint();
      renderAll();
      if (d.events && d.events.length) logToConsole(`Round ${gameState.current_round}: ${d.events[0].description}`);
      break;
    case 'reset':
      gameState = d.gameState;
      hexagons = d.hexagons;
      if (d.config) setConfig(d.config);
      selectedHex = null;
      resetPopHistory();
      renderAll();
      clearConsole();
      logToConsole('Simulation reset');
      document.getElementById('playBtn').disabled = false;
      document.getElementById('stepBtn').disabled = false;
      break;
    case 'complete':
      gameState = d.gameState;
      renderStats();
      logToConsole('Simulation complete');
      document.getElementById('playBtn').disabled = true;
      document.getElementById('stepBtn').disabled = true;
      setPlaying(false);
      break;
  }
}

function setConfig(cfg) {
  config = cfg;
  editConfig = structuredClone(cfg);
  renderConfig();
}

function renderAll() {
  updateRewindMax();
  renderStats();
  drawSparkline();
  drawHexGrid();
  if (selectedHex) {
    const hex = hexagons.find((h) => h.id === selectedHex.id);
    if (hex) displayHexDetails(hex);
  }
}

// ---- Stats ----
function initialPopulation() {
  if (!config) return gameState ? gameState.total_population : 0;
  const w = config.world;
  const total = w.gridSize * w.gridSize;
  return w.urbanCount * w.urban.population + (total - w.urbanCount) * w.rural.population;
}

function renderStats() {
  if (!gameState) return;
  const el = document.getElementById('statsContent');
  const init = initialPopulation();
  const urban = hexagons.filter((h) => h.type === 'urban').reduce((s, h) => s + h.population, 0);
  const rural = hexagons.filter((h) => h.type === 'rural').reduce((s, h) => s + h.population, 0);
  const total = urban + rural;
  const remaining = init > 0 ? (total / init) * 100 : 0;
  const avgInfra =
    hexagons.reduce((s, h) => s + (h.infrastructure_power + h.infrastructure_water + h.infrastructure_roads) / 3, 0) /
    (hexagons.length || 1);
  const avgWater = hexagons.reduce((s, h) => s + h.water_availability, 0) / (hexagons.length || 1);
  const totalRounds = config ? config.totalRounds : 60;

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><div class="stat-label">Round</div><div class="stat-value">${gameState.current_round} <span class="stat-sub">/ ${totalRounds}</span></div></div>
      <div class="stat"><div class="stat-label">Population</div><div class="stat-value">${fmt(total)}</div><div class="stat-sub">${remaining.toFixed(1)}% of start</div></div>
      <div class="stat full"><div class="stat-label">Urban vs Rural</div>
        <div class="stat-value" style="font-size:0.9rem">${fmt(urban)} urban · ${fmt(rural)} rural</div>
        <div class="bar"><span style="width:${total ? (urban / total) * 100 : 0}%; background:#d17a22"></span></div>
      </div>
      <div class="stat"><div class="stat-label">Food</div><div class="stat-value">${fmt(Math.floor(gameState.total_food_tons))}<span class="stat-sub"> t</span></div></div>
      <div class="stat"><div class="stat-label">Deaths</div><div class="stat-value">${fmt(gameState.total_deaths)}</div><div class="stat-sub">${fmt(gameState.deaths_starvation)} starv · ${fmt(gameState.deaths_transit)} transit</div></div>
      <div class="stat"><div class="stat-label">Avg infrastructure</div><div class="stat-value">${avgInfra.toFixed(0)}%</div></div>
      <div class="stat"><div class="stat-label">Avg water</div><div class="stat-value">${avgWater.toFixed(0)}%</div></div>
    </div>`;
}

function resetPopHistory() {
  popHistory = [{ round: 0, total: initialPopulation() }];
  if (gameState && gameState.current_round > 0) pushPopPoint();
}
function pushPopPoint() {
  if (!gameState) return;
  const total = hexagons.reduce((s, h) => s + h.population, 0);
  popHistory.push({ round: gameState.current_round, total });
  if (popHistory.length > 500) popHistory.shift();
}
function drawSparkline() {
  const w = (spark.width = spark.clientWidth || 300);
  const h = spark.height;
  const sctx = spark.getContext('2d');
  sctx.clearRect(0, 0, w, h);
  if (popHistory.length < 2) return;
  const maxV = initialPopulation() || Math.max(...popHistory.map((p) => p.total));
  const n = popHistory.length;
  sctx.beginPath();
  popHistory.forEach((p, i) => {
    const x = (i / (n - 1)) * (w - 2) + 1;
    const y = h - (p.total / maxV) * (h - 4) - 2;
    i === 0 ? sctx.moveTo(x, y) : sctx.lineTo(x, y);
  });
  sctx.strokeStyle = '#ff6b35';
  sctx.lineWidth = 2;
  sctx.stroke();
  // fill under the line
  sctx.lineTo(w - 1, h);
  sctx.lineTo(1, h);
  sctx.closePath();
  sctx.fillStyle = 'rgba(255,107,53,0.15)';
  sctx.fill();
}

// ---- Config panel ----
function renderConfig() {
  if (!editConfig) return;
  const root = document.getElementById('configContent');
  root.innerHTML = '';
  for (const group of CONFIG_GROUPS) {
    const g = document.createElement('div');
    g.className = 'config-group';
    g.innerHTML = `<div class="config-group-title">${group.title}</div>`;
    for (const item of group.items) g.appendChild(buildConfigRow(item));
    root.appendChild(g);
  }
}

function buildConfigRow(item) {
  const row = document.createElement('div');
  row.className = 'config-row';
  const value = getPath(editConfig, item.path);

  const label = document.createElement('label');
  label.textContent = item.label;
  if (item.reinit) {
    const tag = document.createElement('span');
    tag.className = 'reinit-tag';
    tag.textContent = 'world';
    label.appendChild(tag);
  }
  row.appendChild(label);

  const ctl = document.createElement('div');
  ctl.className = 'ctl';

  if (item.type === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!value;
    cb.addEventListener('change', () => {
      setPath(editConfig, item.path, cb.checked);
      markDirty(row, item);
    });
    ctl.appendChild(cb);
  } else {
    const range = document.createElement('input');
    range.type = 'range';
    range.min = item.min;
    range.max = item.max;
    range.step = item.step;
    range.value = value;

    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'num';
    num.min = item.min;
    num.max = item.max;
    num.step = item.step;
    num.value = value;

    const apply = (v) => {
      let n = item.int ? Math.round(Number(v)) : Number(v);
      if (!Number.isFinite(n)) return;
      setPath(editConfig, item.path, n);
      range.value = n;
      num.value = n;
      markDirty(row, item);
    };
    range.addEventListener('input', () => apply(range.value));
    num.addEventListener('input', () => apply(num.value));
    ctl.appendChild(range);
    ctl.appendChild(num);
  }
  row.appendChild(ctl);
  return row;
}

function markDirty(row, item) {
  const dirty = getPath(editConfig, item.path) !== getPath(config, item.path);
  row.classList.toggle('dirty', dirty);
}

function diffConfig() {
  const overrides = {};
  let changed = false;
  for (const group of CONFIG_GROUPS) {
    for (const item of group.items) {
      const ev = getPath(editConfig, item.path);
      if (ev !== getPath(config, item.path)) {
        setPath(overrides, item.path, ev);
        changed = true;
      }
    }
  }
  return changed ? overrides : null;
}

async function applyConfig() {
  const overrides = diffConfig();
  if (!overrides) {
    logToConsole('No config changes to apply');
    return;
  }
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides),
    });
    const data = await res.json();
    if (data.config) setConfig(data.config);
    logToConsole(data.message || 'Config applied');
  } catch (e) {
    logToConsole('Error applying config');
  }
}

// ---- Map ----
function resizeCanvas() {
  const container = canvas.parentElement;
  const size = Math.min(container.clientWidth, container.clientHeight) * 0.97;
  canvas.width = size;
  canvas.height = size;
  drawHexGrid();
}
window.addEventListener('resize', () => {
  resizeCanvas();
  drawSparkline();
});

function gridSize() {
  return config ? config.world.gridSize : 10;
}

function drawHexGrid() {
  if (!hexagons.length) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const gs = gridSize();
  const hw = canvas.width / gs;
  const hh = canvas.height / gs;

  for (const hex of hexagons) {
    const x = hex.grid_x * hw;
    const y = hex.grid_y * hh;
    ctx.fillStyle = colorFor(hex, overlayMode);
    ctx.fillRect(x, y, hw - 1, hh - 1);
    ctx.strokeStyle = selectedHex && selectedHex.id === hex.id ? '#ffff00' : '#2a2a2a';
    ctx.lineWidth = selectedHex && selectedHex.id === hex.id ? 3 : 1;
    ctx.strokeRect(x, y, hw - 1, hh - 1);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.max(9, hw / 9)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatPopulation(hex.population), x + hw / 2, y + hh / 2);
  }
}

function lerpColor(a, b, t) {
  const ah = a.match(/\w\w/g).map((x) => parseInt(x, 16));
  const bh = b.match(/\w\w/g).map((x) => parseInt(x, 16));
  const r = ah.map((v, i) => Math.round(v + (bh[i] - v) * Math.max(0, Math.min(1, t))));
  return `rgb(${r[0]},${r[1]},${r[2]})`;
}

function colorFor(hex, mode) {
  if (mode === 'population') {
    const p = hex.population;
    if (p < 100) return '#1a1a1a';
    if (p < 5000) return '#2d5016';
    if (p < 15000) return '#4a7c1e';
    if (p < 30000) return '#d17a22';
    return '#c0392b';
  }
  if (mode === 'net_force') {
    if (hex.net_force >= 0) return lerpColor('888888', '2ecc71', Math.min(1, hex.net_force / 150));
    return lerpColor('888888', 'c0392b', Math.min(1, -hex.net_force / 150));
  }
  if (mode === 'food') {
    const perCap = config ? config.consumption.perCapitaTonsPerMonth : 0.002;
    const months = hex.population > 0 ? hex.food_stored_tons / (hex.population * perCap) : 6;
    return lerpColor('c0392b', '2ecc71', months / 6); // 0..6+ months
  }
  if (mode === 'water') return lerpColor('c0392b', '4a9eff', hex.water_availability / 100);
  if (mode === 'infrastructure') {
    const avg = (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3;
    return lerpColor('c0392b', '2ecc71', avg / 100);
  }
  return '#333';
}

const LEGENDS = {
  population: ['Population Density', [['#1a1a1a', 'Depleted <100'], ['#2d5016', 'Low <5k'], ['#4a7c1e', 'Med <15k'], ['#d17a22', 'High <30k'], ['#c0392b', 'Very high 30k+']]],
  net_force: ['Net Force (want to leave ↔ stay)', [['#c0392b', 'Strong repel'], ['#888888', 'Neutral'], ['#2ecc71', 'Strong attract']]],
  food: ['Food (months remaining)', [['#c0392b', '0 months'], ['#d1a022', '~3 months'], ['#2ecc71', '6+ months']]],
  water: ['Water availability', [['#c0392b', '0%'], ['#4a9eff', '100%']]],
  infrastructure: ['Infrastructure', [['#c0392b', '0%'], ['#2ecc71', '100%']]],
};

function renderLegend() {
  const [title, items] = LEGENDS[overlayMode];
  document.getElementById('legendTitle').textContent = title;
  document.getElementById('legendItems').innerHTML = items
    .map(([c, l]) => `<div class="legend-item"><span class="legend-color" style="background:${c}"></span><span>${l}</span></div>`)
    .join('');
}

canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const gs = gridSize();
  const gx = Math.floor(((event.clientX - rect.left) / canvas.width) * gs);
  const gy = Math.floor(((event.clientY - rect.top) / canvas.height) * gs);
  const hex = hexagons.find((h) => h.grid_x === gx && h.grid_y === gy);
  if (hex) {
    selectedHex = hex;
    displayHexDetails(hex);
    drawHexGrid();
  }
});

function displayHexDetails(hex) {
  const avgInfra = (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3;
  const perCap = config ? config.consumption.perCapitaTonsPerMonth : 0.002;
  const months = hex.population > 0 ? hex.food_stored_tons / (hex.population * perCap) : Infinity;
  document.getElementById('hexDetailsContent').innerHTML = `
    <div class="detail-header">${hex.id}</div>
    ${detail('Type', hex.type.toUpperCase())}
    ${detail('Population', fmt(hex.population))}
    ${detail('Food', `${hex.food_stored_tons.toFixed(1)} t (${Number.isFinite(months) ? months.toFixed(1) + ' mo' : '—'})`)}
    ${detail('Production', `${hex.food_production_per_month.toFixed(1)} t/mo`)}
    ${detail('Water', `${hex.water_availability.toFixed(0)}%`)}
    ${detail('Infrastructure', `${avgInfra.toFixed(0)}%`)}
    ${detail('Violence', `${hex.violence_level}/10`)}
    ${detail('Net force', hex.net_force.toFixed(1))}
    ${detail('Grid', `(${hex.grid_x}, ${hex.grid_y})`)}`;
}
function detail(label, value) {
  return `<div class="detail-row"><span class="detail-label">${label}</span><span class="detail-value">${value}</span></div>`;
}

// ---- Console ----
function logToConsole(message) {
  const log = document.getElementById('consoleLog');
  const entry = document.createElement('div');
  entry.className = 'console-entry';
  entry.innerHTML = `<div class="console-timestamp">[${new Date().toLocaleTimeString()}]</div><div class="console-message">${message}</div>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 50) log.removeChild(log.firstChild);
}
function clearConsole() {
  document.getElementById('consoleLog').innerHTML = '';
}

// ---- Formatting ----
function fmt(n) {
  return Math.round(n).toLocaleString();
}
function formatPopulation(pop) {
  if (pop >= 10000) return Math.floor(pop / 1000) + 'k';
  if (pop >= 1000) return (pop / 1000).toFixed(1) + 'k';
  return String(Math.round(pop));
}

// ---- Transport ----
let playing = false;
function setPlaying(on) {
  playing = on;
  document.getElementById('playBtn').disabled = on;
  document.getElementById('pauseBtn').disabled = !on;
}
function currentIntervalMs() {
  const speed = Number(document.getElementById('speed').value) || 1;
  return Math.round(2000 / speed);
}

document.getElementById('playBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMs: currentIntervalMs() }),
    });
    setPlaying(true);
  } catch {
    logToConsole('Error starting playback');
  }
});
document.getElementById('pauseBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/pause', { method: 'POST' });
    setPlaying(false);
  } catch {
    logToConsole('Error pausing');
  }
});
document.getElementById('stepBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/step', { method: 'POST' });
  } catch {
    logToConsole('Error stepping');
  }
});
document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('Reset the simulation?')) return;
  try {
    await fetch('/api/reset', { method: 'POST' });
    setPlaying(false);
  } catch {
    logToConsole('Error resetting');
  }
});
document.getElementById('speed').addEventListener('input', async (e) => {
  document.getElementById('speedValue').textContent = `${e.target.value}×`;
  if (playing) {
    // Re-arm the play loop at the new speed.
    await fetch('/api/pause', { method: 'POST' });
    await fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intervalMs: currentIntervalMs() }),
    });
  }
});
document.getElementById('forkBtn').addEventListener('click', async () => {
  const round = Number(document.getElementById('rewind').value);
  try {
    const res = await fetch('/api/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ round }),
    });
    const data = await res.json();
    logToConsole(data.message || data.error || 'Forked');
  } catch {
    logToConsole('Error forking');
  }
});
function updateRewindMax() {
  if (!gameState) return;
  const input = document.getElementById('rewind');
  input.max = gameState.current_round;
}

document.getElementById('overlay').addEventListener('change', (e) => {
  overlayMode = e.target.value;
  renderLegend();
  drawHexGrid();
});

document.getElementById('applyBtn').addEventListener('click', applyConfig);
document.getElementById('revertBtn').addEventListener('click', () => {
  if (config) setConfig(config);
  logToConsole('Reverted unapplied config edits');
});

// ---- Boot ----
renderLegend();
resizeCanvas();
connectWebSocket();
