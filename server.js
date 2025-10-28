/**
 * Echo.io Game Server
 * Multiplayer stealth game using Node.js, Express, and Socket.io
 */

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;

// Game state
const players = new Map();
const bots = new Map();
const bullets = new Map();
let bulletIdCounter = 0;

const gameConfig = {
    worldWidth: 2000,
    worldHeight: 2000,
    playerSpeed: 3,
    pingCooldown: 1000, // milliseconds
    pingDuration: 2000, // milliseconds
    maxPingRadius: 300,
    minBots: 5, // Minimum number of bots
    maxBots: 10, // Maximum number of bots
    botSpeed: 2, // Bot movement speed
    botPingChance: 0.02, // Chance of bot pinging per tick (increased)
    botDirectionChangeChance: 0.02, // Chance of bot changing direction
    botDetectionRange: 400, // How far bots can detect enemies
    botShootRange: 300, // How far bots will shoot
    botAccuracy: 0.15, // Bot shooting accuracy (lower = more accurate)
    botAggressiveness: 0.8, // How likely bots are to pursue enemies
    // Combat settings
    maxHealth: 100,
    bulletDamage: 10,
    bulletSpeed: 10,
    bulletLifetime: 2000, // milliseconds
    shootCooldown: 200, // milliseconds
    respawnTime: 3000 // milliseconds
};

// Serve static files from public directory
app.use(express.static('public'));

// Serve the game HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Bot management functions
let botIdCounter = 0;

function createBot() {
    const botId = `bot_${botIdCounter++}`;
    const botNames = ['Shadow', 'Ghost', 'Phantom', 'Specter', 'Wraith', 'Echo', 'Pulse', 'Whisper', 'Stealth', 'Hunter'];
    const botName = `[BOT] ${botNames[Math.floor(Math.random() * botNames.length)]}`;
    
    const bot = {
        id: botId,
        name: botName,
        x: Math.random() * gameConfig.worldWidth,
        y: Math.random() * gameConfig.worldHeight,
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        lastPing: 0,
        alive: true,
        joinTime: Date.now(),
        score: 0,
        kills: 0,
        deaths: 0,
        health: gameConfig.maxHealth,
        maxHealth: gameConfig.maxHealth,
        lastShoot: 0,
        isBot: true,
        direction: Math.random() * Math.PI * 2, // Random direction in radians
        targetDirection: Math.random() * Math.PI * 2,
        speed: gameConfig.botSpeed
    };
    
    bots.set(botId, bot);
    
    // Notify all players about the new bot
    io.emit('playerJoined', bot);
    
    return bot;
}

function removeBot(botId) {
    const bot = bots.get(botId);
    if (bot) {
        bots.delete(botId);
        io.emit('playerLeft', {
            id: botId,
            finalScore: bot.score
        });
    }
}

