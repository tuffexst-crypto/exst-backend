const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const API_KEY = 'HRKDSKC-ZETMQP9-J1FYZ4W-A3B355B';
const NOWPAYMENTS_URL = 'https://api.nowpayments.io/v1';

async function createNowPaymentsInvoice(coinSymbol, usdAmount) {
    const coinRate = { BTC: 65000, ETH: 3400, LTC: 82, USDT: 1, DOGE: 0.14 };
    const rate = coinRate[coinSymbol] || 1;
    const cryptoAmount = parseFloat((usdAmount / rate).toFixed(6));

    const res = await fetch(`${NOWPAYMENTS_URL}/payment`, {
        method: 'POST',
        headers: {
            'x-api-key': API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            price_amount: parseFloat(usdAmount),
            price_currency: 'usd',
            pay_amount: cryptoAmount,
            pay_currency: coinSymbol.toLowerCase(),
            ipn_callback_url: 'https://nowpayments.io',
            order_id: 'EXST-' + Date.now(),
            order_description: 'EXST Casino Balance Refill'
        })
    });

    if (res.ok) {
        const data = await res.json();
        return {
            id: data.payment_id,
            coin: coinSymbol,
            usdAmount: parseFloat(usdAmount),
            cryptoAmount: data.pay_amount || cryptoAmount,
            address: data.pay_address,
            status: data.payment_status || 'waiting'
        };
    } else {
        const text = await res.text();
        throw new Error('NOWPayments creation failed: ' + text);
    }
}

async function checkNowPaymentsStatus(paymentId) {
    const res = await fetch(`${NOWPAYMENTS_URL}/payment/${paymentId}`, {
        headers: { 'x-api-key': API_KEY }
    });
    if (res.ok) {
        const data = await res.json();
        return {
            status: data.payment_status,
            isSandbox: false
        };
    } else {
        const text = await res.text();
        throw new Error('NOWPayments check failed: ' + text);
    }
}

const server = http.createServer((req, res) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    
    if (parsedUrl.pathname === '/api/create-payment' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { coinSymbol, usdAmount } = JSON.parse(body);
                const invoice = await createNowPaymentsInvoice(coinSymbol, usdAmount);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(invoice));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    if (parsedUrl.pathname === '/api/check-payment' && req.method === 'GET') {
        const paymentId = parsedUrl.searchParams.get('paymentId');
        checkNowPaymentsStatus(paymentId).then(status => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
        }).catch(e => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        });
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('RPS Duels WebSocket Server is running.\n');
});

const wss = new WebSocketServer({ server });

// Server-side State
const players = {}; // username -> { balance, totalWinnings, ws }
let activeDuels = []; // array of { id, creator, wager, creatorMove, status, opponent, opponentMove }
let activeGiveaway = null;
const ADMIN_PASSWORD = 'admin123';
const activeAdminTokens = new Set();

function broadcastLobby() {
    const duelList = activeDuels.map(d => ({
        id: d.id,
        creator: d.creator,
        wager: d.wager,
        status: d.status
    }));

    const leaderboard = Object.keys(players).map(name => ({
        name: name,
        balance: players[name].balance,
        winnings: players[name].totalWinnings
    })).sort((a, b) => b.balance - a.balance);

    const payload = JSON.stringify({
        type: 'lobby_update',
        duels: duelList,
        leaderboard: leaderboard
    });

    wss.clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(payload);
        }
    });
}

