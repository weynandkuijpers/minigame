const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs').promises;

const PUBLIC_IP = '185.69.166.150'; // Updated server public IPv4 address
const PORT = 8080; // Use 443 for WSS in production
const SELECTION_TIMEOUT = 5000; // 5 seconds for selection
const FINAL_DISPLAY_PHASE = 5000; // 5 seconds for final selection display

const wss = new WebSocket.Server({ host: PUBLIC_IP, port: PORT });

const games = {};
let waitingPlayer = null;
const OUTPUT_FILE = 'final_objects.txt';

function generateRandomHex(bytes) {
    return crypto.randomBytes(bytes).toString('hex');
}

function generateLowEntropyHex(bytes) {
    return '00'.repeat(bytes);
}

function calculateShannonEntropy(str) {
    const freq = {};
    for (let char of str) {
        freq[char] = (freq[char] || 0) + 1;
    }
    const len = str.length;
    let entropy = 0;
    for (let char in freq) {
        const p = freq[char] / len;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

function sanitizeFilename(name) {
    // Replace invalid filename characters with underscores
    return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}

async function writePlayerEntropyFile(player1Name, player2Name, finalData) {
    const sanitizedPlayer1 = sanitizeFilename(player1Name);
    const sanitizedPlayer2 = sanitizeFilename(player2Name);
    const filename = `${sanitizedPlayer1}_${sanitizedPlayer2}_entropy.txt`;
    try {
        await fs.writeFile(filename, finalData);
        console.log(`Wrote final object to ${filename}`);
    } catch (e) {
        console.error(`Error writing to ${filename}: ${e.message}`);
    }
}

async function appendFinalObject(finalData) {
    try {
        await fs.appendFile(OUTPUT_FILE, finalData + '\n');
        console.log(`Appended final object to ${OUTPUT_FILE}`);
    } catch (e) {
        console.error(`Error appending to ${OUTPUT_FILE}: ${e.message}`);
    }
}

wss.on('connection', (ws) => {
    console.log('New WebSocket connection established');

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            console.log(`Received message: ${JSON.stringify(msg)}`);
            switch (msg.type) {
                case 'join':
                    handleJoin(ws, msg.playerId, msg.playerName);
                    break;
                case 'select':
                    handleSelect(ws, msg.playerId, msg.hex);
                    break;
            }
        } catch (e) {
            console.error(`Error parsing message: ${e.message}`);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed');
        for (let gameId in games) {
            const game = games[gameId];
            const playerIndex = game.players.findIndex(p => p.ws === ws);
            if (playerIndex !== -1) {
                console.log(`Player ${game.players[playerIndex].id} disconnected from game ${gameId}`);
                clearTimeout(game.timer);
                game.players.forEach(p => {
                    if (p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
                        p.ws.send(JSON.stringify({ type: 'error', message: 'Other player disconnected' }));
                    }
                });
                delete games[gameId];
            }
        }
        if (waitingPlayer && waitingPlayer.ws === ws) {
            console.log(`Waiting player ${waitingPlayer.playerId} disconnected`);
            waitingPlayer = null;
        }
    });
});