function updateBots() {
    const now = Date.now();
    
    bots.forEach(bot => {
        if (!bot.alive) return;
        
        // Update bot score
        bot.score = Math.floor((Date.now() - bot.joinTime) / 1000) + (bot.kills * 100);
        
        // Find nearest enemy (including players and other bots)
        let nearestEnemy = null;
        let nearestDistance = Infinity;
        
        // Check players
        players.forEach(player => {
            if (!player.alive) return;
            const dx = player.x - bot.x;
            const dy = player.y - bot.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < nearestDistance && distance < gameConfig.botDetectionRange) {
                nearestDistance = distance;
                nearestEnemy = player;
            }
        });
        
        // Check other bots
        bots.forEach(otherBot => {
            if (otherBot.id === bot.id || !otherBot.alive) return;
            const dx = otherBot.x - bot.x;
            const dy = otherBot.y - bot.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < nearestDistance && distance < gameConfig.botDetectionRange) {
                nearestDistance = distance;
                nearestEnemy = otherBot;
            }
        });
        
        // If enemy found, pursue and shoot
        if (nearestEnemy && nearestDistance < gameConfig.botDetectionRange) {
            // Aim at enemy
            const angleToEnemy = Math.atan2(nearestEnemy.y - bot.y, nearestEnemy.x - bot.x);
            
            // Decide whether to pursue or just shoot
            if (Math.random() < gameConfig.botAggressiveness) {
                // Aggressive mode: move towards enemy
                bot.targetDirection = angleToEnemy;
                bot.speed = gameConfig.botSpeed * 1.5; // Move faster when chasing
            } else {
                // Cautious mode: maintain distance
                if (nearestDistance < 150) {
                    // Too close, back away
                    bot.targetDirection = angleToEnemy + Math.PI;
                    bot.speed = gameConfig.botSpeed;
                } else {
                    bot.targetDirection = angleToEnemy + (Math.random() - 0.5) * 0.5;
                    bot.speed = gameConfig.botSpeed;
                }
            }
            
            // Shoot at enemy if in range
            if (nearestDistance < gameConfig.botShootRange && now - bot.lastShoot > gameConfig.shootCooldown) {
                bot.lastShoot = now;
                
                // Add some inaccuracy based on distance
                const distanceFactor = nearestDistance / gameConfig.botShootRange;
                const accuracy = gameConfig.botAccuracy * (1 + distanceFactor);
                const shootAngle = angleToEnemy + (Math.random() - 0.5) * accuracy;
                
                // Create bullet
                const bulletId = `bullet_${bulletIdCounter++}`;
                const bullet = {
                    id: bulletId,
                    ownerId: bot.id,
                    ownerName: bot.name,
                    x: bot.x,
                    y: bot.y,
                    vx: Math.cos(shootAngle) * gameConfig.bulletSpeed,
                    vy: Math.sin(shootAngle) * gameConfig.bulletSpeed,
                    damage: gameConfig.bulletDamage,
                    color: bot.color,
                    createdAt: now
                };
                
                bullets.set(bulletId, bullet);
                io.emit('bulletFired', bullet);
            }
        } else {
            // No enemy nearby, wander randomly
            bot.speed = gameConfig.botSpeed;
            if (Math.random() < gameConfig.botDirectionChangeChance) {
                bot.targetDirection = Math.random() * Math.PI * 2;
            }
        }
        
        // Smooth direction change
        const directionDiff = bot.targetDirection - bot.direction;
        bot.direction += directionDiff * 0.1;
        
        // Move bot (use current speed which may vary based on behavior)
        const currentSpeed = bot.speed || gameConfig.botSpeed;
        let newX = bot.x + Math.cos(bot.direction) * currentSpeed;
        let newY = bot.y + Math.sin(bot.direction) * currentSpeed;
        
        // Bounce off walls
        if (newX < 50 || newX > gameConfig.worldWidth - 50) {
            bot.direction = Math.PI - bot.direction;
            bot.targetDirection = bot.direction;
            newX = Math.max(50, Math.min(gameConfig.worldWidth - 50, newX));
        }
        if (newY < 50 || newY > gameConfig.worldHeight - 50) {
            bot.direction = -bot.direction;
            bot.targetDirection = bot.direction;
            newY = Math.max(50, Math.min(gameConfig.worldHeight - 50, newY));
        }
        
        bot.x = newX;
        bot.y = newY;
        
        // Broadcast bot movement
        io.emit('playerMoved', {
            id: bot.id,
            x: bot.x,
            y: bot.y
        });
        
        // Emit ping to reveal enemies (smarter ping usage)
        if (Math.random() < gameConfig.botPingChance * 2 && now - bot.lastPing > gameConfig.pingCooldown) {
            // More likely to ping if no enemy is visible
            if (!nearestEnemy || nearestDistance > 200) {
                bot.lastPing = now;
                
                const pingData = {
                    playerId: bot.id,
                    x: bot.x,
                    y: bot.y,
                    timestamp: now,
                    color: bot.color,
                    maxRadius: gameConfig.maxPingRadius
                };
                
                io.emit('pingEmitted', pingData);
            }
        }
    });
}

function manageBotPopulation() {
    const totalPlayers = players.size + bots.size;
    
    // Add bots if needed
    if (totalPlayers < gameConfig.minBots) {
        const botsToAdd = gameConfig.minBots - totalPlayers;
        for (let i = 0; i < botsToAdd; i++) {
            createBot();
        }
    }
    
    // Remove excess bots if there are too many
    if (bots.size > 0 && totalPlayers > gameConfig.maxBots) {
        const botsToRemove = Math.min(bots.size, totalPlayers - gameConfig.maxBots);
        const botIds = Array.from(bots.keys());
        for (let i = 0; i < botsToRemove; i++) {
            removeBot(botIds[i]);
        }
    }
}

// Respawn player function
function respawnPlayer(playerId) {
    const player = players.get(playerId);
    if (player) {
        player.x = Math.random() * gameConfig.worldWidth;
        player.y = Math.random() * gameConfig.worldHeight;
        player.health = gameConfig.maxHealth;
        player.alive = true;
        player.lastShoot = 0;
        player.lastPing = 0;
        
        io.emit('playerRespawned', {
            id: playerId,
            x: player.x,
            y: player.y,
            health: player.health
        });
    }
}

