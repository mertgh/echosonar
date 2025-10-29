/**
 * Echo.io - Client Side Game Logic
 * Handles rendering, input, and Socket.io communication
 */

// Game State
const game = {
    canvas: null,
    ctx: null,
    socket: null,
    playerId: null,
    player: null,
    players: new Map(),
    pings: [],
    bullets: new Map(),
    camera: { x: 0, y: 0 },
    worldWidth: 2000,
    worldHeight: 2000,
    keys: {},
    mousePos: { x: 0, y: 0 },
    isAlive: true,
    startTime: Date.now(),
    score: 0,
    health: 100,
    maxHealth: 100,
    pingCooldown: 0,
    maxPingCooldown: 1000,
    shootCooldown: 0,
    maxShootCooldown: 200,
    particles: [],
    trails: new Map(),
    leaderboard: [],
    // Track last time the local player shot (ms)
    lastShotAt: 0
};

// Visibility/combat reveal settings
const COMBAT_REVEAL_RANGE = 350; // px
const REVEAL_WHILE_SHOOTING_MS = 900; // ms

// Initialize game when DOM is ready
document.addEventListener('DOMContentLoaded', initGame);

/**
 * Initialize the game
 */
function initGame() {
    // Get canvas and context
    game.canvas = document.getElementById('gameCanvas');
    game.ctx = game.canvas.getContext('2d');
    
    // Set canvas size
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // Setup event listeners
    setupEventListeners();
    
    // Connect to server
    connectToServer();
    
    // Start render loop
    requestAnimationFrame(gameLoop);
}

/**
 * Resize canvas to fit window
 */
function resizeCanvas() {
    game.canvas.width = window.innerWidth;
    game.canvas.height = window.innerHeight;
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
    // Keyboard controls
    document.addEventListener('keydown', (e) => {
        game.keys[e.code] = true;
        
        // Emit ping on spacebar
        if (e.code === 'Space' && game.isAlive && game.pingCooldown <= 0) {
            emitPing();
            e.preventDefault();
        }
    });
    
    document.addEventListener('keyup', (e) => {
        game.keys[e.code] = false;
    });
    
    // Mouse tracking
    game.canvas.addEventListener('mousemove', (e) => {
        game.mousePos.x = e.clientX;
        game.mousePos.y = e.clientY;
    });
    
    // Mouse click for shooting
    game.canvas.addEventListener('click', (e) => {
        if (game.isAlive && game.shootCooldown <= 0) {
            shoot(e.clientX, e.clientY);
        }
    });
    
    // Menu buttons
    document.getElementById('playBtn').addEventListener('click', startGame);
    document.getElementById('respawnBtn').addEventListener('click', respawn);
    document.getElementById('menuBtn').addEventListener('click', showMainMenu);
    
    // Player name input
    document.getElementById('playerName').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            startGame();
        }
    });
}

/**
 * Connect to Socket.io server
 */
