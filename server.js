const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Database error:', err.message);
    else console.log('Connected to SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS friends (user_code TEXT, friend_code TEXT, status TEXT, is_favorite INTEGER DEFAULT 0, PRIMARY KEY (user_code, friend_code))`);
    db.run(`CREATE TABLE IF NOT EXISTS match_history (id INTEGER PRIMARY KEY AUTOINCREMENT, p1_code TEXT, p2_code TEXT, game_mode TEXT, first_player TEXT, winner_code TEXT, date DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

// ── ランタイム状態 ──
const onlineUsers = {};   // socketId -> { code, name, status }
const socketMap = {};     // code -> socketId
const activeMatches = {}; // matchId -> match state
// pendingChallenges: challenger -> { targetCode, matchId }
const pendingChallenges = {};

// ── ユーティリティ ──
function getUserBySocket(socketId) { return onlineUsers[socketId]; }
function getSocketByCode(code) { return socketMap[code] ? io.sockets.sockets.get(socketMap[code]) : null; }
function emitToCode(code, event, data) {
    if (socketMap[code]) io.to(socketMap[code]).emit(event, data);
}
function broadcastFriendsUpdate(codes) {
    codes.forEach(code => emitToCode(code, 'friends_data_update'));
}

io.on('connection', (socket) => {

    // ═══════════════════════════════════════
    // 1. ログイン / 登録
    // ═══════════════════════════════════════
    socket.on('login', (data, callback) => {
        const { code, name } = data;
        if (!code || !name) return callback({ success: false, message: '入力が不完全です。' });

        db.get(`SELECT * FROM users WHERE code = ? OR name = ?`, [code, name], (err, row) => {
            if (row) {
                if (row.code === code && row.name === name) {
                    // 既存セッションを破棄
                    if (socketMap[code] && socketMap[code] !== socket.id) {
                        const old = socketMap[code];
                        delete onlineUsers[old];
                    }
                    setupUser(socket.id, code, name);
                    callback({ success: true, message: 'ログインしました。' });
                } else {
                    callback({ success: false, message: 'コードまたは名前が既に使用されています。' });
                }
            } else {
                db.run(`INSERT INTO users (code, name) VALUES (?, ?)`, [code, name], function(err) {
                    if (err) return callback({ success: false, message: '登録に失敗しました。' });
                    setupUser(socket.id, code, name);
                    callback({ success: true, message: '新規登録 & ログインしました。' });
                });
            }
        });
    });

    function setupUser(socketId, code, name) {
        onlineUsers[socketId] = { code, name, status: 'idle' };
        socketMap[code] = socketId;
        io.emit('friends_data_update');
    }

    // ═══════════════════════════════════════
    // 2. フレンド管理
    // ═══════════════════════════════════════
    socket.on('get_friends', () => {
        const user = getUserBySocket(socket.id);
        if (!user) return;
        db.all(`
            SELECT u.code, u.name, f.status, f.is_favorite, f.user_code as sender
            FROM friends f
            JOIN users u ON (
                (f.user_code = ? AND f.friend_code = u.code) OR
                (f.friend_code = ? AND f.user_code = u.code AND f.status = 'pending')
            )
            WHERE (f.user_code = ? OR f.friend_code = ?)
        `, [user.code, user.code, user.code, user.code], (err, rows) => {
            const list = (rows || []).map(r => ({
                code: r.code,
                name: r.name,
                status: r.status,
                is_favorite: r.is_favorite,
                isSender: r.sender === user.code,
                isOnline: !!socketMap[r.code],
                activity: socketMap[r.code] ? onlineUsers[socketMap[r.code]]?.status : 'offline'
            }));
            socket.emit('friends_data', list);
        });
    });

    socket.on('send_friend_request', (targetCode, callback) => {
        const user = getUserBySocket(socket.id);
        if (!user || user.code === targetCode) return callback?.({ success: false, message: '無効な操作です。' });
        db.get(`SELECT * FROM users WHERE code = ?`, [targetCode], (err, row) => {
            if (!row) return callback?.({ success: false, message: 'ユーザーが見つかりません。' });
            db.run(`INSERT OR IGNORE INTO friends (user_code, friend_code, status) VALUES (?, ?, 'pending')`, [user.code, targetCode], (err) => {
                if (err) return callback?.({ success: false, message: '既に申請中またはフレンドです。' });
                callback?.({ success: true, message: '申請を送りました。' });
                broadcastFriendsUpdate([user.code, targetCode]);
            });
        });
    });

    socket.on('respond_friend_request', ({ targetCode, accept }) => {
        const user = getUserBySocket(socket.id);
        if (!user) return;
        if (accept) {
            db.run(`UPDATE friends SET status = 'accepted' WHERE user_code = ? AND friend_code = ?`, [targetCode, user.code]);
            db.run(`INSERT OR IGNORE INTO friends (user_code, friend_code, status) VALUES (?, ?, 'accepted')`, [user.code, targetCode]);
        } else {
            db.run(`DELETE FROM friends WHERE user_code = ? AND friend_code = ?`, [targetCode, user.code]);
        }
        broadcastFriendsUpdate([user.code, targetCode]);
    });

    socket.on('delete_friend', (targetCode) => {
        const user = getUserBySocket(socket.id);
        if (!user) return;
        db.run(`DELETE FROM friends WHERE (user_code=? AND friend_code=?) OR (user_code=? AND friend_code=?)`,
            [user.code, targetCode, targetCode, user.code], () => {
                broadcastFriendsUpdate([user.code, targetCode]);
            });
    });

    socket.on('toggle_favorite', (targetCode) => {
        const user = getUserBySocket(socket.id);
        if (!user) return;
        db.run(`UPDATE friends SET is_favorite = CASE WHEN is_favorite=1 THEN 0 ELSE 1 END WHERE user_code=? AND friend_code=?`,
            [user.code, targetCode], () => socket.emit('friends_data_update'));
    });

    // ═══════════════════════════════════════
    // 3. 対戦申し込み → 設定 → スタート
    // ═══════════════════════════════════════

    // チャレンジ送信
    socket.on('challenge_friend', (targetCode) => {
        const user = getUserBySocket(socket.id);
        if (!user) return;
        const targetSid = socketMap[targetCode];
        if (!targetSid || onlineUsers[targetSid]?.status !== 'idle') {
            return socket.emit('challenge_error', { message: '相手は現在対戦できません。' });
        }
        io.to(targetSid).emit('incoming_challenge', { code: user.code, name: user.name });
    });

    // チャレンジ応答
    socket.on('respond_challenge', ({ targetCode, accept }) => {
        const user = getUserBySocket(socket.id);
        if (!user) return;
        const targetSid = socketMap[targetCode];
        if (!accept) {
            if (targetSid) io.to(targetSid).emit('challenge_rejected', { name: user.name });
            return;
        }
        if (!targetSid || onlineUsers[targetSid]?.status !== 'idle') return;

        // 設定フェーズへ: チャレンジャー（targetCode）が設定画面を持つ
        const matchId = `match_${Date.now()}`;
        activeMatches[matchId] = {
            p1: targetCode, // challenger = p1
            p2: user.code,  // challenged = p2
            state: 'setup',
            spectators: []
        };
        onlineUsers[socket.id].status = 'setup';
        onlineUsers[targetSid].status = 'setup';

        // p1 に設定画面を表示
        io.to(targetSid).emit('match_setup', {
            matchId,
            isHost: true,
            opponentName: user.name,
            opponentCode: user.code
        });
        // p2 は待機
        socket.emit('match_setup', {
            matchId,
            isHost: false,
            opponentName: onlineUsers[targetSid].name,
            opponentCode: targetCode
        });
        io.emit('friends_data_update');
    });

    // ホストが設定を確定してスタート
    socket.on('match_start_config', (data) => {
        const { matchId, gameMode, firstPlayer } = data; // firstPlayer: 'p1'|'p2'|'random'
        const match = activeMatches[matchId];
        if (!match || match.state !== 'setup') return;

        const user = getUserBySocket(socket.id);
        if (!user || user.code !== match.p1) return; // hostのみ

        const actualFirst = firstPlayer === 'random'
            ? (Math.random() < 0.5 ? match.p1 : match.p2)
            : (firstPlayer === 'p1' ? match.p1 : match.p2);

        match.gameMode = gameMode;
        match.firstPlayer = actualFirst;
        match.currentTurn = actualFirst;
        match.state = 'playing';
        match.gameOverHandled = false;
        match.dbId = null;

        const p1Sid = socketMap[match.p1];
        const p2Sid = socketMap[match.p2];
        const p1Name = onlineUsers[p1Sid]?.name;
        const p2Name = onlineUsers[p2Sid]?.name;

        if (p1Sid) onlineUsers[p1Sid].status = 'playing';
        if (p2Sid) onlineUsers[p2Sid].status = 'playing';

        db.run(`INSERT INTO match_history (p1_code, p2_code, game_mode, first_player) VALUES (?,?,?,?)`,
            [match.p1, match.p2, gameMode, actualFirst], function(err) {
                if (!err) match.dbId = this.lastID;
            });

        const startPayload = {
            matchId,
            gameMode,
            firstPlayer: actualFirst,
            p1: { code: match.p1, name: p1Name },
            p2: { code: match.p2, name: p2Name }
        };

        if (p1Sid) io.to(p1Sid).emit('match_start', startPayload);
        if (p2Sid) io.to(p2Sid).emit('match_start', startPayload);

        // 観戦者にも通知
        match.spectators.forEach(sc => io.to(sc).emit('match_start', startPayload));

        io.emit('friends_data_update');
    });

    // ═══════════════════════════════════════
    // 4. リアルタイムゲーム同期
    // ═══════════════════════════════════════

    // ショット実行（ボール状態をまるごと送信）
    socket.on('shot_fired', (data) => {
        // data: { matchId, ballStates, shotParams }
        const match = activeMatches[data.matchId];
        if (!match || match.state !== 'playing') return;
        const user = getUserBySocket(socket.id);
        if (!user || user.code !== match.currentTurn) return; // ターン外はブロック

        const otherCode = match.p1 === user.code ? match.p2 : match.p1;
        const payload = { ...data, shooterCode: user.code };

        // 相手へ送信
        emitToCode(otherCode, 'opponent_shot', payload);

        // 観戦者へ送信
        match.spectators.forEach(sc => io.to(sc).emit('spectate_shot', payload));
    });

    // ボール最終静止状態（ターン終了後）
    socket.on('turn_end_state', (data) => {
        // data: { matchId, ballStates, nextTurn }
        const match = activeMatches[data.matchId];
        if (!match || match.state !== 'playing') return;
        const user = getUserBySocket(socket.id);
        if (!user) return;

        match.currentTurn = data.nextTurn;

        const otherCode = match.p1 === user.code ? match.p2 : match.p1;
        const payload = { ...data, reporterCode: user.code };

        emitToCode(otherCode, 'sync_ball_state', payload);
        match.spectators.forEach(sc => io.to(sc).emit('sync_ball_state', payload));
    });

    // フリーボール配置同期
    socket.on('freeball_placed', (data) => {
        const match = activeMatches[data.matchId];
        if (!match) return;
        const user = getUserBySocket(socket.id);
        if (!user || user.code !== match.currentTurn) return;

        const otherCode = match.p1 === user.code ? match.p2 : match.p1;
        emitToCode(otherCode, 'opponent_freeball', data);
        match.spectators.forEach(sc => io.to(sc).emit('spectate_freeball', data));
    });

    // ゲームオーバー
    socket.on('game_over', (data) => {
        const match = activeMatches[data.matchId];
        if (!match || match.gameOverHandled) return;
        match.gameOverHandled = true;
        match.state = 'ended';

        const user = getUserBySocket(socket.id);
        if (!user) return;

        const loserCode = user.code;
        const winnerCode = match.p1 === loserCode ? match.p2 : match.p1;

        if (match.dbId) {
            db.run(`UPDATE match_history SET winner_code=? WHERE id=?`, [winnerCode, match.dbId]);
        }

        const resetStatus = (code) => {
            if (socketMap[code] && onlineUsers[socketMap[code]])
                onlineUsers[socketMap[code]].status = 'idle';
        };
        resetStatus(match.p1);
        resetStatus(match.p2);

        emitToCode(winnerCode, 'game_result', { result: 'win', reason: data.reason });
        emitToCode(loserCode, 'game_result', { result: 'lose', reason: data.reason });
        match.spectators.forEach(sc => io.to(sc).emit('game_result', { result: 'spectating_ended', winnerCode }));

        delete activeMatches[data.matchId];
        io.emit('friends_data_update');
    });

    // ═══════════════════════════════════════
    // 5. 観戦
    // ═══════════════════════════════════════
    socket.on('spectate_match', (matchId) => {
        const match = activeMatches[matchId];
        if (!match || match.state !== 'playing') return socket.emit('spectate_error', { message: '観戦できる試合がありません。' });

        if (!match.spectators.includes(socket.id)) match.spectators.push(socket.id);

        const p1Sid = socketMap[match.p1];
        const p2Sid = socketMap[match.p2];
        socket.emit('spectate_started', {
            matchId,
            gameMode: match.gameMode,
            firstPlayer: match.firstPlayer,
            currentTurn: match.currentTurn,
            p1: { code: match.p1, name: onlineUsers[p1Sid]?.name },
            p2: { code: match.p2, name: onlineUsers[p2Sid]?.name }
        });
        // 現在のボール状態をp1に要求してスペクテーターへ渡す
        if (p1Sid) io.to(p1Sid).emit('request_ball_state', { forSpectator: socket.id });
    });

    socket.on('ball_state_response', (data) => {
        // p1/p2 からスペクテーター向けに返す
        const { forSpectator, ballStates, matchId } = data;
        if (forSpectator) {
            io.to(forSpectator).emit('sync_ball_state', { ballStates, matchId, isCurrent: true });
        }
    });

    // ═══════════════════════════════════════
    // 6. 対戦履歴
    // ═══════════════════════════════════════
    socket.on('get_history', (targetCode) => {
        const user = getUserBySocket(socket.id);
        if (!user) return;
        db.all(`SELECT * FROM match_history WHERE (p1_code=? AND p2_code=?) OR (p1_code=? AND p2_code=?) ORDER BY date DESC LIMIT 20`,
            [user.code, targetCode, targetCode, user.code], (err, rows) => {
                socket.emit('history_data', { targetCode, history: rows || [] });
            });
    });

    // ═══════════════════════════════════════
    // 7. ロビーへ戻る
    // ═══════════════════════════════════════
    socket.on('return_to_lobby', () => {
        const user = getUserBySocket(socket.id);
        if (!user) return;

        for (const matchId in activeMatches) {
            const match = activeMatches[matchId];
            if ((match.p1 === user.code || match.p2 === user.code) && !match.gameOverHandled) {
                match.gameOverHandled = true;
                const winnerCode = match.p1 === user.code ? match.p2 : match.p1;
                if (match.dbId) db.run(`UPDATE match_history SET winner_code=? WHERE id=?`, [winnerCode, match.dbId]);
                emitToCode(winnerCode, 'game_result', { result: 'win', reason: 'opponent_left' });
                if (onlineUsers[socketMap[winnerCode]]) onlineUsers[socketMap[winnerCode]].status = 'idle';
                match.spectators.forEach(sc => io.to(sc).emit('game_result', { result: 'spectating_ended', winnerCode }));
                delete activeMatches[matchId];
            }
        }
        user.status = 'idle';
        io.emit('friends_data_update');
    });

    // ═══════════════════════════════════════
    // 8. 切断
    // ═══════════════════════════════════════
    socket.on('disconnect', () => {
        const user = getUserBySocket(socket.id);
        if (!user) return;

        for (const matchId in activeMatches) {
            const match = activeMatches[matchId];
            // スペクテーターとして切断
            match.spectators = match.spectators.filter(s => s !== socket.id);

            if ((match.p1 === user.code || match.p2 === user.code) && !match.gameOverHandled) {
                match.gameOverHandled = true;
                const winnerCode = match.p1 === user.code ? match.p2 : match.p1;
                if (match.dbId) db.run(`UPDATE match_history SET winner_code=? WHERE id=?`, [winnerCode, match.dbId]);
                emitToCode(winnerCode, 'game_result', { result: 'win', reason: 'disconnect' });
                if (socketMap[winnerCode] && onlineUsers[socketMap[winnerCode]])
                    onlineUsers[socketMap[winnerCode]].status = 'idle';
                match.spectators.forEach(sc => io.to(sc).emit('game_result', { result: 'spectating_ended', winnerCode }));
                delete activeMatches[matchId];
            }
        }

        delete socketMap[user.code];
        delete onlineUsers[socket.id];
        io.emit('friends_data_update');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`3D Billiards Online server running on port ${PORT}`));
