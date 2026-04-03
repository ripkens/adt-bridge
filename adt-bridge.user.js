// ==UserScript==
// @name         ADT Match – Board Bridge
// @namespace    https://ad-team-matches.net
// @version      6.5.1
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
// @updateURL    https://raw.githubusercontent.com/ripkens/adt-bridge/main/adt-bridge.meta.js
// @downloadURL  https://raw.githubusercontent.com/ripkens/adt-bridge/main/adt-bridge.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '6.5.1';
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
    // Version Helpers
    // ═════════════════════════════════════════════════════════════════════════
    function compareVersions(a, b) {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const na = pa[i] || 0, nb = pb[i] || 0;
            if (na < nb) return -1;
            if (na > nb) return 1;
        }
        return 0;
    }

    function showUpdateBanner(minVersion) {
        const poll = setInterval(() => {
            if (!document.body) return;
            clearInterval(poll);
            const banner = document.createElement('div');
            banner.id = 'adt-update-banner';
            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#F3486A;color:#fff;padding:10px 16px;font-family:Inter,sans-serif;font-size:13px;font-weight:700;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px';
            banner.innerHTML = `⚠️ ADT Bridge veraltet (v${VERSION}) — Mindestversion v${minVersion} erforderlich. <a href="https://raw.githubusercontent.com/ripkens/adt-bridge/main/adt-bridge.user.js" style="color:#fff;text-decoration:underline;font-weight:800">Jetzt updaten</a>`;
            document.body.prepend(banner);
        }, 200);
    }

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
    let _adtTokenExpiry = 0;

    function getAutodartsToken() {
        // Always read the latest token from page context (refreshed by fetch intercept)
        try {
            const t = unsafeWindow?.__ADT_TOKEN__ || window.__ADT_TOKEN__;
            if (t && t !== _capturedAdtToken) {
                _capturedAdtToken = t;
                // Parse JWT expiry
                try {
                    const payload = JSON.parse(atob(t.split('.')[1]));
                    _adtTokenExpiry = (payload.exp || 0) * 1000;
                } catch {}
            }
        } catch {}
        return _capturedAdtToken || null;
    }

    function isAdtTokenExpired() {
        return !_adtTokenExpiry || Date.now() > _adtTokenExpiry - 30000; // 30s buffer
    }

    /**
     * Refresh autodarts token via Keycloak if expired.
     * Reads refresh_token from localStorage (stored by autodarts OIDC client).
     */
    async function ensureFreshAdtToken() {
        const current = getAutodartsToken();
        if (current && !isAdtTokenExpired()) return current;

        // Try to find refresh token in localStorage
        let refreshToken = null;
        try {
            const win = unsafeWindow || window;
            for (let i = 0; i < win.localStorage.length; i++) {
                const key = win.localStorage.key(i);
                const val = win.localStorage.getItem(key);
                if (val && (key.includes('keycloak') || key.includes('oidc') || key.includes('token'))) {
                    try {
                        const parsed = JSON.parse(val);
                        if (parsed.refresh_token) { refreshToken = parsed.refresh_token; break; }
                    } catch {
                        if (val.startsWith('eyJ') && val.length > 500 && !refreshToken) refreshToken = val;
                    }
                }
            }
        } catch {}

        if (!refreshToken) {
            console.warn('[ADT Bridge] No refresh token found in localStorage');
            return current;
        }

        // Call Keycloak token endpoint
        try {
            const res = await fetch('https://login.autodarts.io/realms/autodarts/protocol/openid-connect/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: 'autodarts-play',
                    refresh_token: refreshToken,
                }),
            });
            if (res.ok) {
                const data = await res.json();
                if (data.access_token) {
                    _capturedAdtToken = data.access_token;
                    try {
                        const win = unsafeWindow || window;
                        win.__ADT_TOKEN__ = data.access_token;
                    } catch {}
                    const payload = JSON.parse(atob(data.access_token.split('.')[1]));
                    _adtTokenExpiry = (payload.exp || 0) * 1000;
                    console.log('[ADT Bridge] Token refreshed via Keycloak, expires:', new Date(_adtTokenExpiry).toLocaleTimeString());
                    return data.access_token;
                }
            } else {
                console.warn('[ADT Bridge] Keycloak refresh failed:', res.status);
            }
        } catch (e) {
            console.warn('[ADT Bridge] Keycloak refresh error:', e);
        }

        return current;
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
            const _keycloakTokenUrl = 'https://login.autodarts.io/realms/autodarts/protocol/openid-connect/token';
            window.fetch = function(...args) {
                const [url, opts] = typeof args[0] === 'string' ? [args[0], args[1]] : [args[0]?.url, args[1]];
                const promise = _origFetch.apply(this, args);
                try {
                    if (typeof url === 'string') {
                        // Capture token from Keycloak token endpoint response (initial login + silent refresh)
                        if (url.startsWith(_keycloakTokenUrl)) {
                            promise.then(res => res.clone().json().then(body => {
                                if (body.access_token) {
                                    window.__ADT_TOKEN__ = body.access_token;
                                    window.dispatchEvent(new CustomEvent('adt-token-refresh', { detail: { token: body.access_token } }));
                                }
                            }).catch(() => {})).catch(() => {});
                        }
                        // Also capture Bearer token from autodarts API calls (fallback)
                        if (url.includes('autodarts.io')) {
                            let auth = null;
                            if (opts?.headers) {
                                if (opts.headers instanceof Headers) auth = opts.headers.get('Authorization');
                                else auth = opts.headers['Authorization'] || opts.headers['authorization'];
                            }
                            if (auth && auth.startsWith('Bearer ')) {
                                window.__ADT_TOKEN__ = auth.substring(7);
                            }
                        }
                        // Detect game actions (works with both absolute and relative URLs)
                        if (opts?.method === 'POST') {
                            if (url.includes('/players/next')) {
                                window.dispatchEvent(new CustomEvent('adt-players-next', { detail: { url } }));
                            }
                            if (url.endsWith('/undo')) {
                                window.dispatchEvent(new CustomEvent('adt-undo', { detail: { url } }));
                            }
                        }
                    }
                } catch {}
                return promise;
            };

            // ── Capture from XMLHttpRequest too ──
            const _origXhrOpen = XMLHttpRequest.prototype.open;
            const _origXhrSend = XMLHttpRequest.prototype.send;
            const _origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this._adtUrl = url;
                this._adtMethod = method;
                return _origXhrOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
                if (this._adtUrl?.includes('autodarts.io') && name.toLowerCase() === 'authorization' && value.startsWith('Bearer ')) {
                    window.__ADT_TOKEN__ = value.substring(7);
                }
                return _origXhrSetHeader.call(this, name, value);
            };
            XMLHttpRequest.prototype.send = function(...args) {
                // Detect game actions via XHR (URL may be relative or absolute)
                if (this._adtMethod === 'POST' && this._adtUrl) {
                    if (this._adtUrl.includes('/players/next')) {
                        window.dispatchEvent(new CustomEvent('adt-players-next', { detail: { url: this._adtUrl } }));
                    }
                    if (this._adtUrl.endsWith('/undo')) {
                        window.dispatchEvent(new CustomEvent('adt-undo', { detail: { url: this._adtUrl } }));
                    }
                }
                return _origXhrSend.apply(this, args);
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

        // Listen for Next/Undo API calls (intercepted from fetch + XHR)
        window.addEventListener('adt-players-next', () => {
            handlePlayersNext();
        });
        window.addEventListener('adt-undo', () => {
            handleUndo();
        });

        // Listen for token refresh from Keycloak intercept (most reliable)
        window.addEventListener('adt-token-refresh', e => {
            const t = e.detail?.token;
            if (t && t !== _capturedAdtToken) {
                _capturedAdtToken = t;
                try {
                    const payload = JSON.parse(atob(t.split('.')[1]));
                    _adtTokenExpiry = (payload.exp || 0) * 1000;
                } catch {}
                console.log('[ADT Bridge] Token refreshed via Keycloak intercept, expires:', new Date(_adtTokenExpiry).toLocaleTimeString());
            }
        });

        // Poll for captured token from page context (fallback)
        setInterval(() => {
            try {
                const t = unsafeWindow?.__ADT_TOKEN__ || window.__ADT_TOKEN__;
                if (t && t !== _capturedAdtToken) {
                    _capturedAdtToken = t;
                    try {
                        const payload = JSON.parse(atob(t.split('.')[1]));
                        _adtTokenExpiry = (payload.exp || 0) * 1000;
                    } catch {}
                    console.log('[ADT Bridge] Autodarts token captured (poll)');
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

        const isBullOff = match.variant && match.variant !== 'X01';
        const prev = S.activeMatch;
        S.activeMatch = match;

        // If autodarts match ID changed (e.g. Bull-off → X01), reset comparison baseline
        const sameMatch = prev && prev.id === match.id;

        // ── Bull-off: only track who won, nothing else ──
        if (isBullOff) {
            if (match.gameFinished && match.gameWinner >= 0) {
                const key = match.id + '-bulloff';
                if (!_dedup[key]) {
                    _dedup[key] = true;
                    const winner = match.players?.[match.gameWinner];
                    api('POST', '/api/events/bulloff', {
                        autodartsMatchId: match.id,
                        teamMatchId:      S.matchId,
                        boardId:          S.boardId,
                        winnerIndex:      match.gameWinner,
                        winnerName:       winner?.name || '?',
                        playerNames:      (match.players || []).map(p => p.name || '?'),
                    });
                    console.log(`[ADT Bridge] Bull-off won by: ${winner?.name}`);
                }
            }
            return; // Skip all other tracking for Bull-off
        }

        // ── Track individual throws ──
        const currTurns = match.turns?.length ?? 0;

        if (currTurns > 0 && !_suppressThrows) {
            const currLastTurn = match.turns[currTurns - 1];
            const currThrowCount = currLastTurn?.throws?.length ?? 0;
            const prevLastTurn = sameMatch && prev?.turns?.length >= currTurns ? prev.turns[currTurns - 1] : null;
            const prevThrowCount = prevLastTurn?.throws?.length ?? 0;

            // New dart landed → broadcast for live display (not stored, may be corrected)
            if (currThrowCount > prevThrowCount && currThrowCount > 0) {
                const newThrow = currLastTurn.throws[currThrowCount - 1];
                console.log(`[ADT Bridge] Throw: ${newThrow?.segment?.name || '?'} (dart ${currThrowCount}/3, R${currLastTurn.round})`);
                sendThrowData(match, currLastTurn, newThrow, currThrowCount);
                setTimeout(fetchAndSendMatchState, 500);
                // New dart thrown = no longer in "undo after next" window
                _lastSentTurn = null;
            }

            // Dart removed (Undo within turn) → broadcast correction
            if (sameMatch && currThrowCount < prevThrowCount) {
                console.log(`[ADT Bridge] Undo: dart removed (now ${currThrowCount} darts, R${currLastTurn.round})`);
                // TODO: broadcast undo event to Play-App
            }
        }

        // Turn completion is handled by handlePlayersNext() via fetch intercept of POST /players/next

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

    // Track last sent turn so we can revert it on undo-after-next
    let _lastSentTurn = null;
    let _suppressThrows = false;

    /**
     * Triggered when POST /undo is intercepted.
     * If a turn was just sent (undo after next), revert it in the backend.
     */
    function handleUndo() {
        if (_lastSentTurn) {
            // Undo happened after a Next → revert the turn in backend
            const t = _lastSentTurn;
            console.log(`[ADT Bridge] Undo after Next → reverting turn R${t.round} T${t.turn}`);
            api('POST', '/api/events/undo-turn', {
                autodartsMatchId: t.autodartsMatchId,
                teamMatchId:      S.matchId,
                round:            t.round,
                turnIndex:        t.turn,
                set:              t.set,
                leg:              t.leg,
            });
            // Remove dedup so the corrected turn can be sent again
            const match = S.activeMatch;
            if (match) {
                delete _dedup[match.id + '-t-' + t.round + '-' + t.turn];
            }
            _lastSentTurn = null;
            // Suppress throw detection for next WS updates (state restoration, not new darts)
            _suppressThrows = true;
            setTimeout(() => { _suppressThrows = false; }, 2000);
        } else {
            console.log('[ADT Bridge] Undo (dart correction)');
        }
        setTimeout(fetchAndSendMatchState, 500);
    }

    /**
     * Triggered when POST /players/next is intercepted (Next button or darts pulled).
     * Reads the current (now completed) turn from S.activeMatch and sends it to backend.
     */
    function handlePlayersNext() {
        const match = S.activeMatch;
        if (!match?.turns?.length) return;

        const currTurn = match.turns[match.turns.length - 1];
        if (!currTurn?.throws?.length) return;

        const dedupKey = match.id + '-t-' + currTurn.round + '-' + currTurn.turn;
        if (_dedup[dedupKey]) return;
        _dedup[dedupKey] = true;

        sendTurnData(match, currTurn);
        // Track for potential undo-after-next (cleared when new dart is thrown)
        _lastSentTurn = {
            autodartsMatchId: match.id,
            round: currTurn.round,
            turn: currTurn.turn,
            set: match.set,
            leg: match.leg,
        };

        console.log(`[ADT Bridge] Next → Turn sent: R${currTurn.round} T${currTurn.turn} = ${currTurn.score}pts (${currTurn.throws.length} darts)`);
        setTimeout(fetchAndSendMatchState, 500);
    }

    /**
     * Fetch full match state from autodarts REST API and send to backend.
     * Called after throw/next/undo to get checkoutGuide, chalkboards etc.
     */
    async function fetchAndSendMatchState() {
        const match = S.activeMatch;
        if (!match?.id || !S.matchId) return;

        const token = getAutodartsToken();
        if (!token) return;

        try {
            const res = await fetch(`https://api.autodarts.io/gs/v0/matches/${match.id}/state`, {
                headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
            });
            if (!res.ok) return;
            const state = await res.json();

            // Send full state to backend (store everything, display what we need)
            api('POST', '/api/events/stats', {
                autodartsMatchId: match.id,
                teamMatchId:      S.matchId,
                boardId:          S.boardId,
                fullState:        state,
                // Keep flat fields for Centrifugo broadcast
                stats:            state.stats || [],
                scores:           state.scores || [],
                chalkboards:      state.chalkboards || [],
                gameScores:       state.gameScores || [],
                players:          (state.players || []).map(p => ({ id: p.id, index: p.index, name: p.name })),
                checkoutGuide:    state.state?.checkoutGuide || [],
                activePlayer:     state.player,
                winner:           state.finished ? state.winner : null,
                finished:         state.finished || false,
                set:              state.set,
                leg:              state.leg,
            });
        } catch (e) {
            // Silently fail — non-critical
        }
    }

    function sendThrowData(match, turn, throwData, dartIndex) {
        api('POST', '/api/events/throw', {
            autodartsMatchId: match.id,
            teamMatchId:      S.matchId,
            boardId:          S.boardId,
            round:            turn.round,
            turnIndex:        turn.turn,
            playerId:         turn.playerId,
            dartIndex:        dartIndex,
            segment:          throwData.segment || null,
            coords:           throwData.coords || null,
            entry:            throwData.entry || null,
            createdAt:        throwData.createdAt || null,
            gameScores:       match.gameScores || [],
            checkoutGuide:    match.state?.checkoutGuide || [],
            activePlayer:     match.player,
            set:              match.set,
            leg:              match.leg,
        });
    }

    function sendTurnData(match, turn) {
        const throws = (turn.throws || []).map(t => ({
            index:     t.throw,
            segment:   t.segment || null,       // { name, number, bed, multiplier }
            coords:    t.coords || null,         // { x, y }
            entry:     t.entry || null,
            createdAt: t.createdAt || null,
        }));

        // Resolve player name from match.players
        let player = (match.players || []).find(p => p.id === turn.playerId || p.userId === turn.playerId);
        // Fallback: use turn index (turn.turn matches player index in 2-player match)
        if (!player && turn.turn !== undefined && match.players?.[turn.turn]) {
            player = match.players[turn.turn];
        }
        const playerName = player?.name || null;
        console.log(`[ADT Bridge] Turn player resolved: playerId=${turn.playerId} turn=${turn.turn} → ${playerName || 'UNKNOWN'}`);

        api('POST', '/api/events/turn', {
            autodartsMatchId: match.id,
            teamMatchId:      S.matchId,
            boardId:          S.boardId,
            round:            turn.round,
            turnIndex:        turn.turn,
            playerId:         turn.playerId,
            playerName:       playerName,
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

    async function sendGameShot(match, legKey) {
        const winner = match.players?.[match.gameWinner];
        const playerNames = (match.players || []).map(p => p.name || '?');

        // Fetch full match state from autodarts REST API for accurate stats
        let fullState = null;
        const token = getAutodartsToken();
        if (token && match.id) {
            try {
                const res = await fetch(`https://api.autodarts.io/gs/v0/matches/${match.id}/state`, {
                    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
                });
                if (res.ok) fullState = await res.json();
            } catch (e) {
                console.warn('[ADT Bridge] Failed to fetch match state for gameshot:', e);
            }
        }

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
            stats:            fullState?.stats || match.stats || [],
            scores:           fullState?.scores || match.scores || [],
            players:          (fullState?.players || match.players || []).map(p => ({
                id: p.id, index: p.index, name: p.name, userId: p.userId,
            })),
            fullState:        fullState,
        });

        console.log(`[ADT Bridge] GameShot! ${winner?.name} wins S${match.set}/L${match.leg}` + (fullState ? ' (with full state)' : ''));
    }

    async function sendMatchFinished(match) {
        // Resolve winner by scores (most sets), not player index (may be swapped)
        let winnerName = '?';
        let winnerIndex = match.winner;
        const scores = match.scores || [];
        if (scores.length >= 2) {
            const maxSets = Math.max(scores[0]?.sets || 0, scores[1]?.sets || 0);
            const winIdx = scores.findIndex(s => (s.sets || 0) === maxSets);
            if (winIdx >= 0 && match.players?.[winIdx]) {
                winnerName = match.players[winIdx].name || '?';
                winnerIndex = winIdx;
            }
        } else if (match.players?.[match.winner]) {
            winnerName = match.players[match.winner].name || '?';
        }

        // Fetch full match state for final stats snapshot
        let fullState = null;
        const token = getAutodartsToken();
        if (token && match.id) {
            try {
                const res = await fetch(`https://api.autodarts.io/gs/v0/matches/${match.id}/state`, {
                    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
                });
                if (res.ok) fullState = await res.json();
            } catch (e) {
                console.warn('[ADT Bridge] Failed to fetch match state for match-finished:', e);
            }
        }

        api('POST', '/api/events/match-finished', {
            autodartsMatchId: match.id,
            teamMatchId:      S.matchId,
            boardId:          S.boardId,
            winnerIndex:      winnerIndex,
            winnerName:       winnerName,
            scores:           fullState?.scores || scores,
            stats:            fullState?.stats || match.stats || [],
            players:          (fullState?.players || match.players || []).map(p => ({
                id: p.id, index: p.index, name: p.name, userId: p.userId,
            })),
            fullState:        fullState,
        });

        console.log(`[ADT Bridge] Match finished! Winner: ${winnerName}` + (fullState ? ' (with full state)' : ''));
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
            players:          (match.players || []).map(p => ({ id: p.id, index: p.index, name: p.name })),
            checkoutGuide:    match.state?.checkoutGuide || [],
            activePlayer:     match.player,
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
        const token = await ensureFreshAdtToken();
        if (!token) { console.warn('[ADT Bridge] No autodarts token'); return; }

        const ADT_API = 'https://api.autodarts.io/gs/v0';
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'application/json' };

        // Resolve real board ID (from user's saved boards, not "any")
        const realBoardId = (cmd.boardId && cmd.boardId !== 'any') ? cmd.boardId
            : S.boards?.[0]?.id || null;

        try {
            // 1. Create lobby
            const lobbyBody = {
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
            };
            console.log('[ADT Bridge] Creating lobby:', JSON.stringify(lobbyBody));
            const lobbyRes = await fetch(ADT_API + '/lobbies', {
                method: 'POST', headers,
                body: JSON.stringify(lobbyBody),
            });

            if (!lobbyRes.ok) {
                const errText = await lobbyRes.text();
                console.warn('[ADT Bridge] Lobby create failed:', lobbyRes.status, errText);
                return;
            }
            const lobby = await lobbyRes.json();
            console.log('[ADT Bridge] Lobby created:', lobby.id);

            // 2. Add players (team names as player names, with board ID)
            for (const team of (cmd.teams || [])) {
                const playerBody = { name: team.name };
                if (realBoardId) playerBody.boardId = realBoardId;
                console.log('[ADT Bridge] Adding player:', JSON.stringify(playerBody));
                const pRes = await fetch(ADT_API + '/lobbies/' + lobby.id + '/players', {
                    method: 'POST', headers,
                    body: JSON.stringify(playerBody),
                });
                if (!pRes.ok) {
                    const errText = await pRes.text();
                    console.warn('[ADT Bridge] Player add failed:', pRes.status, errText);
                }
            }

            // 3. Start
            console.log('[ADT Bridge] Starting lobby...');
            const startRes = await fetch(ADT_API + '/lobbies/' + lobby.id + '/start', { method: 'POST', headers });
            if (startRes.ok) {
                const matchData = await startRes.json();
                S.matchId = cmd.teamMatchId;
                S.boardId = realBoardId || cmd.boardId;
                GM_setValue('adt_active_match', JSON.stringify({ matchId: S.matchId, boardId: S.boardId }));
                console.log('[ADT Bridge] Match started! Lobby:', lobby.id, 'Board:', S.boardId);

                // Navigate to match
                window.location.href = '/matches/' + lobby.id;
            } else {
                const errText = await startRes.text();
                console.warn('[ADT Bridge] Lobby start failed:', startRes.status, errText);
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
    // Autodarts Stats Sync — fetch player stats and send to backend
    // ═════════════════════════════════════════════════════════════════════════
    let _statsSyncInterval = null;

    async function syncAutodartsStats() {
        const token = await ensureFreshAdtToken();
        if (!token || !S.apiKey) return;

        try {
            const res = await fetch('https://api.autodarts.io/us/v0/profile/stats/x01?limit=100', {
                headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
            });
            if (!res.ok) return;
            const stats = await res.json();
            if (!stats || typeof stats !== 'object') return;

            api('POST', '/api/user/autodarts-stats', { stats });
            console.log('[ADT Bridge] Stats synced: avg=' + (stats.averageLast?.average?.toFixed(1) || '?'));
        } catch (e) {
            console.warn('[ADT Bridge] Stats sync failed:', e);
        }
    }

    function startStatsSync() {
        // Sync immediately, then every 10 minutes
        setTimeout(syncAutodartsStats, 5000);
        _statsSyncInterval = setInterval(syncAutodartsStats, 10 * 60 * 1000);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Keepalive Ping — stay visible in "Online Spieler" even with inactive tab
    // ═════════════════════════════════════════════════════════════════════════
    function startKeepalive() {
        setInterval(() => {
            if (!S.apiKey || !S.connected) return;
            const boardIds = (S.boards || []).map(bd => bd.id);
            api('POST', '/api/user/ping', { bridgeVersion: VERSION, boardIds });
        }, 5 * 60 * 1000); // Every 5 minutes
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
            api('POST', '/api/user/ping', { bridgeVersion: VERSION, boardIds: [] }).then(r => {
                if (r.ok) {
                    // Check minimum bridge version
                    const minVersion = r.data?.minBridgeVersion;
                    if (minVersion && compareVersions(VERSION, minVersion) < 0) {
                        S.outdated = true;
                        showUpdateBanner(minVersion);
                    }

                    api('GET', '/api/user/me').then(me => {
                        if (me.ok) {
                            S.user = me.data;
                            S.connected = true;
                            showStatus();
                            connectCentrifugo();
                            startStatsSync();
                            startKeepalive();
                        }
                    });
                    api('GET', '/api/user/boards').then(b => {
                        if (b.ok) {
                            S.boards = b.data || [];
                            // Re-ping with board IDs to register bridge version per board
                            if (S.boards.length) {
                                api('POST', '/api/user/ping', {
                                    bridgeVersion: VERSION,
                                    boardIds: S.boards.map(bd => bd.id),
                                });
                            }
                        }
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
