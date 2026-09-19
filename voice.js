// ============================================================
// شيك شيك - نظام الصوت المستقل
// Stable Voice + Firebase Signaling + Diagnostics
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
    // DIAGNOSTICS
    // ========================================================

    const VOICE_DEBUG = true;

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

      const raw =
        String(
          error?.message ||
          error ||
          ""
        );

      console.warn(
        "[VOICE ERROR]",
        message,
        error
      );

      voiceDebug.lastError =
        `${message}: ${raw}`;

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

      Object.assign(
        voiceDebug.peers[uid],
        patch || {}
      );

      updateDebugBox();
    }


    function getDebugBox() {

      if (!VOICE_DEBUG) return null;

      let box =
        document.getElementById(
          "voiceDebugBox"
        );

      if (box) return box;


      box =
        document.createElement("div");

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


      const peerLines =
        Object.entries(
          voiceDebug.peers
        )
        .map(([uid, p]) => {

          const shortUid =
            String(uid).slice(0, 8);

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
          🛠 تشخيص الصوت المؤقت
        </div>

        الصوت:
        ${voiceActive ? "شغال" : "متوقف"}
        ${voiceMuted ? "🔇" : "🎙️"}
        <br>

        الموجودون بالصوت:
        ${voiceDebug.users}
        <br>

        المطلوب الاتصال بهم:
        ${voiceDebug.expected}
        <br>

        المتصل فعلياً:
        ${voiceRemoteCount()}
        /
        ${voiceDebug.expected}
        <br>

        آخر خطوة:
        ${voiceDebug.lastAction || "-"}
        <br>

        ${
          voiceDebug.lastError
            ? `<span style="color:#ff8080">
                 آخر خطأ:
                 ${voiceDebug.lastError}
               </span><br>`
            : ""
        }

        ${peerLines}
      `;

    }


    // ========================================================
    // BASIC HELPERS
    // ========================================================

    function safeToast(message) {

      try {
        toast?.(message);
      } catch {}

    }


    function wait(ms) {

      if (sleep) {
        return sleep(ms);
      }

      return new Promise(
        resolve =>
          setTimeout(resolve, ms)
      );

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


      voiceDebug.connected =
        voiceRemoteCount();

      updateDebugBox();

    }


    function pairIdFor(a, b) {

      return [
        String(a),
        String(b)
      ]
        .sort()
        .join("__");

    }


    function voiceRemoteCount() {

      let n = 0;

      for (
        const pc
        of voicePeers.values()
      ) {

        if (
          pc &&
          (
            pc.connectionState ===
              "connected" ||

            pc.iceConnectionState ===
              "connected" ||

            pc.iceConnectionState ===
              "completed"
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
    // AUDIO CONTAINER
    // ========================================================

    function getAudioBox() {

      let box =
        document.getElementById(
          "voiceAudios"
        );


      if (!box) {

        box =
          document.createElement("div");

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
    // IOS / SAFARI AUDIO UNLOCK
    // ========================================================

    function unlockRemoteAudios() {

      const box =
        document.getElementById(
          "voiceAudios"
        );

      if (!box) return;


      box
        .querySelectorAll("audio")
        .forEach(audio => {

          try {

            audio.muted = false;
            audio.volume = 1;

            const p =
              audio.play();

            if (p?.catch) {
              p.catch(() => {});
            }

          } catch {}

        });

    }


    function installAudioUnlock() {

      if (audioUnlockInstalled) {
        return;
      }


      audioUnlockInstalled = true;


      const unlock = () => {

        unlockRemoteAudios();

      };


      document.addEventListener(
        "touchstart",
        unlock,
        { passive: true }
      );


      document.addEventListener(
        "pointerdown",
        unlock,
        { passive: true }
      );


      document.addEventListener(
        "click",
        unlock,
        { passive: true }
      );

    }


    installAudioUnlock();


    // ========================================================
    // READ FIREBASE DIRECTLY
    // ========================================================

    async function readVoiceUsers() {

      try {

        const roomCode =
          getRoomCode?.();

        if (!roomCode) {
          return {};
        }


        const snap =
          await get(

            ref(
              db,
              `rooms/${roomCode}/public/voiceUsers`
            )

          );


        const users =
          snap.val() || {};


        debugLog(
          "تم تحديث مستخدمي الصوت"
        );


        return users;

      } catch (e) {

        debugError(
          "قراءة voiceUsers",
          e
        );


        try {

          return (
            getCurrentRoom?.()?.voiceUsers ||
            {}
          );

        } catch {

          return {};

        }

      }

    }


    async function readSignal(pair) {

      try {

        const snap =
          await get(

            ref(
              db,
              `rooms/${getRoomCode()}/public/voiceSignals/${pair}`
            )

          );


        return (
          snap.val() || {}
        );

      } catch (e) {

        debugError(
          "قراءة Signal",
          e
        );

        return {};

      }

    }


    // ========================================================
    // CLEAN OLD SIGNALS
    // ========================================================

    async function clearMyVoiceSignals() {

      try {

        const uid =
          getUid?.();

        const roomCode =
          getRoomCode?.();


        if (
          !uid ||
          !roomCode
        ) {
          return;
        }


        const voiceUsers =
          await readVoiceUsers();


        const users =
          Object
            .keys(voiceUsers)
            .filter(
              id => id !== uid
            );


        for (
          const otherUid
          of users
        ) {

          /*
            مهم:
            المستخدم الأصغر UID هو initiator.

            ما نحذف Signal للطرف الآخر
            إلا إذا نحن الـ initiator.
          */

          if (
            String(uid) <
            String(otherUid)
          ) {

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


        debugLog(
          "تم تنظيف الإشارات القديمة"
        );


      } catch (e) {

        debugError(
          "تنظيف الإشارات",
          e
        );

      }

    }


    // ========================================================
    // LOCAL MICROPHONE
    // ========================================================

    function stopLocalTracks() {

      if (!localVoiceStream) {
        return;
      }


      try {

        localVoiceStream
          .getTracks()
          .forEach(track => {

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

      const timer =
        reconnectTimers.get(otherUid);

      if (timer) {

        clearTimeout(timer);

        reconnectTimers.delete(
          otherUid
        );

      }


      const pc =
        voicePeers.get(otherUid);


      if (pc) {

        try {

          pc.ontrack = null;
          pc.onicecandidate = null;
          pc.onconnectionstatechange = null;
          pc.oniceconnectionstatechange = null;

          pc.close();

        } catch {}

      }


      voicePeers.delete(
        otherUid
      );


      const audio =
        document.getElementById(
          "voice_" + otherUid
        );


      if (audio) {

        try {

          audio.pause();

          audio.srcObject = null;

          audio.remove();

        } catch {}

      }


      setPeerDebug(
        otherUid,
        {
          stage: "مغلق",
          connection: "closed"
        }
      );

    }


    function closeAllPeers() {

      const ids =
        Array.from(
          voicePeers.keys()
        );


      ids.forEach(id => {

        closePeer(id);

      });

    }


    // ========================================================
    // RECONNECT
    // ========================================================

    function scheduleReconnect(
      otherUid,
      delay = 2500
    ) {

      if (
        !voiceActive ||
        reconnectTimers.has(otherUid)
      ) {
        return;
      }


      setPeerDebug(
        otherUid,
        {
          stage:
            "إعادة الاتصال..."
        }
      );


      const timer =
        setTimeout(() => {

          reconnectTimers.delete(
            otherUid
          );


          if (!voiceActive) {
            return;
          }


          closePeer(
            otherUid
          );


          setTimeout(() => {

            if (voiceActive) {
              sync();
            }

          }, 150);

        }, delay);


      reconnectTimers.set(
        otherUid,
        timer
      );

    }


    // ========================================================
    // START
    // ========================================================

    async function start() {

      if (
        voiceActive ||
        voiceStarting
      ) {

        safeToast(
          voiceActive
            ? "المايك شغال بالفعل"
            : "جاري فتح المايك..."
        );

        return;

      }


      const uid =
        getUid?.();

      const roomCode =
        getRoomCode?.();


      if (
        !uid ||
        !roomCode
      ) {

        safeToast(
          "تعذر تحديد الغرفة"
        );

        return;

      }


      voiceStarting = true;

      publishState();


      debugLog(
        "بدء تشغيل المايك"
      );


      try {

        if (!window.isSecureContext) {

          throw new Error(
            "المايك يحتاج HTTPS"
          );

        }


        if (
          !navigator.mediaDevices
            ?.getUserMedia
        ) {

          throw new Error(
            "المتصفح لا يدعم المايك"
          );

        }


        try {

          stopRadio?.(false);

        } catch {}


        try {

          await releaseWebAudio?.();

        } catch {}


        await wait(200);


        debugLog(
          "طلب صلاحية المايك"
        );


        localVoiceStream =
          await navigator.mediaDevices
            .getUserMedia({

              audio: {

                echoCancellation:
                  true,

                noiseSuppression:
                  true,

                autoGainControl:
                  true

              },

              video:
                false

            });


        const tracks =
          localVoiceStream
            .getAudioTracks();


        if (!tracks.length) {

          throw new Error(
            "لم يتم العثور على مايك"
          );

        }


        tracks.forEach(
          track =>
            track.enabled = true
        );


        debugLog(
          "تم تشغيل المايك"
        );


        voiceSessionId =
          String(uid) +
          "_" +
          Date.now() +
          "_" +
          Math.random()
            .toString(36)
            .slice(2, 7);


        voiceActive = true;

        voiceStarting = false;

        voiceMuted = false;


        closeAllPeers();


        await clearMyVoiceSignals();


        await update(

          ref(
            db,
            `rooms/${roomCode}/public/voiceUsers/${uid}`
          ),

          {

            name:
              getName?.() ||
              "مستخدم",

            active:
              true,

            muted:
              false,

            session:
              voiceSessionId,

            ts:
              Date.now()

          }

        );


        debugLog(
          "تم تسجيل المستخدم في قناة الصوت"
        );


        publishState();


        clearInterval(
          voiceSyncTimer
        );


        voiceSyncTimer =
          setInterval(() => {

            if (voiceActive) {
              sync();
            }

          }, 1200);


        setTimeout(
          sync,
          100
        );


        setTimeout(
          sync,
          600
        );


        setTimeout(
          sync,
          1500
        );


        setTimeout(
          sync,
          3000
        );


        safeToast(
          "🎙️ المايك مفتوح — جاري الربط..."
        );


      } catch (e) {

        debugError(
          "تشغيل المايك",
          e
        );


        voiceStarting = false;

        voiceActive = false;

        voiceMuted = false;

        voiceSessionId = "";


        stopLocalTracks();

        closeAllPeers();

        publishState();


        let msg =
          "تعذر تشغيل المايك";


        if (
          e?.name ===
            "NotAllowedError" ||
          e?.name ===
            "PermissionDeniedError"
        ) {

          msg =
            "اسمح للمايك من إعدادات Safari";

        }


        safeToast(msg);

      }

    }


    // ========================================================
    // MUTE
    // ========================================================

    async function toggleMute() {

      if (
        !voiceActive ||
        !localVoiceStream
      ) {

        safeToast(
          "شغل الصوت أولاً"
        );

        return;

      }


      voiceMuted =
        !voiceMuted;


      localVoiceStream
        .getAudioTracks()
        .forEach(track => {

          track.enabled =
            !voiceMuted;

        });


      try {

        await update(

          ref(
            db,
            `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`
          ),

          {

            muted:
              voiceMuted,

            active:
              true,

            ts:
              Date.now()

          }

        );

      } catch (e) {

        debugError(
          "تحديث الكتم",
          e
        );

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

    function attachRemoteAudio(
      otherUid,
      stream
    ) {

      const box =
        getAudioBox();


      let audio =
        document.getElementById(
          "voice_" + otherUid
        );


      if (!audio) {

        audio =
          document.createElement(
            "audio"
          );


        audio.id =
          "voice_" + otherUid;


        audio.autoplay = true;

        audio.playsInline = true;


        audio.setAttribute(
          "playsinline",
          ""
        );


        audio.setAttribute(
          "webkit-playsinline",
          ""
        );


        box.appendChild(
          audio
        );

      }


      audio.srcObject =
        stream;

      audio.muted =
        false;

      audio.volume =
        1;


      debugLog(
        "وصل صوت الطرف الآخر"
      );


      setPeerDebug(
        otherUid,
        {
          stage:
            "تم استقبال الصوت"
        }
      );


      try {

        const p =
          audio.play();


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

    async function makePeer(
      otherUid
    ) {

      if (
        !otherUid ||
        otherUid === getUid() ||
        !localVoiceStream
      ) {

        return null;

      }


      const old =
        voicePeers.get(
          otherUid
        );


      if (
        old &&
        old.connectionState !==
          "closed" &&
        old.connectionState !==
          "failed"
      ) {

        return old;

      }


      if (old) {

        closePeer(
          otherUid
        );

      }


      const uid =
        getUid();


      const roomCode =
        getRoomCode();


      debugLog(
        "إنشاء WebRTC Peer"
      );


      setPeerDebug(
        otherUid,
        {
          stage:
            "إنشاء Peer"
        }
      );


      const pc =
        new RTCPeerConnection({

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

              username:
                "openrelayproject",

              credential:
                "openrelayproject"
            }

          ],

          iceCandidatePoolSize:
            6,

          bundlePolicy:
            "max-bundle",

          rtcpMuxPolicy:
            "require"

        });


      pc._addedRemoteIce =
        new Set();


      pc._remoteUid =
        otherUid;


      pc._createdAt =
        Date.now();


      voicePeers.set(
        otherUid,
        pc
      );


      // ======================================================
      // LOCAL AUDIO
      // ======================================================

      for (
        const track
        of localVoiceStream
          .getAudioTracks()
      ) {

        try {

          pc.addTrack(
            track,
            localVoiceStream
          );

        } catch (e) {

          debugError(
            "إضافة المايك إلى Peer",
            e
          );

        }

      }


      // ======================================================
      // REMOTE AUDIO
      // ======================================================

      pc.ontrack =
        event => {

          let stream =
            event.streams?.[0];


          if (!stream) {

            stream =
              new MediaStream();


            try {

              stream.addTrack(
                event.track
              );

            } catch {}

          }


          attachRemoteAudio(
            otherUid,
            stream
          );

        };


      // ======================================================
      // ICE CANDIDATES
      // ======================================================

      pc.onicecandidate =
        async event => {

          if (!event.candidate) {

            setPeerDebug(
              otherUid,
              {
                stage:
                  "اكتمل جمع ICE"
              }
            );

            return;

          }


          try {

            const candidate =
              event.candidate;


            let type =
              candidate.type ||
              "";


            if (
              !type &&
              candidate.candidate
            ) {

              const m =
                candidate.candidate
                  .match(
                    / typ ([a-z]+)/i
                  );

              type =
                m?.[1] ||
                "";

            }


            setPeerDebug(
              otherUid,
              {
                stage:
                  type === "relay"
                    ? "TURN relay جاهز"
                    : `ICE ${type || "candidate"}`
              }
            );


            const pair =
              pairIdFor(
                uid,
                otherUid
              );


            await set(

              push(

                ref(
                  db,
                  `rooms/${roomCode}/public/voiceSignals/${pair}/candidates/${uid}`
                )

              ),

              candidate.toJSON()

            );


          } catch (e) {

            debugError(
              "إرسال ICE",
              e
            );

          }

        };


      // ======================================================
      // CONNECTION STATE
      // ======================================================

      pc.onconnectionstatechange =
        () => {

          setPeerDebug(
            otherUid,
            {
              connection:
                pc.connectionState,

              signaling:
                pc.signalingState
            }
          );


          publishState();


          if (
            pc.connectionState ===
              "connected"
          ) {

            debugLog(
              "WebRTC متصل"
            );


            setPeerDebug(
              otherUid,
              {
                stage:
                  "✅ متصل"
              }
            );


            unlockRemoteAudios();

            return;

          }


          if (
            pc.connectionState ===
              "failed"
          ) {

            debugLog(
              "WebRTC فشل — إعادة محاولة"
            );


            scheduleReconnect(
              otherUid,
              1000
            );

            return;

          }


          /*
            disconnected قد تكون لحظية
            خصوصاً عند iPhone أو تبديل الشبكة.

            لذلك لا نغلق Peer مباشرة.
          */

          if (
            pc.connectionState ===
              "disconnected"
          ) {

            debugLog(
              "انقطاع مؤقت — انتظار قبل إعادة الربط"
            );


            scheduleReconnect(
              otherUid,
              5000
            );

          }

        };


      pc.oniceconnectionstatechange =
        () => {

          setPeerDebug(
            otherUid,
            {
              ice:
                pc.iceConnectionState,

              signaling:
                pc.signalingState
            }
          );


          publishState();


          if (
            pc.iceConnectionState ===
              "connected" ||
            pc.iceConnectionState ===
              "completed"
          ) {

            setPeerDebug(
              otherUid,
              {
                stage:
                  "✅ ICE متصل"
              }
            );


            unlockRemoteAudios();

          }


          if (
            pc.iceConnectionState ===
              "failed"
          ) {

            debugLog(
              "ICE failed"
            );


            scheduleReconnect(
              otherUid,
              1000
            );

          }


          if (
            pc.iceConnectionState ===
              "disconnected"
          ) {

            scheduleReconnect(
              otherUid,
              5000
            );

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
      otherUid
    ) {

      if (!pc) return;


      /*
        لا نحاول إضافة ICE قبل وصول
        Remote Description.
      */

      if (
        !pc.remoteDescription
      ) {

        return;

      }


      try {

        const snap =
          await get(

            ref(
              db,
              `rooms/${getRoomCode()}/public/voiceSignals/${pair}/candidates/${otherUid}`
            )

          );


        const all =
          snap.val() || {};


        for (
          const [key, candidate]
          of Object.entries(all)
        ) {

          if (
            pc._addedRemoteIce
              ?.has(key)
          ) {

            continue;

          }


          try {

            await pc.addIceCandidate(

              new RTCIceCandidate(
                candidate
              )

            );


            pc._addedRemoteIce
              ?.add(key);


          } catch (e) {

            debugError(
              "إضافة Remote ICE",
              e
            );

          }

        }


      } catch (e) {

        debugError(
          "قراءة Remote ICE",
          e
        );

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


      const uid =
        getUid?.();


      const roomCode =
        getRoomCode?.();


      if (
        !uid ||
        !roomCode
      ) {

        return;

      }


      voiceSyncBusy =
        true;


      try {

        /*
          لا نعتمد على currentRoom هنا.

          نقرأ voiceUsers مباشرة من Firebase
          حتى نرى اللاعب فور دخوله للصوت.
        */

        const voiceUsers =
          await readVoiceUsers();


        const users =
          Object
            .keys(voiceUsers)
            .filter(otherUid => {

              return (
                otherUid !== uid &&
                voiceUsers[otherUid]
                  ?.active === true
              );

            });


        voiceDebug.users =
          Object
            .keys(voiceUsers)
            .filter(id =>
              voiceUsers[id]
                ?.active === true
            )
            .length;


        voiceDebug.expected =
          users.length;


        updateDebugBox();


        // ====================================================
        // REMOVE LEFT USERS
        // ====================================================

        for (
          const otherUid
          of Array.from(
            voicePeers.keys()
          )
        ) {

          if (
            !users.includes(
              otherUid
            )
          ) {

            closePeer(
              otherUid
            );


            delete voiceDebug
              .peers[otherUid];

          }

        }


        // ====================================================
        // EACH REMOTE USER
        // ====================================================

        for (
          const otherUid
          of users
        ) {

          try {

            let pc =
              await makePeer(
                otherUid
              );


            if (!pc) {
              continue;
            }


            const pair =
              pairIdFor(
                uid,
                otherUid
              );


            const initiator =
              String(uid) <
              String(otherUid);


            let signal =
              await readSignal(
                pair
              );


            // =================================================
            // INITIATOR
            // =================================================

            if (initiator) {

              const liveOffer =
                signal.offer;


              if (
                (
                  !liveOffer?.sdp ||
                  liveOffer.session !==
                    voiceSessionId
                ) &&
                pc.signalingState ===
                  "stable"
              ) {

                debugLog(
                  "إنشاء Offer"
                );


                setPeerDebug(
                  otherUid,
                  {
                    stage:
                      "إنشاء Offer"
                  }
                );


                /*
                  تنظيف Answer و ICE القديم
                  قبل جلسة جديدة.
                */

                try {

                  await remove(

                    ref(
                      db,
                      `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                    )

                  );

                } catch {}


                try {

                  await remove(

                    ref(
                      db,
                      `rooms/${roomCode}/public/voiceSignals/${pair}/candidates`
                    )

                  );

                } catch {}


                pc._addedRemoteIce =
                  new Set();


                const offer =
                  await pc.createOffer({

                    offerToReceiveAudio:
                      true,

                    iceRestart:
                      true

                  });


                await pc.setLocalDescription(
                  offer
                );


                await set(

                  ref(
                    db,
                    `rooms/${roomCode}/public/voiceSignals/${pair}/offer`
                  ),

                  {

                    type:
                      pc.localDescription.type,

                    sdp:
                      pc.localDescription.sdp,

                    from:
                      uid,

                    session:
                      voiceSessionId,

                    ts:
                      Date.now()

                  }

                );


                pc._offerAt =
                  Date.now();


                setPeerDebug(
                  otherUid,
                  {
                    stage:
                      "📤 Offer مرسل"
                  }
                );


                debugLog(
                  "Offer مرسل"
                );


                signal =
                  await readSignal(
                    pair
                  );

              }


              // =================================================
              // ANSWER
              // =================================================

              const answer =
                signal.answer ||
                (
                  await get(

                    ref(
                      db,
                      `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                    )

                  )

                ).val();


              if (
                answer?.sdp &&
                answer.session ===
                  voiceSessionId &&
                !pc.currentRemoteDescription
              ) {

                debugLog(
                  "Answer وصل"
                );


                setPeerDebug(
                  otherUid,
                  {
                    stage:
                      "📥 Answer وصل"
                  }
                );


                await pc.setRemoteDescription(

                  new RTCSessionDescription({

                    type:
                      answer.type,

                    sdp:
                      answer.sdp

                  })

                );


                pc._answerAt =
                  Date.now();

              }


              await addRemoteIce(
                pc,
                pair,
                otherUid
              );


              /*
                إذا الـ Offer ظل بدون Answer
                فترة طويلة، نعيد بناء الاتصال.
              */

              if (
                pc._offerAt &&
                !pc.currentRemoteDescription &&
                Date.now() -
                  pc._offerAt >
                  12000
              ) {

                setPeerDebug(
                  otherUid,
                  {
                    stage:
                      "⚠️ لا يوجد Answer"
                  }
                );


                scheduleReconnect(
                  otherUid,
                  500
                );

              }


            // =================================================
            // ANSWERER
            // =================================================

            } else {

              const offer =
                signal.offer ||
                (
                  await get(

                    ref(
                      db,
                      `rooms/${roomCode}/public/voiceSignals/${pair}/offer`
                    )

                  )

                ).val();


              if (!offer?.sdp) {

                setPeerDebug(
                  otherUid,
                  {
                    stage:
                      "بانتظار Offer"
                  }
                );

                continue;

              }


              /*
                إذا وصل Offer لجلسة جديدة،
                نعيد Peer حتى ما نبقى مربوطين
                بالجلسة القديمة.
              */

              if (
                pc._offerSession &&
                pc._offerSession !==
                  offer.session
              ) {

                debugLog(
                  "Offer جديد — إعادة Peer"
                );


                closePeer(
                  otherUid
                );


                pc =
                  await makePeer(
                    otherUid
                  );


                if (!pc) {
                  continue;
                }

              }


              if (
                !pc.currentRemoteDescription &&
                pc.signalingState ===
                  "stable"
              ) {

                setPeerDebug(
                  otherUid,
                  {
                    stage:
                      "📥 Offer وصل"
                  }
                );


                debugLog(
                  "Offer وصل"
                );


                await pc.setRemoteDescription(

                  new RTCSessionDescription({

                    type:
                      offer.type,

                    sdp:
                      offer.sdp

                  })

                );


                pc._offerSession =
                  offer.session ||
                  "";


                /*
                  الآن بعد remoteDescription
                  نقدر نضيف ICE الموجود.
                */

                await addRemoteIce(
                  pc,
                  pair,
                  otherUid
                );


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

                    session:
                      offer.session ||
                      "",

                    ts:
                      Date.now()

                  }

                );


                setPeerDebug(
                  otherUid,
                  {
                    stage:
                      "📤 Answer مرسل"
                  }
                );


                debugLog(
                  "Answer مرسل"
                );

              }


              await addRemoteIce(
                pc,
                pair,
                otherUid
              );

            }


          } catch (peerError) {

            debugError(
              `Peer ${otherUid}`,
              peerError
            );


            setPeerDebug(
              otherUid,
              {
                stage:
                  "❌ خطأ اتصال"
              }
            );


            scheduleReconnect(
              otherUid,
              1800
            );

          }

        }


      } catch (e) {

        debugError(
          "Voice Sync",
          e
        );


      } finally {

        voiceSyncBusy =
          false;


        publishState();

      }

    }


    // ========================================================
    // FORCE RECONNECT
    // ========================================================

    async function reconnect() {

      if (!voiceActive) {
        return;
      }


      debugLog(
        "إعادة ربط يدوي"
      );


      voiceSessionId =
        String(getUid()) +
        "_" +
        Date.now() +
        "_" +
        Math.random()
          .toString(36)
          .slice(2, 7);


      try {

        await update(

          ref(
            db,
            `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`
          ),

          {

            session:
              voiceSessionId,

            active:
              true,

            muted:
              voiceMuted,

            ts:
              Date.now()

          }

        );

      } catch {}


      closeAllPeers();


      setTimeout(() => {

        if (voiceActive) {
          sync();
        }

      }, 200);

    }


    // ========================================================
    // STOP
    // ========================================================

    async function stop(
      removeState = true
    ) {

      const was =
        voiceActive ||
        voiceStarting;


      voiceActive =
        false;

      voiceStarting =
        false;

      voiceMuted =
        false;


      clearInterval(
        voiceSyncTimer
      );


      voiceSyncTimer =
        null;


      for (
        const timer
        of reconnectTimers.values()
      ) {

        clearTimeout(timer);

      }


      reconnectTimers.clear();


      stopLocalTracks();

      closeAllPeers();


      const box =
        document.getElementById(
          "voiceAudios"
        );


      if (box) {

        try {
          box.innerHTML = "";
        } catch {}

      }


      const roomCode =
        getRoomCode?.();


      const uid =
        getUid?.();


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


      voiceSessionId =
        "";


      voiceDebug.users =
        0;

      voiceDebug.expected =
        0;

      voiceDebug.connected =
        0;

      voiceDebug.peers =
        {};

      voiceDebug.lastAction =
        "الصوت متوقف";


      publishState();


      if (
        was &&
        removeState
      ) {

        safeToast(
          "تم إيقاف الصوت المباشر"
        );

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
    // RETURN
    // ========================================================

    return {

      start,

      stop,

      toggleMute,

      sync,

      reconnect,

      remoteCount:
        voiceRemoteCount,

      isActive,

      isStarting,

      isMuted

    };

  }


  window.SheikhVoice = {
    createVoiceController
  };

})();
