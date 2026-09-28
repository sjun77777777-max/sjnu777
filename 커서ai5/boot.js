(function () {
  function setStatus(msg) {
    var root = document.getElementById("app-root");
    if (!root) return;
    var div = document.createElement("div");
    div.className = "card";
    div.innerHTML =
      '<div class="card__title">로딩 상태</div>' +
      '<div class="card__sub" style="margin-top:8px">현재 단계: <b>' +
      msg +
      "</b></div>" +
      '<div class="hint" style="margin-top:10px">이 카드가 보이면 클릭은 정상이고, 앱 스크립트 로딩/호환성 문제를 확인 중이에요.</div>';
    root.innerHTML = "";
    root.appendChild(div);
  }

  function supportsModernJS() {
    try {
      // Syntax checks (older browsers will throw on parse)
      // eslint-disable-next-line no-new-func
      new Function("const a = 1; let b = 2; return (a ?? b) && ({x:1}?.x);");
      if (!("Promise" in window)) return false;
      if (!("localStorage" in window)) return false;
      if (!("addEventListener" in window)) return false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function showUnsupported() {
    var root = document.getElementById("app-root");
    if (!root) return;
    var div = document.createElement("div");
    div.className = "card";
    div.innerHTML =
      '<div class="card__title">브라우저 호환성 문제</div>' +
      '<div class="card__sub" style="margin-top:8px">현재 브라우저가 이 앱을 실행할 수 없어서, 가입/로그인/클릭이 동작하지 않습니다.</div>' +
      '<div class="notice" style="margin-top:12px">' +
      '<div style="font-weight:900">해결 방법</div>' +
      '<div class="muted" style="margin-top:6px;font-size:12px;line-height:1.6">' +
      "- Windows에서 <b>Microsoft Edge</b> 또는 <b>Chrome</b>으로 열어주세요.<br/>" +
      "- 만약 ‘IE 모드’로 열렸다면 IE 모드를 끄고 다시 열어주세요.<br/>" +
      "- 학교 PC라 설치가 어렵다면, 담당 선생님께 기본 브라우저를 Edge로 바꿔달라고 요청하세요." +
      "</div></div>";
    root.innerHTML = "";
    root.appendChild(div);
  }

  function loadApp() {
    setStatus("app.js 불러오는 중");
    var s = document.createElement("script");
    s.src = "./app.js";
    s.async = true;
    s.onerror = function () {
      setStatus("app.js 로드 실패");
      showUnsupported();
    };
    document.body.appendChild(s);
  }

  setStatus("브라우저 검사 중");
  if (!supportsModernJS()) {
    setStatus("브라우저가 너무 오래됨");
    showUnsupported();
    return;
  }

  loadApp();
})();