// Update bullets and check collisions
function updateBullets() {
    const now = Date.now();
    
    bullets.forEach((bullet, bulletId) => {
        // Update bullet position
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;
        
        // Remove old bullets
        if (now - bullet.createdAt > gameConfig.bulletLifetime ||
            bullet.x < 0 || bullet.x > gameConfig.worldWidth ||
            bullet.y < 0 || bullet.y > gameConfig.worldHeight) {
            bullets.delete(bulletId);
            io.emit('bulletRemoved', bulletId);
            return;
        }
        
        // Check collision with players
        const allTargets = [...players.values(), ...bots.values()];
        allTargets.forEach(target => {
            if (target.id === bullet.ownerId || !target.alive) return;
            
            const dx = target.x - bullet.x;
            const dy = target.y - bullet.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            if (distance < 15) { // Hit radius
                // Apply damage
                target.health -= bullet.damage;
                
                // Broadcast hit
                io.emit('playerHit', {
                    playerId: target.id,
                    damage: bullet.damage,
                    health: target.health,
                    shooterId: bullet.ownerId
                });
                
                // Remove bullet
                bullets.delete(bulletId);
                io.emit('bulletRemoved', bulletId);
                
                // Check if target died
                if (target.health <= 0) {
                    target.alive = false;
                    target.deaths++;
                    target.health = 0;
                    
                    // Give kill credit
                    const shooter = players.get(bullet.ownerId) || bots.get(bullet.ownerId);
                    if (shooter) {
                        shooter.kills++;
                        shooter.score += 100;
                    }
                    
                    io.emit('playerDied', {
                        id: target.id,
                        eliminatedBy: bullet.ownerId,
                        eliminatorName: bullet.ownerName,
                        finalScore: target.score,
                        kills: target.kills,
                        deaths: target.deaths
                    });
                    
                    // Respawn if not a bot
                    if (!target.isBot) {
                        setTimeout(() => {
                            respawnPlayer(target.id);
                        }, gameConfig.respawnTime);
                    } else {
                        // Respawn bot immediately with new position
                        target.x = Math.random() * gameConfig.worldWidth;
                        target.y = Math.random() * gameConfig.worldHeight;
                        target.health = gameConfig.maxHealth;
                        target.alive = true;
                    }
                }
            }
        });
    });
}

