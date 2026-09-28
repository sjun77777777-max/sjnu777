/**
 * 스쿨 럭키포인트 - Google Apps Script 서버
 *
 * 사용법(요약)
 * 1) Google Drive에서 새 스프레드시트 생성 (예: "스쿨 럭키포인트 DB")
 * 2) 확장 프로그램 > Apps Script 열기
 * 3) 이 파일 내용을 그대로 붙여넣고 저장
 * 4) 배포 > 새 배포 > 웹 앱
 *    - 실행: 나
 *    - 액세스: 모든 사용자
 * 5) 배포 URL을 앱(설정 탭)의 "온라인 API URL"에 붙여넣기
 *
 * 데이터 처리: doPost(JSON 문자열). Content-Type 은 text/plain 으로 와도 postData.contents 로 동일 처리(브라우저 CORS 사전요청 완화).
 * 브라우저로 URL만 열면 GET이라 doGet에서 안내 페이지를 돌려줍니다.
 * 요청 본문: JSON { action: "...", ... }
 * 응답: JSON { ok: true/false, ... }
 *
 * 주요 action: ping, signup, login, public_students, public_school_config,
 * student_self_apply, student_change_pin, student_ledger, teacher_set_pin, teacher_login(옵션 schoolName 시 메타+명단 동봉), teacher_students, teacher_add_students, teacher_award,
 * teacher_monthly_grant, teacher_get_meta, teacher_set_meta, teacher_set_trusted,
 * teacher_reset_student_pin, teacher_delete_students
 */

const SHEET_STUDENTS = "students";
const SHEET_LEDGER = "ledger";
const SHEET_SETTINGS = "settings";

function ensureSheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let st = ss.getSheetByName(SHEET_STUDENTS);
  if (!st) st = ss.insertSheet(SHEET_STUDENTS);
  if (st.getLastRow() === 0) {
    st.appendRow([
      "id",
      "schoolName",
      "name",
      "className",
      "pinHash",
      "merits",
      "offsets",
      "demerits",
      "trusted",
      "lastMonthlyGrantYYYYMM",
      "createdAt",
    ]);
  }

  let lg = ss.getSheetByName(SHEET_LEDGER);
  if (!lg) lg = ss.insertSheet(SHEET_LEDGER);
  if (lg.getLastRow() === 0) {
    lg.appendRow([
      "id",
      "at",
      "studentId",
      "type",
      "deltaMerits",
      "deltaOffsets",
      "deltaDemerits",
      "note",
      "schoolName",
    ]);
  }

  let set = ss.getSheetByName(SHEET_SETTINGS);
  if (!set) set = ss.insertSheet(SHEET_SETTINGS);
  if (set.getLastRow() === 0) {
    set.appendRow(["key", "value"]);
    // teacherPinHash는 비어있을 수 있음(앱에서 설정)
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSettings_() {
  ensureSheets_();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  const values = sh.getDataRange().getValues(); // header 포함
  const out = {};
  for (let i = 1; i < values.length; i++) {
    const k = String(values[i][0] || "").trim();
    const v = String(values[i][1] || "");
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function setSetting_(key, value) {
  ensureSheets_();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || "").trim() === key) {
      sh.getRange(i + 1, 2).setValue(String(value ?? ""));
      return;
    }
  }
  sh.appendRow([key, String(value ?? "")]);
}

function uid_() {
  return Utilities.getUuid();
}

function yyyymm_() {
  const d = new Date();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  return String(d.getFullYear()) + m;
}

function hashPin_(pin) {
  // 클라이언트와 동일한 간단 해시(FNV-1a 32bit)
  const p = String(pin || "").replace(/\s+/g, "");
  if (p.length < 4 || p.length > 12) return null;
  let h = 2166136261;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = (h >>> 0).toString(16);
  return ("00000000" + u).slice(-8);
}

/** 날짜 서식 셀이 Date로 오인되지 않게, 사용자에게 보이는 문자열로 읽음 */
function readStudentsDisplayRows_() {
  ensureSheets_();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
  return sh.getDataRange().getDisplayValues();
}

function cellBoolTrue_(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "y" || s === "예";
}

function numCell_(v) {
  return Number(String(v ?? "").replace(/,/g, "") || 0);
}

function schoolNoticeFromSettings_(settings) {
  const s = settings || getSettings_();
  return {
    schoolNotice: String(s.schoolNotice || "").slice(0, 200),
    schoolNoticeAt: String(s.schoolNoticeAt || ""),
  };
}

