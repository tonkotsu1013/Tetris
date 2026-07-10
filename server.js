const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ↓ この1行を追加します！
app.use(express.static(path.join(__dirname)));

// データベース初期化
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Connected to the SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS friends (user_code TEXT, friend_code TEXT, status TEXT, is_favorite INTEGER DEFAULT 0, PRIMARY KEY (user_code, friend_code))`); 
    db.run(`CREATE TABLE IF NOT EXISTS match_history (id INTEGER PRIMARY KEY AUTOINCREMENT, p1_code TEXT, p2_code TEXT, p1_type TEXT, p2_type TEXT, date DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    // 勝敗記録用のカラムを追加
    db.run(`ALTER TABLE match_history ADD COLUMN winner_code TEXT`, (err) => {}); 
db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_code TEXT, receiver_code TEXT, group_id INTEGER, message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
db.run(`CREATE TABLE IF NOT EXISTS chat_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, owner_code TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, user_code TEXT, PRIMARY KEY (group_id, user_code))`);

    // ── めっちゃカメレオン用テーブル ──────────────────────────────
    db.run(`CREATE TABLE IF NOT EXISTS camereon_rooms (
        id TEXT PRIMARY KEY,
        name TEXT,
        host_code TEXT,
        password TEXT,
        map TEXT DEFAULT 'hideout',
        max_players INTEGER DEFAULT 8,
        is_public INTEGER DEFAULT 1,
        phase TEXT DEFAULT 'lobby',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS camereon_stats (
        user_code TEXT PRIMARY KEY,
        games_played INTEGER DEFAULT 0,
        games_won INTEGER DEFAULT 0,
        total_score INTEGER DEFAULT 0,
        kills INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const onlineUsers = {}; 
const socketMap = {};   
let matchmakingQueue = [];
const activeMatches = {}; 

// ── めっちゃカメレオン 状態管理 ────────────────────────────────────────────
const camereonRooms   = new Map(); // roomId -> Room
const camereonPlayers = new Map(); // socketId -> { roomId, playerData }

const CAMEREON_CONFIG = {
    PAINT_TIME:    60,
    HUNT_TIME:     90,
    MIN_PLAYERS:    2,
    MAX_PLAYERS:   10,
    HUNTER_RATIO: 0.25,
    BULLET_DAMAGE:  34,
    CHAMELEON_HP:  100,
    SCORE_SURVIVE: 200,
    SCORE_FOUND:    50,
    LOBBY_COUNTDOWN: 5,
    ROOMS_MAX:      50,
};

function camereonMakeRoom(id, name, hostCode, opts = {}) {
    return {
        id, name, host: hostCode,
        password: opts.password || null,
        phase: 'lobby',
        players: new Map(),
        chat: [],
        timer: null, timerEnd: 0,
        map: opts.map || 'hideout',
        paintData: new Map(),
        createdAt: Date.now(),
        maxPlayers: Math.min(opts.maxPlayers || 8, CAMEREON_CONFIG.MAX_PLAYERS),
        isPublic: opts.isPublic !== false,
        gameCount: 0,
    };
}

function camereonMakePlayer(socketId, code, name, color) {
    const colors = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FECA57','#FF9FF3','#54A0FF','#5F27CD'];
    return {
        id: socketId, code: code || null, name: name || `ゲスト${Math.floor(Math.random()*9999)}`,
        role: 'chameleon', hp: CAMEREON_CONFIG.CHAMELEON_HP, alive: true,
        score: 0, x: 0.5, y: 0.5, pose: 'idle',
        color: color || colors[Math.floor(Math.random() * colors.length)],
        isReady: false, kills: 0, paintStrokes: [],
    };
}

function camereonPlayerView(p) {
    return {
        id: p.id, name: p.name, role: p.role, hp: p.hp, alive: p.alive,
        score: p.score, x: p.x, y: p.y, pose: p.pose, color: p.color,
        isReady: p.isReady, kills: p.kills, paintStrokes: p.paintStrokes,
    };
}

function camereonRoomPublic(r) {
    return {
        id: r.id, name: r.name, host: r.host, phase: r.phase,
        playerCount: r.players.size, maxPlayers: r.maxPlayers,
        map: r.map, isPublic: r.isPublic, hasPassword: !!r.password,
        gameCount: r.gameCount, createdAt: r.createdAt,
    };
}

function camereonRoomFull(r) {
    const players = [];
    r.players.forEach(p => players.push(camereonPlayerView(p)));
    return { ...camereonRoomPublic(r), players, chat: r.chat.slice(-50), timerEnd: r.timerEnd };
}

function camereonBroadcast(r) {
    io.to('camereon_' + r.id).emit('camereon:room:update', camereonRoomFull(r));
}

function camereonChat(r, from, text, type = 'system') {
    const msg = { id: Date.now() + Math.random(), from, text, type, ts: Date.now() };
    r.chat.push(msg);
    if (r.chat.length > 200) r.chat.shift();
    io.to('camereon_' + r.id).emit('camereon:chat:message', msg);
}

function camereonAssignRoles(r) {
    const arr = Array.from(r.players.values());
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const hunterCount = Math.max(1, Math.floor(arr.length * CAMEREON_CONFIG.HUNTER_RATIO));
    arr.forEach((p, i) => {
        p.role  = i < hunterCount ? 'hunter' : 'chameleon';
        p.hp    = CAMEREON_CONFIG.CHAMELEON_HP;
        p.alive = true;
        p.x     = 0.1 + Math.random() * 0.8;
        p.y     = 0.1 + Math.random() * 0.8;
        p.paintStrokes = [];
        r.paintData.set(p.id, []);
    });
}

function camereonCheckHuntOver(r) {
    const chams = Array.from(r.players.values()).filter(p => p.role === 'chameleon');
    if (chams.length > 0 && chams.every(p => !p.alive)) {
        camereonEndHunt(r, 'hunter_win');
    }
}

function camereonEndHunt(r, reason) {
    if (r.phase === 'result') return;
    camereonClearTimer(r);
    r.phase = 'result';

    const result = { reason, winner: reason === 'hunter_win' ? 'hunters' : 'chameleons', players: [] };
    r.players.forEach(p => {
        if (p.role === 'chameleon' && p.alive) p.score += CAMEREON_CONFIG.SCORE_SURVIVE;
        result.players.push(camereonPlayerView(p));
    });
    result.players.sort((a, b) => b.score - a.score);

    io.to('camereon_' + r.id).emit('camereon:game:result', result);
    camereonChat(r, 'SYSTEM',
        reason === 'hunter_win' ? '🔫 ハンター勝利！全カメレオンを発見！' : '🦎 カメレオン勝利！生き残りました！'
    );
    r.gameCount++;

    // DBに統計保存
    r.players.forEach(p => {
        if (!p.code) return;
        const won = (result.winner === 'hunters' && p.role === 'hunter') ||
                    (result.winner === 'chameleons' && p.role === 'chameleon' && p.alive) ? 1 : 0;
        db.run(`INSERT INTO camereon_stats (user_code, games_played, games_won, total_score, kills)
                VALUES (?, 1, ?, ?, ?)
                ON CONFLICT(user_code) DO UPDATE SET
                    games_played = games_played + 1,
                    games_won    = games_won + ?,
                    total_score  = total_score + ?,
                    kills        = kills + ?,
                    updated_at   = CURRENT_TIMESTAMP`,
            [p.code, won, p.score, p.kills, won, p.score, p.kills]);
    });

    // 12秒後にロビーへ
    setTimeout(() => {
        if (!camereonRooms.has(r.id)) return;
        r.phase = 'lobby';
        r.players.forEach(p => {
            p.isReady = false; p.role = 'chameleon';
            p.hp = CAMEREON_CONFIG.CHAMELEON_HP; p.alive = true; p.paintStrokes = [];
        });
        r.paintData.clear();
        camereonBroadcast(r);
        camereonChat(r, 'SYSTEM', '🏠 ロビーに戻りました。');
    }, 12000);
}

function camereonClearTimer(r) {
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
}

function camereonStartPaint(r) {
    r.phase = 'paint';
    camereonAssignRoles(r);
    const players = Array.from(r.players.values()).map(camereonPlayerView);

    io.to('camereon_' + r.id).emit('camereon:game:phase', {
        phase: 'paint', duration: CAMEREON_CONFIG.PAINT_TIME, map: r.map, players
    });
    // 各プレイヤーに役割を個別通知
    r.players.forEach((p, sid) => {
        io.to(sid).emit('camereon:player:role', { role: p.role, hp: p.hp, x: p.x, y: p.y });
    });
    camereonChat(r, 'SYSTEM', `🎨 ペイントフェーズ開始！${CAMEREON_CONFIG.PAINT_TIME}秒で擬態してください！`);

    r.timerEnd = Date.now() + CAMEREON_CONFIG.PAINT_TIME * 1000;
    r.timer = setTimeout(() => { if (camereonRooms.has(r.id)) camereonStartHunt(r); }, CAMEREON_CONFIG.PAINT_TIME * 1000);

    [30, 10].forEach(sec => {
        setTimeout(() => {
            if (camereonRooms.has(r.id) && r.phase === 'paint')
                io.to('camereon_' + r.id).emit('camereon:timer:warning', { seconds: sec, phase: 'paint' });
        }, (CAMEREON_CONFIG.PAINT_TIME - sec) * 1000);
    });
}

function camereonStartHunt(r) {
    r.phase = 'hunt';
    const players = Array.from(r.players.values()).map(camereonPlayerView);

    io.to('camereon_' + r.id).emit('camereon:game:phase', {
        phase: 'hunt', duration: CAMEREON_CONFIG.HUNT_TIME, map: r.map, players
    });
    camereonChat(r, 'SYSTEM', '🔫 ハントフェーズ開始！カメレオンは逃げろ！');

    r.timerEnd = Date.now() + CAMEREON_CONFIG.HUNT_TIME * 1000;
    r.timer = setTimeout(() => { if (camereonRooms.has(r.id) && r.phase === 'hunt') camereonEndHunt(r, 'time_up'); }, CAMEREON_CONFIG.HUNT_TIME * 1000);

    [60, 30, 10].forEach(sec => {
        setTimeout(() => {
            if (camereonRooms.has(r.id) && r.phase === 'hunt')
                io.to('camereon_' + r.id).emit('camereon:timer:warning', { seconds: sec, phase: 'hunt' });
        }, (CAMEREON_CONFIG.HUNT_TIME - sec) * 1000);
    });
}

function camereonHandleLeave(socketId) {
    const entry = camereonPlayers.get(socketId);
    if (!entry) return;
    const r      = camereonRooms.get(entry.roomId);
    const player = entry.player;
    camereonPlayers.delete(socketId);
    if (!r) return;

    r.players.delete(socketId);

    if (r.players.size === 0) {
        camereonClearTimer(r);
        camereonRooms.delete(r.id);
        return;
    }
    if (r.host === socketId) {
        r.host = r.players.keys().next().value;
        const newHost = r.players.get(r.host);
        camereonChat(r, 'SYSTEM', `👑 ${newHost.name} がホストになりました。`);
    }
    camereonChat(r, 'SYSTEM', `👋 ${player.name} が退出しました。`);
    if (r.phase === 'hunt' && player.role === 'chameleon') {
        player.alive = false;
        camereonCheckHuntOver(r);
    }
    if (r.phase !== 'result') camereonBroadcast(r);
}

// 5分ごとに空き部屋を掃除
setInterval(() => {
    const now = Date.now();
    camereonRooms.forEach((r, id) => {
        if (r.players.size === 0 && now - r.createdAt > 60000) {
            camereonClearTimer(r);
            camereonRooms.delete(id);
        }
    });
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
// 1. 厳密なログイン処理
    socket.on('login', (data, callback) => {
        const { code, name } = data;
        
        if (onlineUsers[socket.id]) {
            delete socketMap[onlineUsers[socket.id].code];
            delete onlineUsers[socket.id];
        }

        db.get(`SELECT * FROM users WHERE code = ? OR name = ?`, [code, name], (err, row) => {
            if (row) {
                // ① データベースに一致するユーザーが見つかった場合
                if (row.code === code && row.name === name) {
                    // --- 以下の3行を追加 ---
                    if (socketMap[code] && socketMap[code] !== socket.id) {
                        delete onlineUsers[socketMap[code]];
                    }
                    // -----------------------
                    setupUserStatus(socket.id, code, name);
                    callback({ success: true, message: 'ログインしました' });
                } else {
                    // 名前かコードのどちらかが、他の誰かに既に使われている場合
                    callback({ success: false, message: '指定されたコードまたは名前は既に使用されています' });
                }
            } else {
                // ② データベースにデータがなかった場合（新規登録）
                db.run(`INSERT INTO users (code, name) VALUES (?, ?)`, [code, name], function(err) {
                    if (err) return callback({ success: false, message: '登録に失敗しました' });
                    setupUserStatus(socket.id, code, name);
                    callback({ success: true, message: '新規登録＆ログインしました' });
                });
            }
        });
    });

    function setupUserStatus(socketId, code, name) {
        onlineUsers[socketId] = { code, name, status: 'idle' };
        socketMap[code] = socketId;
        io.emit('friends_data_update'); 
    }

    // 2. フレンド取得
    socket.on('get_friends', () => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        
        db.all(`
            SELECT u.code, u.name, f.status, f.is_favorite 
            FROM friends f 
            JOIN users u ON (f.friend_code = u.code AND f.user_code = ?) 
                         OR (f.user_code = u.code AND f.friend_code = ? AND f.status = 'pending')
        `, [user.code, user.code], (err, rows) => {
            if (err) return;
            const friendsList = rows.map(r => ({
                code: r.code, name: r.name, status: r.status, is_favorite: r.is_favorite,
                isOnline: !!socketMap[r.code],
                currentActivity: socketMap[r.code] ? onlineUsers[socketMap[r.code]].status : 'offline'
            }));
            socket.emit('friends_data', friendsList);
        });
    });

    socket.on('toggle_favorite', (targetCode) => {
        const user = onlineUsers[socket.id];
        if(!user) return;
        db.run(`UPDATE friends SET is_favorite = CASE WHEN is_favorite = 1 THEN 0 ELSE 1 END WHERE user_code = ? AND friend_code = ?`, [user.code, targetCode], () => {
            socket.emit('friends_data_update');
        });
    });

    socket.on('delete_friend', (targetCode) => {
        const user = onlineUsers[socket.id];
        if(!user) return;
        db.run(`DELETE FROM friends WHERE (user_code = ? AND friend_code = ?) OR (user_code = ? AND friend_code = ?)`, [user.code, targetCode, targetCode, user.code], () => {
            socket.emit('friends_data_update');
            if (socketMap[targetCode]) io.to(socketMap[targetCode]).emit('friends_data_update');
        });
    });

    socket.on('get_history', (targetCode) => {
        const user = onlineUsers[socket.id];
        if(!user) return;
        db.all(`SELECT * FROM match_history WHERE (p1_code = ? AND p2_code = ?) OR (p1_code = ? AND p2_code = ?) ORDER BY date DESC LIMIT 15`, 
        [user.code, targetCode, targetCode, user.code], (err, rows) => {
            socket.emit('history_data', { targetCode, history: rows || [] });
        });
    });

    // 3. フレンド申請系
    socket.on('send_friend_request', (targetCode, callback) => {
        const user = onlineUsers[socket.id];
        if (!user || user.code === targetCode) return callback({ success: false, message: '無効な操作です。' });
        db.get(`SELECT * FROM users WHERE code = ?`, [targetCode], (err, row) => {
            if (!row) return callback({ success: false, message: 'ユーザーが見つかりません。' });
            db.run(`INSERT INTO friends (user_code, friend_code, status) VALUES (?, ?, 'pending')`, [user.code, targetCode], (err) => {
                if (err) return callback({ success: false, message: '既に申請済みかフレンドです。' });
                callback({ success: true, message: '申請を送信しました。' });
                if (socketMap[targetCode]) io.to(socketMap[targetCode]).emit('friends_data_update');
            });
        });
    });

    socket.on('respond_friend_request', (data) => {
        const user = onlineUsers[socket.id];
        const { targetCode, accept } = data;
        if (!user) return;
        if (accept) {
            db.run(`UPDATE friends SET status = 'accepted' WHERE user_code = ? AND friend_code = ?`, [targetCode, user.code]);
            db.run(`INSERT OR IGNORE INTO friends (user_code, friend_code, status) VALUES (?, ?, 'accepted')`, [user.code, targetCode]);
        } else {
            db.run(`DELETE FROM friends WHERE user_code = ? AND friend_code = ?`, [targetCode, user.code]);
        }
        socket.emit('friends_data_update');
        if (socketMap[targetCode]) io.to(socketMap[targetCode]).emit('friends_data_update');
    });

    // 4. マッチメイキングと対戦
    socket.on('challenge_friend', (targetCode) => {
        const user = onlineUsers[socket.id];
        const targetSocketId = socketMap[targetCode];
        if (user && targetSocketId && onlineUsers[targetSocketId].status === 'idle') {
            io.to(targetSocketId).emit('incoming_challenge', { code: user.code, name: user.name });
        }
    });

    socket.on('respond_challenge', (data) => {
        const user = onlineUsers[socket.id];
        const { targetCode, accept } = data;
        const targetSocketId = socketMap[targetCode];
        if (accept && targetSocketId) {
            const matchId = `match_${Date.now()}`;
            activeMatches[matchId] = { p1: targetCode, p2: user.code, p1Ready: false, p2Ready: false };
            onlineUsers[socket.id].status = 'playing';
            onlineUsers[targetSocketId].status = 'playing';
            io.emit('friends_data_update'); 
            io.to(targetSocketId).emit('match_found', { matchId, opponentName: user.name, opponentCode: user.code });
            socket.emit('match_found', { matchId, opponentName: onlineUsers[targetSocketId].name, opponentCode: targetCode });
        } else if (targetSocketId) {
            io.to(targetSocketId).emit('challenge_rejected', { name: user.name });
        }
    });

    socket.on('join_random_match', () => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        user.status = 'matching';
        io.emit('friends_data_update');

        const validQueue = matchmakingQueue.filter(id => onlineUsers[id] && onlineUsers[id].status === 'matching');
        if (validQueue.length > 0) {
            const opponentSocketId = validQueue.shift();
            const opponent = onlineUsers[opponentSocketId];
            if (opponent && opponentSocketId !== socket.id) {
                const matchId = `match_${Date.now()}`;
                activeMatches[matchId] = { p1: opponent.code, p2: user.code, p1Ready: false, p2Ready: false };
                user.status = 'playing'; opponent.status = 'playing';
                matchmakingQueue = matchmakingQueue.filter(id => id !== opponentSocketId && id !== socket.id);
                io.emit('friends_data_update');
                
                io.to(opponentSocketId).emit('match_found', { matchId, opponentName: user.name, opponentCode: user.code });
                socket.emit('match_found', { matchId, opponentName: opponent.name, opponentCode: opponent.code });
                return;
            }
        }
        if (!matchmakingQueue.includes(socket.id)) matchmakingQueue.push(socket.id);
    });

    socket.on('match_ready', (data) => {
        const { matchId, gameType } = data;
        const match = activeMatches[matchId];
        if (!match) return;

        const user = onlineUsers[socket.id];
        if (match.p1 === user.code) { match.p1Ready = true; match.p1Type = gameType; }
        if (match.p2 === user.code) { match.p2Ready = true; match.p2Type = gameType; }

        if (match.p1Ready && match.p2Ready) {
            // DBにマッチ情報を初期登録 (winner_codeはNULL) - startedAtを記録しておく
            match.startedAt = Date.now();
            db.run(`INSERT INTO match_history (p1_code, p2_code, p1_type, p2_type) VALUES (?, ?, ?, ?)`, 
                   [match.p1, match.p2, match.p1Type, match.p2Type], function(err) {
                if(!err) {
                    match.dbId = this.lastID;
                } else {
                    console.error('match_history INSERT error:', err);
                }
            });

            io.to(socketMap[match.p1]).emit('start_countdown', { opponentType: match.p2Type, opponentName: onlineUsers[socketMap[match.p2]].name });
            io.to(socketMap[match.p2]).emit('start_countdown', { opponentType: match.p1Type, opponentName: onlineUsers[socketMap[match.p1]].name });
        }
    });

    socket.on('game_action', (data) => {
        const { matchId, action, payload, gameType } = data;
        const match = activeMatches[matchId];
        if (!match) return;
        
        const user = onlineUsers[socket.id];
        const targetCode = (match.p1 === user.code) ? match.p2 : match.p1;
        const targetSocketId = socketMap[targetCode];
        
        if (targetSocketId) {
            io.to(targetSocketId).emit('opponent_action', { 
                action, 
                payload, 
                gameType 
            });
        }
    });

    // 5. ゲームオーバーと勝敗記録、ステータスリセット
    // クライアントがgame_overを送ってきた＝クライアントが負け
    socket.on('game_over', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        
        const matchId = data.matchId;
        const match = activeMatches[matchId];
        
        if (match) {
            // 既に処理済み（両者からのrace condition防止）
            if (match.gameOverHandled) return;
            match.gameOverHandled = true;

            const loserCode = user.code;
            const winnerCode = (match.p1 === loserCode) ? match.p2 : match.p1;
            
            const winnerSocketId = socketMap[winnerCode];
            const loserSocketId = socketMap[loserCode];

            // 1. データベースの match_history に勝者を記録
            // dbIdが設定済みなら直接UPDATE、未設定ならコードで検索してUPDATE
            const doUpdate = (id) => {
                db.run(`UPDATE match_history SET winner_code = ? WHERE id = ?`, [winnerCode, id], (err) => {
                    if (err) console.error('UPDATE winner_code error:', err);
                });
            };
            if (match.dbId) {
                doUpdate(match.dbId);
            } else {
                // dbIdがまだ設定されていない場合はコードで最新レコードを探す
                db.get(`SELECT id FROM match_history WHERE p1_code = ? AND p2_code = ? AND winner_code IS NULL ORDER BY id DESC LIMIT 1`,
                    [match.p1, match.p2], (err, row) => {
                        if (row) doUpdate(row.id);
                    });
            }

            // 2. 勝者に 'win' のシグナルを送信
            if (winnerSocketId) {
                io.to(winnerSocketId).emit('game_result', { result: 'win', reason: 'opponent_game_over' });
                if (onlineUsers[winnerSocketId]) onlineUsers[winnerSocketId].status = 'idle';
            }
            
            // 3. 敗者に 'lose' のシグナルを送信（確認用。ローカルでは既に表示済み）
            if (loserSocketId) {
                io.to(loserSocketId).emit('game_result', { result: 'lose', reason: 'game_over' });
                if (onlineUsers[loserSocketId]) onlineUsers[loserSocketId].status = 'idle';
            }

            // 4. マッチを終了して削除
            delete activeMatches[matchId];
            io.emit('friends_data_update'); // ステータスをidleに更新
        }
    });
    
    socket.on('return_to_lobby', () => {
        const user = onlineUsers[socket.id];
        if (user) {
            user.status = 'idle';
            matchmakingQueue = matchmakingQueue.filter(id => id !== socket.id);
            
            // 進行中のマッチがあれば、対戦相手を勝者として記録・通知
            for (const matchId in activeMatches) {
                const match = activeMatches[matchId];
                if (match.p1 === user.code || match.p2 === user.code) {
                    if (match.gameOverHandled) { delete activeMatches[matchId]; continue; }
                    match.gameOverHandled = true;
                    const winnerCode = (match.p1 === user.code) ? match.p2 : match.p1;
                    const winnerSocketId = socketMap[winnerCode];
                    const doUp = (id) => db.run(`UPDATE match_history SET winner_code = ? WHERE id = ?`, [winnerCode, id]);
                    if (match.dbId) { doUp(match.dbId); }
                    else {
                        db.get(`SELECT id FROM match_history WHERE p1_code = ? AND p2_code = ? AND winner_code IS NULL ORDER BY id DESC LIMIT 1`,
                            [match.p1, match.p2], (err, row) => { if (row) doUp(row.id); });
                    }
                    if (winnerSocketId) {
                        io.to(winnerSocketId).emit('game_result', { result: 'win', reason: 'opponent_left' });
                        if (onlineUsers[winnerSocketId]) onlineUsers[winnerSocketId].status = 'idle';
                    }
                    delete activeMatches[matchId];
                }
            }
            
            io.emit('friends_data_update');
        }
    });

// ----- ここから追加（io.on('connection', ...) の中） -----
    socket.on('get_chat_contacts', () => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        db.all(`SELECT u.code, u.name FROM friends f JOIN users u ON f.friend_code = u.code WHERE f.user_code = ? AND f.status = 'accepted'`, [user.code], (err, friends) => {
            db.all(`SELECT g.id, g.name, g.owner_code FROM chat_groups g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_code = ?`, [user.code], (err, groups) => {
                socket.emit('chat_contacts_data', { friends: friends || [], groups: groups || [] });
            });
        });
    });

    socket.on('create_group', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const { name, members } = data; 
        db.run(`INSERT INTO chat_groups (name, owner_code) VALUES (?, ?)`, [name, user.code], function(err) {
            if (err) return;
            const groupId = this.lastID;
            const allMembers = [user.code, ...members];
            const stmt = db.prepare(`INSERT INTO group_members (group_id, user_code) VALUES (?, ?)`);
            allMembers.forEach(m => stmt.run(groupId, m));
            stmt.finalize();
            allMembers.forEach(m => {
                if (socketMap[m]) io.to(socketMap[m]).emit('chat_contacts_update');
            });
        });
    });

    socket.on('delete_group', (groupId) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        db.get(`SELECT owner_code FROM chat_groups WHERE id = ?`, [groupId], (err, row) => {
            if (row && row.owner_code === user.code) {
                db.all(`SELECT user_code FROM group_members WHERE group_id = ?`, [groupId], (err, members) => {
                    db.run(`DELETE FROM chat_groups WHERE id = ?`, [groupId]);
                    db.run(`DELETE FROM group_members WHERE group_id = ?`, [groupId]);
                    if(members) {
                        members.forEach(m => {
                            if (socketMap[m.user_code]) io.to(socketMap[m.user_code]).emit('chat_contacts_update');
                        });
                    }
                });
            }
        });
    });

    socket.on('send_chat_message', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const { targetCode, groupId, message } = data;
        db.run(`INSERT INTO messages (sender_code, receiver_code, group_id, message) VALUES (?, ?, ?, ?)`,
            [user.code, targetCode || null, groupId || null, message], function(err) {
            if (err) return;
            const msgObj = { id: this.lastID, sender_code: user.code, sender_name: user.name, receiver_code: targetCode, group_id: groupId, message, timestamp: new Date() };
            
            if (groupId) {
                db.all(`SELECT user_code FROM group_members WHERE group_id = ?`, [groupId], (err, members) => {
                    if (members) {
                        members.forEach(m => {
                            if (socketMap[m.user_code]) io.to(socketMap[m.user_code]).emit('receive_chat_message', msgObj);
                        });
                    }
                });
            } else if (targetCode) {
                socket.emit('receive_chat_message', msgObj);
                if (socketMap[targetCode]) io.to(socketMap[targetCode]).emit('receive_chat_message', msgObj);
            }
        });
    });

    socket.on('get_chat_messages', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const { targetCode, groupId } = data;
        if (groupId) {
            db.all(`SELECT m.*, u.name as sender_name FROM messages m JOIN users u ON m.sender_code = u.code WHERE m.group_id = ? ORDER BY m.timestamp ASC`, [groupId], (err, rows) => {
                socket.emit('chat_messages_data', rows || []);
            });
        } else if (targetCode) {
            db.all(`SELECT m.*, u.name as sender_name FROM messages m JOIN users u ON m.sender_code = u.code WHERE (m.sender_code = ? AND m.receiver_code = ?) OR (m.sender_code = ? AND m.receiver_code = ?) ORDER BY m.timestamp ASC`, 
            [user.code, targetCode, targetCode, user.code], (err, rows) => {
                socket.emit('chat_messages_data', rows || []);
            });
        }
    });

    socket.on('vc_signal', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        if (socketMap[data.target]) {
            io.to(socketMap[data.target]).emit('vc_signal', { sender: user.code, signal: data.signal });
        }
    });

// --------------------------------------------------
    // グループボイスチャットのシグナリング
    socket.on('group_vc_signal', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const { groupId, signal, target } = data;
        
        if (target) {
            // 特定のターゲット（アンサーを返す相手など）が指定されている場合
            if (socketMap[target]) {
                io.to(socketMap[target]).emit('group_vc_signal', { sender: user.code, groupId, signal });
            }
        } else {
            // ターゲット指定がない場合は、自分以外のグループメンバー全員にブロードキャスト
            db.all(`SELECT user_code FROM group_members WHERE group_id = ?`, [groupId], (err, members) => {
                if (members) {
                    members.forEach(m => {
                        if (m.user_code !== user.code && socketMap[m.user_code]) {
                            io.to(socketMap[m.user_code]).emit('group_vc_signal', { sender: user.code, groupId, signal });
                        }
                    });
                }
            });
        }
    });

    // グループメンバーの追加（オーナーのみ）
    socket.on('add_group_member', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const { groupId, memberCode } = data;
        
        db.get(`SELECT owner_code FROM chat_groups WHERE id = ?`, [groupId], (err, row) => {
            if (row && row.owner_code === user.code) {
                db.run(`INSERT OR IGNORE INTO group_members (group_id, user_code) VALUES (?, ?)`, [groupId, memberCode], () => {
                    if (socketMap[memberCode]) io.to(socketMap[memberCode]).emit('chat_contacts_update');
                    io.to(socket.id).emit('chat_contacts_update');
                });
            }
        });
    });

    // グループメンバーの削除（オーナーのみ）
    socket.on('remove_group_member', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const { groupId, memberCode } = data;
        
        db.get(`SELECT owner_code FROM chat_groups WHERE id = ?`, [groupId], (err, row) => {
            if (row && row.owner_code === user.code && memberCode !== user.code) { // オーナー自身は削除できないようにする
                db.run(`DELETE FROM group_members WHERE group_id = ? AND user_code = ?`, [groupId, memberCode], () => {
                    if (socketMap[memberCode]) io.to(socketMap[memberCode]).emit('chat_contacts_update');
                    io.to(socket.id).emit('chat_contacts_update');
                });
            }
        });
    });

    // グループからの脱退（オーナー以外）
    socket.on('leave_group', (groupId) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        
        db.get(`SELECT owner_code FROM chat_groups WHERE id = ?`, [groupId], (err, row) => {
            if (row && row.owner_code !== user.code) { // オーナーは脱退できない（削除機能を使う）
                db.run(`DELETE FROM group_members WHERE group_id = ? AND user_code = ?`, [groupId, user.code], () => {
                    socket.emit('chat_contacts_update');
                });
            }
        });
    });

    // メッセージの削除機能（自分の送信したメッセージのみ削除可能）
    socket.on('delete_message', (messageId) => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        
        db.get(`SELECT sender_code, group_id, receiver_code FROM messages WHERE id = ?`, [messageId], (err, row) => {
            if (row && row.sender_code === user.code) {
                db.run(`DELETE FROM messages WHERE id = ?`, [messageId], () => {
                    // グループメッセージの場合、全メンバーに削除を通知
                    if (row.group_id) {
                        db.all(`SELECT user_code FROM group_members WHERE group_id = ?`, [row.group_id], (err, members) => {
                            if (members) {
                                members.forEach(m => { 
                                    if (socketMap[m.user_code]) {
                                        io.to(socketMap[m.user_code]).emit('message_deleted', messageId); 
                                    }
                                });
                            }
                        });
                    } 
                    // 個人メッセージの場合、お互いに削除を通知
                    else if (row.receiver_code) {
                        socket.emit('message_deleted', messageId);
                        if (socketMap[row.receiver_code]) {
                            io.to(socketMap[row.receiver_code]).emit('message_deleted', messageId);
                        }
                    }
                });
            }
        });
    });

    // アカウントの削除機能
    socket.on('delete_account', () => {
        const user = onlineUsers[socket.id];
        if (!user) return;
        const code = user.code;
        
        // 関連するユーザーデータを削除
        db.run(`DELETE FROM users WHERE code = ?`, [code]);
        db.run(`DELETE FROM friends WHERE user_code = ? OR friend_code = ?`, [code, code]);
        db.run(`DELETE FROM group_members WHERE user_code = ?`, [code]);
        db.run(`DELETE FROM messages WHERE sender_code = ? OR receiver_code = ?`, [code, code]);
        // ※オーナーになっているグループ自体の削除が必要な場合は、連鎖削除の処理を追加してください。
        
        delete socketMap[code];
        delete onlineUsers[socket.id];
        
        io.emit('friends_data_update');
        socket.emit('account_deleted');
        socket.disconnect();
    });
    // --------------------------------------------------
    // ----- ここまで追加 -----

    // ══════════════════════════════════════════════════════════════════════════
    // めっちゃカメレオン Socket.IO イベント
    // 既存の onlineUsers/socketMap は参照するが上書きしない。
    // 全イベント名は 'camereon:' プレフィックスで名前衝突を防ぐ。
    // ══════════════════════════════════════════════════════════════════════════

    // ── 部屋一覧 ─────────────────────────────────────────────────────────────
    socket.on('camereon:rooms:list', (cb) => {
        const list = [];
        camereonRooms.forEach(r => {
            if (r.isPublic && r.phase === 'lobby') list.push(camereonRoomPublic(r));
        });
        list.sort((a, b) => b.createdAt - a.createdAt);
        if (typeof cb === 'function') cb({ ok: true, rooms: list.slice(0, 20) });
    });

    // ── 部屋作成 ─────────────────────────────────────────────────────────────
    socket.on('camereon:room:create', (data, cb) => {
        if (camereonRooms.size >= CAMEREON_CONFIG.ROOMS_MAX)
            return cb && cb({ ok: false, error: 'サーバーが満室です。' });

        // ログイン済みユーザーのcodeを使う、なければゲスト
        const existingUser = onlineUsers[socket.id];
        const playerCode   = existingUser ? existingUser.code : null;
        const playerName   = data.playerName || (existingUser ? existingUser.name : null) || `ゲスト${Math.floor(Math.random()*9999)}`;

        const roomId = Math.random().toString(36).slice(2, 10).toUpperCase();
        const r = camereonMakeRoom(roomId, data.name || `${playerName}の部屋`, socket.id, {
            password: data.password, map: data.map,
            maxPlayers: data.maxPlayers, isPublic: data.isPublic,
        });
        const player = camereonMakePlayer(socket.id, playerCode, playerName, existingUser ? undefined : data.color);
        player.isReady = true;
        r.players.set(socket.id, player);
        camereonRooms.set(roomId, r);
        camereonPlayers.set(socket.id, { roomId, player });

        socket.join('camereon_' + roomId);
        camereonChat(r, 'SYSTEM', `🦎 ${player.name} が部屋を作成しました！`);

        if (typeof cb === 'function') cb({ ok: true, room: camereonRoomFull(r), playerId: socket.id });
    });

    // ── 部屋参加 ─────────────────────────────────────────────────────────────
    socket.on('camereon:room:join', (data, cb) => {
        const r = camereonRooms.get(data.roomId);
        if (!r) return cb && cb({ ok: false, error: '部屋が見つかりません。' });
        if (r.players.size >= r.maxPlayers) return cb && cb({ ok: false, error: '部屋が満員です。' });
        if (r.phase !== 'lobby') return cb && cb({ ok: false, error: 'ゲームはすでに始まっています。' });
        if (r.password && r.password !== data.password) return cb && cb({ ok: false, error: 'パスワードが違います。' });

        const existingUser = onlineUsers[socket.id];
        const playerCode   = existingUser ? existingUser.code : null;
        const playerName   = data.playerName || (existingUser ? existingUser.name : null) || `ゲスト${Math.floor(Math.random()*9999)}`;

        const player = camereonMakePlayer(socket.id, playerCode, playerName);
        r.players.set(socket.id, player);
        camereonPlayers.set(socket.id, { roomId: data.roomId, player });

        socket.join('camereon_' + data.roomId);
        camereonBroadcast(r);
        camereonChat(r, 'SYSTEM', `👋 ${player.name} が参加しました！`);

        if (typeof cb === 'function') cb({ ok: true, room: camereonRoomFull(r), playerId: socket.id });
    });

    // ── 退出 ──────────────────────────────────────────────────────────────────
    socket.on('camereon:room:leave', () => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return;
        socket.leave('camereon_' + entry.roomId);
        camereonHandleLeave(socket.id);
    });

    // ── 準備完了 ──────────────────────────────────────────────────────────────
    socket.on('camereon:player:ready', (isReady, cb) => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return;
        const r = camereonRooms.get(entry.roomId);
        if (!r || r.phase !== 'lobby') return;
        entry.player.isReady = !!isReady;
        camereonBroadcast(r);

        if (r.players.size >= CAMEREON_CONFIG.MIN_PLAYERS) {
            const allReady = Array.from(r.players.values()).every(p => p.isReady);
            if (allReady) {
                camereonChat(r, 'SYSTEM', `⏳ ${CAMEREON_CONFIG.LOBBY_COUNTDOWN}秒後にゲーム開始...`);
                setTimeout(() => {
                    if (camereonRooms.has(r.id) && r.phase === 'lobby') camereonStartPaint(r);
                }, CAMEREON_CONFIG.LOBBY_COUNTDOWN * 1000);
            }
        }
        if (typeof cb === 'function') cb({ ok: true });
    });

    // ── ペイントストローク ────────────────────────────────────────────────────
    socket.on('camereon:paint:stroke', (stroke) => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return;
        const r = camereonRooms.get(entry.roomId);
        if (!r || r.phase !== 'paint' || entry.player.role !== 'chameleon') return;
        entry.player.paintStrokes.push(stroke);
        if (!r.paintData.has(socket.id)) r.paintData.set(socket.id, []);
        r.paintData.get(socket.id).push(stroke);
        socket.to('camereon_' + r.id).emit('camereon:paint:stroke', { playerId: socket.id, stroke });
    });

    socket.on('camereon:paint:clear', () => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return;
        const r = camereonRooms.get(entry.roomId);
        if (!r || r.phase !== 'paint' || entry.player.role !== 'chameleon') return;
        entry.player.paintStrokes = [];
        r.paintData.set(socket.id, []);
        socket.to('camereon_' + r.id).emit('camereon:paint:clear', { playerId: socket.id });
    });

    // ── 移動（ハントフェーズ）────────────────────────────────────────────────
    socket.on('camereon:player:move', (pos) => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return;
        const r = camereonRooms.get(entry.roomId);
        const p = entry.player;
        if (!r || r.phase !== 'hunt' || !p.alive) return;
        p.x = Math.max(0, Math.min(1, pos.x));
        p.y = Math.max(0, Math.min(1, pos.y));
        p.pose = pos.pose || p.pose;
        socket.to('camereon_' + r.id).emit('camereon:player:moved', { id: socket.id, x: p.x, y: p.y, pose: p.pose });
    });

    // ── 射撃（ハンター）──────────────────────────────────────────────────────
    socket.on('camereon:hunter:shoot', (data, cb) => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return cb && cb({ ok: false });
        const r      = camereonRooms.get(entry.roomId);
        const hunter = entry.player;
        if (!r || r.phase !== 'hunt' || hunter.role !== 'hunter' || !hunter.alive)
            return cb && cb({ ok: false });

        const HIT_RADIUS = 0.06;
        let hit = null;
        r.players.forEach(p => {
            if (p.role === 'chameleon' && p.alive) {
                const dx = p.x - data.targetX, dy = p.y - data.targetY;
                if (Math.sqrt(dx*dx + dy*dy) < HIT_RADIUS) {
                    if (!hit) hit = p;
                }
            }
        });

        io.to('camereon_' + r.id).emit('camereon:hunter:bullet', {
            from: socket.id, targetX: data.targetX, targetY: data.targetY,
            bulletId: data.bulletId, hit: hit ? hit.id : null,
        });

        if (hit) {
            hit.hp -= CAMEREON_CONFIG.BULLET_DAMAGE;
            if (hit.hp <= 0) {
                hit.hp = 0; hit.alive = false;
                hunter.kills++;
                hunter.score += CAMEREON_CONFIG.SCORE_FOUND;
                io.to('camereon_' + r.id).emit('camereon:player:eliminated', {
                    playerId: hit.id, playerName: hit.name,
                    hunterId: socket.id, hunterName: hunter.name,
                });
                camereonChat(r, 'SYSTEM', `💥 ${hunter.name} が ${hit.name} を発見！`);
                camereonCheckHuntOver(r);
            } else {
                io.to('camereon_' + r.id).emit('camereon:player:damaged', { playerId: hit.id, hp: hit.hp, damage: CAMEREON_CONFIG.BULLET_DAMAGE });
            }
            if (typeof cb === 'function') cb({ ok: true, hit: hit.id, hp: hit.hp, alive: hit.alive });
        } else {
            if (typeof cb === 'function') cb({ ok: true, hit: null });
        }
    });

    // ── チャット ──────────────────────────────────────────────────────────────
    socket.on('camereon:chat:send', (text) => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return;
        const r = camereonRooms.get(entry.roomId);
        if (!r) return;
        const sanitized = String(text).slice(0, 120).trim();
        if (!sanitized) return;
        const msg = {
            id: Date.now() + Math.random(), from: entry.player.name,
            fromId: socket.id, text: sanitized,
            type: (!entry.player.alive && r.phase === 'hunt') ? 'spectator' : 'chat',
            ts: Date.now(),
        };
        r.chat.push(msg);
        if (r.chat.length > 200) r.chat.shift();
        io.to('camereon_' + r.id).emit('camereon:chat:message', msg);
    });

    // ── ホスト操作 ────────────────────────────────────────────────────────────
    socket.on('camereon:host:forceStart', (cb) => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return cb && cb({ ok: false });
        const r = camereonRooms.get(entry.roomId);
        if (!r || r.host !== socket.id) return cb && cb({ ok: false, error: 'ホストのみ操作可能です。' });
        if (r.phase !== 'lobby') return cb && cb({ ok: false });
        if (r.players.size < CAMEREON_CONFIG.MIN_PLAYERS)
            return cb && cb({ ok: false, error: `最低${CAMEREON_CONFIG.MIN_PLAYERS}人必要です。` });
        camereonStartPaint(r);
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('camereon:host:setMap', (mapId, cb) => {
        const entry = camereonPlayers.get(socket.id);
        if (!entry) return cb && cb({ ok: false });
        const r = camereonRooms.get(entry.roomId);
        if (!r || r.host !== socket.id || r.phase !== 'lobby') return cb && cb({ ok: false });
        const validMaps = ['hideout','osaka','backrooms','forest','school','space'];
        if (!validMaps.includes(mapId)) return cb && cb({ ok: false, error: '無効なマップです。' });
        r.map = mapId;
        camereonBroadcast(r);
        camereonChat(r, 'SYSTEM', `🗺️ マップが「${mapId}」に変更されました。`);
        if (typeof cb === 'function') cb({ ok: true });
    });

    // ── Ping ──────────────────────────────────────────────────────────────────
    socket.on('camereon:ping', (ts, cb) => { if (typeof cb === 'function') cb(ts); });

    // ── 統計取得 ──────────────────────────────────────────────────────────────
    socket.on('camereon:get_stats', (targetCode, cb) => {
        const code = targetCode || (onlineUsers[socket.id] ? onlineUsers[socket.id].code : null);
        if (!code) return cb && cb({ ok: false, error: 'ログインが必要です。' });
        db.get(`SELECT * FROM camereon_stats WHERE user_code = ?`, [code], (err, row) => {
            cb && cb({ ok: true, stats: row || { user_code: code, games_played:0, games_won:0, total_score:0, kills:0 } });
        });
    });

    // ── 部屋同期（再接続用）──────────────────────────────────────────────────
    socket.on('camereon:room:sync', (roomId, cb) => {
        const r = camereonRooms.get(roomId);
        if (!r) return cb && cb({ ok: false, error: '部屋が見つかりません。' });
        cb && cb({ ok: true, room: camereonRoomFull(r) });
    });

    // ══════════════════════════════════════════════════════════════════════════
    // (めっちゃカメレオン イベントここまで)
    // ══════════════════════════════════════════════════════════════════════════

    socket.on('disconnect', () => {
        const user = onlineUsers[socket.id];
        if (user) {
            matchmakingQueue = matchmakingQueue.filter(id => id !== socket.id);
            
            for (const matchId in activeMatches) {
                const match = activeMatches[matchId];
                if (match.p1 === user.code || match.p2 === user.code) {
                    if (match.gameOverHandled) { delete activeMatches[matchId]; continue; }
                    match.gameOverHandled = true;
                    const winnerCode = (match.p1 === user.code) ? match.p2 : match.p1;
                    const winnerSocketId = socketMap[winnerCode];
                    const doUp = (id) => db.run(`UPDATE match_history SET winner_code = ? WHERE id = ?`, [winnerCode, id]);
                    if (match.dbId) { doUp(match.dbId); }
                    else {
                        db.get(`SELECT id FROM match_history WHERE p1_code = ? AND p2_code = ? AND winner_code IS NULL ORDER BY id DESC LIMIT 1`,
                            [match.p1, match.p2], (err, row) => { if (row) doUp(row.id); });
                    }
                    if (winnerSocketId) {
                        io.to(winnerSocketId).emit('game_result', { result: 'win', reason: 'disconnect' });
                        if (onlineUsers[winnerSocketId]) onlineUsers[winnerSocketId].status = 'idle';
                    }
                    delete activeMatches[matchId];
                }
            }

            delete socketMap[user.code];
            delete onlineUsers[socket.id];
            io.emit('friends_data_update');
        }

        // めっちゃカメレオン: ログイン状態に関わらず退出処理
        if (camereonPlayers.has(socket.id)) {
            const entry = camereonPlayers.get(socket.id);
            if (entry) socket.leave('camereon_' + entry.roomId);
            camereonHandleLeave(socket.id);
        }
    });
});

// ── めっちゃカメレオン REST API ───────────────────────────────────────────────
app.get('/api/camereon/rooms', (req, res) => {
    const list = [];
    camereonRooms.forEach(r => { if (r.isPublic) list.push(camereonRoomPublic(r)); });
    res.json({ rooms: list, total: camereonRooms.size });
});

app.get('/api/camereon/stats/:code', (req, res) => {
    db.get(`SELECT * FROM camereon_stats WHERE user_code = ?`, [req.params.code], (err, row) => {
        res.json(row || { user_code: req.params.code, games_played:0, games_won:0, total_score:0, kills:0 });
    });
});

app.get('/api/camereon/ranking', (req, res) => {
    db.all(`SELECT cs.*, u.name FROM camereon_stats cs LEFT JOIN users u ON cs.user_code = u.code
            ORDER BY cs.total_score DESC LIMIT 20`, [], (err, rows) => {
        res.json({ ranking: rows || [] });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`🦎 めっちゃカメレオン モジュール: 有効`);
    console.log(`   /api/camereon/rooms    - 部屋一覧`);
    console.log(`   /api/camereon/ranking  - ランキング`);
});
