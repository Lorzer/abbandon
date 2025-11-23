/**
 * ABBADON Phase 1 - Frontend Logic
 */

// State
let gameState = null;
let hexagons = [];
let selectedHex = null;
let ws = null;

// Canvas
const canvas = document.getElementById('hexCanvas');
const ctx = canvas.getContext('2d');

// Set canvas size
function resizeCanvas() {
  const container = canvas.parentElement;
  const size = Math.min(container.clientWidth, container.clientHeight) * 0.95;
  canvas.width = size;
  canvas.height = size;
  drawHexGrid();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// WebSocket connection
function connectWebSocket() {
  ws = new WebSocket(`ws://${window.location.host}`);

  ws.onopen = () => {
    console.log('WebSocket connected');
    logToConsole('Connected to server');
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    handleWebSocketMessage(message);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
    logToConsole('Connection error');
  };

  ws.onclose = () => {
    console.log('WebSocket closed');
    logToConsole('Disconnected from server');
    // Attempt reconnect after 2 seconds
    setTimeout(connectWebSocket, 2000);
  };
}

connectWebSocket();

// Handle WebSocket messages
function handleWebSocketMessage(message) {
  switch (message.type) {
    case 'init':
      gameState = message.data.gameState;
      hexagons = message.data.hexagons;
      updateUI();
      drawHexGrid();
      logToConsole('Simulation initialized');
      break;

    case 'update':
      gameState = message.data.gameState;
      hexagons = message.data.hexagons;
      updateUI();
      drawHexGrid();

      // Log events
      if (message.data.events && message.data.events.length > 0) {
        const event = message.data.events[0];
        logToConsole(`Round ${gameState.current_round}: ${event.description}`);
      }
      break;

    case 'reset':
      gameState = message.data.gameState;
      hexagons = message.data.hexagons;
      selectedHex = null;
      updateUI();
      drawHexGrid();
      clearConsole();
      logToConsole('Simulation reset');
      break;

    case 'complete':
      gameState = message.data.gameState;
      updateUI();
      logToConsole('Simulation complete (60 rounds)');
      document.getElementById('playBtn').disabled = true;
      document.getElementById('stepBtn').disabled = true;
      break;
  }
}

// Update UI metrics
function updateUI() {
  if (!gameState) return;

  document.getElementById('metricRound').textContent = gameState.current_round;
  document.getElementById('metricPopulation').textContent = gameState.total_population.toLocaleString();
  document.getElementById('metricFood').textContent = Math.floor(gameState.total_food_tons);
  document.getElementById('metricDeaths').textContent = gameState.total_deaths.toLocaleString();

  // Calculate urban/rural populations
  const urbanPop = hexagons
    .filter((h) => h.type === 'urban')
    .reduce((sum, h) => sum + h.population, 0);
  const ruralPop = hexagons
    .filter((h) => h.type === 'rural')
    .reduce((sum, h) => sum + h.population, 0);

  document.getElementById('metricUrbanPop').textContent = urbanPop.toLocaleString();
  document.getElementById('metricRuralPop').textContent = ruralPop.toLocaleString();

  // Update selected hex details if one is selected
  if (selectedHex) {
    const hex = hexagons.find((h) => h.id === selectedHex.id);
    if (hex) {
      displayHexDetails(hex);
    }
  }
}

// Draw hex grid
function drawHexGrid() {
  if (!hexagons.length) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const gridSize = 10;
  const hexWidth = canvas.width / gridSize;
  const hexHeight = canvas.height / gridSize;

  for (const hex of hexagons) {
    const x = hex.grid_x * hexWidth;
    const y = hex.grid_y * hexHeight;

    // Choose color based on population
    const color = getHexColor(hex);

    // Draw hex (as rectangle for simplicity)
    ctx.fillStyle = color;
    ctx.fillRect(x, y, hexWidth - 1, hexHeight - 1);

    // Draw border
    ctx.strokeStyle = selectedHex && selectedHex.id === hex.id ? '#ffff00' : '#2a2a2a';
    ctx.lineWidth = selectedHex && selectedHex.id === hex.id ? 3 : 1;
    ctx.strokeRect(x, y, hexWidth - 1, hexHeight - 1);

    // Draw population number
    ctx.fillStyle = '#ffffff';
    ctx.font = `${Math.max(10, hexWidth / 8)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const popText = formatPopulation(hex.population);
    ctx.fillText(popText, x + hexWidth / 2, y + hexHeight / 2);
  }
}

// Get hex color based on population
function getHexColor(hex) {
  const pop = hex.population;

  if (pop < 100) {
    return '#1a1a1a'; // Depleted (black)
  } else if (pop < 5000) {
    return '#2d5016'; // Low (dark green)
  } else if (pop < 15000) {
    return '#4a7c1e'; // Medium (green)
  } else if (pop < 30000) {
    return '#d17a22'; // High (orange)
  } else {
    return '#c0392b'; // Very high (red)
  }
}

// Format population for display
function formatPopulation(pop) {
  if (pop >= 10000) {
    return Math.floor(pop / 1000) + 'k';
  } else if (pop >= 1000) {
    return (pop / 1000).toFixed(1) + 'k';
  } else {
    return pop.toString();
  }
}

// Canvas click handler
canvas.addEventListener('click', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const gridSize = 10;
  const hexWidth = canvas.width / gridSize;
  const hexHeight = canvas.height / gridSize;

  const gridX = Math.floor(x / hexWidth);
  const gridY = Math.floor(y / hexHeight);

  const hex = hexagons.find((h) => h.grid_x === gridX && h.grid_y === gridY);
  if (hex) {
    selectedHex = hex;
    displayHexDetails(hex);
    drawHexGrid();
  }
});

// Display hex details
function displayHexDetails(hex) {
  const container = document.getElementById('hexDetailsContent');

  const avgInfra =
    (hex.infrastructure_power + hex.infrastructure_water + hex.infrastructure_roads) / 3;

  container.innerHTML = `
    <div class="detail-header">${hex.id}</div>
    <div class="detail-row">
      <span class="detail-label">Type:</span>
      <span class="detail-value">${hex.type.toUpperCase()}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Population:</span>
      <span class="detail-value">${hex.population.toLocaleString()}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Food Stored:</span>
      <span class="detail-value">${hex.food_stored_tons.toFixed(1)} tons</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Food Production:</span>
      <span class="detail-value">${hex.food_production_per_month.toFixed(1)} tons/month</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Water:</span>
      <span class="detail-value">${hex.water_availability.toFixed(0)}%</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Infrastructure:</span>
      <span class="detail-value">${avgInfra.toFixed(0)}%</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Violence Level:</span>
      <span class="detail-value">${hex.violence_level}/10</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Net Force:</span>
      <span class="detail-value">${hex.net_force.toFixed(1)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Grid Position:</span>
      <span class="detail-value">(${hex.grid_x}, ${hex.grid_y})</span>
    </div>
  `;
}

// Console logging
function logToConsole(message) {
  const consoleLog = document.getElementById('consoleLog');
  const entry = document.createElement('div');
  entry.className = 'console-entry';

  const timestamp = new Date().toLocaleTimeString();
  entry.innerHTML = `
    <div class="console-timestamp">[${timestamp}]</div>
    <div class="console-message">${message}</div>
  `;

  consoleLog.appendChild(entry);
  consoleLog.scrollTop = consoleLog.scrollHeight;

  // Keep max 50 entries
  while (consoleLog.children.length > 50) {
    consoleLog.removeChild(consoleLog.firstChild);
  }
}

function clearConsole() {
  document.getElementById('consoleLog').innerHTML = '';
}

// Button handlers
document.getElementById('playBtn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/play', { method: 'POST' });
    const data = await response.json();
    logToConsole(data.message);

    document.getElementById('playBtn').disabled = true;
    document.getElementById('pauseBtn').disabled = false;
  } catch (error) {
    console.error('Error:', error);
    logToConsole('Error starting playback');
  }
});

document.getElementById('pauseBtn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/pause', { method: 'POST' });
    const data = await response.json();
    logToConsole(data.message);

    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
  } catch (error) {
    console.error('Error:', error);
    logToConsole('Error pausing playback');
  }
});

document.getElementById('stepBtn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/step', { method: 'POST' });
    const data = await response.json();
    logToConsole(data.message);
  } catch (error) {
    console.error('Error:', error);
    logToConsole('Error stepping simulation');
  }
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to reset the simulation?')) {
    return;
  }

  try {
    const response = await fetch('/api/reset', { method: 'POST' });
    const data = await response.json();
    logToConsole(data.message);

    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = true;
    document.getElementById('stepBtn').disabled = false;
  } catch (error) {
    console.error('Error:', error);
    logToConsole('Error resetting simulation');
  }
});