function statReportsFromSettings_(settings) {
  const s = settings || getSettings_();
  let reports = [];
  try {
    const raw = String(s.statReportsJson || "").trim();
    if (raw) reports = JSON.parse(raw);
  } catch (e) {
    reports = [];
  }
  if (!Array.isArray(reports)) reports = [];
  return {
    statReports: reports,
    activeStatReportId: String(s.activeStatReportId || ""),
  };
}

/** 홈용: 반 평균·상점 상위·최근 7일 상점(벌점 없음) */
function computeHomeStats_(schoolName, settings) {
  ensureSheets_();
  const sn = String(schoolName || "").trim();
  const stValues = readStudentsDisplayRows_();
  const students = [];
  const byId = {};
  for (let i = 1; i < stValues.length; i++) {
    if (sn && String(stValues[i][1] || "").trim() !== sn) continue;
    const s = {
      id: String(stValues[i][0]),
      name: String(stValues[i][2] ?? "").trim(),
      className: String(stValues[i][3] ?? "").trim(),
      merits: numCell_(stValues[i][5]),
    };
    if (!s.name) continue;
    students.push(s);
    byId[s.id] = s;
  }

  const classMap = {};
  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    const c = s.className || "(반 미정)";
    if (!classMap[c]) classMap[c] = { className: c, count: 0, sum: 0 };
    classMap[c].count++;
    classMap[c].sum += s.merits;
  }

  let threshold = 6;
  try {
    const raw = settings && settings.classPolicyJson != null ? settings.classPolicyJson : getSettings_().classPolicyJson;
    const cp = JSON.parse(String(raw || "{}"));
    if (cp && isFinite(Number(cp.specialActivityThresholdAvgMerits))) {
      threshold = Number(cp.specialActivityThresholdAvgMerits);
    }
  } catch (e) {
    threshold = 6;
  }

  const classNames = Object.keys(classMap).sort();
  const classes = [];
  for (let i = 0; i < classNames.length; i++) {
    const g = classMap[classNames[i]];
    const avg = g.count ? g.sum / g.count : 0;
    classes.push({
      className: g.className,
      count: g.count,
      avgMerits: Math.round(avg * 100) / 100,
      specialOk: avg >= threshold,
    });
  }

  const topMerits = students
    .slice()
    .sort(function (a, b) {
      return b.merits - a.merits;
    })
    .filter(function (s) {
      return s.merits > 0;
    })
    .slice(0, 5)
    .map(function (s) {
      return { name: s.name, className: s.className, merits: s.merits };
    });

  const weekly = {};
  const lg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LEDGER);
  if (lg && lg.getLastRow() > 1) {
    const lv = lg.getDataRange().getDisplayValues();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (let i = 1; i < lv.length; i++) {
      const dm = numCell_(lv[i][4]);
      if (dm <= 0) continue;
      const sid = String(lv[i][2] || "");
      if (!byId[sid]) continue;
      const at = Date.parse(String(lv[i][1] || ""));
      if (!isFinite(at) || at < cutoff) continue;
      weekly[sid] = (weekly[sid] || 0) + dm;
    }
  }

  const weeklyIds = Object.keys(weekly);
  const weeklyTop = weeklyIds
    .map(function (id) {
      return { name: byId[id].name, className: byId[id].className, gained: weekly[id] };
    })
    .sort(function (a, b) {
      return b.gained - a.gained;
    })
    .slice(0, 5);

  return { classes: classes, topMerits: topMerits, weeklyTop: weeklyTop, threshold: threshold };
}

function findStudentRow_(schoolName, name, className) {
  ensureSheets_();
  const values = readStudentsDisplayRows_();
  for (let i = 1; i < values.length; i++) {
    if (
      String(values[i][1] || "").trim() === String(schoolName || "").trim() &&
      String(values[i][2] || "").trim() === String(name || "").trim() &&
      String(values[i][3] || "").trim() === String(className || "").trim()
    ) {
      return { row: i + 1, data: values[i] };
    }
  }
  return null;
}

function getStudentById_(id) {
  ensureSheets_();
  const values = readStudentsDisplayRows_();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) return { row: i + 1, data: values[i] };
  }
  return null;
}

function addLedger_(entry) {
  ensureSheets_();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LEDGER);
  sh.appendRow([
    entry.id || uid_(),
    entry.at || new Date().toISOString(),
    entry.studentId || "",
    entry.type || "adjust",
    Number(entry.deltaMerits || 0),
    Number(entry.deltaOffsets || 0),
    Number(entry.deltaDemerits || 0),
    entry.note || "",
    entry.schoolName || "",
  ]);
}

