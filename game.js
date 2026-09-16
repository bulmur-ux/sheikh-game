// شيك شيك — طبقة تثبيت محرك الجولة
// مستقلة عن الحسابات/الدخول/الراديو/المايك.

export function createGameFlowUI(){
  let lastTurnKey = "";
  let noticeTimer = 0;

  function ensureNotice(){
    let el = document.getElementById("gameTurnNotice");

    if(el) return el;

    el = document.createElement("div");
    el.id = "gameTurnNotice";
    el.setAttribute("aria-live", "assertive");

    document.body.appendChild(el);

    return el;
  }

  function announceTurn({
    roundToken = "",
    turnSeq = 0,
    turnUid = "",
    myUid = "",
    name = "اللاعب"
  }){
    if(!turnUid) return;

    const key = `${roundToken}:${turnSeq}:${turnUid}`;

    // يمنع تكرار نفس تنبيه الدور
    // مع كل تحديث يصل من Firebase
    if(key === lastTurnKey) return;

    lastTurnKey = key;

    const el = ensureNotice();
    const mine = turnUid === myUid;

    // إذا الدور عند اللاعب نفسه
    if(mine){
      el.textContent = `⚡ الدور عندك يا ${name}`;
    }else{
      el.textContent = `🎴 الدور عند ${name}`;
    }

    el.className = mine ? "show mine" : "show";

    clearTimeout(noticeTimer);

    noticeTimer = setTimeout(() => {
      el.className = "";
    }, 2600);

    // اهتزاز خفيف على جهاز صاحب الدور
    if(mine){
      try{
        navigator.vibrate?.(80);
      }catch(e){}
    }
  }

  function syncMemorize({
    phase,
    myHand,
    memorizeUntil
  }){
    // مرحلة كشف أول ورقتين
    if(phase !== "memorize"){
      return {
        active: false,
        remaining: 0,
        waitingForHand: false
      };
    }

    // الوقت موحد بين جميع اللاعبين
    // ويعتمد على وقت نهاية واحد للجولة
    const remaining = Math.max(
      0,
      Math.ceil(
        (Number(memorizeUntil || 0) - Date.now()) / 1000
      )
    );

    return {
      active: true,
      remaining,
      waitingForHand: !myHand
    };
  }

  return {
    announceTurn,
    syncMemorize
  };
}