function connectToServer() {
    game.socket = io();
    
    // Connection events
    game.socket.on('connect', () => {
        console.log('Connected to server');
        hideConnectionStatus();
    });
    
    game.socket.on('disconnect', () => {
        console.log('Disconnected from server');
        showConnectionStatus('Disconnected from server');
    });
    
    // Game setup
    game.socket.on('gameSetup', (data) => {
        game.playerId = data.playerId;
        game.player = data.player;
        game.worldWidth = data.gameConfig.worldWidth;
        game.worldHeight = data.gameConfig.worldHeight;
        game.maxPingCooldown = data.gameConfig.pingCooldown;
        game.maxShootCooldown = data.gameConfig.shootCooldown || 200;
        game.health = data.player.health;
        game.maxHealth = data.player.maxHealth;
        
        // Add existing players
        data.existingPlayers.forEach(player => {
            if (player.id !== game.playerId) {
                game.players.set(player.id, player);
            }
        });
        
        // Update UI
        updatePlayerInfo();
        updatePlayersCount();
        updateHealthBar();
    });
    
    // Player joined
    game.socket.on('playerJoined', (player) => {
        game.players.set(player.id, player);
        const message = player.isBot ? `${player.name} joined` : `New player joined`;
        addEventLog(message, 'join');
        updatePlayersCount();
    });
    
    // Player left
    game.socket.on('playerLeft', (data) => {
        const player = game.players.get(data.id);
        const wasBot = player && player.isBot;
        game.players.delete(data.id);
        game.trails.delete(data.id);
        const message = wasBot ? `Bot left` : `Player left (Score: ${data.finalScore}s)`;
        addEventLog(message, 'leave');
        updatePlayersCount();
    });
    
    // Player movement
    game.socket.on('playerMoved', (data) => {
        const player = game.players.get(data.id);
        if (player) {
            // Store previous position for trail
            if (!game.trails.has(data.id)) {
                game.trails.set(data.id, []);
            }
            const trail = game.trails.get(data.id);
            trail.push({ x: player.x, y: player.y, alpha: 0.5 });
            if (trail.length > 20) trail.shift();
            
            player.x = data.x;
            player.y = data.y;
        }
    });
    
    // Ping emitted
    game.socket.on('pingEmitted', (pingData) => {
        // Add ping to render queue
        const ping = {
            ...pingData,
            radius: 0,
            alpha: 1,
            startTime: Date.now()
        };
        game.pings.push(ping);
        
        // Add visual feedback
        if (pingData.playerId !== game.playerId) {
            addEventLog(`Player used sonar!`, 'ping');
            
            // Create particles at ping origin
            createPingParticles(pingData.x, pingData.y, pingData.color);
        }
    });
    
    // Bullet fired
    game.socket.on('bulletFired', (bullet) => {
        game.bullets.set(bullet.id, bullet);
    });
    
    // Bullet removed
    game.socket.on('bulletRemoved', (bulletId) => {
        game.bullets.delete(bulletId);
    });
    
    // Player hit
    game.socket.on('playerHit', (data) => {
        if (data.playerId === game.playerId) {
            game.health = data.health;
            updateHealthBar();
            
            // Create hit effect
            createHitEffect(game.player.x, game.player.y);
        } else {
            const player = game.players.get(data.playerId);
            if (player) {
                player.health = data.health;
                createHitEffect(player.x, player.y);
            }
        }
    });
    
    // Player died
    game.socket.on('playerDied', (data) => {
        if (data.id === game.playerId) {
            game.isAlive = false;
            showDeathScreen(data);
        }
        const player = game.players.get(data.id);
        if (player) {
            player.alive = false;
            player.health = 0;
        }
        addEventLog(`${data.eliminatorName} eliminated ${player?.name || 'a player'}!`, 'elimination');
    });
    
    // Player respawned
    game.socket.on('playerRespawned', (data) => {
        if (data.id === game.playerId) {
            game.isAlive = true;
            game.health = data.health;
            game.player.x = data.x;
            game.player.y = data.y;
            game.player.health = data.health;
            updateHealthBar();
            
            // Hide death screen
            document.getElementById('deathScreen').classList.remove('active');
            document.getElementById('gameUI').classList.remove('hidden');
        } else {
            const player = game.players.get(data.id);
            if (player) {
                player.x = data.x;
                player.y = data.y;
                player.health = data.health;
                player.alive = true;
            }
        }
    });
    
    // Game state update
    game.socket.on('gameState', (data) => {
        // Update scores and health
        if (game.player) {
            const player = data.players.find(p => p.id === game.playerId);
            if (player) {
                game.score = player.score;
                game.health = player.health;
                game.player.health = player.health;
                updateScore();
                updateHealthBar();
            }
        }
        
        // Update other players' health
        data.players.forEach(player => {
            if (player.id !== game.playerId) {
                const existingPlayer = game.players.get(player.id);
                if (existingPlayer) {
                    existingPlayer.health = player.health;
                    existingPlayer.alive = player.alive;
                }
            }
        });
        
        // Update bullets
        if (data.bullets) {
            // Clear and update bullets
            game.bullets.clear();
            data.bullets.forEach(bullet => {
                game.bullets.set(bullet.id, bullet);
            });
        }
        
        // Update leaderboard
        if (data.leaderboard) {
            game.leaderboard = data.leaderboard;
            updateLeaderboard();
        }
    });
    
    // Ping cooldown
    game.socket.on('pingCooldown', (data) => {
        console.log(`Ping on cooldown: ${data.remaining}ms remaining`);
    });
    
    // Player name updated
    game.socket.on('playerNameUpdated', (data) => {
        const player = game.players.get(data.id);
        if (player) {
            player.name = data.name;
        }
        if (data.id === game.playerId && game.player) {
            game.player.name = data.name;
            updatePlayerInfo();
        }
    });
}