/**
 * 브라우저 주소창으로 웹앱 URL을 열면 GET 요청이 옵니다.
 * doPost만 있으면 "함수 doGet을 찾을 수 없습니다" 류 오류가 나므로 안내 HTML을 반환합니다.
 */
function doGet() {
  const html =
    "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"/><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/><title>스쿨 럭키포인트 API</title></head>" +
    "<body style=\"font-family:system-ui,sans-serif;line-height:1.55;padding:20px;max-width:640px;margin:0 auto\">" +
    "<h1 style=\"font-size:1.25rem\">서버는 정상입니다</h1>" +
    "<p>이 주소는 <strong>앱 화면</strong>이 아니라, <strong>스쿨 럭키포인트</strong> 앱이 쓰는 <strong>API(배포 URL)</strong>입니다.</p>" +
    "<ul>" +
    "<li><strong>앱</strong>은 <code>index.html</code>을 더블클릭하지 말고, <strong>https(또는 http) 주소</strong>로 여세요. 학교 홈페이지·GitHub Pages에 올리거나, 폴더에서 로컬 서버를 켜면 됩니다.</li>" +
    "<li>앱에는 웹앱 주소를 미리 넣어 배포할 수도 있고, 같은 폴더의 <code>cloud-config.json</code>에 <code>apiUrl</code>만 두면 자동으로 연결될 수 있어요. 수동으로 넣을 때는 <strong>설정 → API URL</strong>에 이 주소(<code>.../exec</code>)를 붙여넣으세요.</li>" +
    "<li>같은 스프레드시트를 쓰는 사람들은 <strong>학교 이름</strong>만 학생회와 똑같이 맞추면 됩니다.</li>" +
    "<li>테스트용 <code>/dev</code> URL은 로그인한 본인만 열 수 있어요. 학생·학부모에게는 <strong>배포</strong> URL을 쓰는 것이 좋습니다.</li>" +
    "</ul>" +
    "<p style=\"color:#555;font-size:14px\">앱에서 &ldquo;연결 테스트&rdquo;를 누르면 POST 통신이 되는지 확인할 수 있어요.</p>" +
    "</body></html>";
  return ContentService.createTextOutput(html).setMimeType(ContentService.MimeType.HTML);
}

