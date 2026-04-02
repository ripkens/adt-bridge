// ==UserScript==
// @name         ADT Match – Board Bridge
// @namespace    https://ad-team-matches.net
// @version      6.0.0
// @description  Board Bridge: Intercepts autodarts.io WebSocket data and relays to ADT Match backend
// @author       ADT Match
// @match        https://play.autodarts.io/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      ad-team-matches.net
// @connect      boards.ws.autodarts.io
// @require      https://cdn.jsdelivr.net/npm/centrifuge@5/dist/centrifuge.min.js
// @updateURL    https://ad-team-matches.net/scripts/adt-bridge.meta.js
// @downloadURL  https://ad-team-matches.net/scripts/adt-bridge.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '6.0.0';
    const SERVER  = 'https://ad-team-matches.net';

    // ═════════════════════════════════════════════════════════════════════════
    // State
    // ═════════════════════════════════════════════════════════════════════════
    const S = {
        apiKey:      GM_getValue('adt_api_key', ''),
        user:        null,
        boards:      [],
        connected:   false,
        activeMatch: null,    // Current IMatch from autodarts WS
        matchId:     null,    // Our TeamMatch ID linked to this autodarts match
        boardId:     null,    // Board ID this PC is playing on
    };

    let _capturedAdtToken = null;

    // ═════════════════════════════════════════════════════════════════════════
    // API Helper
    // ═════════════════════════════════════════════════════════════════════════
    function api(method, path, body) {
        return new Promise(resolve => {
            const opts = {
                method,
                url: SERVER + path,
                headers: { Accept: 'application/json', Authorization: 'Bearer ' + S.apiKey },
                onload: r => {
                    let d; try { d = JSON.parse(r.responseText); } catch {}
                    resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, data: d });
                },
                onerror: () => resolve({ ok: false, status: 0, data: null }),
            };
            if (body) { opts.headers['Content-Type'] = 'application/json'; opts.data = JSON.stringify(body); }
            GM_xmlhttpRequest(opts);
        });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Autodarts Token Capture
    // ═════════════════════════════════════════════════════════════════════════
    function getAutodartsToken() {
        if (_capturedAdtToken) return _capturedAdtToken;
        // Check page context variable
        try {
            const t = unsafeWindow?.__ADT_TOKEN__ || window.__ADT_TOKEN__;
            if (t) { _capturedAdtToken = t; return t; }
        } catch {}
        return null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // WebSocket Interceptor — captures ALL autodarts channels
    // ═════════════════════════════════════════════════════════════════════════
    function interceptWebSocket() {
        // Inject interceptors into PAGE context (not TM sandbox)
        // This is critical because autodarts.io fetch/WS runs in page scope
        const script = document.createElement('script');
        script.textContent = `
        (function() {
            // ── Capture autodarts Bearer token from fetch ──
            const _origFetch = window.fetch;
            window.fetch = function(...args) {
                try {
                    const [url, opts] = args;
                    if (typeof url === 'string' && url.includes('autodarts.io')) {
                        let auth = null;
                        if (opts?.headers) {
                            if (opts.headers instanceof Headers) auth = opts.headers.get('Authorization');
                            else auth = opts.headers['Authorization'] || opts.headers['authorization'];
                        }
                        if (auth && auth.startsWith('Bearer ')) {
                            window.__ADT_TOKEN__ = auth.substring(7);
                        }
                    }
                } catch {}
                return _origFetch.apply(this, args);
            };

            // ── Capture from XMLHttpRequest too ──
            const _origXhrOpen = XMLHttpRequest.prototype.open;
            const _origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this._adtUrl = url;
                return _origXhrOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                if (this._adtUrl?.includes('autodarts.io') && name.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
                    window.__ADT_TOKEN__ = value.substring(7);
                }
                return _origXhrSetHeader.call(this, name, value);
            };

            // ── WebSocket interceptor ──
            const _OrigWS = window.WebSocket;
            window.WebSocket = function(url, protocols) {
                const ws = new _OrigWS(url, protocols);
                if (url && url.includes('autodarts')) {
                    ws.addEventListener('message', function(e) {
                        try {
                            window.dispatchEvent(new CustomEvent('adt-ws-message', { detail: { url: url, data: e.data } }));
                        } catch {}
                    });
                }
                return ws;
            };
            window.WebSocket.prototype = _OrigWS.prototype;
            window.WebSocket.CONNECTING = _OrigWS.CONNECTING;
            window.WebSocket.OPEN = _OrigWS.OPEN;
            window.WebSocket.CLOSING = _OrigWS.CLOSING;
            window.WebSocket.CLOSED = _OrigWS.CLOSED;
        })();
        `;
        document.documentElement.appendChild(script);
        script.remove();

        // Listen for WS messages from page context
        window.addEventListener('adt-ws-message', e => {
            try { handleWsMessage(e.detail.url, e.detail.data); } catch {}
        });

        // Poll for captured token from page context
        setInterval(() => {
            try {
                const t = unsafeWindow?.__ADT_TOKEN__ || window.__ADT_TOKEN__;
                if (t && t !== _capturedAdtToken) {
                    _capturedAdtToken = t;
                    console.log('[ADT Bridge] Autodarts token captured');
                }
            } catch {}
        }, 1000);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // WS Message Handler — routes to channel-specific processors
    // ═════════════════════════════════════════════════════════════════════════
    const _dedup = {};

    function handleWsMessage(wsUrl, rawData) {
        if (!S.apiKey) return;

        let msg;
        try { msg = JSON.parse(rawData); } catch { return; }

        const channel = msg?.result?.channel ?? msg?.channel ?? '';
        const payload = msg?.result?.data?.data ?? msg?.data?.data ?? msg?.data ?? msg;
        if (!channel || !payload || typeof payload !== 'object') return;

        switch (true) {
            case channel === 'autodarts.matches':
                handleMatchUpdate(payload);
                break;
            case channel === 'autodarts.boards':
                handleBoardUpdate(payload);
                break;
            case channel === 'autodarts.boards.images':
                handleBoardImage(payload);
                break;
            case channel === 'autodarts.lobbies':
                handleLobbyUpdate(payload);
                break;
            case channel === 'autodarts.tournaments':
                // Forward for info, not critical
                break;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Channel: autodarts.matches — Turn/Throw/GameShot detection
    // ═════════════════════════════════════════════════════════════════════════
    function handleMatchUpdate(match) {
        if (match.body) return; // Skip activation messages without data
        if (!match.id) return;

        const prev = S.activeMatch;
        S.activeMatch = match;

        // Detect new throw (turns array grew)
        const prevTurns = prev?.turns?.length ?? 0;
        const currTurns = match.turns?.length ?? 0;

        if (currTurns > prevTurns && currTurns > 0) {
            const newTurn = match.turns[currTurns - 1];
            sendTurnData(match, newTurn);
        }

        // Detect GameShot (leg finished)
        if (match.gameFinished && match.gameWinner >= 0) {
            const legKey = match.id + '-s' + (match.set ?? 1) + '-l' + (match.leg ?? 1);
            if (!_dedup[legKey]) {
                _dedup[legKey] = true;
                sendGameShot(match, legKey);
            }
        }

        // Detect match finished
        if (match.finished && match.winner >= 0) {
            const matchKey = match.id + '-finished';
            if (!_dedup[matchKey]) {
                _dedup[matchKey] = true;
                sendMatchFinished(match);
            }
        }

        // Send full stats update
        if (match.stats?.length) {
            sendStatsUpdate(match);
        }

        // Update player name badges (team darts)
        updatePlayerBadges(match);
    }

    function sendTurnData(match, turn) {
        const throws = (turn.throws || []).map(t => ({
            index:     t.throw,
            segment:   t.segment || null,       // { name, number, bed, multiplier }
            coords:    t.coords || null,         // { x, y }
            entry:     t.entry || null,
            createdAt: t.createdAt || null,
        }));

        api('POST', '/api/events/turn', {
            autodartsMatchId: match.id,
            teamMatchId:      S.matchId,
            boardId:          S.boardId,
            round:            turn.round,
            turnIndex:        turn.turn,
            playerId:         turn.playerId,
            score:            turn.score,
            points:           turn.points,
            busted:           turn.busted || false,
            throws:           throws,
            // Include current game state
            gameScores:       match.gameScores || [],
            set:              match.set,
            leg:              match.leg,
        });

        console.log(`[ADT Bridge] Turn: R${turn.round} P${turn.playerId} = ${turn.score}pts (${throws.length} darts)`);
    }

    function sendGameShot(match, legKey) {
        const winner = match.players?.[match.gameWinner];
        const playerNames = (match.players || []).map(p => p.name || '?');

        api('POST', '/api/events/gameshot', {
            autodartsMatchId: match.id,
            teamMatchId:      S.matchId,
            boardId:          S.boardId,
            legKey:           legKey,
            set:              match.set,
            leg:              match.leg,
            winnerIndex:      match.gameWinner,
            winnerName:       winner?.name || '?',
            winnerPlayerId:   winner?.userId || winner?.id || null,
            playerNames:      playerNames,
            gameScores:       match.gameScores || [],
            stats:            match.stats || [],
        });

        console.log(`[ADT Bridge] GameShot! ${winner?.name} wins S${match.set}/L${match.leg}`);
    }

    function sendMatchFinished(match) {
        const winner = match.players?.[match.winner];

        api('POST', '/api/events/match-finished', {
            autodartsMatchId: match.id,
            teamMatchId:      S.matchId,
            boardId:          S.boardId,
            winnerIndex:      match.winner,
            winnerName:       winner?.name || '?',
            scores:           match.scores || [],
            stats:            match.stats || [],
        });

        console.log(`[ADT Bridge] Match finished! Winner: ${winner?.name}`);
    }

    function sendStatsUpdate(match) {
        // Throttle: max once per 3 seconds
        const now = Date.now();
        if (now - (sendStatsUpdate._last || 0) < 3000) return;
        sendStatsUpdate._last = now;

        api('POST', '/api/events/stats', {
            autodartsMatchId: match.id,
            teamMatchId:      S.matchId,
            boardId:          S.boardId,
            stats:            match.stats,
            scores:           match.scores,
            chalkboards:      match.chalkboards || [],
            gameScores:       match.gameScores || [],
            set:              match.set,
            leg:              match.leg,
        });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Player Name Badge Injection (Team Darts: show who's throwing)
    // ═════════════════════════════════════════════════════════════════════════
    let _teamTurnCounters = {};
    let _adtPlayerToTeam = {};
    let _lastPlayer = -1;
    let _lastRound = 0;

    function updatePlayerBadges(match) {
        if (!match.players || match.players.length < 2) return;
        // Only inject if this is a team match (team names as player names)
        // Our team matches use team names as autodarts player names

        const currentPlayer = match.player; // 0 or 1 (autodarts position)
        const currentRound = match.round || 0;

        // Detect new leg (round reset)
        if (currentRound < _lastRound && _lastRound > 2) {
            // Remove old badges
            for (let i = 0; i < 2; i++) {
                const b = document.getElementById('adt-badge-' + i);
                if (b) b.remove();
            }
        }

        // Detect turn change within leg → rotate team member
        if (currentPlayer !== _lastPlayer && _lastPlayer >= 0) {
            const teamId = _adtPlayerToTeam[_lastPlayer];
            if (teamId) _teamTurnCounters[teamId] = (_teamTurnCounters[teamId] || 0) + 1;
        }

        _lastPlayer = currentPlayer;
        _lastRound = currentRound;

        // Resolve team mapping from player names
        resolveTeamMapping(match.players);

        // Inject/update badges
        for (let autoIdx = 0; autoIdx < 2; autoIdx++) {
            const member = getCurrentTeamMember(autoIdx);
            if (!member) continue;

            const badgeId = 'adt-badge-' + autoIdx;
            let badge = document.getElementById(badgeId);
            const isActive = autoIdx === currentPlayer;

            if (!badge) {
                const teamName = match.players[autoIdx]?.name || '';
                if (!teamName) continue;

                const allEls = document.querySelectorAll('span, div, p');
                for (const el of allEls) {
                    if (el.textContent.trim().toUpperCase() === teamName.toUpperCase() && el.childNodes.length === 1 && !el.querySelector('[id^="adt-"]')) {
                        badge = document.createElement('span');
                        badge.id = badgeId;
                        badge.style.cssText = 'display:block;padding:3px 10px;border-radius:6px;font-size:12px;font-weight:700;margin-top:4px;text-align:center;transition:all .2s;font-family:Inter,sans-serif';
                        el.insertAdjacentElement('afterend', badge);
                        break;
                    }
                }
            }

            if (badge) {
                badge.textContent = '🎯 ' + member;
                badge.style.background = isActive ? '#0F62E6' : 'rgba(255,255,255,.08)';
                badge.style.color = isActive ? '#fff' : 'rgba(255,255,255,.4)';
            }
        }
    }

    function resolveTeamMapping(adtPlayers) {
        // Map autodarts player index to our team structure
        // This needs the linked TeamMatch data
        const saved = GM_getValue('adt_team_mapping', '');
        if (saved) {
            try {
                const mapping = JSON.parse(saved);
                for (let i = 0; i < 2; i++) {
                    const adtName = (adtPlayers[i]?.name || '').toUpperCase();
                    for (const [tid, tName] of Object.entries(mapping.teamNames || {})) {
                        if (tName.toUpperCase() === adtName) _adtPlayerToTeam[i] = tid;
                    }
                }
            } catch {}
        }
    }

    function getCurrentTeamMember(autoIdx) {
        const teamId = _adtPlayerToTeam[autoIdx];
        if (!teamId) return null;

        const saved = GM_getValue('adt_team_mapping', '');
        if (!saved) return null;

        try {
            const mapping = JSON.parse(saved);
            const members = mapping.teamMembers?.[teamId] || [];
            if (members.length <= 1) return null; // 1v1, no badge needed
            const turnIdx = (_teamTurnCounters[teamId] || 0) % members.length;
            return members[turnIdx];
        } catch {}
        return null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Channel: autodarts.boards — Board status
    // ═════════════════════════════════════════════════════════════════════════
    function handleBoardUpdate(board) {
        if (board.id) S.boardId = board.id;

        // Also try to capture board images from DOM (blob URLs)
        setTimeout(() => {
            const imgs = document.querySelectorAll('img[src^="blob:"]');
            if (imgs.length > 0) {
                captureBlobImage(imgs[0].src);
            }
        }, 500);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Channel: autodarts.boards.images — Board camera
    // ═════════════════════════════════════════════════════════════════════════
    function handleBoardImage(data) {
        if (!data.url) return;

        const imageUrl = `https://boards.ws.autodarts.io${data.url}`;

        api('POST', '/api/events/board-image', {
            autodartsMatchId: S.activeMatch?.id || null,
            teamMatchId:      S.matchId,
            boardId:          S.boardId,
            imageUrl:         imageUrl,
            timestamp:        new Date().toISOString(),
        });

        console.log('[ADT Bridge] Board image:', imageUrl);
    }

    async function captureBlobImage(blobUrl) {
        try {
            const response = await fetch(blobUrl);
            const blob = await response.blob();
            const reader = new FileReader();
            const base64 = await new Promise((resolve, reject) => {
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            api('POST', '/api/events/board-image', {
                autodartsMatchId: S.activeMatch?.id || null,
                teamMatchId:      S.matchId,
                boardId:          S.boardId,
                imageBase64:      base64,
                timestamp:        new Date().toISOString(),
            });

            console.log('[ADT Bridge] Board image captured (blob)');
        } catch (e) {
            console.warn('[ADT Bridge] Blob capture failed:', e);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Channel: autodarts.lobbies
    // ═════════════════════════════════════════════════════════════════════════
    function handleLobbyUpdate(lobby) {
        // Store for reference, used when creating matches
        S.activeLobby = lobby;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Centrifugo — receive commands from backend
    // ═════════════════════════════════════════════════════════════════════════
    let centrifuge = null;

    async function connectCentrifugo() {
        if (!S.user?.id) return;

        const res = await api('GET', '/api/user/ws-token');
        if (!res.ok || !res.data?.token) return;

        centrifuge = new Centrifuge('wss://ad-team-matches.net/centrifugo/connection/websocket', {
            token: res.data.token,
        });

        centrifuge.on('connected', () => {
            console.log('[ADT Bridge] Centrifugo connected');
            S.wsConnected = true;
        });

        centrifuge.on('disconnected', () => {
            S.wsConnected = false;
        });

        // Subscribe to user channel for commands
        const sub = centrifuge.newSubscription('user:' + S.user.id);
        sub.on('publication', ctx => {
            const d = ctx.data;
            if (d?.type === 'board_command') handleBoardCommand(d);
        });
        sub.subscribe();

        centrifuge.connect();
    }

    function handleBoardCommand(cmd) {
        switch (cmd.action) {
            case 'create_lobby':
                createAutodartsLobby(cmd);
                break;
            case 'start_match':
                startAutodartsMatch(cmd);
                break;
            case 'link_match':
                S.matchId = cmd.teamMatchId;
                S.boardId = cmd.boardId;
                GM_setValue('adt_active_match', JSON.stringify({ matchId: S.matchId, boardId: S.boardId }));
                // Store team mapping for player badge injection
                if (cmd.teamNames && cmd.teamMembers) {
                    GM_setValue('adt_team_mapping', JSON.stringify({
                        teamNames: cmd.teamNames,     // { teamId: "Team Alpha" }
                        teamMembers: cmd.teamMembers,  // { teamId: ["DampflokTV", "DHille"] }
                    }));
                    _teamTurnCounters = {};
                    _lastPlayer = -1;
                    _lastRound = 0;
                }
                console.log('[ADT Bridge] Linked to match:', S.matchId);
                break;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Autodarts Lobby/Match Control
    // ═════════════════════════════════════════════════════════════════════════
    async function createAutodartsLobby(cmd) {
        const token = getAutodartsToken();
        if (!token) { console.warn('[ADT Bridge] No autodarts token'); return; }

        const ADT_API = 'https://api.autodarts.io/gs/v0';
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'application/json' };

        try {
            const lobbyRes = await fetch(ADT_API + '/lobbies', {
                method: 'POST', headers,
                body: JSON.stringify({
                    variant: cmd.variant || 'X01',
                    settings: {
                        baseScore: cmd.baseScore || 501,
                        inMode: cmd.inMode || 'Straight',
                        outMode: cmd.outMode || 'Double',
                        bullMode: cmd.bullMode || '25/50',
                        maxRounds: 50,
                    },
                    bullOffMode: cmd.bullOffMode || 'Normal',
                    isPrivate: true,
                    sets: cmd.sets || 3,
                    legs: cmd.legs || 2,
                }),
            });

            if (!lobbyRes.ok) { console.warn('[ADT Bridge] Lobby create failed:', lobbyRes.status); return; }
            const lobby = await lobbyRes.json();

            // Add players
            for (const team of (cmd.teams || [])) {
                await fetch(ADT_API + '/lobbies/' + lobby.id + '/players', {
                    method: 'POST', headers,
                    body: JSON.stringify({ name: team.name, boardId: cmd.boardId }),
                });
            }

            // Start
            const startRes = await fetch(ADT_API + '/lobbies/' + lobby.id + '/start', { method: 'POST', headers });
            if (startRes.ok) {
                const matchData = await startRes.json();
                S.matchId = cmd.teamMatchId;
                S.boardId = cmd.boardId;
                GM_setValue('adt_active_match', JSON.stringify({ matchId: S.matchId, boardId: S.boardId }));
                console.log('[ADT Bridge] Match started:', lobby.id);

                // Navigate to match
                window.location.href = '/matches/' + lobby.id;
            }
        } catch (e) {
            console.error('[ADT Bridge] Lobby error:', e);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Sidebar Navigation Item
    // ═════════════════════════════════════════════════════════════════════════
    function injectNavItem() {
        if (document.getElementById('adt-bridge-nav')) return;

        function findNav() {
            const stacks = document.querySelectorAll('.chakra-stack');
            for (const s of stacks) {
                if (s.querySelector('a[href="/lobbies"]') && !s.querySelector('.animate__animated')) return s;
            }
            return null;
        }

        const poll = setInterval(() => {
            const nav = findNav();
            if (!nav) return;
            clearInterval(poll);

            const link = document.createElement('a');
            link.id = 'adt-bridge-nav';
            link.className = 'chakra-button css-1nal3hj';
            link.href = 'https://play.ad-team-matches.net';
            link.target = '_blank';
            link.style.cursor = 'pointer';
            link.innerHTML = '<span class="chakra-button__icon" style="margin-right:8px;display:inline-flex"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="0.8" fill="currentColor"/></svg></span>ADT Match';
            nav.appendChild(link);

            // Re-inject if removed
            new MutationObserver(() => {
                if (!document.getElementById('adt-bridge-nav')) nav.appendChild(link);
            }).observe(nav, { childList: true, subtree: true });
        }, 500);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Connection Status Badge
    // ═════════════════════════════════════════════════════════════════════════
    GM_addStyle(`
        #adt-bridge-status {
            position: fixed; bottom: 12px; right: 12px; z-index: 99999;
            background: rgba(6,12,31,.9); border: 1px solid rgba(9,255,141,.2);
            border-radius: 8px; padding: 6px 12px;
            font-family: 'Inter', sans-serif; font-size: 11px; font-weight: 600;
            color: #8A92AB; display: flex; align-items: center; gap: 6px;
            backdrop-filter: blur(8px);
        }
        #adt-bridge-status .dot {
            width: 6px; height: 6px; border-radius: 50%;
        }
        .dot-on { background: #09ff8d; box-shadow: 0 0 6px rgba(9,255,141,.5); }
        .dot-off { background: #F3486A; }
    `);

    function showStatus() {
        let el = document.getElementById('adt-bridge-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'adt-bridge-status';
            document.body.appendChild(el);
        }
        const dot = S.connected ? 'dot-on' : 'dot-off';
        const text = S.connected ? `ADT Bridge v${VERSION}` : 'ADT Bridge — nicht verbunden';
        el.innerHTML = `<span class="dot ${dot}"></span>${text}`;
        el.style.cursor = 'pointer';
        el.onclick = showSettings;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Settings Popup (Token Entry)
    // ═════════════════════════════════════════════════════════════════════════
    function showSettings() {
        if (document.getElementById('adt-settings-popup')) return;

        const overlay = document.createElement('div');
        overlay.id = 'adt-settings-popup';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(6,12,31,.85);display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif';
        overlay.innerHTML = `
            <div style="background:#141C33;border:1px solid #1e2d4a;border-radius:12px;padding:32px;width:100%;max-width:400px">
                <h2 style="font-size:18px;font-weight:800;color:#e8ecf4;margin:0 0 4px">🎯 ADT Match Bridge</h2>
                <p style="font-size:12px;color:#7a8599;margin:0 0 20px">v${VERSION} — Verbinde mit deinem ADT Match Account</p>
                <label style="display:block;font-size:10px;color:#4d5870;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">API-Token</label>
                <input id="adt-token-input" type="password" value="${S.apiKey}" placeholder="adt_xxx..."
                    style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid #1e2d4a;background:#131d35;color:#e8ecf4;font-size:13px;font-family:monospace;outline:none;box-sizing:border-box" />
                <p style="font-size:11px;color:#4d5870;margin:8px 0 16px">
                    Token aus <a href="https://ad-team-matches.net/profile/api-token" target="_blank" style="color:#5b9cff">Profil → API-Token</a> oder
                    <a href="https://play.ad-team-matches.net" target="_blank" style="color:#5b9cff">Play-App Login</a>
                </p>
                <div style="display:flex;gap:8px">
                    <button id="adt-save-btn" style="flex:1;padding:10px;border-radius:8px;border:none;background:#F3486A;color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Speichern</button>
                    <button id="adt-close-btn" style="padding:10px 16px;border-radius:8px;border:1px solid #1e2d4a;background:transparent;color:#7a8599;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Schließen</button>
                </div>
                <div id="adt-settings-msg" style="margin-top:12px;font-size:12px;text-align:center"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('adt-save-btn').onclick = async () => {
            const val = document.getElementById('adt-token-input').value.trim();
            const msg = document.getElementById('adt-settings-msg');
            if (!val) { msg.innerHTML = '<span style="color:#F3486A">Token eingeben!</span>'; return; }

            S.apiKey = val;
            GM_setValue('adt_api_key', val);
            msg.innerHTML = '<span style="color:#7a8599">Teste Verbindung...</span>';

            const r = await api('POST', '/api/user/ping');
            if (r.ok) {
                const me = await api('GET', '/api/user/me');
                S.user = me.ok ? me.data : null;
                S.connected = true;
                msg.innerHTML = '<span style="color:#09ff8d">✓ Verbunden als ' + (S.user?.name || '?') + '</span>';
                showStatus();
                connectCentrifugo();
                setTimeout(() => overlay.remove(), 1500);
            } else {
                msg.innerHTML = '<span style="color:#F3486A">Verbindung fehlgeschlagen (' + r.status + ')</span>';
            }
        };

        document.getElementById('adt-close-btn').onclick = () => overlay.remove();
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Init
    // ═════════════════════════════════════════════════════════════════════════
    console.log(`[ADT Bridge] v${VERSION}`);

    // Intercept WebSocket BEFORE autodarts loads
    interceptWebSocket();

    // Restore active match
    try {
        const saved = GM_getValue('adt_active_match', '');
        if (saved) {
            const { matchId, boardId } = JSON.parse(saved);
            S.matchId = matchId;
            S.boardId = boardId;
        }
    } catch {}

    // Wait for DOM
    function init() {
        injectNavItem();
        showStatus();

        // Show settings if no token
        if (!S.apiKey) {
            showSettings();
        }

        // Connect to ADT backend
        if (S.apiKey) {
            api('POST', '/api/user/ping').then(r => {
                if (r.ok) {
                    api('GET', '/api/user/me').then(me => {
                        if (me.ok) {
                            S.user = me.data;
                            S.connected = true;
                            showStatus();
                            connectCentrifugo();
                        }
                    });
                    api('GET', '/api/user/boards').then(b => {
                        if (b.ok) S.boards = b.data || [];
                    });
                } else {
                    showStatus();
                }
            });
        } else {
            showStatus();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