/**
 * Start the game
 */
function startGame() {
    const playerName = document.getElementById('playerName').value || 'Anonymous';
    
    // Hide menu
    document.getElementById('mainMenu').classList.remove('active');
    document.getElementById('gameUI').classList.remove('hidden');
    
    // Reset game state
    game.isAlive = true;
    game.startTime = Date.now();
    game.score = 0;
    game.pingCooldown = 0;
    
    // Request to join game
    if (game.socket && game.socket.connected) {
        // Send player name to server
        game.socket.emit('setPlayerName', playerName);
        
        // Update player info locally
        if (game.player) {
            game.player.name = playerName;
        }
        
        // Player is already connected, just show the game
        updatePlayerInfo();
    }
}

/**
 * Emit a sonar ping
 */
function emitPing() {
    if (game.pingCooldown <= 0 && game.socket) {
        game.socket.emit('emitPing');
        game.pingCooldown = game.maxPingCooldown;
    }
}

/**
 * Shoot a bullet
 */
function shoot(mouseX, mouseY) {
    if (!game.player || !game.isAlive || game.shootCooldown > 0) return;
    
    // Calculate angle from player to mouse
    const worldMouseX = mouseX + game.camera.x;
    const worldMouseY = mouseY + game.camera.y;
    const angle = Math.atan2(worldMouseY - game.player.y, worldMouseX - game.player.x);
    
    // Send shoot event to server
    if (game.socket) {
        game.socket.emit('shoot', { angle: angle });
        game.shootCooldown = game.maxShootCooldown;
        // Mark ourselves as recently shooting for visibility rules
        game.lastShotAt = Date.now();
    }
}

/**
 * Main game loop
 */
let lastTime = 0;
function gameLoop(timestamp) {
    const deltaTime = timestamp - lastTime;
    lastTime = timestamp;
    
    // Update game state
    update(deltaTime);
    
    // Render everything
    render();
    
    // Continue loop
    requestAnimationFrame(gameLoop);
}

/**
 * Update game state
 */
function update(deltaTime) {
    if (!game.player || !game.isAlive) return;
    
    // Update player movement
    let dx = 0, dy = 0;
    const speed = 5;
    
    if (game.keys['KeyW'] || game.keys['ArrowUp']) dy -= speed;
    if (game.keys['KeyS'] || game.keys['ArrowDown']) dy += speed;
    if (game.keys['KeyA'] || game.keys['ArrowLeft']) dx -= speed;
    if (game.keys['KeyD'] || game.keys['ArrowRight']) dx += speed;
    
    // Normalize diagonal movement
    if (dx !== 0 && dy !== 0) {
        const factor = 1 / Math.sqrt(2);
        dx *= factor;
        dy *= factor;
    }
    
    // Update player position
    if (dx !== 0 || dy !== 0) {
        game.player.x = Math.max(0, Math.min(game.worldWidth, game.player.x + dx));
        game.player.y = Math.max(0, Math.min(game.worldHeight, game.player.y + dy));
        
        // Send movement to server
        if (game.socket) {
            game.socket.emit('playerMove', {
                x: game.player.x,
                y: game.player.y
            });
        }
    }
    
    // Update camera to follow player
    game.camera.x = game.player.x - game.canvas.width / 2;
    game.camera.y = game.player.y - game.canvas.height / 2;
    
    // Update ping cooldown
    if (game.pingCooldown > 0) {
        game.pingCooldown = Math.max(0, game.pingCooldown - deltaTime);
        updatePingCooldownBar();
    }
    
    // Update shoot cooldown
    if (game.shootCooldown > 0) {
        game.shootCooldown = Math.max(0, game.shootCooldown - deltaTime);
    }
    
    // Update pings
    game.pings = game.pings.filter(ping => {
        const elapsed = Date.now() - ping.startTime;
        const progress = elapsed / 2000; // 2 second duration
        
        if (progress >= 1) return false;
        
        // Expand ping radius
        ping.radius = progress * ping.maxRadius;
        ping.alpha = 1 - progress;
        
        return true;
    });
    
    // Update particles
    game.particles = game.particles.filter(particle => {
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.alpha -= particle.decay;
        return particle.alpha > 0;
    });
    
    // Update trails
    game.trails.forEach(trail => {
        trail.forEach(point => {
            point.alpha *= 0.95;
        });
        // Remove faded trail points
        while (trail.length > 0 && trail[0].alpha < 0.01) {
            trail.shift();
        }
    });
}

