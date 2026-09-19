// ============================================================
// شيك شيك - نظام الصوت المستقل
// Voice v6.4 (Full Fix: State Conflict + Robust TURN/STUN Relay)
// ============================================================

(function () {
  "use strict";

  function createVoiceController(o) {

    const {
      db,
      ref,
      get,
      set,
      update,
      push,
      remove,
      getRoomCode,
      getUid,
      getName,
      getCurrentRoom,
      toast,
      sleep,
      releaseWebAudio,
      stopRadio,
      onStateChange,
      onUiRefresh
    } = o;

    // ========================================================
    // STATE
    // ========================================================

    let voiceActive = false;
    let voiceStarting = false;
    let voiceMuted = false;

    let localVoiceStream = null;

    let voiceSyncBusy = false;
    let voiceSessionId = "";
    let voiceSyncTimer = null;

    const voicePeers = new Map();
    const reconnectTimers = new Map();

    let audioUnlockInstalled = false;

    // ========================================================
    // SETTINGS
    // ========================================================

    const VOICE_VERSION = "6.4";
    const VOICE_DEBUG = false;

    const SYNC_MS = 1200;
    const HEARTBEAT_MS = 5000;
    const ICE_CHECK_TIMEOUT = 12000;

    let lastHeartbeatAt = 0;

    // ========================================================
    // DEBUG
    // ========================================================

    const voiceDebug = {
      users: 0,
      expected: 0,
      connected: 0,
      lastAction: "جاهز",
      lastError: "",
      peers: {}
    };

    function debugLog(message, data) {
      if (!VOICE_DEBUG) return;
      try {
        console.log("%c[VOICE]", "color:#00d084;font-weight:bold", message, data || "");
      } catch {}
      voiceDebug.lastAction = String(message || "");
      updateDebugBox();
    }

    function debugError(message, error) {
      const raw = String(error?.message || error || "");
      try {
        console.warn("[VOICE ERROR]", message, error);
      } catch {}
      voiceDebug.lastError = `${message}: ${raw}`;
      updateDebugBox();
    }

    function setPeerDebug(uid, patch) {
      if (!VOICE_DEBUG) return;
      if (!voiceDebug.peers[uid]) {
        voiceDebug.peers[uid] = { connection: "-", ice: "-", signaling: "-", stage: "انتظار" };
      }
      Object.assign(voiceDebug.peers[uid], patch || {});
      updateDebugBox();
    }

    function getDebugBox() {
      if (!VOICE_DEBUG) return null;
      let box = document.getElementById("voiceDebugBox");
      if (box) return box;

      box = document.createElement("div");
      box.id = "voiceDebugBox";
      box.dir = "rtl";
      box.style.cssText = `
        position:fixed; left:8px; bottom:8px; z-index:999999;
        width:min(92vw,360px); max-height:42vh; overflow:auto;
        padding:10px; border-radius:12px; background:rgba(0,0,0,.88);
        color:#fff; border:1px solid rgba(255,255,255,.25);
        font-family:Arial,sans-serif; font-size:12px; line-height:1.65;
        text-align:right; direction:rtl;
      `;
      document.body.appendChild(box);
      return box;
    }

    function updateDebugBox() {
      if (!VOICE_DEBUG) return;
      const box = getDebugBox();
      if (!box) return;

      const peerLines = Object.entries(voiceDebug.peers).map(([uid, p]) => {
        const shortUid = String(uid).slice(0, 8);
        return `
          <div style="margin-top:6px; padding-top:6px; border-top:1px solid #444;">
            👤 ${shortUid}<br>المرحلة: ${p.stage || "-"}<br>WebRTC: ${p.connection || "-"}<br>ICE: ${p.ice || "-"}<br>Signal: ${p.signaling || "-"}
          </div>
        `;
      }).join("");

      box.innerHTML = `
        <div style="font-weight:bold; color:#ffd54a; margin-bottom:4px;">🛠 تشخيص الصوت المؤقت — v${VOICE_VERSION}</div>
        الصوت: ${voiceActive ? "شغال" : "متوقف"} ${voiceMuted ? "🔇" : "🎙️"}<br>
        الموجودون بالصوت: ${voiceDebug.users}<br>
        المطلوب الاتصال بهم: ${voiceDebug.expected}<br>
        المتصل فعلياً: ${voiceRemoteCount()} / ${voiceDebug.expected}<br>
        آخر خطوة: ${voiceDebug.lastAction || "-"}<br>
        ${voiceDebug.lastError ? `<span style="color:#ff8080">آخر خطأ: ${voiceDebug.lastError}</span><br>` : ""}
        ${peerLines}
      `;
    }

    // ========================================================
    // HELPERS
    // ========================================================

    function safeToast(message) {
      try { toast?.(message); } catch {}
    }

    function wait(ms) {
      if (sleep) return sleep(ms);
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function publishState() {
      try {
        onStateChange?.({
          active: voiceActive,
          starting: voiceStarting,
          muted: voiceMuted,
          remoteCount: voiceRemoteCount()
        });
      } catch {}
      try { onUiRefresh?.(); } catch {}
      voiceDebug.connected = voiceRemoteCount();
      updateDebugBox();
    }

    function pairIdFor(a, b) {
      return [String(a), String(b)].sort().join("__");
    }

    function makePairSessionKey(uid, mySession, otherUid, otherSession) {
      const arr = [
        { uid: String(uid), session: String(mySession || "") },
        { uid: String(otherUid), session: String(otherSession || "") }
      ].sort((a, b) => a.uid.localeCompare(b.uid));
      return arr[0].session + "__PAIR__" + arr[1].session;
    }

    function voiceRemoteCount() {
      let n = 0;
      for (const pc of voicePeers.values()) {
        if (pc && (pc.connectionState === "connected" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed")) {
          n++;
        }
      }
      return n;
    }

    function isActive() { return voiceActive; }
    function isStarting() { return voiceStarting; }
    function isMuted() { return voiceMuted; }

    // ========================================================
    // AUDIO BOX & UNLOCK
    // ========================================================

    function getAudioBox() {
      let box = document.getElementById("voiceAudios");
      if (!box) {
        box = document.createElement("div");
        box.id = "voiceAudios";
        box.style.cssText = "position:fixed; width:1px; height:1px; overflow:hidden; opacity:0; pointer-events:none;";
        document.body.appendChild(box);
      }
      return box;
    }

    function unlockRemoteAudios() {
      const box = document.getElementById("voiceAudios");
      if (!box) return;
      box.querySelectorAll("audio").forEach(audio => {
        try {
          audio.muted = false;
          audio.volume = 1;
          const p = audio.play();
          if (p?.catch) p.catch(() => {});
        } catch {}
      });
    }

    function installAudioUnlock() {
      if (audioUnlockInstalled) return;
      audioUnlockInstalled = true;
      const unlock = () => { unlockRemoteAudios(); };
      document.addEventListener("touchstart", unlock, { passive: true });
      document.addEventListener("pointerdown", unlock, { passive: true });
      document.addEventListener("click", unlock, { passive: true });
    }
    installAudioUnlock();

    // ========================================================
    // FIREBASE READS
    // ========================================================

    async function readVoiceUsers() {
      try {
        const roomCode = getRoomCode?.();
        if (!roomCode) return {};
        const snap = await get(ref(db, `rooms/${roomCode}/public/voiceUsers`));
        return snap.val() || {};
      } catch (e) {
        debugError("قراءة voiceUsers", e);
        return getCurrentRoom?.()?.voiceUsers || {};
      }
    }

    async function readSignal(pair) {
      try {
        const roomCode = getRoomCode?.();
        if (!roomCode) return {};
        const snap = await get(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}`));
        return snap.val() || {};
      } catch (e) {
        debugError("قراءة Signal", e);
        return {};
      }
    }

    async function heartbeat() {
      if (!voiceActive) return;
      const now = Date.now();
      if (now - lastHeartbeatAt < HEARTBEAT_MS) return;
      lastHeartbeatAt = now;
      try {
        await update(ref(db, `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`), {
          active: true,
          muted: voiceMuted,
          session: voiceSessionId,
          ts: now
        });
      } catch (e) {
        debugError("Heartbeat", e);
      }
    }

    async function clearMyVoiceSignals() {
      try {
        const uid = getUid?.();
        const roomCode = getRoomCode?.();
        if (!uid || !roomCode) return;
        const voiceUsers = await readVoiceUsers();
        for (const otherUid of Object.keys(voiceUsers).filter(id => id !== uid)) {
          if (String(uid) < String(otherUid)) {
            try {
              await remove(ref(db, `rooms/${roomCode}/public/voiceSignals/${pairIdFor(uid, otherUid)}`));
            } catch {}
          }
        }
      } catch (e) {
        debugError("تنظيف الإشارات", e);
      }
    }

    function stopLocalTracks() {
      if (!localVoiceStream) return;
      try {
        localVoiceStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
      } catch {}
      localVoiceStream = null;
    }

    // ========================================================
    // PEER MANAGEMENT
    // ========================================================

    function closePeer(otherUid) {
      const timer = reconnectTimers.get(otherUid);
      if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(otherUid);
      }

      const pc = voicePeers.get(otherUid);
      if (pc) {
        try { if (pc._iceWatchTimer) clearTimeout(pc._iceWatchTimer); } catch {}
        try {
          pc.ontrack = null;
          pc.onicecandidate = null;
          pc.onconnectionstatechange = null;
          pc.oniceconnectionstatechange = null;
          pc.close();
        } catch {}
      }
      voicePeers.delete(otherUid);

      const audio = document.getElementById("voice_" + otherUid);
      if (audio) {
        try {
          audio.pause();
          audio.srcObject = null;
          audio.remove();
        } catch {}
      }

      setPeerDebug(otherUid, { stage: "مغلق", connection: "closed" });
    }

    function closeAllPeers() {
      Array.from(voicePeers.keys()).forEach(id => closePeer(id));
    }

    function scheduleReconnect(otherUid, delay = 1800) {
      if (!voiceActive || reconnectTimers.has(otherUid)) return;
      setPeerDebug(otherUid, { stage: "إعادة الاتصال..." });

      const timer = setTimeout(() => {
        reconnectTimers.delete(otherUid);
        if (!voiceActive) return;
        closePeer(otherUid);
        setTimeout(() => { if (voiceActive) sync(); }, 200);
      }, delay);

      reconnectTimers.set(otherUid, timer);
    }

    function watchIce(pc, otherUid) {
      if (!pc) return;
      try { if (pc._iceWatchTimer) clearTimeout(pc._iceWatchTimer); } catch {}

      pc._iceWatchTimer = setTimeout(() => {
        if (!voiceActive || !pc) return;
        const good = pc.connectionState === "connected" || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed";
        if (good) return;

        if (pc.iceConnectionState === "checking" || pc.connectionState === "connecting" || pc.connectionState === "new") {
          debugLog(`ICE عالق — إعادة ربط ${String(otherUid).slice(0, 8)}`);
          setPeerDebug(otherUid, { stage: "♻️ ICE عالق — إعادة الاتصال" });
          scheduleReconnect(otherUid, 300);
        }
      }, ICE_CHECK_TIMEOUT);
    }

    // ========================================================
    // START VOICE
    // ========================================================

    async function start() {
      if (voiceActive || voiceStarting) {
        safeToast(voiceActive ? "المايك شغال بالفعل" : "جاري فتح المايك...");
        return;
      }

      const uid = getUid?.();
      const roomCode = getRoomCode?.();
      if (!uid || !roomCode) {
        safeToast("تعذر تحديد الغرفة");
        return;
      }

      voiceStarting = true;
      publishState();
      debugLog("بدء تشغيل المايك");

      try {
        if (!window.isSecureContext) throw new Error("المايك يحتاج HTTPS");
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("المتصفح لا يدعم المايك");

        try { stopRadio?.(false); } catch {}
        try { await releaseWebAudio?.(); } catch {}
        await wait(200);

        localVoiceStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        });

        const tracks = localVoiceStream.getAudioTracks();
        if (!tracks.length) throw new Error("لم يتم العثور على مايك");
        tracks.forEach(track => track.enabled = true);

        voiceSessionId = String(uid) + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        voiceActive = true;
        voiceStarting = false;
        voiceMuted = false;
        lastHeartbeatAt = 0;

        closeAllPeers();
        await clearMyVoiceSignals();

        await update(ref(db, `rooms/${roomCode}/public/voiceUsers/${uid}`), {
          name: getName?.() || "مستخدم",
          active: true,
          muted: false,
          session: voiceSessionId,
          ts: Date.now()
        });

        publishState();

        clearInterval(voiceSyncTimer);
        voiceSyncTimer = setInterval(() => {
          if (voiceActive) sync();
        }, SYNC_MS);

        setTimeout(sync, 100);
        setTimeout(sync, 600);
        setTimeout(sync, 1500);

        safeToast("🎙️ المايك مفتوح — جاري الربط...");
      } catch (e) {
        debugError("تشغيل المايك", e);
        voiceStarting = false;
        voiceActive = false;
        voiceMuted = false;
        voiceSessionId = "";
        stopLocalTracks();
        closeAllPeers();
        publishState();

        let msg = "تعذر تشغيل المايك";
        if (e?.name === "NotAllowedError" || e?.name === "PermissionDeniedError") {
          msg = "اسمح للمايك من إعدادات المتصفح";
        }
        safeToast(msg);
      }
    }

    async function toggleMute() {
      if (!voiceActive || !localVoiceStream) {
        safeToast("شغل الصوت أولاً");
        return;
      }

      voiceMuted = !voiceMuted;
      localVoiceStream.getAudioTracks().forEach(track => { track.enabled = !voiceMuted; });

      try {
        await update(ref(db, `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`), {
          muted: voiceMuted,
          active: true,
          session: voiceSessionId,
          ts: Date.now()
        });
      } catch (e) {
        debugError("تحديث الكتم", e);
      }

      publishState();
      safeToast(voiceMuted ? "🔇 تم كتم مايكك" : "🎙️ تم فتح مايكك");
    }

    function attachRemoteAudio(otherUid, stream) {
      const box = getAudioBox();
      let audio = document.getElementById("voice_" + otherUid);
      if (!audio) {
        audio = document.createElement("audio");
        audio.id = "voice_" + otherUid;
        audio.autoplay = true;
        audio.playsInline = true;
        audio.setAttribute("playsinline", "");
        audio.setAttribute("webkit-playsinline", "");
        box.appendChild(audio);
      }

      audio.srcObject = stream;
      audio.muted = false;
      audio.volume = 1;
      setPeerDebug(otherUid, { stage: "🔊 تم استقبال الصوت" });

      try {
        const p = audio.play();
        if (p?.catch) {
          p.catch(() => { safeToast("🔊 اضغط على الشاشة لتفعيل الصوت"); });
        }
      } catch {}
    }

    // ========================================================
    // MAKE PEER (مع خوادم STUN & TURN لتجاوز حظر الشبكات)
    // ========================================================

    async function makePeer(otherUid, pairKey = "") {
      if (!otherUid || otherUid === getUid() || !localVoiceStream) return null;

      const old = voicePeers.get(otherUid);
      if (old && old.connectionState !== "closed" && old.connectionState !== "failed" && (!pairKey || old._pairKey === pairKey)) {
        return old;
      }

      if (old) closePeer(otherUid);

      const uid = getUid();
      const roomCode = getRoomCode();

      setPeerDebug(otherUid, { stage: "إنشاء Peer" });

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
          {
            urls: [
              'turn:relay.metered.ca:80',
              'turn:relay.metered.ca:443',
              'turn:relay.metered.ca:443?transport=tcp'
            ],
            username: '0c7b2c01d4a696ebf4581ed7',
            credential: 'cR8/4tG+r7Y2+gB1'
          }
        ],
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle'
      });

      pc._addedRemoteIce = new Set();
      pc._remoteUid = otherUid;
      pc._pairKey = pairKey || "";
      pc._offerAt = 0;
      pc._answerAt = 0;
      pc._iceWatchTimer = null;

      voicePeers.set(otherUid, pc);

      for (const track of localVoiceStream.getAudioTracks()) {
        try { pc.addTrack(track, localVoiceStream); } catch (e) { debugError("إضافة المايك", e); }
      }

      pc.ontrack = event => {
        let stream = event.streams?.[0];
        if (!stream) {
          stream = new MediaStream();
          try { stream.addTrack(event.track); } catch {}
        }
        attachRemoteAudio(otherUid, stream);
      };

      pc.onicecandidate = async event => {
        if (!event.candidate) return;
        try {
          const pair = pairIdFor(uid, otherUid);
          const currentPairKey = pc._pairKey;
          if (!currentPairKey) return;

          await push(
            ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/ice/${currentPairKey}/${uid}`),
            event.candidate.toJSON()
          );
        } catch (e) {
          debugError("إرسال ICE", e);
        }
      };

      pc.onconnectionstatechange = () => {
        setPeerDebug(otherUid, { connection: pc.connectionState, signaling: pc.signalingState });
        publishState();

        if (pc.connectionState === "connected") {
          if (pc._iceWatchTimer) { clearTimeout(pc._iceWatchTimer); pc._iceWatchTimer = null; }
          setPeerDebug(otherUid, { stage: "✅ متصل" });
          unlockRemoteAudios();
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          scheduleReconnect(otherUid, 1000);
        }
      };

      pc.oniceconnectionstatechange = () => {
        setPeerDebug(otherUid, { ice: pc.iceConnectionState, signaling: pc.signalingState });
        publishState();

        if (pc.iceConnectionState === "checking") {
          watchIce(pc, otherUid);
        } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          if (pc._iceWatchTimer) { clearTimeout(pc._iceWatchTimer); pc._iceWatchTimer = null; }
          setPeerDebug(otherUid, { stage: "✅ ICE متصل" });
          unlockRemoteAudios();
        } else if (pc.iceConnectionState === "failed") {
          scheduleReconnect(otherUid, 1000);
        }
      };

      return pc;
    }

    async function addRemoteIce(pc, pair, pairKey, otherUid) {
      if (!pc || !pc.remoteDescription || !pairKey) return;
      try {
        const snap = await get(ref(db, `rooms/${getRoomCode()}/public/voiceSignals/${pair}/ice/${pairKey}/${otherUid}`));
        const all = snap.val() || {};

        for (const [key, candidate] of Object.entries(all)) {
          if (pc._addedRemoteIce?.has(key)) continue;
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            pc._addedRemoteIce?.add(key);
          } catch (e) {
            debugError("إضافة Remote ICE", e);
          }
        }
      } catch (e) {
        debugError("قراءة Remote ICE", e);
      }
    }

    // ========================================================
    // SYNC & SIGNALING
    // ========================================================

    async function sync() {
      if (!voiceActive || !localVoiceStream || voiceSyncBusy) return;

      const uid = getUid?.();
      const roomCode = getRoomCode?.();
      if (!uid || !roomCode) return;

      voiceSyncBusy = true;

      try {
        await heartbeat();
        const voiceUsers = await readVoiceUsers();

        const users = Object.keys(voiceUsers).filter(otherUid => (
          otherUid !== uid &&
          voiceUsers[otherUid]?.active === true &&
          !!voiceUsers[otherUid]?.session
        ));

        voiceDebug.users = Object.keys(voiceUsers).filter(id => voiceUsers[id]?.active === true).length;
        voiceDebug.expected = users.length;
        updateDebugBox();

        for (const otherUid of Array.from(voicePeers.keys())) {
          if (!users.includes(otherUid)) {
            closePeer(otherUid);
            delete voiceDebug.peers[otherUid];
          }
        }

        for (const otherUid of users) {
          try {
            const remoteSession = String(voiceUsers[otherUid]?.session || "");
            if (!remoteSession) continue;

            const pair = pairIdFor(uid, otherUid);
            const pairKey = makePairSessionKey(uid, voiceSessionId, otherUid, remoteSession);
            const initiator = String(uid) < String(otherUid);

            let pc = voicePeers.get(otherUid);

            if (pc && pc._pairKey && pc._pairKey !== pairKey) {
              closePeer(otherUid);
              pc = null;
            }

            pc = pc || await makePeer(otherUid, pairKey);
            if (!pc) continue;

            pc._pairKey = pairKey;
            const signal = await readSignal(pair);

            // ----------------------------------------------------
            // INITIATOR LOGIC
            // ----------------------------------------------------
            if (initiator) {
              const offer = signal?.offer || null;
              const offerMatches = offer?.sdp && offer?.pairKey === pairKey && offer?.from === uid;

              if (!offerMatches && pc.signalingState === "stable") {
                setPeerDebug(otherUid, { stage: "إنشاء Offer" });

                try { await remove(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/offer`)); } catch {}
                try { await remove(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/answer`)); } catch {}

                pc._addedRemoteIce = new Set();
                const newOffer = await pc.createOffer({ offerToReceiveAudio: true, iceRestart: true });
                await pc.setLocalDescription(newOffer);

                await set(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/offer`), {
                  type: pc.localDescription.type,
                  sdp: pc.localDescription.sdp,
                  from: uid,
                  to: otherUid,
                  pairKey: pairKey,
                  ts: Date.now()
                });

                pc._offerAt = Date.now();
                setPeerDebug(otherUid, { stage: "📤 Offer مرسل" });
              }

              const answer = signal?.answer || null;
              const answerMatches = answer?.sdp && answer?.pairKey === pairKey && answer?.from === otherUid;

              if (answerMatches && !pc.currentRemoteDescription) {
                if (pc.signalingState === "have-local-offer") {
                  setPeerDebug(otherUid, { stage: "📥 Answer وصل" });
                  await pc.setRemoteDescription(new RTCSessionDescription({ type: answer.type, sdp: answer.sdp }));
                  pc._answerAt = Date.now();
                  await addRemoteIce(pc, pair, pairKey, otherUid);
                  watchIce(pc, otherUid);
                } else if (pc.signalingState === "stable") {
                  debugLog("الاتصال مستقر مسبقاً، تم تخطي Answer المعلق.");
                }
              }

              await addRemoteIce(pc, pair, pairKey, otherUid);

            // ----------------------------------------------------
            // ANSWERER LOGIC
            // ----------------------------------------------------
            } else {
              const offer = signal?.offer || null;
              const offerMatches = offer?.sdp && offer?.pairKey === pairKey && offer?.from === otherUid;

              if (!offerMatches) {
                setPeerDebug(otherUid, { stage: "⏳ بانتظار Offer" });
                continue;
              }

              if (!pc.currentRemoteDescription && pc.signalingState === "stable") {
                setPeerDebug(otherUid, { stage: "📥 Offer وصل" });
                await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }));
                await addRemoteIce(pc, pair, pairKey, otherUid);

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                await set(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/answer`), {
                  type: pc.localDescription.type,
                  sdp: pc.localDescription.sdp,
                  from: uid,
                  to: otherUid,
                  pairKey: pairKey,
                  ts: Date.now()
                });

                pc._answerAt = Date.now();
                setPeerDebug(otherUid, { stage: "📤 Answer مرسل" });
                watchIce(pc, otherUid);
              }

              await addRemoteIce(pc, pair, pairKey, otherUid);
            }

          } catch (peerError) {
            debugError(`Peer ${otherUid}`, peerError);
            setPeerDebug(otherUid, { stage: "❌ خطأ — إعادة المحاولة" });
            scheduleReconnect(otherUid, 1200);
          }
        }
      } catch (e) {
        debugError("Voice Sync", e);
      } finally {
        voiceSyncBusy = false;
        publishState();
      }
    }

    async function reconnect() {
      if (!voiceActive) return;
      debugLog("إعادة ربط يدوي");

      voiceSessionId = String(getUid()) + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      lastHeartbeatAt = 0;

      try {
        await update(ref(db, `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`), {
          session: voiceSessionId,
          active: true,
          muted: voiceMuted,
          ts: Date.now()
        });
      } catch {}

      closeAllPeers();
      setTimeout(() => { if (voiceActive) sync(); }, 250);
    }

    async function stop(removeState = true) {
      const was = voiceActive || voiceStarting;
      voiceActive = false;
      voiceStarting = false;
      voiceMuted = false;

      clearInterval(voiceSyncTimer);
      voiceSyncTimer = null;

      reconnectTimers.forEach(timer => clearTimeout(timer));
      reconnectTimers.clear();

      stopLocalTracks();
      closeAllPeers();

      const box = document.getElementById("voiceAudios");
      if (box) { try { box.innerHTML = ""; } catch {} }

      const roomCode = getRoomCode?.();
      const uid = getUid?.();

      if (removeState && roomCode && uid) {
        try { await remove(ref(db, `rooms/${roomCode}/public/voiceUsers/${uid}`)); } catch {}
        try { await clearMyVoiceSignals(); } catch {}
      }

      voiceSessionId = "";
      voiceDebug.users = 0;
      voiceDebug.expected = 0;
      voiceDebug.connected = 0;
      voiceDebug.peers = {};
      voiceDebug.lastAction = "الصوت متوقف";

      publishState();
      if (was && removeState) safeToast("تم إيقاف الصوت المباشر");
    }

    window.addEventListener("pagehide", () => {
      try { stopLocalTracks(); closeAllPeers(); } catch {}
    });

    return {
      start,
      stop,
      toggleMute,
      sync,
      reconnect,
      remoteCount: voiceRemoteCount,
      isActive,
      isStarting,
      isMuted
    };
  }

  window.SheikhVoice = { createVoiceController };

})();