function handleJoin(ws, playerId, playerName) {
    console.log(`Join attempt by playerId: ${playerId}, playerName: ${playerName}`);

    if (waitingPlayer && waitingPlayer.playerId === playerId) {
        console.log(`Rejected: Player ${playerId} already waiting`);
        ws.send(JSON.stringify({ type: 'error', message: 'Cannot join the same game twice' }));
        return;
    }
    for (let gameId in games) {
        if (games[gameId].players.some(p => p.id === playerId)) {
            console.log(`Rejected: Player ${playerId} already in game ${gameId}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Already in a game' }));
            return;
        }
    }

    const name = playerName || playerId; // Fallback to playerId if no name
    if (waitingPlayer) {
        const gameId = crypto.randomBytes(16).toString('hex');
        games[gameId] = {
            players: [
                { id: waitingPlayer.playerId, name: waitingPlayer.playerName, ws: waitingPlayer.ws, number: 1 },
                { id: playerId, name, ws, number: 2 }
            ],
            state: {
                round: 1,
                currentPlayer: 1,
                selections: { 1: [], 2: [] }
            },
            options: Array(4).fill().map(() => generateRandomHex(32)),
            lastSelection: null,
            timer: null
        };
        console.log(`Game ${gameId} started with players: ${games[gameId].players.map(p => `Player ${p.number} (${p.id}, ${p.name})`).join(', ')}`);
        startTurn(gameId);
        waitingPlayer = null;
    } else {
        waitingPlayer = { playerId, playerName: name, ws };
        ws.send(JSON.stringify({ type: 'waiting' }));
        console.log(`Player ${playerId} (${name}) is waiting for second player`);
    }
}

function startTurn(gameId) {
    const game = games[gameId];
    if (!game) return;

    if (game.state.selections[1].length >= 2 && game.state.selections[2].length >= 2) {
        console.log(`Game ${gameId} is complete, skipping startTurn`);
        return;
    }

    clearTimeout(game.timer);
    const options = game.options;
    game.players.forEach((player, index) => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
                type: 'start',
                playerId: player.id,
                playerNumber: player.number,
                currentPlayer: game.state.currentPlayer,
                round: game.state.round,
                options,
                lastSelection: game.lastSelection
            }));
        }
    });

    game.timer = setTimeout(() => {
        const game = games[gameId];
        if (!game) return;
        const currentPlayer = game.state.currentPlayer;
        const player = game.players[currentPlayer - 1];
        if (game.state.selections[currentPlayer].length >= game.state.round) return;

        const lowEntropyHex = generateLowEntropyHex(32);
        console.log(`Timeout: Auto-selecting low-entropy for Player ${currentPlayer} (${player.id}) in game ${gameId}: ${lowEntropyHex}`);
        handleSelect(player.ws, player.id, lowEntropyHex);
    }, SELECTION_TIMEOUT);
}

function handleSelect(ws, playerId, hex) {
    console.log(`Select attempt by playerId: ${playerId}, hex: ${hex}`);
    let gameId = null;
    for (let id in games) {
        if (games[id].players.some(p => p.id === playerId)) {
            gameId = id;
            break;
        }
    }
    if (!gameId) {
        console.log(`Game not found for player ${playerId}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
        return;
    }

    const game = games[gameId];
    const currentPlayer = game.state.currentPlayer;
    const playerIndex = game.players.findIndex(p => p.id === playerId);

    if (playerIndex + 1 !== currentPlayer) {
        console.log(`Not player ${playerId}'s turn in game ${gameId}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Not your turn' }));
        return;
    }

    if (game.state.selections[currentPlayer].length >= game.state.round) {
        console.log(`Player ${playerId} already selected for round ${game.state.round}`);
        return;
    }

    clearTimeout(game.timer);
    game.state.selections[currentPlayer].push(hex);
    console.log(`Player ${currentPlayer} (${playerId}) selected in game ${gameId}, round ${game.state.round}, selections: P1=${game.state.selections[1].length}, P2=${game.state.selections[2].length}`);

    const maxEntropy = 4;
    const selectionEntropy = calculateShannonEntropy(hex);
    const selectionEntropyPercent = (selectionEntropy / maxEntropy * 100).toFixed(2);
    game.lastSelection = {
        playerNumber: currentPlayer,
        hex,
        entropy: selectionEntropyPercent
    };

    if (currentPlayer === 1) {
        game.state.currentPlayer = 2;
        game.options = Array(4).fill().map(() => generateRandomHex(32));
        startTurn(gameId);
    } else {
        if (game.state.selections[2].length < 2) {
            game.state.currentPlayer = 1;
            game.state.round = 2;
            game.options = Array(4).fill().map(() => generateRandomHex(32));
            startTurn(gameId);
        } else {
            clearTimeout(game.timer);
            game.players.forEach(player => {
                if (player.ws.readyState === WebSocket.OPEN) {
                    player.ws.send(JSON.stringify({
                        type: 'selection',
                        playerNumber: game.lastSelection.playerNumber,
                        hex: game.lastSelection.hex,
                        entropy: game.lastSelection.entropy
                    }));
                }
            });

            setTimeout(async () => {
                const game = games[gameId];
                if (!game) return;

                const finalData = [
                    game.state.selections[1][0],
                    game.state.selections[2][0],
                    game.state.selections[1][1],
                    game.state.selections[2][1]
                ].join('');
                if (finalData.length !== 256) {
                    console.error(`Final data length error: ${finalData.length} hex chars`);
                }
                const maxEntropy = 4;
                const totalEntropy = calculateShannonEntropy(finalData);
                const totalEntropyPercent = (totalEntropy / maxEntropy * 100).toFixed(2);
                const player1Data = game.state.selections[1].join('');
                const player2Data = game.state.selections[2].join('');
                const player1Entropy = calculateShannonEntropy(player1Data);
                const player2Entropy = calculateShannonEntropy(player2Data);
                const player1EntropyPercent = (player1Entropy / maxEntropy * 100).toFixed(2);
                const player2EntropyPercent = (player2Entropy / maxEntropy * 100).toFixed(2);
                const winner = player1Entropy > player2Entropy ? 'Player 1 wins!' :
                               player2Entropy > player1Entropy ? 'Player 2 wins!' : 'It\'s a tie!';

                await writePlayerEntropyFile(game.players[0].name, game.players[1].name, finalData);
                await appendFinalObject(finalData);

                game.players.forEach(player => {
                    if (player.ws.readyState === WebSocket.OPEN) {
                        player.ws.send(JSON.stringify({
                            type: 'result',
                            finalData,
                            totalEntropy: totalEntropyPercent,
                            player1Entropy: player1EntropyPercent,
                            player2Entropy: player2EntropyPercent,
                            winner,
                            players: game.state.selections
                        }));
                    }
                });
                console.log(`Game ${gameId} ended. Winner: ${winner}`);

                delete games[gameId];
            }, FINAL_DISPLAY_PHASE);
        }
    }
}

console.log(`WebSocket server running on ws://${PUBLIC_IP}:${PORT}`);