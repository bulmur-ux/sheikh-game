// ============================================================
// شيك شيك - Voice System v5
// Auto listen + push-to-talk mic + resilient WebRTC/Firebase
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


    let voiceActive = false;
    let voiceStarting = false;
    let voiceMuted = true;

    let localVoiceStream = null;
    let voiceSessionId = "";

    let voiceSyncBusy = false;
    let voiceSyncTimer = null;
    let audioUnlockInstalled = false;

    const voicePeers = new Map();
    const retryTimers = new Map();


    // ========================================================
    // ICE / STUN / TURN
    // ========================================================

    const ICE_SERVERS = [

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

    ];


    // ========================================================
    // HELPERS
    // ========================================================

    const wait = ms => {

      return sleep
        ? sleep(ms)
        : new Promise(resolve => setTimeout(resolve, ms));

    };


    function safeToast(message) {

      try {
        toast?.(message);
      } catch {}

    }


    function pairIdFor(a, b) {

      return [String(a), String(b)]
        .sort()
        .join("__");

    }


    function newSession() {

      return (
        (getUid?.() || "u") +
        "_" +
        Date.now() +
        "_" +
        Math.random()
          .toString(36)
          .slice(2, 8)
      );

    }


    function remoteCount() {

      let count = 0;

      for (const pc of voicePeers.values()) {

        if (
          pc &&
          (
            pc.connectionState === "connected" ||
            pc.iceConnectionState === "connected" ||
            pc.iceConnectionState === "completed"
          )
        ) {
          count++;
        }

      }

      return count;
    }


    function publishState() {

      try {

        onStateChange?.({

          active: voiceActive,
          starting: voiceStarting,
          muted: voiceMuted,

          remoteCount: remoteCount(),

          listening:
            voiceActive &&
            !localVoiceStream

        });

      } catch {}


      try {
        onUiRefresh?.();
      } catch {}

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

      let box =
        document.getElementById("voiceAudios");


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
    // IPHONE / SAFARI AUDIO UNLOCK
    // ========================================================

    function unlockRemoteAudios() {

      document
        .querySelectorAll("#voiceAudios audio")
        .forEach(audio => {

          try {

            audio.muted = false;
            audio.volume = 1;

            const playPromise =
              audio.play();

            if (playPromise?.catch) {

              playPromise.catch(() => {});

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
    // LOCAL TRACKS
    // ========================================================

    function stopLocalTracks() {

      if (localVoiceStream) {

        try {

          localVoiceStream
            .getTracks()
            .forEach(track => {

              try {
                track.stop();
              } catch {}

            });

        } catch {}

      }


      localVoiceStream = null;

    }


    // ========================================================
    // PEER CLEANUP
    // ========================================================

    function closePeer(otherUid) {

      const pc =
        voicePeers.get(otherUid);


      if (pc) {

        try {

          pc.ontrack = null;

          pc.onconnectionstatechange = null;

          pc.oniceconnectionstatechange = null;

          pc.close();

        } catch {}

      }


      voicePeers.delete(otherUid);


      const retry =
        retryTimers.get(otherUid);


      if (retry) {

        clearTimeout(retry);

      }


      retryTimers.delete(otherUid);


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

    }


    function closeAllPeers() {

      Array
        .from(voicePeers.keys())
        .forEach(closePeer);

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
          document.createElement("audio");


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


        box.appendChild(audio);

      }


      if (
        audio.srcObject !== stream
      ) {

        audio.srcObject =
          stream;

      }


      audio.muted = false;
      audio.volume = 1;


      try {

        const playPromise =
          audio.play();


        if (playPromise?.catch) {

          playPromise.catch(() => {});

        }

      } catch {}

    }


    // ========================================================
    // FIREBASE VOICE USERS
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


        return (
          snap.val() || {}
        );


      } catch (e) {

        console.warn(
          "voice users",
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


      } catch {

        return {};

      }

    }


    // ========================================================
    // REGISTER SELF
    // ========================================================

    async function registerSelf(extra = {}) {

      const roomCode =
        getRoomCode?.();


      const uid =
        getUid?.();


      if (
        !roomCode ||
        !uid
      ) {
        return;
      }


      await update(

        ref(
          db,
          `rooms/${roomCode}/public/voiceUsers/${uid}`
        ),

        {

          name:
            getName?.() ||
            "مستخدم",

          active: true,

          muted:
            voiceMuted,

          session:
            voiceSessionId,

          mode:
            localVoiceStream
              ? "talk"
              : "listen",

          ts:
            Date.now(),

          ...extra

        }

      );

    }


    // ========================================================
    // WAIT FOR ICE
    // ========================================================

    function waitIceComplete(
      pc,
      timeout = 5500
    ) {

      if (
        pc.iceGatheringState ===
        "complete"
      ) {

        return Promise.resolve();

      }


      return new Promise(resolve => {

        let done = false;


        const finish = () => {

          if (done) {
            return;
          }


          done = true;


          pc.removeEventListener(
            "icegatheringstatechange",
            check
          );


          clearTimeout(timer);

          resolve();

        };


        const check = () => {

          if (
            pc.iceGatheringState ===
            "complete"
          ) {

            finish();

          }

        };


        const timer =
          setTimeout(
            finish,
            timeout
          );


        pc.addEventListener(
          "icegatheringstatechange",
          check
        );

      });

    }


    // ========================================================
    // RETRY
    // ========================================================

    function scheduleRetry(
      otherUid,
      delay = 1800
    ) {

      if (
        !voiceActive ||
        retryTimers.has(otherUid)
      ) {
        return;
      }


      retryTimers.set(

        otherUid,

        setTimeout(() => {

          retryTimers.delete(
            otherUid
          );


          if (!voiceActive) {
            return;
          }


          closePeer(otherUid);

          sync();

        }, delay)

      );

    }


    // ========================================================
    // CREATE PEER
    // ========================================================

    async function makePeer(
      otherUid
    ) {

      if (
        !otherUid ||
        otherUid === getUid()
      ) {
        return null;
      }


      let old =
        voicePeers.get(otherUid);


      if (
        old &&
        old.connectionState !== "closed" &&
        old.connectionState !== "failed"
      ) {

        return old;

      }


      if (old) {

        closePeer(otherUid);

      }


      const pc =
        new RTCPeerConnection({

          iceServers:
            ICE_SERVERS,

          iceCandidatePoolSize:
            4,

          bundlePolicy:
            "max-bundle",

          rtcpMuxPolicy:
            "require"

        });


      pc._remoteUid =
        otherUid;


      pc._createdAt =
        Date.now();


      pc._signalKey = "";


      voicePeers.set(
        otherUid,
        pc
      );


      // ======================================================
      // TALK MODE
      // ======================================================

      if (
        localVoiceStream
          ?.getAudioTracks
          ?.()
          .length
      ) {

        for (
          const track
          of localVoiceStream.getAudioTracks()
        ) {

          try {

            pc.addTrack(
              track,
              localVoiceStream
            );

          } catch (e) {

            console.warn(
              "voice addTrack",
              e
            );

          }

        }


      // ======================================================
      // LISTEN ONLY MODE
      // ======================================================

      } else {

        try {

          pc.addTransceiver(
            "audio",
            {
              direction:
                "recvonly"
            }
          );

        } catch (e) {

          console.warn(
            "voice recvonly",
            e
          );

        }

      }


      // ======================================================
      // RECEIVE REMOTE AUDIO
      // ======================================================

      pc.ontrack = event => {

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
      // CONNECTION STATE
      // ======================================================

      const stateChanged = () => {

        publishState();


        if (
          pc.connectionState === "connected" ||
          pc.iceConnectionState === "connected" ||
          pc.iceConnectionState === "completed"
        ) {

          pc._connectedAt =
            Date.now();


          unlockRemoteAudios();

          return;

        }


        if (
          pc.connectionState === "failed" ||
          pc.iceConnectionState === "failed"
        ) {

          scheduleRetry(
            otherUid,
            700
          );

        } else if (
          pc.connectionState === "disconnected" ||
          pc.iceConnectionState === "disconnected"
        ) {

          scheduleRetry(
            otherUid,
            4500
          );

        }

      };


      pc.onconnectionstatechange =
        stateChanged;


      pc.oniceconnectionstatechange =
        stateChanged;


      return pc;

    }


    // ========================================================
    // LISTEN MODE
    // ========================================================

    /*
      هذه أهم نقطة في النظام الجديد.

      المستخدم يدخل قناة الصوت بدون طلب المايك.
      يقدر يسمع الموجودين مباشرة.

      لا يظهر طلب صلاحية المايك إلا إذا ضغط
      المستخدم على فتح المايك.
    */

    async function listen() {

      if (voiceActive) {
        return;
      }


      const roomCode =
        getRoomCode?.();


      const uid =
        getUid?.();


      if (
        !roomCode ||
        !uid
      ) {
        return;
      }


      voiceStarting = true;

      voiceMuted = true;

      publishState();


      try {

        voiceSessionId =
          newSession();


        voiceActive = true;

        voiceStarting = false;


        await registerSelf();


        startSyncLoop();


        publishState();


        setTimeout(
          sync,
          80
        );


        setTimeout(
          sync,
          500
        );


        setTimeout(
          sync,
          1400
        );


      } catch (e) {

        console.warn(
          "voice listen",
          e
        );


        voiceActive = false;

        voiceStarting = false;


        publishState();

      }

    }


    // ========================================================
    // GET MICROPHONE
    // ========================================================

    async function acquireMic() {

      if (localVoiceStream) {

        return true;

      }


      if (!window.isSecureContext) {

        throw new Error("HTTPS");

      }


      if (
        !navigator.mediaDevices
          ?.getUserMedia
      ) {

        throw new Error(
          "UNSUPPORTED"
        );

      }


      try {

        stopRadio?.(false);

      } catch {}


      try {

        await releaseWebAudio?.();

      } catch {}


      await wait(100);


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


      if (
        !localVoiceStream
          .getAudioTracks()
          .length
      ) {

        throw new Error(
          "NO_MIC"
        );

      }


      return true;

    }


    // ========================================================
    // START / OPEN MICROPHONE
    // ========================================================

    async function start(
      options = {}
    ) {

      /*
        للاستماع فقط:

        start({ muted:true })

        أو:

        listen()
      */

      if (
        options?.muted === true
      ) {

        await listen();

        return;

      }


      if (voiceStarting) {
        return;
      }


      /*
        إذا لم يكن داخل الصوت،
        ندخله أولاً بوضع الاستماع.
      */

      if (!voiceActive) {

        await listen();

      }


      /*
        إذا المايك مفتوح بالفعل
      */

      if (
        localVoiceStream &&
        !voiceMuted
      ) {

        safeToast(
          "🎙️ المايك شغال بالفعل"
        );

        return;

      }


      voiceStarting = true;

      publishState();


      try {

        await acquireMic();


        voiceMuted = false;


        localVoiceStream
          .getAudioTracks()
          .forEach(track => {

            track.enabled =
              true;

          });


        /*
          جلسة جديدة لأن وضع المستخدم
          تغير من استماع إلى تحدث.
        */

        voiceSessionId =
          newSession();


        await registerSelf();


        /*
          نعيد بناء الاتصالات حتى تنتقل
          من recvonly إلى إرسال واستقبال.
        */

        closeAllPeers();


        voiceStarting = false;


        publishState();


        setTimeout(
          sync,
          80
        );


        setTimeout(
          sync,
          600
        );


        safeToast(
          "🎙️ تم فتح المايك"
        );


      } catch (e) {

        console.warn(
          "voice mic",
          e
        );


        voiceStarting = false;

        voiceMuted = true;


        publishState();


        if (
          e?.name ===
            "NotAllowedError" ||
          e?.name ===
            "PermissionDeniedError"
        ) {

          safeToast(
            "اسمح للمايك من إعدادات Safari ثم حاول مرة ثانية"
          );

        } else {

          safeToast(
            "تعذر تشغيل المايك"
          );

        }

      }

    }


    // ========================================================
    // MUTE / UNMUTE
    // ========================================================

    async function toggleMute() {

      /*
        إذا لم يدخل قناة الصوت بعد:
        ندخله ثم نفتح المايك.
      */

      if (!voiceActive) {

        await listen();

        return start();

      }


      /*
        إذا داخل للاستماع فقط وما طلب
        صلاحية المايك من قبل.
      */

      if (!localVoiceStream) {

        return start();

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

        await registerSelf();

      } catch {}


      publishState();


      if (voiceMuted) {

        safeToast(
          "🔇 تم كتم المايك — ما زلت تسمع الموجودين"
        );

      } else {

        safeToast(
          "🎙️ تم فتح المايك"
        );

      }

    }


    // ========================================================
    // SYNC LOOP
    // ========================================================

    function startSyncLoop() {

      clearInterval(
        voiceSyncTimer
      );


      voiceSyncTimer =
        setInterval(() => {

          if (voiceActive) {

            sync();

          }

        }, 1100);

    }


    // ========================================================
    // SYNC
    // ========================================================

    async function sync() {

      if (
        !voiceActive ||
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


      voiceSyncBusy = true;


      try {

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


        // ====================================================
        // REMOVE USERS WHO LEFT
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

          }

        }


        // ====================================================
        // CONNECT USERS
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


            /*
              Session للطرفين.

              إذا أحد الطرفين فتح المايك
              أو أعاد الاتصال، تتغير الجلسة
              ويعاد بناء الاتصال.
            */

            const mine =
              voiceUsers[uid]
                ?.session ||
              voiceSessionId;


            const theirs =
              voiceUsers[otherUid]
                ?.session ||
              "";


            const key =
              initiator
                ? `${mine}|${theirs}`
                : `${theirs}|${mine}`;


            let signal =
              await readSignal(
                pair
              );


            // =================================================
            // CALLER
            // =================================================

            if (initiator) {

              const stale =
                !signal.offer?.sdp ||
                signal.key !== key;


              if (
                stale &&
                pc.signalingState ===
                  "stable"
              ) {

                /*
                  نعيد إنشاء Peer نظيف.
                */

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


                const offer =
                  await pc.createOffer({

                    offerToReceiveAudio:
                      true

                  });


                await pc.setLocalDescription(
                  offer
                );


                /*
                  ننتظر ICE حتى تدخل الـ candidates
                  داخل SDP نفسه.

                  هذا يقلل مشاكل السباق في Firebase.
                */

                await waitIceComplete(
                  pc
                );


                await set(

                  ref(
                    db,
                    `rooms/${roomCode}/public/voiceSignals/${pair}`
                  ),

                  {

                    key,

                    caller:
                      uid,

                    callee:
                      otherUid,

                    offer: {

                      type:
                        pc.localDescription.type,

                      sdp:
                        pc.localDescription.sdp

                    },

                    ts:
                      Date.now()

                  }

                );


                pc._signalKey =
                  key;


                pc._offerAt =
                  Date.now();


                signal =
                  await readSignal(
                    pair
                  );

              }


              // =================================================
              // ANSWER
              // =================================================

              if (
                signal.key === key &&
                signal.answer?.sdp &&
                !pc.currentRemoteDescription
              ) {

                await pc.setRemoteDescription(

                  new RTCSessionDescription(
                    signal.answer
                  )

                );


                pc._answerAt =
                  Date.now();

              }


              /*
                إذا ظل أكثر من 14 ثانية
                بدون Answer نعيد المحاولة.
              */

              if (
                pc._offerAt &&
                !pc.currentRemoteDescription &&
                Date.now() -
                  pc._offerAt >
                  14000
              ) {

                scheduleRetry(
                  otherUid,
                  100
                );

              }


            // =================================================
            // ANSWERER
            // =================================================

            } else {

              if (
                !signal.offer?.sdp ||
                signal.key !== key
              ) {

                continue;

              }


              /*
                إذا الجلسة تغيرت،
                نعيد Peer من الصفر.
              */

              if (
                pc._signalKey &&
                pc._signalKey !== key
              ) {

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

                await pc.setRemoteDescription(

                  new RTCSessionDescription(
                    signal.offer
                  )

                );


                pc._signalKey =
                  key;


                const answer =
                  await pc.createAnswer();


                await pc.setLocalDescription(
                  answer
                );


                await waitIceComplete(
                  pc
                );


                await update(

                  ref(
                    db,
                    `rooms/${roomCode}/public/voiceSignals/${pair}`
                  ),

                  {

                    answer: {

                      type:
                        pc.localDescription.type,

                      sdp:
                        pc.localDescription.sdp

                    },

                    answerTs:
                      Date.now()

                  }

                );

              }

            }


          } catch (peerError) {

            console.warn(
              "voice peer sync",
              otherUid,
              peerError
            );


            scheduleRetry(
              otherUid,
              1800
            );

          }

        }


      } catch (e) {

        console.warn(
          "voice sync",
          e
        );


      } finally {

        voiceSyncBusy = false;

        publishState();

      }

    }


    // ========================================================
    // RECONNECT
    // ========================================================

    async function reconnect() {

      if (!voiceActive) {
        return;
      }


      voiceSessionId =
        newSession();


      try {

        await registerSelf();

      } catch {}


      closeAllPeers();


      setTimeout(
        sync,
        100
      );


      setTimeout(
        sync,
        900
      );

    }


    // ========================================================
    // STOP / LEAVE VOICE
    // ========================================================

    async function stop(
      removeState = true
    ) {

      const was =
        voiceActive ||
        voiceStarting;


      voiceActive = false;

      voiceStarting = false;

      voiceMuted = true;


      clearInterval(
        voiceSyncTimer
      );


      voiceSyncTimer = null;


      for (
        const timer
        of retryTimers.values()
      ) {

        clearTimeout(timer);

      }


      retryTimers.clear();


      stopLocalTracks();

      closeAllPeers();


      const box =
        document.getElementById(
          "voiceAudios"
        );


      if (box) {

        box.innerHTML = "";

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


        /*
          نحذف فقط الإشارات التي يكون
          هذا المستخدم هو الـ initiator لها.

          هذا يقلل احتمال حذف اتصال
          الطرف الآخر في نفس اللحظة.
        */

        try {

          const users =
            await readVoiceUsers();


          for (
            const otherUid
            of Object.keys(users)
          ) {

            if (
              otherUid !== uid &&
              String(uid) <
                String(otherUid)
            ) {

              await remove(

                ref(
                  db,
                  `rooms/${roomCode}/public/voiceSignals/${pairIdFor(uid, otherUid)}`
                )

              ).catch(() => {});

            }

          }

        } catch {}

      }


      voiceSessionId = "";


      publishState();


      if (
        was &&
        removeState
      ) {

        safeToast(
          "تم الخروج من الصوت"
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
    // CONTROLLER
    // ========================================================

    return {

      start,

      listen,

      stop,

      toggleMute,

      sync,

      reconnect,

      remoteCount,

      isActive,

      isStarting,

      isMuted

    };

  }


  // ==========================================================
  // GLOBAL
  // ==========================================================

  window.SheikhVoice = {
    createVoiceController
  };


})();