/**
 * Render the game
 */
function render() {
    const ctx = game.ctx;
    
    // Clear canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, game.canvas.width, game.canvas.height);
    
    if (!game.player) return;
    
    // Save context
    ctx.save();
    
    // Apply camera transform
    ctx.translate(-game.camera.x, -game.camera.y);
    
    // Draw grid (subtle)
    drawGrid();
    
    // Draw trails
    drawTrails();
    
    // Draw particles
    drawParticles();
    
    // Draw pings
    drawPings();
    
    // Draw bullets
    drawBullets();
    
    // Draw other players (only visible during pings)
    drawPlayers();
    
    // Draw current player
    drawPlayer(game.player, true);
    
    // Draw health bars
    drawHealthBars();
    
    // Restore context
    ctx.restore();
    
    // Draw UI elements (not affected by camera)
    drawRadar();
}

/**
 * Draw background grid
 */
function drawGrid() {
    const ctx = game.ctx;
    const gridSize = 100;
    
    ctx.strokeStyle = 'rgba(0, 100, 200, 0.05)';
    ctx.lineWidth = 1;
    
    // Calculate visible grid area
    const startX = Math.floor(game.camera.x / gridSize) * gridSize;
    const startY = Math.floor(game.camera.y / gridSize) * gridSize;
    const endX = startX + game.canvas.width + gridSize;
    const endY = startY + game.canvas.height + gridSize;
    
    // Draw vertical lines
    for (let x = startX; x <= endX; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, startY);
        ctx.lineTo(x, endY);
        ctx.stroke();
    }
    
    // Draw horizontal lines
    for (let y = startY; y <= endY; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(startX, y);
        ctx.lineTo(endX, y);
        ctx.stroke();
    }
}

/**
 * Draw player trails
 */
function drawTrails() {
    const ctx = game.ctx;
    
    game.trails.forEach((trail, playerId) => {
        const player = game.players.get(playerId);
        if (!player) return;
        
        trail.forEach((point, index) => {
            ctx.fillStyle = player.color.replace(')', `, ${point.alpha})`).replace('hsl', 'hsla');
            ctx.beginPath();
            ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
            ctx.fill();
        });
    });
}

/**
 * Draw particles
 */
function drawParticles() {
    const ctx = game.ctx;
    
    game.particles.forEach(particle => {
        ctx.fillStyle = `rgba(${particle.r}, ${particle.g}, ${particle.b}, ${particle.alpha})`;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fill();
    });
}

/**
 * Draw sonar pings
 */
