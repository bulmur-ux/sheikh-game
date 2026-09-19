// ============================================================
// شيك شيك - نظام الصوت المستقل
// Voice v6.3
// Stable Offer/Answer + offerId + Session ICE + Diagnostics
// ============================================================

(function () {
  "use strict";

  function createVoiceController(o) {
    const {
      db, ref, get, set, update, push, remove,
      getRoomCode, getUid, getName, getCurrentRoom,
      toast, sleep, releaseWebAudio, stopRadio,
      onStateChange, onUiRefresh
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
    let lastHeartbeatAt = 0;

    const voicePeers = new Map();
    const reconnectTimers = new Map();

    let audioUnlockInstalled = false;

    // ========================================================
    // SETTINGS
    // ========================================================

    const VOICE_VERSION = "6.3";
    const VOICE_DEBUG = true;

    const SYNC_MS = 1200;
    const HEARTBEAT_MS = 5000;
    const ICE_CHECK_TIMEOUT = 12000;
    const OFFER_TIMEOUT = 12000;

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
        console.log(
          "%c[VOICE]",
          "color:#00d084;font-weight:bold",
          message,
          data || ""
        );
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
        voiceDebug.peers[uid] = {
          connection: "-",
          ice: "-",
          signaling: "-",
          stage: "انتظار"
        };
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
        position:fixed;
        left:8px;
        bottom:8px;
        z-index:999999;
        width:min(92vw,360px);
        max-height:42vh;
        overflow:auto;
        padding:10px;
        border-radius:12px;
        background:rgba(0,0,0,.88);
        color:#fff;
        border:1px solid rgba(255,255,255,.25);
        font-family:Arial,sans-serif;
        font-size:12px;
        line-height:1.65;
        text-align:right;
        direction:rtl;
      `;

      document.body.appendChild(box);
      return box;
    }

    function updateDebugBox() {
      if (!VOICE_DEBUG) return;

      const box = getDebugBox();
      if (!box) return;

      const peerLines = Object.entries(voiceDebug.peers)
        .map(([uid, p]) => {
          const shortUid = String(uid).slice(0, 8);

          return `
            <div style="
              margin-top:6px;
              padding-top:6px;
              border-top:1px solid #444;
            ">
              👤 ${shortUid}<br>
              المرحلة: ${p.stage || "-"}<br>
              WebRTC: ${p.connection || "-"}<br>
              ICE: ${p.ice || "-"}<br>
              Signal: ${p.signaling || "-"}
            </div>
          `;
        })
        .join("");

      box.innerHTML = `
        <div style="
          font-weight:bold;
          color:#ffd54a;
          margin-bottom:4px;
        ">
          🛠 تشخيص الصوت المؤقت — v${VOICE_VERSION}
        </div>

        الصوت: ${voiceActive ? "شغال" : "متوقف"}
        ${voiceMuted ? "🔇" : "🎙️"}<br>

        الموجودون بالصوت: ${voiceDebug.users}<br>
        المطلوب الاتصال بهم: ${voiceDebug.expected}<br>

        المتصل فعلياً:
        ${voiceRemoteCount()} / ${voiceDebug.expected}<br>

        آخر خطوة: ${voiceDebug.lastAction || "-"}<br>

        ${
          voiceDebug.lastError
            ? `<span style="color:#ff8080">
                 آخر خطأ: ${voiceDebug.lastError}
               </span><br>`
            : ""
        }

        ${peerLines}
      `;
    }

    // ========================================================
    // HELPERS
    // ========================================================

    function safeToast(message) {
      try {
        toast?.(message);
      } catch {}
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

      try {
        onUiRefresh?.();
      } catch {}

      voiceDebug.connected = voiceRemoteCount();
      updateDebugBox();
    }

    function pairIdFor(a, b) {
      return [String(a), String(b)].sort().join("__");
    }

    function makePairSessionKey(uid, mySession, otherUid, otherSession) {
      const arr = [
        {
          uid: String(uid),
          session: String(mySession || "")
        },
        {
          uid: String(otherUid),
          session: String(otherSession || "")
        }
      ].sort((a, b) => a.uid.localeCompare(b.uid));

      return arr[0].session + "__PAIR__" + arr[1].session;
    }

    function makeOfferId(uid, otherUid) {
      return (
        String(uid).slice(0, 8) +
        "_" +
        String(otherUid).slice(0, 8) +
        "_" +
        Date.now() +
        "_" +
        Math.random().toString(36).slice(2, 10)
      );
    }

    function voiceRemoteCount() {
      let n = 0;

      for (const pc of voicePeers.values()) {
        if (
          pc &&
          (
            pc.connectionState === "connected" ||
            pc.iceConnectionState === "connected" ||
            pc.iceConnectionState === "completed"
          )
        ) {
          n++;
        }
      }

      return n;
    }

    function isActive() {
      return voiceActive;
    }

    function isStarting() {
      return voiceStarting;
    }

    function isMuted() {
      return voiceMuted;
    }

    // ========================================================
    // AUDIO BOX
    // ========================================================

    function getAudioBox() {
      let box = document.getElementById("voiceAudios");

      if (!box) {
        box = document.createElement("div");
        box.id = "voiceAudios";

        box.style.cssText =
          "position:fixed;" +
          "width:1px;" +
          "height:1px;" +
          "overflow:hidden;" +
          "opacity:0;" +
          "pointer-events:none;";

        document.body.appendChild(box);
      }

      return box;
    }

    // ========================================================
    // IOS AUDIO UNLOCK
    // ========================================================

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

      const unlock = () => {
        unlockRemoteAudios();
      };

      document.addEventListener("touchstart", unlock, { passive: true });
      document.addEventListener("pointerdown", unlock, { passive: true });
      document.addEventListener("click", unlock, { passive: true });
    }

    installAudioUnlock();

    // ========================================================
    // FIREBASE READ
    // ========================================================

    async function readVoiceUsers() {
      try {
        const roomCode = getRoomCode?.();
        if (!roomCode) return {};

        const snap = await get(
          ref(db, `rooms/${roomCode}/public/voiceUsers`)
        );

        const users = snap.val() || {};
        debugLog("تم تحديث مستخدمي الصوت");

        return users;
      } catch (e) {
        debugError("قراءة voiceUsers", e);

        try {
          return getCurrentRoom?.()?.voiceUsers || {};
        } catch {
          return {};
        }
      }
    }

    async function readSignal(pair) {
      try {
        const roomCode = getRoomCode?.();
        if (!roomCode) return {};

        const snap = await get(
          ref(
            db,
            `rooms/${roomCode}/public/voiceSignals/${pair}`
          )
        );

        return snap.val() || {};
      } catch (e) {
        debugError("قراءة Signal", e);
        return {};
      }
    }

    // ========================================================
    // HEARTBEAT
    // ========================================================

    async function heartbeat() {
      if (!voiceActive) return;

      const now = Date.now();

      if (now - lastHeartbeatAt < HEARTBEAT_MS) {
        return;
      }

      lastHeartbeatAt = now;

      try {
        await update(
          ref(
            db,
            `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`
          ),
          {
            active: true,
            muted: voiceMuted,
            session: voiceSessionId,
            ts: now
          }
        );
      } catch (e) {
        debugError("Heartbeat", e);
      }
    }

    // ========================================================
    // CLEAN OLD SIGNALS
    // ========================================================

    async function clearMyVoiceSignals() {
      try {
        const uid = getUid?.();
        const roomCode = getRoomCode?.();

        if (!uid || !roomCode) return;

        const voiceUsers = await readVoiceUsers();

        const users = Object.keys(voiceUsers)
          .filter(id => id !== uid);

        for (const otherUid of users) {
          if (String(uid) < String(otherUid)) {
            try {
              await remove(
                ref(
                  db,
                  `rooms/${roomCode}/public/voiceSignals/${pairIdFor(uid, otherUid)}`
                )
              );
            } catch {}
          }
        }

        debugLog("تم تنظيف الإشارات القديمة");
      } catch (e) {
        debugError("تنظيف الإشارات", e);
      }
    }

    // ========================================================
    // LOCAL MIC
    // ========================================================

    function stopLocalTracks() {
      if (!localVoiceStream) return;

      try {
        localVoiceStream.getTracks().forEach(track => {
          try {
            track.stop();
          } catch {}
        });
      } catch {}

      localVoiceStream = null;
    }

    // ========================================================
    // PEER CLEANUP
    // ========================================================

    function closePeer(otherUid) {
      const timer = reconnectTimers.get(otherUid);

      if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(otherUid);
      }

      const pc = voicePeers.get(otherUid);

      if (pc) {
        try {
          if (pc._iceWatchTimer) {
            clearTimeout(pc._iceWatchTimer);
          }
        } catch {}

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

      setPeerDebug(otherUid, {
        stage: "مغلق",
        connection: "closed"
      });
    }

    function closeAllPeers() {
      const ids = Array.from(voicePeers.keys());
      ids.forEach(id => closePeer(id));
    }

    // ========================================================
    // RECONNECT
    // ========================================================

    function scheduleReconnect(otherUid, delay = 1800) {
      if (
        !voiceActive ||
        reconnectTimers.has(otherUid)
      ) {
        return;
      }

      setPeerDebug(otherUid, {
        stage: "إعادة الاتصال..."
      });

      const timer = setTimeout(() => {
        reconnectTimers.delete(otherUid);

        if (!voiceActive) return;

        closePeer(otherUid);

        setTimeout(() => {
          if (voiceActive) sync();
        }, 200);
      }, delay);

      reconnectTimers.set(otherUid, timer);
    }

    function watchIce(pc, otherUid) {
      if (!pc) return;

      try {
        if (pc._iceWatchTimer) {
          clearTimeout(pc._iceWatchTimer);
        }
      } catch {}

      pc._iceWatchTimer = setTimeout(() => {
        if (!voiceActive || !pc) return;

        const good =
          pc.connectionState === "connected" ||
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed";

        if (good) return;

        if (
          pc.iceConnectionState === "checking" ||
          pc.connectionState === "connecting" ||
          pc.connectionState === "new"
        ) {
          debugLog(
            `ICE عالق — إعادة ربط ${String(otherUid).slice(0, 8)}`
          );

          setPeerDebug(otherUid, {
            stage: "♻️ ICE عالق — إعادة الاتصال"
          });

          scheduleReconnect(otherUid, 300);
        }
      }, ICE_CHECK_TIMEOUT);
    }

    // ========================================================
    // START
    // ========================================================

    async function start() {
      if (voiceActive || voiceStarting) {
        safeToast(
          voiceActive
            ? "المايك شغال بالفعل"
            : "جاري فتح المايك..."
        );
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
        if (!window.isSecureContext) {
          throw new Error("المايك يحتاج HTTPS");
        }

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("المتصفح لا يدعم المايك");
        }

        try {
          stopRadio?.(false);
        } catch {}

        try {
          await releaseWebAudio?.();
        } catch {}

        await wait(200);

        debugLog("طلب صلاحية المايك");

        localVoiceStream =
          await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            },
            video: false
          });

        const tracks = localVoiceStream.getAudioTracks();

        if (!tracks.length) {
          throw new Error("لم يتم العثور على مايك");
        }

        tracks.forEach(track => {
          track.enabled = true;
        });

        voiceSessionId =
          String(uid) +
          "_" +
          Date.now() +
          "_" +
          Math.random().toString(36).slice(2, 8);

        voiceActive = true;
        voiceStarting = false;
        voiceMuted = false;

        lastHeartbeatAt = 0;

        closeAllPeers();

        await clearMyVoiceSignals();

        await update(
          ref(
            db,
            `rooms/${roomCode}/public/voiceUsers/${uid}`
          ),
          {
            name: getName?.() || "مستخدم",
            active: true,
            muted: false,
            session: voiceSessionId,
            ts: Date.now()
          }
        );

        debugLog("تم تسجيل المستخدم في قناة الصوت");

        publishState();

        clearInterval(voiceSyncTimer);

        voiceSyncTimer = setInterval(() => {
          if (voiceActive) sync();
        }, SYNC_MS);

        setTimeout(sync, 100);
        setTimeout(sync, 600);
        setTimeout(sync, 1500);
        setTimeout(sync, 3000);

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

        if (
          e?.name === "NotAllowedError" ||
          e?.name === "PermissionDeniedError"
        ) {
          msg = "اسمح للمايك من إعدادات Safari";
        }

        safeToast(msg);
      }
    }

    // ========================================================
    // MUTE
    // ========================================================

    async function toggleMute() {
      if (!voiceActive || !localVoiceStream) {
        safeToast("شغل الصوت أولاً");
        return;
      }

      voiceMuted = !voiceMuted;

      localVoiceStream.getAudioTracks().forEach(track => {
        track.enabled = !voiceMuted;
      });

      try {
        await update(
          ref(
            db,
            `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`
          ),
          {
            muted: voiceMuted,
            active: true,
            session: voiceSessionId,
            ts: Date.now()
          }
        );
      } catch (e) {
        debugError("تحديث الكتم", e);
      }

      publishState();

      safeToast(
        voiceMuted
          ? "🔇 تم كتم مايكك — ما زلت تسمع الآخرين"
          : "🎙️ تم فتح مايكك"
      );
    }

    // ========================================================
    // REMOTE AUDIO
    // ========================================================

    function attachRemoteAudio(otherUid, stream) {
      const box = getAudioBox();

      let audio =
        document.getElementById("voice_" + otherUid);

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

      debugLog("وصل صوت الطرف الآخر");

      setPeerDebug(otherUid, {
        stage: "🔊 تم استقبال الصوت"
      });

      try {
        const p = audio.play();

        if (p?.catch) {
          p.catch(e => {
            debugError(
              "Safari منع تشغيل الصوت",
              e
            );

            safeToast(
              "🔊 اضغط على الشاشة مرة لتفعيل الصوت"
            );
          });
        }
      } catch {}
    }

    // ========================================================
    // MAKE PEER
    // ========================================================

    async function makePeer(otherUid, pairKey = "") {
      if (
        !otherUid ||
        otherUid === getUid() ||
        !localVoiceStream
      ) {
        return null;
      }

      const old = voicePeers.get(otherUid);

      if (
        old &&
        old.connectionState !== "closed" &&
        old.connectionState !== "failed" &&
        (
          !pairKey ||
          !old._pairKey ||
          old._pairKey === pairKey
        )
      ) {
        return old;
      }

      if (old) {
        closePeer(otherUid);
      }

      const uid = getUid();
      const roomCode = getRoomCode();

      debugLog("إنشاء WebRTC Peer");

      setPeerDebug(otherUid, {
        stage: "إنشاء Peer"
      });

      const pc = new RTCPeerConnection({
        iceServers: [
          {
            urls: [
              "stun:stun.l.google.com:19302",
              "stun:stun1.l.google.com:19302",
              "stun:stun.cloudflare.com:3478"
            ]
          },
          {
            urls: [
              "turn:openrelay.metered.ca:80",
              "turn:openrelay.metered.ca:443",
              "turn:openrelay.metered.ca:443?transport=tcp"
            ],
            username: "openrelayproject",
            credential: "openrelayproject"
          }
        ],

        iceCandidatePoolSize: 6,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require"
      });

      pc._addedRemoteIce = new Set();
      pc._remoteUid = otherUid;
      pc._createdAt = Date.now();
      pc._pairKey = pairKey || "";

      // v6.3
      pc._offerAt = 0;
      pc._answerAt = 0;
      pc._offerId = "";
      pc._answerOfferId = "";
      pc._makingOffer = false;
      pc._settingRemoteAnswer = false;
      pc._iceWatchTimer = null;

      voicePeers.set(otherUid, pc);

      for (const track of localVoiceStream.getAudioTracks()) {
        try {
          pc.addTrack(track, localVoiceStream);
        } catch (e) {
          debugError("إضافة المايك إلى Peer", e);
        }
      }

      pc.ontrack = event => {
        let stream = event.streams?.[0];

        if (!stream) {
          stream = new MediaStream();

          try {
            stream.addTrack(event.track);
          } catch {}
        }

        attachRemoteAudio(otherUid, stream);
      };

      pc.onicecandidate = async event => {
        if (!event.candidate) return;

        try {
          const candidate = event.candidate;

          let type = candidate.type || "";

          if (!type && candidate.candidate) {
            const m =
              candidate.candidate.match(/ typ ([a-z]+)/i);

            type = m?.[1] || "";
          }

          setPeerDebug(otherUid, {
            stage:
              type === "relay"
                ? "TURN relay جاهز"
                : `ICE ${type || "candidate"}`
          });

          const pair =
            pairIdFor(uid, otherUid);

          const currentPairKey =
            pc._pairKey;

          if (!currentPairKey) return;

          await set(
            push(
              ref(
                db,
                `rooms/${roomCode}/public/voiceSignals/${pair}/ice/${currentPairKey}/${uid}`
              )
            ),
            candidate.toJSON()
          );
        } catch (e) {
          debugError("إرسال ICE", e);
        }
      };

      pc.onconnectionstatechange = () => {
        setPeerDebug(otherUid, {
          connection: pc.connectionState,
          signaling: pc.signalingState
        });

        publishState();

        if (pc.connectionState === "connected") {
          if (pc._iceWatchTimer) {
            clearTimeout(pc._iceWatchTimer);
            pc._iceWatchTimer = null;
          }

          debugLog("WebRTC متصل");

          setPeerDebug(otherUid, {
            stage: "✅ متصل"
          });

          unlockRemoteAudios();
          return;
        }

        if (pc.connectionState === "failed") {
          debugLog("WebRTC فشل — إعادة محاولة");
          scheduleReconnect(otherUid, 700);
          return;
        }

        if (pc.connectionState === "disconnected") {
          debugLog("انقطاع مؤقت");
          scheduleReconnect(otherUid, 4000);
        }
      };

      pc.oniceconnectionstatechange = () => {
        setPeerDebug(otherUid, {
          ice: pc.iceConnectionState,
          signaling: pc.signalingState
        });

        publishState();

        if (pc.iceConnectionState === "checking") {
          setPeerDebug(otherUid, {
            stage: "🔄 ICE checking"
          });

          watchIce(pc, otherUid);
        }

        if (
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
        ) {
          if (pc._iceWatchTimer) {
            clearTimeout(pc._iceWatchTimer);
            pc._iceWatchTimer = null;
          }

          setPeerDebug(otherUid, {
            stage: "✅ ICE متصل"
          });

          unlockRemoteAudios();
        }

        if (pc.iceConnectionState === "failed") {
          debugLog("ICE failed");
          scheduleReconnect(otherUid, 700);
        }

        if (pc.iceConnectionState === "disconnected") {
          scheduleReconnect(otherUid, 4000);
        }
      };

      return pc;
    }

    // ========================================================
    // REMOTE ICE
    // ========================================================

    async function addRemoteIce(
      pc,
      pair,
      pairKey,
      otherUid
    ) {
      if (
        !pc ||
        !pc.remoteDescription ||
        !pairKey
      ) {
        return;
      }

      try {
        const snap = await get(
          ref(
            db,
            `rooms/${getRoomCode()}/public/voiceSignals/${pair}/ice/${pairKey}/${otherUid}`
          )
        );

        const all = snap.val() || {};

        for (const [key, candidate] of Object.entries(all)) {
          if (pc._addedRemoteIce?.has(key)) {
            continue;
          }

          try {
            await pc.addIceCandidate(
              new RTCIceCandidate(candidate)
            );

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
    // SYNC
    // ========================================================

    async function sync() {
      if (
        !voiceActive ||
        !localVoiceStream ||
        voiceSyncBusy
      ) {
        return;
      }

      const uid = getUid?.();
      const roomCode = getRoomCode?.();

      if (!uid || !roomCode) return;

      voiceSyncBusy = true;

      try {
        await heartbeat();

        const voiceUsers =
          await readVoiceUsers();

        const users =
          Object.keys(voiceUsers)
            .filter(otherUid => (
              otherUid !== uid &&
              voiceUsers[otherUid]?.active === true &&
              !!voiceUsers[otherUid]?.session
            ));

        voiceDebug.users =
          Object.keys(voiceUsers)
            .filter(id =>
              voiceUsers[id]?.active === true
            ).length;

        voiceDebug.expected = users.length;
        updateDebugBox();

        // إزالة أي Peer للاعب خرج
        for (const otherUid of Array.from(voicePeers.keys())) {
          if (!users.includes(otherUid)) {
            closePeer(otherUid);
            delete voiceDebug.peers[otherUid];
          }
        }

        for (const otherUid of users) {
          try {
            const remoteSession =
              String(
                voiceUsers[otherUid]?.session || ""
              );

            if (!remoteSession) continue;

            const pair =
              pairIdFor(uid, otherUid);

            const pairKey =
              makePairSessionKey(
                uid,
                voiceSessionId,
                otherUid,
                remoteSession
              );

            const initiator =
              String(uid) < String(otherUid);

            let pc =
              voicePeers.get(otherUid);

            if (
              pc &&
              pc._pairKey &&
              pc._pairKey !== pairKey
            ) {
              debugLog(
                `تغيرت جلسة ${String(otherUid).slice(0, 8)}`
              );

              closePeer(otherUid);
              pc = null;
            }

            pc =
              pc ||
              await makePeer(
                otherUid,
                pairKey
              );

            if (!pc) continue;

            pc._pairKey = pairKey;

            let signal =
              await readSignal(pair);

            // =================================================
            // INITIATOR
            // =================================================

            if (initiator) {
              const offer =
                signal?.offer || null;

              const offerMatches =
                offer?.sdp &&
                offer?.pairKey === pairKey &&
                offer?.from === uid &&
                offer?.to === otherUid &&
                offer?.fromSession === voiceSessionId &&
                offer?.toSession === remoteSession &&
                !!offer?.offerId;

              /*
               * v6.3:
               * لا ننشئ Offer جديد إذا:
               * - Peer يصنع Offer الآن
               * - عندنا Offer محلي قائم
               * - signaling ليست stable
               */
              const canCreateOffer =
                !pc._makingOffer &&
                pc.signalingState === "stable" &&
                !pc.localDescription;

              if (
                !offerMatches &&
                canCreateOffer
              ) {
                pc._makingOffer = true;

                try {
                  debugLog(
                    `إنشاء Offer ${String(otherUid).slice(0, 8)}`
                  );

                  setPeerDebug(otherUid, {
                    stage: "إنشاء Offer"
                  });

                  // نمسح العرض/الجواب القديم فقط
                  try {
                    await remove(
                      ref(
                        db,
                        `rooms/${roomCode}/public/voiceSignals/${pair}/offer`
                      )
                    );
                  } catch {}

                  try {
                    await remove(
                      ref(
                        db,
                        `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                      )
                    );
                  } catch {}

                  pc._addedRemoteIce = new Set();

                  const offerId =
                    makeOfferId(uid, otherUid);

                  pc._offerId = offerId;
                  pc._answerOfferId = "";

                  const newOffer =
                    await pc.createOffer({
                      offerToReceiveAudio: true,
                      iceRestart: true
                    });

                  /*
                   * تأكيد أن الـPeer ما تبدل أثناء await
                   */
                  if (
                    !voiceActive ||
                    voicePeers.get(otherUid) !== pc ||
                    pc.signalingState !== "stable"
                  ) {
                    debugLog(
                      `تم إلغاء Offer قديم ${String(otherUid).slice(0, 8)}`
                    );
                    continue;
                  }

                  await pc.setLocalDescription(newOffer);

                  await set(
                    ref(
                      db,
                      `rooms/${roomCode}/public/voiceSignals/${pair}/offer`
                    ),
                    {
                      type: pc.localDescription.type,
                      sdp: pc.localDescription.sdp,

                      from: uid,
                      to: otherUid,

                      fromSession: voiceSessionId,
                      toSession: remoteSession,

                      pairKey,
                      offerId,

                      ts: Date.now()
                    }
                  );

                  pc._offerAt = Date.now();

                  setPeerDebug(otherUid, {
                    stage: "📤 Offer مرسل"
                  });

                  debugLog(
                    `Offer مرسل ${String(otherUid).slice(0, 8)}`
                  );

                  signal =
                    await readSignal(pair);

                } finally {
                  pc._makingOffer = false;
                }
              }

              // -------------------------------------------------
              // ANSWER
              // -------------------------------------------------

              let answer =
                signal?.answer || null;

              if (!answer?.sdp) {
                try {
                  const answerSnap =
                    await get(
                      ref(
                        db,
                        `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                      )
                    );

                  answer = answerSnap.val();
                } catch {}
              }

              const answerMatches =
                answer?.sdp &&
                answer?.pairKey === pairKey &&
                answer?.from === otherUid &&
                answer?.to === uid &&
                answer?.fromSession === remoteSession &&
                answer?.toSession === voiceSessionId &&
                !!answer?.offerId &&
                answer.offerId === pc._offerId;

              if (answerMatches) {
                /*
                 * أهم إصلاح في v6.3:
                 *
                 * Answer لا يقبل إلا إذا Peer ينتظر Answer فعلاً.
                 * هذا يمنع:
                 * Called in wrong state: stable
                 */
                if (
                  pc.signalingState === "have-local-offer" &&
                  !pc.currentRemoteDescription &&
                  !pc._settingRemoteAnswer &&
                  pc._answerOfferId !== answer.offerId
                ) {
                  pc._settingRemoteAnswer = true;

                  try {
                    debugLog(
                      `Answer صحيح وصل ${String(otherUid).slice(0, 8)}`
                    );

                    setPeerDebug(otherUid, {
                      stage: "📥 Answer صحيح"
                    });

                    /*
                     * نتحقق مرة ثانية مباشرة قبل
                     * setRemoteDescription
                     */
                    if (
                      pc.signalingState !== "have-local-offer"
                    ) {
                      debugLog(
                        `تم تجاهل Answer — الحالة ${pc.signalingState}`
                      );
                    } else {
                      await pc.setRemoteDescription(
                        new RTCSessionDescription({
                          type: answer.type,
                          sdp: answer.sdp
                        })
                      );

                      pc._answerAt = Date.now();
                      pc._answerOfferId =
                        answer.offerId;

                      debugLog(
                        `تم تثبيت Answer ${String(otherUid).slice(0, 8)}`
                      );

                      setPeerDebug(otherUid, {
                        stage: "✅ Answer مثبت"
                      });

                      await addRemoteIce(
                        pc,
                        pair,
                        pairKey,
                        otherUid
                      );

                      watchIce(
                        pc,
                        otherUid
                      );
                    }
                  } catch (e) {
                    /*
                     * إذا تغيرت الحالة خلال await
                     * لا نكسر النظام.
                     */
                    if (
                      String(e?.message || "")
                        .includes("wrong state")
                    ) {
                      debugLog(
                        `تم تجاهل Answer مكرر/قديم ${String(otherUid).slice(0, 8)}`
                      );

                      setPeerDebug(otherUid, {
                        stage:
                          "↩️ تم تجاهل Answer قديم"
                      });
                    } else {
                      throw e;
                    }
                  } finally {
                    pc._settingRemoteAnswer = false;
                  }
                } else if (
                  pc._answerOfferId === answer.offerId ||
                  pc.signalingState === "stable"
                ) {
                  /*
                   * Answer سبق تطبيقه.
                   * لا نحاول تطبيقه مرة ثانية.
                   */
                  setPeerDebug(otherUid, {
                    stage:
                      pc.connectionState === "connected"
                        ? "✅ متصل"
                        : "⏳ Answer مثبت — انتظار ICE"
                  });
                }
              } else if (
                answer?.sdp &&
                answer?.offerId &&
                pc._offerId &&
                answer.offerId !== pc._offerId
              ) {
                debugLog(
                  `تجاهل Answer قديم ${String(otherUid).slice(0, 8)}`
                );

                setPeerDebug(otherUid, {
                  stage: "↩️ تجاهل Answer قديم"
                });
              }

              await addRemoteIce(
                pc,
                pair,
                pairKey,
                otherUid
              );

              /*
               * إذا أرسلنا Offer ولم يصل Answer صالح
               * خلال المهلة، نعيد Peer كامل.
               */
              if (
                pc._offerAt &&
                !pc.currentRemoteDescription &&
                Date.now() - pc._offerAt > OFFER_TIMEOUT
              ) {
                setPeerDebug(otherUid, {
                  stage:
                    "♻️ Answer تأخر — إعادة المحاولة"
                });

                debugLog(
                  `Answer تأخر ${String(otherUid).slice(0, 8)}`
                );

                try {
                  const currentOffer =
                    (
                      await get(
                        ref(
                          db,
                          `rooms/${roomCode}/public/voiceSignals/${pair}/offer`
                        )
                      )
                    ).val();

                  /*
                   * لا نحذف Offer جديد أنشأته محاولة أحدث.
                   */
                  if (
                    !currentOffer?.offerId ||
                    currentOffer.offerId === pc._offerId
                  ) {
                    await remove(
                      ref(
                        db,
                        `rooms/${roomCode}/public/voiceSignals/${pair}/offer`
                      )
                    );
                  }
                } catch {}

                try {
                  const currentAnswer =
                    (
                      await get(
                        ref(
                          db,
                          `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                        )
                      )
                    ).val();

                  if (
                    !currentAnswer?.offerId ||
                    currentAnswer.offerId === pc._offerId
                  ) {
                    await remove(
                      ref(
                        db,
                        `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                      )
                    );
                  }
                } catch {}

                closePeer(otherUid);
                continue;
              }

            // =================================================
            // ANSWERER
            // =================================================

            } else {
              let offer =
                signal?.offer || null;

              if (!offer?.sdp) {
                const offerSnap =
                  await get(
                    ref(
                      db,
                      `rooms/${roomCode}/public/voiceSignals/${pair}/offer`
                    )
                  );

                offer = offerSnap.val();
              }

              const offerMatches =
                offer?.sdp &&
                offer?.pairKey === pairKey &&
                offer?.from === otherUid &&
                offer?.to === uid &&
                offer?.fromSession === remoteSession &&
                offer?.toSession === voiceSessionId &&
                !!offer?.offerId;

              if (!offerMatches) {
                setPeerDebug(otherUid, {
                  stage: "⏳ بانتظار Offer جديد"
                });

                continue;
              }

              /*
               * إذا سبق لنا الرد على نفس offerId
               * لا ننشئ Answer جديد.
               */
              const alreadyAnswered =
                pc._answerOfferId === offer.offerId;

              if (
                !alreadyAnswered &&
                !pc.currentRemoteDescription &&
                pc.signalingState === "stable"
              ) {
                debugLog(
                  `Offer وصل ${String(otherUid).slice(0, 8)}`
                );

                setPeerDebug(otherUid, {
                  stage: "📥 Offer وصل"
                });

                /*
                 * تسجيل offerId قبل عمليات await.
                 */
                pc._offerId = offer.offerId;

                await pc.setRemoteDescription(
                  new RTCSessionDescription({
                    type: offer.type,
                    sdp: offer.sdp
                  })
                );

                await addRemoteIce(
                  pc,
                  pair,
                  pairKey,
                  otherUid
                );

                /*
                 * بعد setRemoteDescription(offer)
                 * المفروض الحالة have-remote-offer.
                 */
                if (
                  pc.signalingState !==
                  "have-remote-offer"
                ) {
                  debugLog(
                    `Offer تغيرت حالته قبل Answer: ${pc.signalingState}`
                  );

                  continue;
                }

                const answer =
                  await pc.createAnswer();

                await pc.setLocalDescription(
                  answer
                );

                await set(
                  ref(
                    db,
                    `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                  ),
                  {
                    type:
                      pc.localDescription.type,

                    sdp:
                      pc.localDescription.sdp,

                    from:
                      uid,

                    to:
                      otherUid,

                    fromSession:
                      voiceSessionId,

                    toSession:
                      remoteSession,

                    pairKey,

                    /*
                     * أهم نقطة:
                     * Answer مربوط بنفس Offer.
                     */
                    offerId:
                      offer.offerId,

                    ts:
                      Date.now()
                  }
                );

                pc._answerAt =
                  Date.now();

                pc._answerOfferId =
                  offer.offerId;

                setPeerDebug(otherUid, {
                  stage: "📤 Answer مرسل"
                });

                debugLog(
                  `Answer مرسل ${String(otherUid).slice(0, 8)}`
                );

                watchIce(
                  pc,
                  otherUid
                );
              }

              /*
               * لو نفس Offer سبق الرد عليه
               * نبقي Peer الحالي ولا نعيد Answer.
               */
              if (alreadyAnswered) {
                setPeerDebug(otherUid, {
                  stage:
                    pc.connectionState === "connected"
                      ? "✅ متصل"
                      : "⏳ Answer مرسل — انتظار ICE"
                });
              }

              await addRemoteIce(
                pc,
                pair,
                pairKey,
                otherUid
              );
            }

            setPeerDebug(otherUid, {
              connection:
                pc.connectionState || "-",

              ice:
                pc.iceConnectionState || "-",

              signaling:
                pc.signalingState || "-"
            });

          } catch (peerError) {
            debugError(
              `Peer ${otherUid}`,
              peerError
            );

            setPeerDebug(otherUid, {
              stage: "❌ خطأ — إعادة المحاولة"
            });

            scheduleReconnect(
              otherUid,
              1200
            );
          }
        }

      } catch (e) {
        debugError("Voice Sync", e);
      } finally {
        voiceSyncBusy = false;
        publishState();
      }
    }

    // ========================================================
    // MANUAL RECONNECT
    // ========================================================

    async function reconnect() {
      if (!voiceActive) return;

      debugLog("إعادة ربط يدوي");

      voiceSessionId =
        String(getUid()) +
        "_" +
        Date.now() +
        "_" +
        Math.random()
          .toString(36)
          .slice(2, 8);

      lastHeartbeatAt = 0;

      try {
        await update(
          ref(
            db,
            `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`
          ),
          {
            session: voiceSessionId,
            active: true,
            muted: voiceMuted,
            ts: Date.now()
          }
        );
      } catch {}

      closeAllPeers();

      setTimeout(() => {
        if (voiceActive) sync();
      }, 250);
    }

    // ========================================================
    // STOP
    // ========================================================

    async function stop(removeState = true) {
      const was =
        voiceActive ||
        voiceStarting;

      voiceActive = false;
      voiceStarting = false;
      voiceMuted = false;

      clearInterval(voiceSyncTimer);
      voiceSyncTimer = null;

      for (const timer of reconnectTimers.values()) {
        clearTimeout(timer);
      }

      reconnectTimers.clear();

      stopLocalTracks();
      closeAllPeers();

      const box =
        document.getElementById("voiceAudios");

      if (box) {
        try {
          box.innerHTML = "";
        } catch {}
      }

      const roomCode = getRoomCode?.();
      const uid = getUid?.();

      if (
        removeState &&
        roomCode &&
        uid
      ) {
        try {
          await remove(
            ref(
              db,
              `rooms/${roomCode}/public/voiceUsers/${uid}`
            )
          );
        } catch {}

        try {
          await clearMyVoiceSignals();
        } catch {}
      }

      voiceSessionId = "";

      voiceDebug.users = 0;
      voiceDebug.expected = 0;
      voiceDebug.connected = 0;
      voiceDebug.peers = {};
      voiceDebug.lastAction = "الصوت متوقف";
      voiceDebug.lastError = "";

      publishState();

      if (was && removeState) {
        safeToast("تم إيقاف الصوت المباشر");
      }
    }

    // ========================================================
    // PAGE CLEANUP
    // ========================================================

    window.addEventListener(
      "pagehide",
      () => {
        try {
          stopLocalTracks();
          closeAllPeers();
        } catch {}
      }
    );

    // ========================================================
    // PUBLIC API
    // متوافق مع index الحالي
    // ========================================================

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

  window.SheikhVoice = {
    createVoiceController
  };

})();