function doPost(e) {
  ensureSheets_();
  let body = {};
  try {
    const raw = e.postData && e.postData.contents ? e.postData.contents : "{}";
    body = JSON.parse(raw);
  } catch (err) {
    return json_({ ok: false, error: "invalid_json" });
  }

  const action = String(body.action || "");

  if (action === "ping") {
    return json_({ ok: true, now: new Date().toISOString(), yyyymm: yyyymm_() });
  }

  if (action === "teacher_set_pin") {
    const pin = String(body.pin || "");
    const h = hashPin_(pin);
    if (!h) return json_({ ok: false, error: "bad_pin" });
    const settings = getSettings_();
    const stored = String(settings.teacherPinHash || "").trim();
    const oneTimeUsed = String(settings.teacherPinOneTimeResetUsed || "").trim() === "true";
    if (stored) {
      const currentH = hashPin_(String(body.currentPin || ""));
      const currentOk = !!(currentH && currentH === stored);
      const wantOneTime = body.oneTimeReset === true || body.oneTimeReset === "true";
      if (currentOk) {
        // 로그인한 뒤 현재 PIN으로 변경
      } else if (wantOneTime && !oneTimeUsed) {
        setSetting_("teacherPinOneTimeResetUsed", "true");
      } else if (wantOneTime && oneTimeUsed) {
        return json_({ ok: false, error: "one_time_reset_used" });
      } else {
        return json_({ ok: false, error: "need_current_pin" });
      }
    }
    setSetting_("teacherPinHash", h);
    return json_({ ok: true });
  }

  if (action === "teacher_login") {
    const settings = getSettings_();
    const stored = String(settings.teacherPinHash || "");
    if (!stored) return json_({ ok: false, error: "no_teacher_pin" });
    const h = hashPin_(String(body.pin || ""));
    if (!h) return json_({ ok: false, error: "bad_pin" });
    if (h !== stored) return json_({ ok: false, error: "wrong_pin" });

    /** quick: true 이면 PIN 확인만 하고 즉시 반환(로그인 체감 속도 개선) */
    if (body.quick) {
      return json_({ ok: true, quick: true });
    }

    /** 한 번의 요청으로 클라이언트가 teacher_get_meta + teacher_students를 대체할 수 있게 함(웹앱 콜드스타트 비용 절감) */
    const schoolName = String(body.schoolName || "").trim();
    const values = readStudentsDisplayRows_();
    const students = [];
    for (let i = 1; i < values.length; i++) {
      if (schoolName && String(values[i][1] || "").trim() !== schoolName) continue;
      students.push({
        id: String(values[i][0]),
        schoolName: String(values[i][1] ?? "").trim(),
        name: String(values[i][2] ?? "").trim(),
        className: String(values[i][3] ?? "").trim(),
        merits: numCell_(values[i][5]),
        offsets: numCell_(values[i][6]),
        demerits: numCell_(values[i][7]),
        trusted: cellBoolTrue_(values[i][8]),
        lastMonthlyGrantYYYYMM: String(values[i][9] || "").trim() || null,
      });
    }
    let classPolicy = null;
    let rewardCatalog = null;
    try {
      const cp = String(settings.classPolicyJson || "").trim();
      if (cp) classPolicy = JSON.parse(cp);
    } catch (e) {
      classPolicy = null;
    }
    try {
      const rc = String(settings.rewardCatalogJson || "").trim();
      if (rc) rewardCatalog = JSON.parse(rc);
    } catch (e) {
      rewardCatalog = null;
    }
    const notice = schoolNoticeFromSettings_(settings);
    const stats = statReportsFromSettings_(settings);
    return json_({
      ok: true,
      students: students,
      classPolicy: classPolicy,
      rewardCatalog: rewardCatalog,
      schoolNotice: notice.schoolNotice,
      schoolNoticeAt: notice.schoolNoticeAt,
      statReports: stats.statReports,
      activeStatReportId: stats.activeStatReportId,
    });
  }

  if (action === "signup") {
    const schoolName = String(body.schoolName || "").trim();
    const name = String(body.name || "").trim();
    const className = String(body.className || "").trim();
    const pin = String(body.pin || "");
    if (!schoolName || !name || !className) return json_({ ok: false, error: "missing_fields" });
    const h = hashPin_(pin);
    if (!h) return json_({ ok: false, error: "bad_pin" });

    const existed = findStudentRow_(schoolName, name, className);
    if (!existed) return json_({ ok: false, error: "not_on_roster" });
    const pinHash = String(existed.data[4] || "").trim();
    if (pinHash) return json_({ ok: false, error: "already_exists" });

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    sh.getRange(existed.row, 5).setValue(h);
    return json_({
      ok: true,
      student: {
        id: String(existed.data[0]),
        schoolName: String(existed.data[1] ?? "").trim(),
        name: String(existed.data[2] ?? "").trim(),
        className: String(existed.data[3] ?? "").trim(),
        merits: Number(existed.data[5] || 0),
        offsets: Number(existed.data[6] || 0),
        demerits: Number(existed.data[7] || 0),
        lastMonthlyGrantYYYYMM: String(existed.data[9] || "").trim() || null,
      },
    });
  }

  if (action === "login") {
    const schoolName = String(body.schoolName || "").trim();
    const name = String(body.name || "").trim();
    const className = String(body.className || "").trim();
    const pin = String(body.pin || "");
    if (!schoolName || !name || !className) return json_({ ok: false, error: "missing_fields" });
    const row = findStudentRow_(schoolName, name, className);
    if (!row) return json_({ ok: false, error: "not_found" });
    const pinHash = String(row.data[4] || "");
    const h = hashPin_(pin);
    if (!h) return json_({ ok: false, error: "bad_pin" });
    if (!pinHash) {
      return json_({ ok: false, error: "need_signup" });
    }
    if (h !== pinHash) {
      return json_({ ok: false, error: "wrong_pin" });
    }

    return json_({
      ok: true,
      student: {
        id: String(row.data[0]),
        schoolName: String(row.data[1]),
        name: String(row.data[2]),
        className: String(row.data[3]),
        merits: Number(row.data[5] || 0),
        offsets: Number(row.data[6] || 0),
        demerits: Number(row.data[7] || 0),
        lastMonthlyGrantYYYYMM: String(row.data[9] || "").trim() || null,
      },
    });
  }

  if (action === "public_students") {
    const schoolName = String(body.schoolName || "").trim();
    if (!schoolName) return json_({ ok: false, error: "missing_school" });
    const values = readStudentsDisplayRows_();
    /** 같은 학교에서 이름+반 같으면 한 줄만(시트에 중복 행이 있어도). 아래쪽 행이 위를 덮어씀 */
    const byPerson = new Map();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][1] || "").trim() !== schoolName) continue;
      const name = String(values[i][2] ?? "").trim();
      const className = String(values[i][3] ?? "").trim();
      if (!name) continue;
      const id = String(values[i][0] || "").trim();
      const pKey = (name + "|" + className).toLowerCase();
      byPerson.set(pKey, {
        id: id || pKey,
        name: name,
        className: className,
        merits: numCell_(values[i][5]),
      });
    }
    return json_({ ok: true, students: Array.from(byPerson.values()) });
  }

  if (action === "public_school_config") {
    const settings = getSettings_();
    let classPolicy = null;
    let rewardCatalog = null;
    try {
      const cp = String(settings.classPolicyJson || "").trim();
      if (cp) classPolicy = JSON.parse(cp);
    } catch (e) {
      classPolicy = null;
    }
    try {
      const rc = String(settings.rewardCatalogJson || "").trim();
      if (rc) rewardCatalog = JSON.parse(rc);
    } catch (e) {
      rewardCatalog = null;
    }
    const notice = schoolNoticeFromSettings_(settings);
    const stats = statReportsFromSettings_(settings);
    const schoolName = String(body.schoolName || "").trim();
    const teacherPinSet = !!String(settings.teacherPinHash || "").trim();
    const oneTimeUsed = String(settings.teacherPinOneTimeResetUsed || "").trim() === "true";
    return json_({
      ok: true,
      classPolicy: classPolicy,
      rewardCatalog: rewardCatalog,
      schoolNotice: notice.schoolNotice,
      schoolNoticeAt: notice.schoolNoticeAt,
      homeStats: computeHomeStats_(schoolName, settings),
      statReports: stats.statReports,
      activeStatReportId: stats.activeStatReportId,
      teacherPinOneTimeResetUsed: oneTimeUsed,
      teacherPinOneTimeResetAvailable: teacherPinSet && !oneTimeUsed,
    });
  }

  if (action === "student_change_pin") {
    const studentId = String(body.studentId || "").trim();
    const currentPin = String(body.currentPin || "");
    const pin = String(body.pin || "");
    if (!studentId) return json_({ ok: false, error: "missing_student" });
    const currentH = hashPin_(currentPin);
    const newH = hashPin_(pin);
    if (!currentH || !newH) return json_({ ok: false, error: "bad_pin" });
    const st = getStudentById_(studentId);
    if (!st) return json_({ ok: false, error: "not_found" });
    const pinHash = String(st.data[4] || "").trim();
    if (!pinHash) return json_({ ok: false, error: "need_signup" });
    if (currentH !== pinHash) return json_({ ok: false, error: "wrong_pin" });
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    sh.getRange(st.row, 5).setValue(newH);
    return json_({ ok: true });
  }

  if (action === "student_self_apply") {
    const studentId = String(body.studentId || "").trim();
    const pin = String(body.pin || "");
    if (!studentId) return json_({ ok: false, error: "missing_student" });
    const h = hashPin_(pin);
    if (!h) return json_({ ok: false, error: "bad_pin" });
    const st = getStudentById_(studentId);
    if (!st) return json_({ ok: false, error: "not_found" });
    const pinHash = String(st.data[4] || "");
    if (!pinHash || h !== pinHash) return json_({ ok: false, error: "wrong_pin" });

    const dm = Number(body.deltaMerits || 0);
    const dof = Number(body.deltaOffsets || 0);
    const dd = Number(body.deltaDemerits || 0);
    const note = String(body.note || "");
    const type = String(body.type || "student_self");
    if (type !== "reward_buy" && type !== "reward_use") {
      return json_({ ok: false, error: "forbidden_type" });
    }
    if (isNaN(dm) || isNaN(dof) || isNaN(dd)) return json_({ ok: false, error: "bad_delta" });
    if (dof !== 0 || dd !== 0) return json_({ ok: false, error: "student_cannot_change_points" });
    if (type === "reward_use" && dm !== 0) return json_({ ok: false, error: "reward_use_no_delta" });
    if (type === "reward_buy" && !(dm < 0)) return json_({ ok: false, error: "reward_buy_must_spend" });
    if (dm > 0) return json_({ ok: false, error: "student_cannot_increase" });

    const merits0 = Number(st.data[5] || 0);
    const offsets0 = Number(st.data[6] || 0);
    const demerits0 = Number(st.data[7] || 0);

    const merits = Math.max(0, merits0 + dm);
    const offsets = Math.max(0, offsets0 + dof);
    const demerits = Math.max(0, demerits0 + dd);

    if (merits !== merits0 + dm) return json_({ ok: false, error: "merits_insufficient" });
    if (offsets !== offsets0 + dof) return json_({ ok: false, error: "offsets_insufficient" });
    if (demerits !== demerits0 + dd) return json_({ ok: false, error: "demerits_insufficient" });

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    sh.getRange(st.row, 6).setValue(merits);
    sh.getRange(st.row, 7).setValue(offsets);
    sh.getRange(st.row, 8).setValue(demerits);

    addLedger_({
      studentId: studentId,
      type: type,
      deltaMerits: dm,
      deltaOffsets: dof,
      deltaDemerits: dd,
      note: note,
      schoolName: String(st.data[1] || ""),
    });

    return json_({
      ok: true,
      student: {
        id: studentId,
        schoolName: String(st.data[1] || ""),
        name: String(st.data[2] || ""),
        className: String(st.data[3] || ""),
        merits: merits,
        offsets: offsets,
        demerits: demerits,
      },
    });
  }

  if (action === "student_ledger") {
    const studentId = String(body.studentId || "").trim();
    const pin = String(body.pin || "");
    if (!studentId) return json_({ ok: false, error: "missing_student" });
    const h = hashPin_(pin);
    if (!h) return json_({ ok: false, error: "bad_pin" });
    const st = getStudentById_(studentId);
    if (!st) return json_({ ok: false, error: "not_found" });
    const pinHash = String(st.data[4] || "");
    if (!pinHash || h !== pinHash) return json_({ ok: false, error: "wrong_pin" });

    ensureSheets_();
    const lg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LEDGER);
    const out = [];
    if (lg && lg.getLastRow() > 1) {
      const values = lg.getDataRange().getDisplayValues();
      for (let i = values.length - 1; i >= 1; i--) {
        if (String(values[i][2] || "") !== studentId) continue;
        out.push({
          id: String(values[i][0] || ""),
          at: String(values[i][1] || ""),
          studentId: studentId,
          type: String(values[i][3] || ""),
          deltaMerits: numCell_(values[i][4]),
          deltaOffsets: numCell_(values[i][5]),
          deltaDemerits: numCell_(values[i][6]),
          note: String(values[i][7] || ""),
        });
        if (out.length >= 120) break;
      }
    }
    return json_({ ok: true, ledger: out });
  }

  // ---- teacher-only actions (requires teacher pin in request) ----
  function requireTeacher_() {
    const settings = getSettings_();
    const stored = String(settings.teacherPinHash || "");
    if (!stored) return { ok: false, error: "no_teacher_pin" };
    const h = hashPin_(String(body.teacherPin || ""));
    if (!h) return { ok: false, error: "bad_pin" };
    if (h !== stored) return { ok: false, error: "unauthorized" };
    return { ok: true };
  }

  if (action === "teacher_add_students") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const schoolName = String(body.schoolName || "").trim();
    if (!schoolName) return json_({ ok: false, error: "missing_school" });
    let list = Array.isArray(body.students) ? body.students : [];
    if (!list.length && body.name && body.className) {
      list = [{ name: body.name, className: body.className }];
    }
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    const added = [];
    const skipped = [];
    for (let i = 0; i < list.length && i < 400; i++) {
      const name = String(list[i].name || "").trim();
      const className = String(list[i].className || "").trim();
      if (!name || !className) continue;
      const found = findStudentRow_(schoolName, name, className);
      if (found) {
        skipped.push({
          id: String(found.data[0] || ""),
          name: name,
          className: className,
          reason: "already_exists",
        });
        continue;
      }
      const id = uid_();
      sh.appendRow([id, schoolName, name, className, "", 0, 0, 0, false, "", new Date().toISOString()]);
      added.push({
        id: id,
        schoolName: schoolName,
        name: name,
        className: className,
        merits: 0,
        offsets: 0,
        demerits: 0,
        lastMonthlyGrantYYYYMM: null,
      });
    }
    return json_({ ok: true, students: added, skipped: skipped });
  }

  if (action === "teacher_delete_students") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const schoolName = String(body.schoolName || "").trim();
    const ids = [];
    if (Array.isArray(body.studentIds)) {
      for (let i = 0; i < body.studentIds.length; i++) ids.push(String(body.studentIds[i] || ""));
    }
    if (body.studentId) ids.push(String(body.studentId));
    const people = Array.isArray(body.students) ? body.students : [];
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    if (!sh) return json_({ ok: false, error: "no_sheet" });
    const values = readStudentsDisplayRows_();
    const rowsToDelete = [];
    const seen = {};
    for (let r = 1; r < values.length; r++) {
      const id = String(values[r][0] || "");
      const sc = String(values[r][1] || "").trim();
      const nm = String(values[r][2] || "").trim();
      const cl = String(values[r][3] || "").trim();
      if (schoolName && sc && sc !== schoolName) continue;
      let hit = false;
      for (let j = 0; j < ids.length; j++) {
        if (ids[j] && ids[j] === id) {
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (let k = 0; k < people.length; k++) {
          if (String(people[k].name || "").trim() === nm && String(people[k].className || "").trim() === cl) {
            hit = true;
            break;
          }
        }
      }
      if (hit && !seen[r + 1]) {
        seen[r + 1] = true;
        rowsToDelete.push({ row: r + 1, data: values[r] });
      }
    }
    rowsToDelete.sort(function (a, b) {
      return b.row - a.row;
    });
    for (let d = 0; d < rowsToDelete.length; d++) {
      addLedger_({
        studentId: String(rowsToDelete[d].data[0] || ""),
        type: "student_delete",
        note: "학생 명단 삭제",
        schoolName: String(rowsToDelete[d].data[1] || schoolName || ""),
      });
      sh.deleteRow(rowsToDelete[d].row);
    }
    return json_({ ok: true, deleted: rowsToDelete.length });
  }

  if (action === "teacher_students") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const schoolName = String(body.schoolName || "").trim();
    const className = String(body.className || "").trim();
    const values = readStudentsDisplayRows_();
    const out = [];
    for (let i = 1; i < values.length; i++) {
      if (schoolName && String(values[i][1] || "").trim() !== schoolName) continue;
      if (className && String(values[i][3] || "").trim() !== className) continue;
      out.push({
        id: String(values[i][0]),
        schoolName: String(values[i][1] ?? "").trim(),
        name: String(values[i][2] ?? "").trim(),
        className: String(values[i][3] ?? "").trim(),
        merits: numCell_(values[i][5]),
        offsets: numCell_(values[i][6]),
        demerits: numCell_(values[i][7]),
        trusted: cellBoolTrue_(values[i][8]),
        lastMonthlyGrantYYYYMM: String(values[i][9] || "").trim() || null,
      });
    }
    return json_({ ok: true, students: out });
  }

  if (action === "teacher_award") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const studentId = String(body.studentId || "");
    const scopeClass = String(body.className || "").trim();
    const dm = Number(body.deltaMerits || 0);
    const dof = Number(body.deltaOffsets || 0);
    const dd = Number(body.deltaDemerits || 0);
    const note = String(body.note || "");
    const st = getStudentById_(studentId);
    if (!st) return json_({ ok: false, error: "not_found" });
    if (scopeClass && scopeClass !== "*" && String(st.data[3] || "").trim() !== scopeClass) {
      return json_({ ok: false, error: "wrong_class" });
    }

    const merits = Math.max(0, Number(st.data[5] || 0) + dm);
    const offsets = Math.max(0, Number(st.data[6] || 0) + dof);
    const demerits = Math.max(0, Number(st.data[7] || 0) + dd);

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    sh.getRange(st.row, 6).setValue(merits);
    sh.getRange(st.row, 7).setValue(offsets);
    sh.getRange(st.row, 8).setValue(demerits);

    const ledgerType = String(body.ledgerType || "teacher_award").trim() || "teacher_award";
    addLedger_({
      studentId: studentId,
      type: ledgerType,
      deltaMerits: dm,
      deltaOffsets: dof,
      deltaDemerits: dd,
      note: note,
      schoolName: String(st.data[1] || ""),
    });

    return json_({ ok: true, student: { id: studentId, merits: merits, offsets: offsets, demerits: demerits } });
  }

  if (action === "teacher_monthly_grant") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const studentId = String(body.studentId || "");
    const st = getStudentById_(studentId);
    if (!st) return json_({ ok: false, error: "not_found" });
    if (!cellBoolTrue_(st.data[8])) return json_({ ok: false, error: "not_trusted" });
    const cur = yyyymm_();
    const last = String(st.data[9] || "").trim();
    if (last === cur) return json_({ ok: false, error: "already_granted_month" });

    const merits = Math.max(0, Number(st.data[5] || 0) + 1);
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    sh.getRange(st.row, 6).setValue(merits);
    sh.getRange(st.row, 10).setValue(cur);

    addLedger_({
      studentId: studentId,
      type: "monthly_grant",
      deltaMerits: 1,
      deltaOffsets: 0,
      deltaDemerits: 0,
      note: "월 1회 상점 지급",
      schoolName: String(st.data[1] || ""),
    });

    return json_({
      ok: true,
      student: {
        id: studentId,
        merits: merits,
        offsets: Number(st.data[6] || 0),
        demerits: Number(st.data[7] || 0),
        lastMonthlyGrantYYYYMM: cur,
      },
    });
  }

  if (action === "teacher_get_meta") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const settings = getSettings_();
    let classPolicy = null;
    let rewardCatalog = null;
    try {
      const cp = String(settings.classPolicyJson || "").trim();
      if (cp) classPolicy = JSON.parse(cp);
    } catch (e) {
      classPolicy = null;
    }
    try {
      const rc = String(settings.rewardCatalogJson || "").trim();
      if (rc) rewardCatalog = JSON.parse(rc);
    } catch (e) {
      rewardCatalog = null;
    }
    const notice = schoolNoticeFromSettings_(settings);
    const stats = statReportsFromSettings_(settings);
    return json_({
      ok: true,
      classPolicy: classPolicy,
      rewardCatalog: rewardCatalog,
      schoolNotice: notice.schoolNotice,
      schoolNoticeAt: notice.schoolNoticeAt,
      statReports: stats.statReports,
      activeStatReportId: stats.activeStatReportId,
    });
  }

  if (action === "teacher_set_meta") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    if (body.classPolicy != null) {
      try {
        setSetting_("classPolicyJson", JSON.stringify(body.classPolicy));
      } catch (e) {
        return json_({ ok: false, error: "bad_class_policy" });
      }
    }
    if (body.rewardCatalog != null) {
      try {
        setSetting_("rewardCatalogJson", JSON.stringify(body.rewardCatalog));
      } catch (e) {
        return json_({ ok: false, error: "bad_reward_catalog" });
      }
    }
    if (body.schoolNotice != null) {
      setSetting_("schoolNotice", String(body.schoolNotice).slice(0, 200));
      setSetting_("schoolNoticeAt", new Date().toISOString());
    }
    if (body.statReports != null) {
      try {
        const packed = JSON.stringify(body.statReports);
        if (packed.length > 48000) return json_({ ok: false, error: "stat_too_large" });
        setSetting_("statReportsJson", packed);
      } catch (e) {
        return json_({ ok: false, error: "bad_stat_reports" });
      }
    }
    if (body.activeStatReportId != null) {
      setSetting_("activeStatReportId", String(body.activeStatReportId || ""));
    }
    return json_({ ok: true });
  }

  if (action === "teacher_set_trusted") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const studentId = String(body.studentId || "");
    const trusted = !!body.trusted;
    const st = getStudentById_(studentId);
    if (!st) return json_({ ok: false, error: "not_found" });
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    sh.getRange(st.row, 9).setValue(trusted ? "true" : "false");
    return json_({ ok: true, student: { id: studentId, trusted: trusted } });
  }

  if (action === "teacher_reset_student_pin") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const studentId = String(body.studentId || "");
    const st = getStudentById_(studentId);
    if (!st) return json_({ ok: false, error: "not_found" });
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_STUDENTS);
    sh.getRange(st.row, 5).setValue("");
    return json_({ ok: true });
  }

  if (action === "teacher_wipe_records") {
    const auth = requireTeacher_();
    if (!auth.ok) return json_(auth);
    const schoolName = String(body.schoolName || "").trim();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const shStudents = ss.getSheetByName(SHEET_STUDENTS);
    const shLedger = ss.getSheetByName(SHEET_LEDGER);
    let wipedStudents = 0;
    let wipedLedger = 0;

    if (shStudents) {
      const values = shStudents.getDataRange().getValues();
      if (values.length > 1) {
        if (!schoolName) {
          shStudents.getRange(2, 1, values.length - 1, values[0].length).clearContent();
          wipedStudents = values.length - 1;
        } else {
          for (let i = values.length - 1; i >= 1; i--) {
            if (String(values[i][1] || "").trim() === schoolName) {
              shStudents.deleteRow(i + 1);
              wipedStudents++;
            }
          }
        }
      }
    }

    if (shLedger) {
      const values = shLedger.getDataRange().getValues();
      if (values.length > 1) {
        if (!schoolName) {
          shLedger.getRange(2, 1, values.length - 1, values[0].length).clearContent();
          wipedLedger = values.length - 1;
        } else {
          for (let i = values.length - 1; i >= 1; i--) {
            if (String(values[i][8] || "").trim() === schoolName) {
              shLedger.deleteRow(i + 1);
              wipedLedger++;
            }
          }
        }
      }
    }

    return json_({ ok: true, wipedStudents: wipedStudents, wipedLedger: wipedLedger });
  }

  return json_({ ok: false, error: "unknown_action" });
}