function drawPings() {
    const ctx = game.ctx;
    
    game.pings.forEach(ping => {
        // Multiple expanding rings for better effect
        for (let i = 0; i < 3; i++) {
            const ringRadius = ping.radius - i * 20;
            if (ringRadius > 0) {
                // Draw expanding ring with gradient stroke
                const ringAlpha = ping.alpha * (0.6 - i * 0.15);
                ctx.strokeStyle = `rgba(0, 255, 255, ${ringAlpha})`;
                ctx.lineWidth = 3 - i;
                ctx.beginPath();
                ctx.arc(ping.x, ping.y, ringRadius, 0, Math.PI * 2);
                ctx.stroke();
                
                // Add glow to rings
                ctx.shadowColor = 'rgba(0, 255, 255, 0.8)';
                ctx.shadowBlur = 10;
                ctx.stroke();
                ctx.shadowBlur = 0;
            }
        }
        
        // Enhanced inner glow
        if (ping.radius < 100) {
            const gradient = ctx.createRadialGradient(ping.x, ping.y, 0, ping.x, ping.y, ping.radius);
            gradient.addColorStop(0, `rgba(255, 255, 255, ${ping.alpha * 0.5})`);
            gradient.addColorStop(0.5, `rgba(0, 255, 255, ${ping.alpha * 0.3})`);
            gradient.addColorStop(1, 'rgba(0, 200, 255, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(ping.x, ping.y, ping.radius, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Scan line effect
        ctx.save();
        ctx.translate(ping.x, ping.y);
        const scanAngle = (Date.now() / 100) % (Math.PI * 2);
        ctx.rotate(scanAngle);
        
        const scanGradient = ctx.createLinearGradient(0, 0, ping.radius, 0);
        scanGradient.addColorStop(0, `rgba(0, 255, 255, 0)`);
        scanGradient.addColorStop(0.5, `rgba(0, 255, 255, ${ping.alpha * 0.3})`);
        scanGradient.addColorStop(1, `rgba(0, 255, 255, 0)`);
        
        ctx.strokeStyle = scanGradient;
        ctx.lineWidth = 15;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(ping.radius, 0);
        ctx.stroke();
        
        ctx.restore();
    });
}

/**
 * Draw all players
 */
function drawPlayers() {
    game.players.forEach(player => {
        // Only draw other players if they're visible (near a ping)
        const isVisible = isPlayerVisible(player);
        if (isVisible) {
            drawPlayer(player, false, isVisible);
        }
    });
}

/**
 * Draw a single player
 */
function drawPlayer(player, isSelf, visibility = 1) {
    const ctx = game.ctx;
    
    // Enhanced visibility for sonar-detected enemies
    if (!isSelf && visibility > 0) {
        // Pulsing outline effect for detected enemies
        const pulseTime = Date.now() / 200;
        const pulseFactor = 0.5 + Math.sin(pulseTime) * 0.5;
        
        // Large warning circle for high visibility
        ctx.strokeStyle = `rgba(255, 0, 0, ${visibility * 0.3 * pulseFactor})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(player.x, player.y, 25 + pulseFactor * 5, 0, Math.PI * 2);
        ctx.stroke();
        
        // Danger indicator lines
        ctx.save();
        ctx.translate(player.x, player.y);
        ctx.rotate(pulseTime * 0.1);
        for (let i = 0; i < 4; i++) {
            ctx.rotate(Math.PI / 2);
            ctx.strokeStyle = `rgba(255, 100, 100, ${visibility * 0.5})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(15, 0);
            ctx.lineTo(20 + pulseFactor * 3, 0);
            ctx.stroke();
        }
        ctx.restore();
    }
    
    // Enhanced glow effect
    if (isSelf || visibility > 0) {
        // Double glow for better visibility
        const glowRadius = isSelf ? 30 : 40 + visibility * 10;
        
        // Outer glow
        const gradient1 = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, glowRadius);
        if (isSelf) {
            gradient1.addColorStop(0, player.color.replace(')', ', 0.3)').replace('hsl', 'hsla'));
            gradient1.addColorStop(1, 'rgba(0, 0, 0, 0)');
        } else {
            // Red warning glow for enemies
            gradient1.addColorStop(0, `rgba(255, 0, 0, ${0.2 * visibility})`);
            gradient1.addColorStop(0.5, `rgba(255, 100, 100, ${0.1 * visibility})`);
            gradient1.addColorStop(1, 'rgba(0, 0, 0, 0)');
        }
        ctx.fillStyle = gradient1;
        ctx.beginPath();
        ctx.arc(player.x, player.y, glowRadius, 0, Math.PI * 2);
        ctx.fill();
        
        // Inner color glow
        const gradient2 = ctx.createRadialGradient(player.x, player.y, 0, player.x, player.y, 20);
        gradient2.addColorStop(0, player.color.replace(')', `, ${0.4 * visibility})`).replace('hsl', 'hsla'));
        gradient2.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient2;
        ctx.beginPath();
        ctx.arc(player.x, player.y, 20, 0, Math.PI * 2);
        ctx.fill();
    }
    
    // Player circle with enhanced visibility
    ctx.fillStyle = isSelf ? player.color : player.color.replace(')', `, ${Math.min(1, visibility * 1.5)})`).replace('hsl', 'hsla');
    ctx.beginPath();
    ctx.arc(player.x, player.y, 10, 0, Math.PI * 2);
    ctx.fill();
    
    // Enhanced border
    ctx.strokeStyle = isSelf ? 'rgba(255, 255, 255, 0.8)' : `rgba(255, 255, 255, ${Math.min(1, visibility * 1.2)})`;
    ctx.lineWidth = isSelf ? 2 : 3;
    ctx.stroke();
    
    // Danger icon for detected enemies
    if (!isSelf && visibility > 0.5) {
        ctx.fillStyle = `rgba(255, 0, 0, ${visibility})`;
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚠', player.x, player.y - 30);
    }
    
    // Draw player name/label with enhanced visibility
    if ((isSelf || visibility > 0.2) && player.name) {
        ctx.save();
        ctx.font = 'bold 12px Orbitron';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        
        const text = player.name || (player.isBot ? '[BOT]' : 'Player');
        const textWidth = ctx.measureText(text).width;
        
        // Enhanced background for text
        ctx.fillStyle = `rgba(0, 0, 0, ${0.7 * visibility})`;
        ctx.fillRect(player.x - textWidth/2 - 6, player.y - 28, textWidth + 12, 18);
        
        // Border for text background
        ctx.strokeStyle = `rgba(255, 100, 100, ${visibility * 0.5})`;
        ctx.lineWidth = 1;
        ctx.strokeRect(player.x - textWidth/2 - 6, player.y - 28, textWidth + 12, 18);
        
        // Enhanced text color
        ctx.fillStyle = player.isBot ? `rgba(255, 100, 100, ${Math.min(1, visibility * 1.5)})` : 
                       (isSelf ? 'rgba(255, 255, 255, 0.9)' : `rgba(255, 255, 100, ${Math.min(1, visibility * 1.5)})`);
        ctx.fillText(text, player.x, player.y - 15);
        ctx.restore();
    }
}

