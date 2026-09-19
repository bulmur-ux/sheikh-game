// ============================================================
// شيك شيك - Voice System
// voice.js
// WebRTC Voice Controller
// يدعم:
// 1) صوت اللاعبين
// 2) كتم / فتح المايك
// 3) دخول الإدارة للاستماع فقط
// 4) تحدث الإدارة عند الحاجة
// 5) إعادة الربط تلقائياً
// 6) Safari / iPhone
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

    let audioUnlockInstalled = false;


    // ========================================================
    // HELPERS
    // ========================================================

    function safeToast(message) {
      try {
        toast?.(message);
      } catch {}
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
    }


    function pairIdFor(a, b) {

      return [String(a), String(b)]
        .sort()
        .join("__");
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


    function getAudioBox() {

      let box =
        document.getElementById("voiceAudios");


      if (!box) {

        box =
          document.createElement("div");

        box.id = "voiceAudios";

        box.style.position = "fixed";
        box.style.width = "1px";
        box.style.height = "1px";
        box.style.overflow = "hidden";
        box.style.opacity = "0";
        box.style.pointerEvents = "none";

        document.body.appendChild(box);
      }


      return box;
    }


    // ========================================================
    // SAFARI / IOS AUDIO UNLOCK
    // ========================================================

    function unlockRemoteAudios() {

      const box =
        document.getElementById("voiceAudios");

      if (!box) {
        return;
      }


      const audios =
        box.querySelectorAll("audio");


      audios.forEach(audio => {

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
    // SIGNAL CLEANUP
    // ========================================================

    async function clearMyVoiceSignals() {

      try {

        const uid =
          getUid?.();

        const roomCode =
          getRoomCode?.();


        if (!uid || !roomCode) {
          return;
        }


        /*
          نقرأ voiceUsers مباشرة من Firebase.

          السبب:
          getCurrentRoom قد لا يكون محدثاً في نفس اللحظة،
          خصوصاً عند دخول مستخدم جديد للصوت.
        */

        const usersSnap =
          await get(

            ref(
              db,
              `rooms/${roomCode}/public/voiceUsers`
            )

          );


        const voiceUsers =
          usersSnap.val() || {};


        const users =
          Object.keys(voiceUsers)
            .filter(id => id !== uid);


        await Promise.all(

          users.map(other =>

            remove(

              ref(
                db,
                `rooms/${roomCode}/public/voiceSignals/${pairIdFor(uid, other)}`
              )

            ).catch(() => {})

          )

        );


      } catch (e) {

        console.warn(
          "clearMyVoiceSignals",
          e
        );
      }
    }


    // ========================================================
    // START VOICE
    // ========================================================

    /*
      PLAYER:

      voice.start()


      ADMIN LISTEN ONLY:

      voice.start({
        muted: true
      })


      الإدارة تدخل وهي مكتومة من البداية.
    */

    async function start(options = {}) {

      if (voiceActive || voiceStarting) {

        safeToast(
          voiceActive
            ? "المايك شغال بالفعل"
            : "جاري فتح المايك..."
        );

        return;
      }


      const roomCode =
        getRoomCode?.();

      const uid =
        getUid?.();


      if (!roomCode) {

        safeToast(
          "لا توجد غرفة صوت حالياً"
        );

        return;
      }


      if (!uid) {

        safeToast(
          "تعذر تحديد المستخدم"
        );

        return;
      }


      voiceStarting = true;

      publishState();


      try {

        if (!window.isSecureContext) {

          throw new Error(
            "المايك يحتاج اتصال HTTPS"
          );
        }


        if (
          !navigator.mediaDevices ||
          !navigator.mediaDevices.getUserMedia
        ) {

          throw new Error(
            "المتصفح لا يدعم تشغيل المايك"
          );
        }


        /*
          نوقف الراديو قبل تشغيل الصوت المباشر
          لتقليل تعارض الصوت على Safari.
        */

        try {
          stopRadio?.(false);
        } catch {}


        try {
          await releaseWebAudio?.();
        } catch {}


        try {

          if (sleep) {
            await sleep(250);
          } else {
            await new Promise(
              resolve =>
                setTimeout(resolve, 250)
            );
          }

        } catch {}


        // --------------------------------------------
        // طلب المايك
        // --------------------------------------------

        localVoiceStream =
          await navigator.mediaDevices
            .getUserMedia({

              audio: {

                echoCancellation: true,

                noiseSuppression: true,

                autoGainControl: true

              },

              video: false

            });


        const tracks =
          localVoiceStream.getAudioTracks();


        if (!tracks.length) {

          throw new Error(
            "لم يتم العثور على مايك"
          );
        }


        const startMuted =
          options?.muted === true;


        /*
          مهم جداً للإدارة:

          إذا دخلت الإدارة للاستماع فقط،
          نقفل التراك قبل إنشاء PeerConnection.
        */

        tracks.forEach(track => {

          track.enabled =
            !startMuted;

        });


        const myName =
          getName?.() || "مستخدم";


        voiceSessionId =
          uid +
          "_" +
          Date.now() +
          "_" +
          Math.random()
            .toString(36)
            .slice(2, 8);


        voiceActive = true;

        voiceStarting = false;

        voiceMuted =
          startMuted;


        // --------------------------------------------
        // إغلاق أي Peer قديم
        // --------------------------------------------

        closeAllPeers();


        // --------------------------------------------
        // تنظيف إشارات قديمة
        // --------------------------------------------

        await clearMyVoiceSignals();


        // --------------------------------------------
        // تسجيل المستخدم في قناة الصوت
        // --------------------------------------------

        await update(

          ref(
            db,
            `rooms/${roomCode}/public/voiceUsers/${uid}`
          ),

          {

            name: myName,

            active: true,

            muted: startMuted,

            session: voiceSessionId,

            ts: Date.now()

          }

        );


        publishState();


        // --------------------------------------------
        // محاولات ربط أولية
        // --------------------------------------------

        setTimeout(() => {

          if (voiceActive) {
            sync();
          }

        }, 150);


        setTimeout(() => {

          if (voiceActive) {
            sync();
          }

        }, 600);


        setTimeout(() => {

          if (voiceActive) {
            sync();
          }

        }, 1500);


        setTimeout(() => {

          if (voiceActive) {
            sync();
          }

        }, 3000);


        // --------------------------------------------
        // مزامنة مستمرة
        // --------------------------------------------

        clearInterval(
          voiceSyncTimer
        );


        voiceSyncTimer =
          setInterval(() => {

            if (voiceActive) {
              sync();
            }

          }, 1200);


        if (startMuted) {

          safeToast(
            "🔊 تم دخول الصوت — الاستماع فقط"
          );

        } else {

          safeToast(
            "🎙️ المايك مفتوح — جاري الربط..."
          );
        }


      } catch (e) {

        console.warn(
          "voice start",
          e
        );


        voiceStarting = false;

        voiceActive = false;

        voiceMuted = false;

        voiceSessionId = "";


        stopLocalTracks();

        closeAllPeers();

        publishState();


        const raw =
          String(
            e?.message || ""
          );


        let msg =
          "تعذر تشغيل المايك";


        if (
          e?.name === "NotAllowedError" ||
          e?.name === "PermissionDeniedError"
        ) {

          msg =
            "اسمح للمايك من إعدادات Safari ثم حاول مرة ثانية";

        } else if (
          e?.name === "NotFoundError"
        ) {

          msg =
            "لم يتم العثور على مايك";

        } else if (
          e?.name === "NotReadableError"
        ) {

          msg =
            "المايك مستخدم من تطبيق آخر";

        } else if (
          raw.includes("HTTPS")
        ) {

          msg =
            "تشغيل المايك يحتاج HTTPS";
        }


        if (
          raw &&
          !msg.includes(raw)
        ) {

          console.warn(
            "Voice error details:",
            raw
          );
        }


        safeToast(msg);
      }
    }


    // ========================================================
    // LOCAL TRACKS
    // ========================================================

    function stopLocalTracks() {

      if (!localVoiceStream) {
        return;
      }


      try {

        for (
          const track
          of localVoiceStream.getTracks()
        ) {

          try {
            track.stop();
          } catch {}
        }

      } catch {}


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
    }


    function closeAllPeers() {

      const ids =
        Array.from(
          voicePeers.keys()
        );


      ids.forEach(id => {

        closePeer(id);

      });


      voicePeers.clear();
    }


    // ========================================================
    // MUTE / UNMUTE
    // ========================================================

    /*
      اللاعب:
      كتم / فتح المايك.

      الإدارة:
      تدخل start({muted:true})
      وبعدها يمكن فتح المايك عند الحاجة.
    */

    async function toggleMute() {

      if (
        !voiceActive ||
        !localVoiceStream
      ) {

        safeToast(
          "الصوت غير مشغل"
        );

        return;
      }


      voiceMuted =
        !voiceMuted;


      const tracks =
        localVoiceStream.getAudioTracks();


      tracks.forEach(track => {

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

            muted: voiceMuted,

            active: true,

            ts: Date.now()

          }

        );

      } catch (e) {

        console.warn(
          "voice mute state",
          e
        );
      }


      publishState();


      safeToast(

        voiceMuted
          ? "🔇 تم كتم المايك"
          : "🎙️ تم فتح المايك"

      );
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


      clearInterval(
        voiceSyncTimer
      );


      voiceSyncTimer = null;


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


      voiceSessionId = "";

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


      if (
        audio.srcObject !== stream
      ) {

        audio.srcObject =
          stream;
      }


      audio.muted = false;

      audio.volume = 1;


      try {

        const p =
          audio.play();


        if (p?.catch) {

          p.catch(err => {

            console.warn(
              "remote audio autoplay",
              err
            );


            /*
              Safari قد يمنع التشغيل حتى يضغط
              المستخدم على الصفحة مرة واحدة.
            */

            safeToast(
              "🔊 اضغط على الشاشة مرة لتفعيل صوت الطرف الآخر"
            );
          });
        }

      } catch {}
    }


    // ========================================================
    // CREATE PEER
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


      const uid =
        getUid();

      const roomCode =
        getRoomCode();


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
              urls:
                "turn:openrelay.metered.ca:80",

              username:
                "openrelayproject",

              credential:
                "openrelayproject"
            },

            {
              urls:
                "turn:openrelay.metered.ca:443",

              username:
                "openrelayproject",

              credential:
                "openrelayproject"
            }

          ],

          iceCandidatePoolSize: 10

        });


      pc._addedRemoteIce =
        new Set();


      pc._remoteUid =
        otherUid;


      voicePeers.set(
        otherUid,
        pc
      );


      // --------------------------------------------
      // إرسال الصوت المحلي
      // --------------------------------------------

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
            "addTrack",
            e
          );
        }
      }


      // --------------------------------------------
      // استقبال صوت الطرف الآخر
      // --------------------------------------------

      pc.ontrack = event => {

        console.log(
          "VOICE REMOTE TRACK:",
          otherUid
        );


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


      // --------------------------------------------
      // ICE
      // --------------------------------------------

      pc.onicecandidate =
        async event => {

          if (!event.candidate) {
            return;
          }


          try {

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

              event.candidate.toJSON()

            );

          } catch (e) {

            console.warn(
              "send ice",
              e
            );
          }
        };


      // --------------------------------------------
      // CONNECTION STATE
      // --------------------------------------------

      pc.onconnectionstatechange =
        () => {

          console.log(
            "VOICE CONNECTION:",
            otherUid,
            pc.connectionState
          );


          publishState();


          if (
            pc.connectionState === "failed" ||
            pc.connectionState === "closed"
          ) {

            closePeer(
              otherUid
            );


            if (voiceActive) {

              setTimeout(
                () => sync(),
                700
              );
            }
          }


          if (
            pc.connectionState === "connected"
          ) {

            unlockRemoteAudios();
          }
        };


      pc.oniceconnectionstatechange =
        () => {

          console.log(
            "VOICE ICE:",
            otherUid,
            pc.iceConnectionState
          );


          publishState();


          if (
            pc.iceConnectionState === "failed"
          ) {

            closePeer(
              otherUid
            );


            if (voiceActive) {

              setTimeout(
                () => sync(),
                700
              );
            }
          }


          if (
            pc.iceConnectionState === "connected" ||
            pc.iceConnectionState === "completed"
          ) {

            unlockRemoteAudios();
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

      if (!pc) {
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
            pc._addedRemoteIce?.has(
              key
            )
          ) {
            continue;
          }


          try {

            await pc.addIceCandidate(

              new RTCIceCandidate(
                candidate
              )

            );


            pc._addedRemoteIce?.add(
              key
            );


          } catch (e) {

            /*
              أحياناً يصل ICE قبل remoteDescription.
              لا نحذف المفتاح حتى نحاول مرة ثانية.
            */

            console.warn(
              "addIceCandidate waiting",
              e
            );
          }
        }


      } catch (e) {

        console.warn(
          "read remote ice",
          e
        );
      }
    }


    // ========================================================
    // READ LIVE VOICE USERS
    // ========================================================

    async function readVoiceUsers() {

      try {

        const roomCode =
          getRoomCode();


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
          "readVoiceUsers",
          e
        );


        /*
          fallback:
          إذا فشلت القراءة المباشرة،
          نستخدم نسخة الغرفة الحالية.
        */

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


    // ========================================================
    // READ SIGNAL
    // ========================================================

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


      voiceSyncBusy = true;


      try {

        // --------------------------------------------
        // نقرأ الموجودين في الصوت مباشرة
        // --------------------------------------------

        const voiceUsers =
          await readVoiceUsers();


        const users =
          Object.keys(
            voiceUsers
          )
            .filter(otherUid => {

              return (
                otherUid !== uid &&
                voiceUsers[otherUid]?.active === true
              );

            });


        // --------------------------------------------
        // حذف Peer لمستخدم خرج من الصوت
        // --------------------------------------------

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


        // --------------------------------------------
        // إنشاء / تحديث الاتصالات
        // --------------------------------------------

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


            // =================================================
            // INITIATOR
            // =================================================

            if (initiator) {

              const signal =
                await readSignal(
                  pair
                );


              const liveOffer =
                signal.offer;


              /*
                ننشئ Offer جديد إذا:

                - لا يوجد Offer
                - أو الـ Offer ليس للجلسة الحالية
              */

              if (
                (
                  !liveOffer?.sdp ||
                  liveOffer.session !==
                    voiceSessionId
                ) &&
                pc.signalingState ===
                  "stable"
              ) {

                // تنظيف جواب قديم

                await remove(

                  ref(
                    db,
                    `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                  )

                ).catch(() => {});


                // تنظيف ICE القديم لهذا الزوج

                await remove(

                  ref(
                    db,
                    `rooms/${roomCode}/public/voiceSignals/${pair}/candidates`
                  )

                ).catch(() => {});


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
              }


              // --------------------------------------------
              // قراءة Answer
              // --------------------------------------------

              const answerSnap =
                await get(

                  ref(
                    db,
                    `rooms/${roomCode}/public/voiceSignals/${pair}/answer`
                  )

                );


              const answer =
                answerSnap.val();


              if (
                answer?.sdp &&
                answer.session ===
                  voiceSessionId &&
                !pc.currentRemoteDescription
              ) {

                await pc.setRemoteDescription(

                  new RTCSessionDescription({

                    type:
                      answer.type,

                    sdp:
                      answer.sdp

                  })

                );
              }


              if (
                pc.currentRemoteDescription
              ) {

                await addRemoteIce(
                  pc,
                  pair,
                  otherUid
                );
              }


            // =================================================
            // ANSWERER
            // =================================================

            } else {

              const signal =
                await readSignal(
                  pair
                );


              const offer =
                signal.offer;


              if (!offer?.sdp) {
                continue;
              }


              /*
                إذا الـ Peer الحالي مربوط بـ Offer قديم،
                نعيد إنشاء الاتصال.
              */

              if (
                pc._offerSession &&
                pc._offerSession !==
                  offer.session
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

                  new RTCSessionDescription({

                    type:
                      offer.type,

                    sdp:
                      offer.sdp

                  })

                );


                pc._offerSession =
                  offer.session || "";


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
                      offer.session || "",

                    ts:
                      Date.now()

                  }

                );
              }


              if (
                pc.currentRemoteDescription
              ) {

                await addRemoteIce(
                  pc,
                  pair,
                  otherUid
                );
              }
            }


          } catch (peerError) {

            console.warn(
              "voice peer sync",
              otherUid,
              peerError
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
    // FORCE RECONNECT
    // ========================================================

    async function reconnect() {

      if (!voiceActive) {
        return;
      }


      closeAllPeers();


      try {
        await clearMyVoiceSignals();
      } catch {}


      setTimeout(() => {

        if (voiceActive) {
          sync();
        }

      }, 250);
    }


    // ========================================================
    // PAGE CLEANUP
    // ========================================================

    function pageCleanup() {

      /*
        لا ننتظر Firebase هنا،
        فقط نوقف الصوت المحلي فوراً.
      */

      try {

        if (localVoiceStream) {

          localVoiceStream
            .getTracks()
            .forEach(track => {

              try {
                track.stop();
              } catch {}

            });
        }

      } catch {}


      try {
        closeAllPeers();
      } catch {}
    }


    window.addEventListener(
      "pagehide",
      pageCleanup
    );


    // ========================================================
    // RETURN CONTROLLER
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


  // ==========================================================
  // GLOBAL
  // ==========================================================

  window.SheikhVoice = {
    createVoiceController
  };


})();