wss.on('connection', (ws) => {
    let clientUsername = null;
    ws.isAdmin = false;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'auth': {
                    const { username, balance, winnings } = data;
                    clientUsername = username;
                    
                    // Always register or update player details to sync frontend and backend balances
                    players[username] = {
                        balance: parseFloat(balance) || 0,
                        totalWinnings: parseFloat(winnings) || 0,
                        ws: ws
                    };
                    
                    console.log(`Player connected: ${username} with balance $${players[username].balance}`);
                    
                    // Reply with confirmation
                    ws.send(JSON.stringify({
                        type: 'auth_success',
                        balance: players[username].balance,
                        winnings: players[username].totalWinnings
                    }));
                    
                    if (activeGiveaway) {
                        ws.send(JSON.stringify({
                            type: 'giveaway_started',
                            id: activeGiveaway.id,
                            prize: activeGiveaway.prize,
                            duration: Math.max(0, Math.ceil((activeGiveaway.endTime - Date.now()) / 1000)),
                            minWager: activeGiveaway.minWager,
                            entrants: activeGiveaway.entrants,
                            host: activeGiveaway.host
                        }));
                    }
                    
                    broadcastLobby();
                    break;
                }

                case 'admin_login': {
                    const { password, token } = data;
                    let success = false;
                    let useToken = token;

                    if (token) {
                        if (activeAdminTokens.has(token)) {
                            success = true;
                        }
                    } else if (password) {
                        if (password === ADMIN_PASSWORD) {
                            success = true;
                        }
                    }

                    if (success) {
                        ws.isAdmin = true;
                        const newToken = useToken || Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
                        activeAdminTokens.add(newToken);

                        ws.send(JSON.stringify({
                            type: 'admin_auth_success',
                            token: newToken
                        }));
                        console.log(`Admin session verified via ${token ? 'Token' : 'Password'}.`);
                    } else {
                        ws.isAdmin = false;
                        ws.send(JSON.stringify({
                            type: 'admin_auth_failed',
                            message: 'Invalid administrator credentials.',
                            showToast: !token
                        }));
                    }
                    break;
                }

                case 'update_balance': {
                    const { username, balance, winnings } = data;
                    if (players[username]) {
                        players[username].balance = balance;
                        players[username].totalWinnings = winnings;
                        broadcastLobby();
                    }
                    break;
                }

                case 'create_duel': {
                    const { creator, wager, move } = data;
                    
                    // Validate balance
                    if (!players[creator] || players[creator].balance < wager) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Insufficient balance' }));
                        return;
                    }

                    // Deduct balance
                    players[creator].balance -= wager;
                    ws.send(JSON.stringify({
                        type: 'balance_update',
                        balance: players[creator].balance
                    }));

                    const duel = {
                        id: Math.random().toString(36).substring(2, 9),
                        creator: creator,
                        wager: wager,
                        creatorMove: move,
                        status: 'Open',
                        opponent: null,
                        opponentMove: null
                    };

                    activeDuels.unshift(duel);
                    console.log(`Duel created by ${creator} for $${wager}`);
                    broadcastLobby();
                    break;
                }

                case 'join_duel': {
                    const { opponent, duelId, move } = data;
                    
                    const duel = activeDuels.find(d => d.id === duelId);
                    if (!duel || duel.status !== 'Open') {
                        ws.send(JSON.stringify({ type: 'error', message: 'Duel no longer available' }));
                        return;
                    }

                    if (duel.creator === opponent) {
                        ws.send(JSON.stringify({ type: 'error', message: 'You cannot join your own duel' }));
                        return;
                    }

                    if (!players[opponent] || players[opponent].balance < duel.wager) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Insufficient balance' }));
                        return;
                    }

                    // Deduct balance
                    players[opponent].balance -= duel.wager;
                    ws.send(JSON.stringify({
                        type: 'balance_update',
                        balance: players[opponent].balance
                    }));

                    duel.status = 'Playing';
                    duel.opponent = opponent;
                    duel.opponentMove = move;

                    console.log(`Player ${opponent} joined duel ${duelId}`);
                    broadcastLobby();

                    // Send duel info to both players to start visual reveal countdowns
                    const creatorWs = players[duel.creator]?.ws;
                    const opponentWs = players[opponent]?.ws;

                    const matchData = {
                        type: 'duel_start',
                        duelId: duel.id,
                        creator: duel.creator,
                        creatorMove: duel.creatorMove,
                        opponent: duel.opponent,
                        opponentMove: duel.opponentMove,
                        wager: duel.wager
                    };

                    if (creatorWs && creatorWs.readyState === 1) {
                        creatorWs.send(JSON.stringify(matchData));
                    }
                    if (opponentWs && opponentWs.readyState === 1) {
                        opponentWs.send(JSON.stringify(matchData));
                    }

                    // Resolve outcomes on the server
                    resolveDuelOutcome(duel);
                    break;
                }

                case 'chat_msg': {
                    const { username, text, vipRank } = data;
                    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    
                    const chatPayload = JSON.stringify({
                        type: 'chat_broadcast',
                        username: username,
                        text: text,
                        vipRank: vipRank || null,
                        timestamp: timestamp
                    });
                    
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(chatPayload);
                        }
                    });
                    break;
                }

                case 'create_giveaway': {
                    if (!ws.isAdmin) {
                        ws.send(JSON.stringify({
                            type: 'giveaway_error',
                            message: 'Only administrators can launch community giveaways!'
                        }));
                        break;
                    }
                    const { username, prize, duration, minWager } = data;
                    
                    if (activeGiveaway) {
                        ws.send(JSON.stringify({
                            type: 'giveaway_error',
                            message: 'A giveaway is already active!'
                        }));
                        break;
                    }

                    const prizeAmt = parseFloat(prize);
                    const dur = parseInt(duration) || 60;
                    const minW = parseFloat(minWager) || 0;

                    if (isNaN(prizeAmt) || prizeAmt <= 0) {
                        ws.send(JSON.stringify({
                            type: 'giveaway_error',
                            message: 'Invalid prize amount!'
                        }));
                        break;
                    }

                    // Check host balance
                    const hostPlayer = players[username];
                    if (!hostPlayer || hostPlayer.balance < prizeAmt) {
                        ws.send(JSON.stringify({
                            type: 'giveaway_error',
                            message: 'Insufficient balance to host giveaway!'
                        }));
                        break;
                    }

                    // Deduct balance from host
                    hostPlayer.balance -= prizeAmt;
                    ws.send(JSON.stringify({
                        type: 'balance_update',
                        balance: hostPlayer.balance
                    }));

                    // Set up giveaway state
                    activeGiveaway = {
                        id: Math.random().toString(36).substring(2, 9),
                        prize: prizeAmt,
                        duration: dur,
                        minWager: minW,
                        endTime: Date.now() + (dur * 1000),
                        entrants: [],
                        host: username
                    };

                    // Broadcast starting
                    const startPayload = JSON.stringify({
                        type: 'giveaway_started',
                        id: activeGiveaway.id,
                        prize: activeGiveaway.prize,
                        duration: activeGiveaway.duration,
                        minWager: activeGiveaway.minWager,
                        entrants: [],
                        host: activeGiveaway.host
                    });

                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(startPayload);
                        }
                    });

                    // Broadcast announcement to live chat
                    const chatAnnouncement = JSON.stringify({
                        type: 'chat_broadcast',
                        username: 'System',
                        text: `🎁 <strong style="color:#ffb020;">GIVEAWAY STARTED!</strong> @${username} is hosting a <strong>$${prizeAmt.toFixed(2)}</strong> Giveaway! Go to the Giveaways tab to join! (Req: $${minW.toFixed(2)} wager)`,
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                    
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(chatAnnouncement);
                        }
                    });

                    // Set timeout to resolve
                    activeGiveaway.timerId = setTimeout(() => {
                        resolveGiveaway();
                    }, dur * 1000);

                    break;
                }

                case 'join_giveaway': {
                    const { username, wageredVolume } = data;
                    if (!activeGiveaway) {
                        ws.send(JSON.stringify({
                            type: 'giveaway_error',
                            message: 'No active giveaway!'
                        }));
                        break;
                    }

                    if (activeGiveaway.entrants.includes(username)) {
                        ws.send(JSON.stringify({
                            type: 'giveaway_error',
                            message: 'You have already joined!'
                        }));
                        break;
                    }

                    if (wageredVolume < activeGiveaway.minWager) {
                        ws.send(JSON.stringify({
                            type: 'giveaway_error',
                            message: `Min wager requirement not met! (Need $${activeGiveaway.minWager.toFixed(2)})`
                        }));
                        break;
                    }

                    activeGiveaway.entrants.push(username);

                    // Broadcast entrants update
                    const entrantsPayload = JSON.stringify({
                        type: 'giveaway_entrants_update',
                        entrants: activeGiveaway.entrants
                    });

                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(entrantsPayload);
                        }
                    });

                    break;
                }

                case 'admin_modify_balance': {
                    if (!ws.isAdmin) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Unauthorized action.'
                        }));
                        break;
                    }
                    const { targetUser, amount, action } = data;
                    
                    const target = players[targetUser];
                    if (target) {
                        const change = parseFloat(amount) || 0;
                        if (action === 'credit') {
                            target.balance += change;
                        } else if (action === 'debit') {
                            target.balance = Math.max(0, target.balance - change);
                        }
                        
                        if (target.ws && target.ws.readyState === 1) {
                            target.ws.send(JSON.stringify({
                                type: 'balance_update',
                                balance: target.balance
                            }));
                        }
                        
                        console.log(`Admin modified ${targetUser} balance. Action: ${action}, Amount: $${change}. New balance: $${target.balance}`);
                        broadcastLobby();
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Player '${targetUser}' is not online right now.`
                        }));
                    }
                    break;
                }

                case 'place_bet': {
                    const { game, username, wager, multiplier, payout } = data;
                    
                    const betPayload = JSON.stringify({
                        type: 'live_bet_broadcast',
                        game,
                        username,
                        wager,
                        multiplier,
                        payout
                    });
                    
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(betPayload);
                        }
                    });
                    break;
                }

                case 'tip_player': {
                    const { sender, recipient, amount } = data;
                    const val = parseFloat(amount) || 0;
                    
                    if (val <= 0) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid tip amount.' }));
                        return;
                    }

                    const fromPlayer = players[sender];
                    const toPlayer = players[recipient];

                    if (!fromPlayer) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Sender not found.' }));
                        return;
                    }

                    if (fromPlayer.balance < val) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Insufficient balance to tip.' }));
                        return;
                    }

                    if (!toPlayer) {
                        ws.send(JSON.stringify({ type: 'error', message: `Player '${recipient}' is not online.` }));
                        return;
                    }

                    if (sender.toLowerCase() === recipient.toLowerCase()) {
                        ws.send(JSON.stringify({ type: 'error', message: 'You cannot tip yourself.' }));
                        return;
                    }

                    fromPlayer.balance -= val;
                    toPlayer.balance += val;

                    if (fromPlayer.ws && fromPlayer.ws.readyState === 1) {
                        fromPlayer.ws.send(JSON.stringify({
                            type: 'balance_update',
                            balance: fromPlayer.balance
                        }));
                    }

                    if (toPlayer.ws && toPlayer.ws.readyState === 1) {
                        toPlayer.ws.send(JSON.stringify({
                            type: 'balance_update',
                            balance: toPlayer.balance
                        }));
                    }

                    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const chatPayload = JSON.stringify({
                        type: 'chat_broadcast',
                        username: 'System',
                        text: `💸 ${sender} tipped $${val.toFixed(2)} to ${recipient}!`,
                        timestamp: timestamp
                    });

                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(chatPayload);
                        }
                    });

                    broadcastLobby();
                    break;
                }
            }
        } catch (e) {
            console.error('Error handling message:', e);
        }
    });

    ws.on('close', () => {
        if (clientUsername) {
            console.log(`Player disconnected: ${clientUsername}`);
            if (players[clientUsername]) {
                players[clientUsername].ws = null;
            }
            // Cleanup any Open duels created by this player
            activeDuels = activeDuels.filter(d => !(d.creator === clientUsername && d.status === 'Open'));
            broadcastLobby();
        }
    });
});

function resolveDuelOutcome(duel) {
    const p1 = duel.creator;
    const p2 = duel.opponent;
    const m1 = duel.creatorMove;
    const m2 = duel.opponentMove;
    const wager = duel.wager;

    let winner = null;
    if (m1 === m2) {
        winner = 'tie';
    } else if (
        (m1 === 'rock' && m2 === 'scissors') ||
        (m1 === 'paper' && m2 === 'rock') ||
        (m1 === 'scissors' && m2 === 'paper')
    ) {
        winner = p1;
    } else {
        winner = p2;
    }

    // Delay outcome credits on the server to match the client countdown transition
    setTimeout(() => {
        if (winner === 'tie') {
            if (players[p1]) players[p1].balance += wager;
            if (players[p2]) players[p2].balance += wager;
        } else {
            const winAmount = wager * 1.95;
            if (players[winner]) {
                players[winner].balance += winAmount;
                players[winner].totalWinnings += winAmount;
            }
        }

        // Remove from active list
        activeDuels = activeDuels.filter(d => d.id !== duel.id);
        
        // Push final balances
        if (players[p1] && players[p1].ws && players[p1].ws.readyState === 1) {
            players[p1].ws.send(JSON.stringify({
                type: 'outcome_resolved',
                balance: players[p1].balance,
                winnings: players[p1].totalWinnings
            }));
        }
        if (players[p2] && players[p2].ws && players[p2].ws.readyState === 1) {
            players[p2].ws.send(JSON.stringify({
                type: 'outcome_resolved',
                balance: players[p2].balance,
                winnings: players[p2].totalWinnings
            }));
        }

        const betBroadcastP1 = JSON.stringify({
            type: 'live_bet_broadcast',
            game: 'RPS Duel',
            username: p1,
            wager: wager,
            multiplier: winner === 'tie' ? 1.0 : (winner === p1 ? 1.95 : 0.0),
            payout: winner === 'tie' ? wager : (winner === p1 ? wager * 1.95 : 0.0)
        });

        const betBroadcastP2 = JSON.stringify({
            type: 'live_bet_broadcast',
            game: 'RPS Duel',
            username: p2,
            wager: wager,
            multiplier: winner === 'tie' ? 1.0 : (winner === p2 ? 1.95 : 0.0),
            payout: winner === 'tie' ? wager : (winner === p2 ? wager * 1.95 : 0.0)
        });

        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(betBroadcastP1);
                client.send(betBroadcastP2);
            }
        });

        broadcastLobby();
    }, 4500); // 3s countdown + 1.5s delay
}

function resolveGiveaway() {
    if (!activeGiveaway) return;

    const { prize, entrants, host, id } = activeGiveaway;

    if (entrants.length === 0) {
        // Refund host
        const hPlayer = players[host];
        if (hPlayer) {
            hPlayer.balance += prize;
            if (hPlayer.ws && hPlayer.ws.readyState === 1) {
                hPlayer.ws.send(JSON.stringify({
                    type: 'balance_update',
                    balance: hPlayer.balance
                }));
                hPlayer.ws.send(JSON.stringify({
                    type: 'giveaway_error',
                    message: 'Giveaway cancelled: no players joined. Refunded!'
                }));
            }
        }

        // Broadcast cancellation
        const cancelPayload = JSON.stringify({
            type: 'giveaway_ended',
            winner: null,
            prize: prize,
            message: 'No entrants joined. Giveaway cancelled.'
        });

        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(cancelPayload);
            }
        });

        // Broadcast announcement to live chat
        const chatCancel = JSON.stringify({
            type: 'chat_broadcast',
            username: 'System',
            text: `⚠️ The <strong>$${prize.toFixed(2)}</strong> Giveaway hosted by @${host} has been cancelled because no one entered.`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        
        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(chatCancel);
            }
        });

        activeGiveaway = null;
        return;
    }

    // Pick random winner
    const winner = entrants[Math.floor(Math.random() * entrants.length)];
    
    // Credit winner
    const wPlayer = players[winner];
    if (wPlayer) {
        wPlayer.balance += prize;
        if (wPlayer.ws && wPlayer.ws.readyState === 1) {
            wPlayer.ws.send(JSON.stringify({
                type: 'balance_update',
                balance: wPlayer.balance
            }));
            wPlayer.ws.send(JSON.stringify({
                type: 'giveaway_win_notify',
                prize: prize
            }));
        }
    }

    // Broadcast winner
    const endPayload = JSON.stringify({
        type: 'giveaway_ended',
        winner: winner,
        prize: prize
    });

    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(endPayload);
        }
    });

    // Broadcast announcement to live chat
    const chatEnd = JSON.stringify({
        type: 'chat_broadcast',
        username: 'System',
        text: `🎉 <strong style="color:#2ecc71;">GIVEAWAY RESOLVED!</strong> @${winner} has won the <strong>$${prize.toFixed(2)}</strong> Giveaway hosted by @${host}!`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(chatEnd);
        }
    });

    activeGiveaway = null;
    broadcastLobby();
}

server.listen(PORT, () => {
    console.log(`WebSocket server running on port ${PORT}`);
});