/**
 * Check if a player is visible (near a ping)
 */
function isPlayerVisible(player) {
    let maxVisibility = 0;
    
    game.pings.forEach(ping => {
        const distance = Math.sqrt(
            Math.pow(player.x - ping.x, 2) + 
            Math.pow(player.y - ping.y, 2)
        );
        
        // Increased detection range and visibility
        if (distance < ping.radius + 100) {
            // Enhanced visibility calculation - players stay visible longer
            const visibility = ping.alpha * (1 - (distance / (ping.radius + 100))) * 1.5;
            maxVisibility = Math.max(maxVisibility, Math.min(1, visibility));
        }
    });
    
    // Additional visibility: if WE have shot recently, reveal nearby enemies
    const sinceShotMs = Date.now() - (game.lastShotAt || 0);
    if (sinceShotMs >= 0 && sinceShotMs < REVEAL_WHILE_SHOOTING_MS) {
        const dx = player.x - (game.player?.x ?? 0);
        const dy = player.y - (game.player?.y ?? 0);
        const distanceToSelf = Math.sqrt(dx * dx + dy * dy);
        if (distanceToSelf < COMBAT_REVEAL_RANGE) {
            // Visibility increases as distance gets closer; ensure a minimum while shooting
            const proximity = 1 - (distanceToSelf / COMBAT_REVEAL_RANGE);
            const shootVisibility = Math.max(0.4, 0.4 + 0.6 * proximity); // 0.4..1.0
            maxVisibility = Math.max(maxVisibility, Math.min(1, shootVisibility));
        }
    }
    
    return maxVisibility;
}

