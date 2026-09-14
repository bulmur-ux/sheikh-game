// شيك شيك - نظام المايك المستقل (مدعوم بخوادم TURN و STUN المجانية للربط الفوري)
(function(){

  function createVoiceController(o){

    const {
      db, ref, get, set, update, push, remove,
      getRoomCode, getUid, getName, getCurrentRoom,
      toast, sleep, releaseWebAudio, stopRadio,
      onStateChange, onUiRefresh
    } = o;

    let voiceActive = false;
    let voiceStarting = false;
    let voiceMuted = false;

    let localVoiceStream = null;
    let voiceSyncBusy = false;
    let voiceSessionId = "";
    let voiceSyncTimer = null;

    const voicePeers = new Map();

    function publishState(){
      onStateChange?.({
        active: voiceActive,
        starting: voiceStarting,
        muted: voiceMuted,
        remoteCount: voiceRemoteCount()
      });

      onUiRefresh?.();
    }

    function pairIdFor(a,b){
      return [a,b].sort().join("__");
    }

    function voiceRemoteCount(){
      let n = 0;

      for(const pc of voicePeers.values()){
        if(pc.connectionState === "connected" || pc.connectionState === "completed"){
          n++;
        }
      }

      return n;
    }

    function isActive(){
      return voiceActive;
    }

    function isStarting(){
      return voiceStarting;
    }

    function isMuted(){
      return voiceMuted;
    }

    async function clearMyVoiceSignals(){
      try{
        const currentRoom = getCurrentRoom();
        const uid = getUid();
        const roomCode = getRoomCode();

        const players =
          Object.keys(currentRoom?.players || {})
          .filter(id => id !== uid);

        await Promise.all(
          players.map(other =>
            remove(
              ref(
                db,
                `rooms/${roomCode}/public/voiceSignals/${pairIdFor(uid,other)}`
              )
            ).catch(()=>{})
          )
        );
      }catch{}
    }

    async function start(){
      if(voiceActive || voiceStarting){
        toast(
          voiceActive
            ? "المايك شغال بالفعل"
            : "جاري فتح المايك..."
        );
        return;
      }

      voiceStarting = true;
      publishState();

      try{
        if(!window.isSecureContext){
          throw new Error("المايك يحتاج HTTPS");
        }

        if(!navigator.mediaDevices?.getUserMedia){
          throw new Error("المتصفح لا يدعم المايك");
        }

        try{
          stopRadio?.(false);
        }catch{}

        await releaseWebAudio?.();
        await sleep(250);

        localVoiceStream =
          await navigator.mediaDevices.getUserMedia({
            audio:{
              echoCancellation:true,
              noiseSuppression:true,
              autoGainControl:true
            },
            video:false
          });

        const tracks = localVoiceStream.getAudioTracks();
        if(!tracks.length){
          throw new Error("لم يتم العثور على مايك");
        }

        tracks.forEach(t => t.enabled = true);

        const uid = getUid();
        const roomCode = getRoomCode();
        const myName = getName();

        voiceSessionId = uid + "_" + Date.now();
        voiceActive = true;
        voiceStarting = false;
        voiceMuted = false;

        for(const pc of voicePeers.values()){
          try{ pc.close(); }catch{}
        }
        voicePeers.clear();

        await clearMyVoiceSignals();

        await update(
          ref(db, `rooms/${roomCode}/public/voiceUsers/${uid}`),
          {
            name: myName,
            active: true,
            muted: false,
            session: voiceSessionId,
            ts: Date.now()
          }
        );

        publishState();

        setTimeout(()=>sync(), 200);
        setTimeout(()=>sync(), 1000);
        setTimeout(()=>sync(), 2500);

        clearInterval(voiceSyncTimer);
        voiceSyncTimer = setInterval(()=>{
          if(voiceActive){
            sync();
          }
        }, 1500);

        toast("🎙️ المايك مفتوح — جاري الربط...");

      }catch(e){
        voiceStarting = false;
        voiceActive = false;
        voiceSessionId = "";

        if(localVoiceStream){
          for(const t of localVoiceStream.getTracks()){
            try{ t.stop(); }catch{}
          }
          localVoiceStream = null;
        }

        publishState();
        const raw = String(e?.message || "");
        let msg = e?.name === "NotAllowedError" ? "اسمح للمايك من إعدادات المتصفح" : "تعذر تشغيل المايك";
        if(raw){ msg += " — " + raw; }
        toast(msg);
      }
    }

    async function toggleMute(){
      if(!voiceActive || !localVoiceStream){ return; }

      voiceMuted = !voiceMuted;
      for(const t of localVoiceStream.getAudioTracks()){
        t.enabled = !voiceMuted;
      }

      try{
        await update(
          ref(db, `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`),
          {
            muted: voiceMuted,
            active: true,
            ts: Date.now()
          }
        );
      }catch{}

      publishState();
      toast(voiceMuted ? "تم كتم المايك" : "تم فتح المايك");
    }

    async function stop(removeState = true){
      const was = voiceActive;
      voiceActive = false;
      voiceStarting = false;
      voiceMuted = false;

      clearInterval(voiceSyncTimer);
      voiceSyncTimer = null;

      if(localVoiceStream){
        for(const t of localVoiceStream.getTracks()){
          try{ t.stop(); }catch{}
        }
        localVoiceStream = null;
      }

      for(const pc of voicePeers.values()){
        try{ pc.close(); }catch{}
      }
      voicePeers.clear();

      const box = document.getElementById("voiceAudios");
      if(box){ box.innerHTML = ""; }

      if(removeState && getRoomCode() && getUid()){
        try{
          await remove(ref(db, `rooms/${getRoomCode()}/public/voiceUsers/${getUid()}`));
          await clearMyVoiceSignals();
        }catch{}
      }

      voiceSessionId = "";
      publishState();

      if(was && removeState){
        toast("تم إيقاف الصوت المباشر");
      }
    }

    function attachRemoteAudio(otherUid, stream){
      const box = document.getElementById("voiceAudios");
      if(!box){ return; }

      let a = document.getElementById("voice_" + otherUid);
      if(!a){
        a = document.createElement("audio");
        a.id = "voice_" + otherUid;
        a.autoplay = true;
        a.playsInline = true;
        box.appendChild(a);
      }

      a.srcObject = stream;
      a.muted = false;
      a.volume = 1;

      const p = a.play();
      if(p?.catch){
        p.catch(()=>{
          toast("اضغط على الشاشة لتفعيل صوت الطرف الآخر");
        });
      }
    }

    async function makePeer(otherUid){
      if(voicePeers.has(otherUid) || !localVoiceStream){
        return voicePeers.get(otherUid);
      }

      const uid = getUid();
      const roomCode = getRoomCode();

      // دمج خوادم STUN و TURN المجانية المتاحة لتجاوز الجدران النارية نهائياً
      const pc = new RTCPeerConnection({
        iceServers:[
          {
            urls:[
              "stun:stun.l.google.com:19302",
              "stun:stun1.l.google.com:19302",
              "stun:stun.cloudflare.com:3478"
            ]
          },
          {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject"
          },
          {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject"
          }
        ],
        iceCandidatePoolSize: 10
      });

      voicePeers.set(otherUid, pc);
      pc._addedRemoteIce = new Set();

      for(const t of localVoiceStream.getTracks()){
        pc.addTrack(t, localVoiceStream);
      }

      pc.ontrack = e => {
        const st = e.streams?.[0] || new MediaStream([e.track]);
        attachRemoteAudio(otherUid, st);
      };

      pc.onicecandidate = e => {
        if(e.candidate){
          try{
            set(
              push(
                ref(db, `rooms/${roomCode}/public/voiceSignals/${pairIdFor(uid,otherUid)}/candidates/${uid}`)
              ),
              e.candidate.toJSON()
            );
          }catch{}
        }
      };

      pc.onconnectionstatechange = () => {
        publishState();
        if(["failed", "closed", "disconnected"].includes(pc.connectionState)){
          try{ pc.close(); }catch{}
          voicePeers.delete(otherUid);
          if(voiceActive){
            setTimeout(()=>sync(), 1000);
          }
        }
      };

      return pc;
    }

    async function addRemoteIce(pc, pair, otherUid){
      try{
        const snap = await get(
          ref(db, `rooms/${getRoomCode()}/public/voiceSignals/${pair}/candidates/${otherUid}`)
        );
        const all = snap.val() || {};

        for(const [k,c] of Object.entries(all)){
          if(pc._addedRemoteIce?.has(k)){ continue; }
          try{
            await pc.addIceCandidate(new RTCIceCandidate(c));
            pc._addedRemoteIce?.add(k);
          }catch{}
        }
      }catch{}
    }

    async function sync(){
      const currentRoom = getCurrentRoom();
      if(!voiceActive || !localVoiceStream || !currentRoom || voiceSyncBusy){
        return;
      }

      voiceSyncBusy = true;

      try{
        const uid = getUid();
        const roomCode = getRoomCode();
        const vu = currentRoom.voiceUsers || {};

        const players = Object.keys(vu).filter(id => id !== uid && vu[id]?.active);

        for(const otherUid of players){
          let pc = await makePeer(otherUid);
          if(!pc){ continue; }

          const pair = pairIdFor(uid, otherUid);
          const sig = currentRoom.voiceSignals?.[pair] || {};
          const initiator = uid < otherUid;

          if(initiator){
            const liveOffer = (
              await get(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/offer`))
            ).val();

            if((!liveOffer || liveOffer.session !== voiceSessionId) && pc.signalingState === "stable"){
              await remove(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/answer`)).catch(()=>{});

              const offer = await pc.createOffer({ offerToReceiveAudio: true, iceRestart: true });
              await pc.setLocalDescription(offer);

              await set(
                ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/offer`),
                {
                  type: pc.localDescription.type,
                  sdp: pc.localDescription.sdp,
                  from: uid,
                  session: voiceSessionId,
                  ts: Date.now()
                }
              );
            }

            const latest = (
              await get(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/answer`))
            ).val();

            if(latest?.sdp && latest.session === voiceSessionId && !pc.currentRemoteDescription){
              await pc.setRemoteDescription(
                new RTCSessionDescription({ type: latest.type, sdp: latest.sdp })
              );
            }

            await addRemoteIce(pc, pair, otherUid);

          }else{
            const offer = sig.offer || (
              await get(ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/offer`))
            ).val();

            if(offer?.sdp && !pc.currentRemoteDescription){
              await pc.setRemoteDescription(
                new RTCSessionDescription({ type: offer.type, sdp: offer.sdp })
              );

              const ans = await pc.createAnswer();
              await pc.setLocalDescription(ans);

              await set(
                ref(db, `rooms/${roomCode}/public/voiceSignals/${pair}/answer`),
                {
                  type: pc.localDescription.type,
                  sdp: pc.localDescription.sdp,
                  from: uid,
                  session: offer.session || "",
                  ts: Date.now()
                }
              );
            }

            await addRemoteIce(pc, pair, otherUid);
          }
        }
      }catch(e){
        console.warn("voice sync", e);
      }finally{
        voiceSyncBusy = false;
        publishState();
      }
    }

    return {
      start,
      stop,
      toggleMute,
      sync,
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