// Get leaderboard data
function getLeaderboard() {
    const allPlayers = [...players.values(), ...bots.values()];
    return allPlayers
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(player => ({
            id: player.id,
            name: player.name,
            score: player.score,
            kills: player.kills,
            deaths: player.deaths,
            kd: player.deaths === 0 ? player.kills : (player.kills / player.deaths).toFixed(2),
            isBot: player.isBot,
            alive: player.alive
        }));
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`🎮 Player connected: ${socket.id}`);
    
    // Create new player
    const newPlayer = {
        id: socket.id,
        name: 'Player',
        x: Math.random() * gameConfig.worldWidth,
        y: Math.random() * gameConfig.worldHeight,
        color: `hsl(${Math.random() * 360}, 70%, 50%)`,
        lastPing: 0,
        alive: true,
        joinTime: Date.now(),
        score: 0,
        kills: 0,
        deaths: 0,
        health: gameConfig.maxHealth,
        maxHealth: gameConfig.maxHealth,
        lastShoot: 0,
        isBot: false
    };
    
    players.set(socket.id, newPlayer);
    
    // Get all players (real + bots)
    const allPlayers = [
        ...Array.from(players.values()),
        ...Array.from(bots.values())
    ];
    
    // Send initial game state to the new player
    socket.emit('gameSetup', {
        playerId: socket.id,
        player: newPlayer,
        gameConfig: gameConfig,
        existingPlayers: allPlayers
    });
    
    // Notify other players about the new player
    socket.broadcast.emit('playerJoined', newPlayer);
    
    // Handle player movement
    socket.on('playerMove', (movementData) => {
        const player = players.get(socket.id);
        if (!player || !player.alive) return;
        
        // Update player position with boundary checks
        player.x = Math.max(0, Math.min(gameConfig.worldWidth, movementData.x));
        player.y = Math.max(0, Math.min(gameConfig.worldHeight, movementData.y));
        
        // Broadcast movement to all other players
        socket.broadcast.emit('playerMoved', {
            id: socket.id,
            x: player.x,
            y: player.y
        });
    });
    
    // Handle ping/sonar emission
    socket.on('emitPing', () => {
        const player = players.get(socket.id);
        if (!player || !player.alive) return;
        
        const now = Date.now();
        
        // Check cooldown
        if (now - player.lastPing < gameConfig.pingCooldown) {
            socket.emit('pingCooldown', {
                remaining: gameConfig.pingCooldown - (now - player.lastPing)
            });
            return;
        }
        
        player.lastPing = now;
        
        // Create ping data
        const pingData = {
            playerId: socket.id,
            x: player.x,
            y: player.y,
            timestamp: now,
            color: player.color,
            maxRadius: gameConfig.maxPingRadius
        };
        
        // Broadcast ping to all players (including sender)
        io.emit('pingEmitted', pingData);
        
        // Update player score (survived another ping)
        player.score = Math.floor((Date.now() - player.joinTime) / 1000);
    });
    
    // Handle shooting
    socket.on('shoot', (shootData) => {
        const player = players.get(socket.id);
        if (!player || !player.alive) return;
        
        const now = Date.now();
        
        // Check shoot cooldown
        if (now - player.lastShoot < gameConfig.shootCooldown) {
            return;
        }
        
        player.lastShoot = now;
        
        // Create bullet
        const bulletId = `bullet_${bulletIdCounter++}`;
        const bullet = {
            id: bulletId,
            ownerId: socket.id,
            ownerName: player.name,
            x: player.x,
            y: player.y,
            vx: Math.cos(shootData.angle) * gameConfig.bulletSpeed,
            vy: Math.sin(shootData.angle) * gameConfig.bulletSpeed,
            damage: gameConfig.bulletDamage,
            color: player.color,
            createdAt: now
        };
        
        bullets.set(bulletId, bullet);
        
        // Broadcast bullet creation
        io.emit('bulletFired', bullet);
    });
    
    // Handle player death/elimination
    socket.on('playerEliminated', (eliminatorId) => {
        const player = players.get(socket.id);
        if (player) {
            player.alive = false;
            player.deaths++;
            
            // Give kill credit to eliminator
            const eliminator = players.get(eliminatorId) || bots.get(eliminatorId);
            if (eliminator) {
                eliminator.kills++;
                eliminator.score += 100; // Bonus points for kill
            }
            
            io.emit('playerDied', {
                id: socket.id,
                eliminatedBy: eliminatorId,
                eliminatorName: eliminator ? eliminator.name : 'Unknown',
                finalScore: player.score,
                kills: player.kills,
                deaths: player.deaths
            });
            
            // Respawn after delay
            setTimeout(() => {
                if (players.has(socket.id)) {
                    respawnPlayer(socket.id);
                }
            }, gameConfig.respawnTime);
        }
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`👋 Player disconnected: ${socket.id}`);
        const player = players.get(socket.id);
        
        if (player) {
            // Calculate final score
            player.score = Math.floor((Date.now() - player.joinTime) / 1000);
            
            // Notify other players
            socket.broadcast.emit('playerLeft', {
                id: socket.id,
                finalScore: player.score
            });
            
            // Remove player from game state
            players.delete(socket.id);
            
            // Check if we need to add bots
            manageBotPopulation();
        }
    });
    
    // Handle player name update
    socket.on('setPlayerName', (name) => {
        const player = players.get(socket.id);
        if (player) {
            player.name = name || 'Anonymous';
            // Broadcast name update to all players
            io.emit('playerNameUpdated', {
                id: socket.id,
                name: player.name
            });
        }
    });
    
    // Handle chat messages (optional feature)
    socket.on('chatMessage', (message) => {
        const player = players.get(socket.id);
        if (!player) return;
        
        io.emit('chatMessage', {
            playerId: socket.id,
            playerColor: player.color,
            message: message,
            timestamp: Date.now()
        });
    });
});

// Game tick - broadcast game state periodically
setInterval(() => {
    // Update bots
    updateBots();
    
    // Update bullets and check collisions
    updateBullets();
    
    // Manage bot population
    manageBotPopulation();
    
    // Update scores for all alive players
    players.forEach(player => {
        if (player.alive) {
            player.score = Math.floor((Date.now() - player.joinTime) / 1000) + (player.kills * 100);
        }
    });
    
    bots.forEach(bot => {
        if (bot.alive) {
            bot.score = Math.floor((Date.now() - bot.joinTime) / 1000) + (bot.kills * 100);
        }
    });
    
    // Combine real players and bots for game state
    const allPlayers = [
        ...Array.from(players.values()),
        ...Array.from(bots.values())
    ];
    
    // Get current bullets
    const activeBullets = Array.from(bullets.values());
    
    // Broadcast current game state
    if (allPlayers.length > 0) {
        io.emit('gameState', {
            players: allPlayers,
            bullets: activeBullets,
            leaderboard: getLeaderboard(),
            timestamp: Date.now()
        });
    }
}, 100); // 10 times per second for state sync

// Start server
http.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 Echo.io Server is running!
    🌐 Visit http://localhost:${PORT}
    📦 Game Configuration:
       - World Size: ${gameConfig.worldWidth}x${gameConfig.worldHeight}
       - Ping Cooldown: ${gameConfig.pingCooldown}ms
       - Max Ping Radius: ${gameConfig.maxPingRadius}px
       - Bot Count: ${gameConfig.minBots}-${gameConfig.maxBots}
    🤖 Spawning initial bots...
    `);
    
    // Spawn initial bots
    manageBotPopulation();
    console.log(`   ✅ ${bots.size} bots spawned!`);
});