/**
 * Draw bullets
 */
function drawBullets() {
    const ctx = game.ctx;
    
    game.bullets.forEach(bullet => {
        // Draw bullet trail
        ctx.strokeStyle = bullet.color.replace(')', ', 0.3)').replace('hsl', 'hsla');
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(bullet.x - bullet.vx * 2, bullet.y - bullet.vy * 2);
        ctx.lineTo(bullet.x, bullet.y);
        ctx.stroke();
        
        // Draw bullet
        ctx.fillStyle = bullet.color;
        ctx.beginPath();
        ctx.arc(bullet.x, bullet.y, 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Bullet glow
        const gradient = ctx.createRadialGradient(bullet.x, bullet.y, 0, bullet.x, bullet.y, 10);
        gradient.addColorStop(0, bullet.color.replace(')', ', 0.5)').replace('hsl', 'hsla'));
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(bullet.x, bullet.y, 10, 0, Math.PI * 2);
        ctx.fill();
    });
}

/**
 * Draw health bars above players
 */
function drawHealthBars() {
    const ctx = game.ctx;
    
    // Don't draw health bar above current player (it's already in the UI)
    // Only draw health bars for visible enemy players
    game.players.forEach(player => {
        if (player.alive) {
            const visibility = isPlayerVisible(player);
            if (visibility > 0) {
                // Draw health bar higher up to avoid covering names
                drawHealthBar(player.x, player.y - 40, player.health || 100, 100, false, visibility);
            }
        }
    });
}

/**
 * Draw a single health bar
 */
function drawHealthBar(x, y, health, maxHealth, isSelf, visibility = 1) {
    const ctx = game.ctx;
    const barWidth = 35;  // Slightly smaller
    const barHeight = 3;  // Thinner bar
    const percentage = Math.max(0, health / maxHealth);
    
    // Background with darker color
    ctx.fillStyle = `rgba(20, 0, 0, ${0.7 * visibility})`;
    ctx.fillRect(x - barWidth/2, y, barWidth, barHeight);
    
    // Health fill with gradient effect
    const healthColor = percentage > 0.6 ? '50, 255, 50' : percentage > 0.3 ? '255, 200, 0' : '255, 50, 50';
    ctx.fillStyle = `rgba(${healthColor}, ${visibility})`;
    ctx.fillRect(x - barWidth/2, y, barWidth * percentage, barHeight);
    
    // Border with better visibility
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.5 * visibility})`;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - barWidth/2, y, barWidth, barHeight);
    
    // Add percentage text for better clarity (only if visibility is high)
    if (visibility > 0.7) {
        ctx.font = '9px Arial';
        ctx.fillStyle = `rgba(255, 255, 255, ${visibility * 0.8})`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${Math.ceil(percentage * 100)}%`, x, y - 2);
    }
}

/**
 * Draw radar/minimap
 */
function drawRadar() {
    // Optional: implement a minimap showing ping locations
}

/**
 * Create particle effects for ping
 */
function createPingParticles(x, y, color) {
    const particleCount = 20;
    
    for (let i = 0; i < particleCount; i++) {
        const angle = (Math.PI * 2 * i) / particleCount;
        const speed = 2 + Math.random() * 3;
        
        game.particles.push({
            x: x,
            y: y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: 2 + Math.random() * 2,
            r: 0,
            g: 200,
            b: 255,
            alpha: 0.8,
            decay: 0.02
        });
    }
}

/**
 * Create hit effect
 */
function createHitEffect(x, y) {
    const particleCount = 10;
    
    for (let i = 0; i < particleCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * 3;
        
        game.particles.push({
            x: x,
            y: y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            size: 1 + Math.random() * 2,
            r: 255,
            g: 100,
            b: 100,
            alpha: 0.9,
            decay: 0.03
        });
    }
}

/**
 * Update UI elements
 */
function updatePlayerInfo() {
    if (!game.player) return;
    
    document.getElementById('playerNameDisplay').textContent = 
        game.player.name || document.getElementById('playerName').value || 'Anonymous';
    document.getElementById('playerColorIndicator').style.backgroundColor = game.player.color;
}

function updateScore() {
    document.getElementById('scoreValue').textContent = game.score;
}

function updatePlayersCount() {
    // Count total players including bots
    const totalPlayers = game.players.size + 1; // +1 for self
    document.getElementById('playersCount').textContent = totalPlayers;
}

function updatePingCooldownBar() {
    const percentage = ((game.maxPingCooldown - game.pingCooldown) / game.maxPingCooldown) * 100;
    document.getElementById('pingCooldownBar').style.width = percentage + '%';
}

function updateHealthBar() {
    if (!game.player) return;
    
    const percentage = (game.health / game.maxHealth) * 100;
    document.getElementById('healthBarFill').style.width = percentage + '%';
    document.getElementById('healthValue').textContent = `${Math.ceil(game.health)}/${game.maxHealth}`;
}

function updateLeaderboard() {
    const leaderboardContent = document.getElementById('leaderboardContent');
    leaderboardContent.innerHTML = '';
    
    game.leaderboard.forEach((entry, index) => {
        const entryDiv = document.createElement('div');
        entryDiv.className = 'leaderboard-entry';
        
        // Add classes based on player type
        if (entry.id === game.playerId) {
            entryDiv.classList.add('current-player');
        } else if (entry.isBot) {
            entryDiv.classList.add('bot');
        } else {
            entryDiv.classList.add('player');
        }
        
        if (!entry.alive) {
            entryDiv.classList.add('dead');
        }
        
        entryDiv.innerHTML = `
            <span class="leaderboard-rank">${index + 1}</span>
            <span class="leaderboard-name">${entry.name}</span>
            <div class="leaderboard-stats">
                <span class="leaderboard-score">${entry.score}</span>
                <span class="leaderboard-kills">${entry.kills}K</span>
                <span class="leaderboard-kd">${entry.kd}KD</span>
            </div>
        `;
        
        leaderboardContent.appendChild(entryDiv);
    });
}

/**
 * Event log
 */
function addEventLog(message, type) {
    const eventLog = document.getElementById('eventLog');
    const eventItem = document.createElement('div');
    eventItem.className = `event-item ${type}`;
    eventItem.textContent = message;
    eventLog.appendChild(eventItem);
    
    // Remove old events
    while (eventLog.children.length > 5) {
        eventLog.removeChild(eventLog.firstChild);
    }
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (eventItem.parentNode) {
            eventItem.style.opacity = '0';
            setTimeout(() => eventItem.remove(), 300);
        }
    }, 5000);
}

/**
 * Show/hide screens
 */
function showDeathScreen(deathData) {
    document.getElementById('finalScore').textContent = deathData ? deathData.finalScore : game.score;
    
    // Update death message with eliminator info if available
    const deathTitle = document.querySelector('.death-title');
    if (deathData && deathData.eliminatorName) {
        deathTitle.textContent = `ELIMINATED BY ${deathData.eliminatorName}`;
    }
    
    document.getElementById('deathScreen').classList.add('active');
    document.getElementById('gameUI').classList.add('hidden');
}

function respawn() {
    document.getElementById('deathScreen').classList.remove('active');
    startGame();
}

function showMainMenu() {
    document.getElementById('deathScreen').classList.remove('active');
    document.getElementById('mainMenu').classList.add('active');
    document.getElementById('gameUI').classList.add('hidden');
}

function showConnectionStatus(message) {
    const status = document.getElementById('connectionStatus');
    status.querySelector('.status-text').textContent = message;
    status.classList.remove('hidden');
}

function hideConnectionStatus() {
    document.getElementById('connectionStatus').classList.add('hidden');
}
