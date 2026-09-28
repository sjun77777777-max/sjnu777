const STORAGE_KEY = "school-lucky-point.v1";
const SESSION_KEY = "school-lucky-point.session.v1";
/** 학교 배포용으로 연습 학생·구매·통계를 한 번 비웠다는 표시 */
const DEPLOY_CLEAN_MARK = "school-deploy-2026-09-17";

/** 학생·학생회는 동시에 로그인하지 않음. 로그아웃 후 다른 계정으로 전환 가능 */
function clearOppositeSession_(role) {
  if (role === "student") {
    session.teacherAuthed = false;
    session.teacherPinForApi = null;
    session.teacherClassName = null;
  } else if (role === "teacher") {
    session.studentId = null;
    session.studentPinForApi = null;
  }
}

/** 이미 로그인 중이면 다른 가입/로그인 차단 */
function guardNoActiveLogin(actionLabel) {
  if (session.studentId) {
    alert(`학생으로 로그인 중이에요.\n다른 계정·역할로 쓰려면 먼저 로그아웃한 뒤 ${actionLabel}해 주세요.`);
    return false;
  }
  if (session.teacherAuthed) {
    alert(`학생회로 로그인 중이에요.\n다른 계정·역할로 쓰려면 먼저 로그아웃한 뒤 ${actionLabel}해 주세요.`);
    return false;
  }
  return true;
}

/**
 * 한 학교·한 스프레드시트용 웹앱 /exec URL 과 기본 학교 이름.
 * 비우면 설정에서 URL·학교 이름을 직접 넣는 방식으로 돌아갑니다.
 * (같은 폴더의 cloud-config.json 에 "apiUrl" 만 있어도 됩니다.)
 */
const DEFAULT_CLOUD_API_URL =
  "https://script.google.com/macros/s/AKfycbzEq2GF7M9vkubC7pBRBSYjXqgsjKFimA3GnCodycN09x7S_EeOkNZQ9bteTXdSL92feA/exec";

/** 저장된 학교 이름이 없을 때 쓰는 기본값(해연중학교 배포본) */
const DEFAULT_SCHOOL_NAME = "해연중학교";

function defaultSchoolNameResolved_() {
  const s = String(DEFAULT_SCHOOL_NAME || "").trim();
  return s || null;
}

/**
 * Data model (stored in localStorage)
 * - students: { id, schoolName, name, className, merits, offsets, demerits, trusted, lastMonthlyGrantYYYYMM, pinHash }
 * - ledger:   { id, at, studentId, type, deltaMerits, deltaOffsets, deltaDemerits, note }
 * - rewardCatalog: 보상 목록(학생회가 설정, 로컬+온라인 동기화)
 * - auth:     teacherPinHash (stored in state.settings, UI는 학생회 PIN)
 * - meta.statReports: 업로드한 엑셀/CSV 통계 자료
 */

const LUNCH_PRIORITY_ID = "lunch_priority";
const LUNCH_BUDDY_EXTRA_MERITS = 3;
const LUNCH_BUDDY_MAX = 8;

const defaultRewardCatalog = [
  {
    id: "worksheet_reprint",
    title: "학습지 재발급권",
    costMerits: 2,
    detail: "잃어버린 학습지 1부를 원하는 과목으로 재발급(구매 시 메모에 과목 적기)",
  },
  {
    id: "book_reprint",
    title: "책 재발급권",
    costMerits: 3,
    detail: "잃어버린 교과서 1부를 원하는 과목으로 재발급(구매 시 메모에 과목 적기)",
  },
  {
    id: LUNCH_PRIORITY_ID,
    title: "급식 우선권",
    costMerits: 6,
    detail: "급식 줄 우선 입장 1회. 친구를 데려가면 1명당 상점 3점 추가",
  },
];

function cloneDefaultRewards() {
  return JSON.parse(JSON.stringify(defaultRewardCatalog));
}

const STOCK_REWARD_IDS = new Set([
  "homework_pass",
  "errand_skip",
  "praise_card",
  "honor_nominate",
  "board_message",
  "chore_skip",
  "seat_swap",
  "broadcast_song",
  "boardgame_rent",
  "music_request",
  "seat_choice",
  "lost_material_reprint",
  "gym_lunch",
  "snack_coupon",
  "lunch_buddy",
  "class_event",
  "class_movie",
  ...defaultRewardCatalog.map((r) => r.id),
]);

/** 기본 상점 목록이면 최종 3종으로 맞춘다. 학생회가 직접 만든 보상은 유지 */
function migrateRewardCatalog_(catalog) {
  const next = cloneDefaultRewards();
  if (!Array.isArray(catalog) || !catalog.length) return next;
  const looksLikeStock = catalog.every((x) => !x || !x.id || STOCK_REWARD_IDS.has(x.id));
  if (looksLikeStock) return next;
  const cleaned = catalog.filter((x) => x && x.id && x.id !== "homework_pass");
  return cleaned.length ? cleaned : next;
}

function clampLunchBuddyCount_(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(v, LUNCH_BUDDY_MAX);
}

function rewardPurchaseCost_(reward, buddyCount) {
  const base = Number(reward?.costMerits) || 0;
  if (!reward || reward.id !== LUNCH_PRIORITY_ID) return base;
  return base + LUNCH_BUDDY_EXTRA_MERITS * clampLunchBuddyCount_(buddyCount);
}

function rewardPurchaseTitle_(reward, buddyCount) {
  const title = String(reward?.title || "보상");
  if (!reward || reward.id !== LUNCH_PRIORITY_ID) return title;
  const n = clampLunchBuddyCount_(buddyCount);
  if (n <= 0) return title;
  return `${title} (친구 ${n}명 동행)`;
}

function rewardPriceLabel_(reward) {
  return String(reward?.costMerits ?? 0);
}

function sortedRewardCatalog_() {
  return state.rewardCatalog
    .slice()
    .sort((a, b) => Number(a.costMerits) - Number(b.costMerits) || String(a.title).localeCompare(String(b.title), "ko"));
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function nowISO() {
  return new Date().toISOString();
}

function yyyymm(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

function clampNonNeg(n) {
  return Math.max(0, Number.isFinite(n) ? n : 0);
}

/** 예전 데모 데이터(김하나·이두나, 학교 없음·2-3·PIN 없음)만 로드 시 제거 */
function stripLegacyDemoStudents_(students) {
  if (!Array.isArray(students)) return [];
  return students.filter((s) => {
    const nm = String(s.name || "");
    if (nm !== "김하나" && nm !== "이두나") return true;
    if (String(s.className || "") !== "2-3") return true;
    if (String(s.schoolName || "").trim()) return true;
    if (s.pinHash) return true;
    return false;
  });
}

function applySchoolDeployClean_(st) {
  if (!st || !st.meta) return st;
  if (String(st.meta.deployCleanMark || "") === DEPLOY_CLEAN_MARK) return st;
  st.students = [];
  st.ledger = [];
  st.meta.publicStudentsCache = null;
  st.meta.publicStudentsCacheAt = null;
  st.meta.statReports = [];
  st.meta.activeStatReportId = null;
  st.meta.appliedStatGrants = [];
  st.meta.deletedStudents = [];
  st.meta.homeStats = null;
  st.meta.homeStatsAt = null;
  st.meta.schoolNotice = "";
  st.meta.schoolNoticeAt = null;
  st.meta.blockServerRosterRestore = true;
  st.meta.pendingServerWipe = true;
  st.meta.deployCleanMark = DEPLOY_CLEAN_MARK;
  st.meta.deployCleanToast = true;
  return st;
}

async function maybeWipeServerDemoData_() {
  if (!state.meta?.pendingServerWipe) return true;
  if (!onlineEnabled()) return false;
  if (!session.teacherPinForApi) return false;
  const res = await wipeServerRecordsIfPossible_();
  if (!res.ok) return false;
  await pushTeacherMetaToServer({
    statReports: [],
    activeStatReportId: "",
    schoolNotice: "",
  });
  state.students = [];
  state.ledger = [];
  state.meta.statReports = [];
  state.meta.activeStatReportId = null;
  state.meta.appliedStatGrants = [];
  state.meta.deletedStudents = [];
  state.meta.publicStudentsCache = null;
  state.meta.publicStudentsCacheAt = null;
  state.meta.homeStats = null;
  state.meta.homeStatsAt = null;
  state.meta.schoolNotice = "";
  state.meta.schoolNoticeAt = null;
  state.meta.pendingServerWipe = false;
  state.meta.blockServerRosterRestore = false;
  flushSaveState();
  return true;
}

function allowServerRosterRestore_() {
  if (state.meta?.pendingServerWipe) return false;
  if (!state.meta?.blockServerRosterRestore) return true;
  if (!session.teacherAuthed) return false;
  state.meta.blockServerRosterRestore = false;
  return true;
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedState();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return seedState();
    if (!Array.isArray(parsed.students) || !Array.isArray(parsed.ledger)) return seedState();
    const studentsRaw = stripLegacyDemoStudents_(parsed.students);
    const loaded = {
      version: 4,
      students: dedupeStudentsList(studentsRaw),
      ledger: parsed.ledger,
      classPolicy: parsed.classPolicy ?? {
        meritsToOffset: 5,
        offsetCancelsDemerits: 1,
        specialActivityThresholdAvgMerits: 6,
      },
      rewardCatalog: migrateRewardCatalog_(parsed.rewardCatalog),
      settings: {
        ...(parsed.settings && typeof parsed.settings === "object" ? parsed.settings : { teacherPinHash: null }),
        teacherPinOneTimeResetUsed: !!(parsed.settings && parsed.settings.teacherPinOneTimeResetUsed),
        teacherPinLocked: !!(parsed.settings && parsed.settings.teacherPinLocked),
      },
      meta: (() => {
        const m = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {};
        const savedSchool = m.schoolName != null ? String(m.schoolName).trim() : "";
        const savedApi = m.apiUrl != null ? String(m.apiUrl).trim() : "";
        return {
          schoolName: savedSchool || defaultSchoolNameResolved_() || null,
          apiUrl: savedApi || null,
          publicStudentsCache: m.publicStudentsCache ?? null,
          publicStudentsCacheAt: m.publicStudentsCacheAt ?? null,
          blockServerRosterRestore: !!m.blockServerRosterRestore,
          schoolNotice: m.schoolNotice != null ? String(m.schoolNotice).slice(0, 200) : "",
          schoolNoticeAt: m.schoolNoticeAt ?? null,
          homeStats: m.homeStats && typeof m.homeStats === "object" ? m.homeStats : null,
          homeStatsAt: m.homeStatsAt ?? null,
          statReports: normalizeStatReports_(m.statReports),
          activeStatReportId: m.activeStatReportId != null ? String(m.activeStatReportId) : null,
          appliedStatGrants: Array.isArray(m.appliedStatGrants) ? m.appliedStatGrants.map(String).slice(-2000) : [],
          deletedStudents: normalizeDeletedStudents_(m.deletedStudents),
          deployCleanMark: m.deployCleanMark != null ? String(m.deployCleanMark) : "",
          pendingServerWipe: !!m.pendingServerWipe,
          deployCleanToast: !!m.deployCleanToast,
          teacherPinOneTimeResetAvailable: m.teacherPinOneTimeResetAvailable === true ? true : m.teacherPinOneTimeResetAvailable === false ? false : null,
        };
      })(),
    };
    return applySchoolDeployClean_(loaded);
  } catch {
    return seedState();
  }
}

let saveStateTimer = null;
let sessionSaveTimer = null;
let studentsNeedDedupe = true;
let lastTeacherRosterSyncAt = 0;
let lastPublicStudentsFetchAt = 0;

/** localStorage 저장은 무겁기 때문에 묶어서 저장 */
function saveState(state) {
  if (saveStateTimer) clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      // ignore
    }
  }, 280);
}

function scheduleSaveSession() {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    try {
      saveSession();
    } catch (_) {
      // ignore
    }
  }, 200);
}

function markStudentsDirty() {
  studentsNeedDedupe = true;
  saveState(state);
}

function flushSaveState() {
  if (saveStateTimer) {
    clearTimeout(saveStateTimer);
    saveStateTimer = null;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (_) {
    // ignore
  }
}

function seedState() {
  return {
    version: 4,
    students: [],
    ledger: [],
    classPolicy: {
      meritsToOffset: 5,
      offsetCancelsDemerits: 1,
      specialActivityThresholdAvgMerits: 6,
    },
    rewardCatalog: cloneDefaultRewards(),
    settings: {
      teacherPinHash: null,
      teacherPinOneTimeResetUsed: false,
      teacherPinLocked: false,
    },
    meta: {
      schoolName: defaultSchoolNameResolved_() || null,
      apiUrl: null,
      publicStudentsCache: null,
      publicStudentsCacheAt: null,
      blockServerRosterRestore: false,
      schoolNotice: "",
      schoolNoticeAt: null,
      homeStats: null,
      homeStatsAt: null,
      statReports: [],
      activeStatReportId: null,
      appliedStatGrants: [],
      deletedStudents: [],
      deployCleanMark: DEPLOY_CLEAN_MARK,
      pendingServerWipe: false,
      deployCleanToast: false,
      teacherPinOneTimeResetAvailable: null,
    },
  };
}

function defaultApiUrlResolved_() {
  const d = String(DEFAULT_CLOUD_API_URL || "").trim();
  if (!d) return null;
  if (!/^https?:\/\//i.test(d)) return "https://" + d.replace(/^\/+/, "");
  return d.replace(/\/+$/, "");
}

function apiUrl() {
  const u = state.meta && state.meta.apiUrl ? String(state.meta.apiUrl).trim() : "";
  if (u) return u;
  return defaultApiUrlResolved_();
}

/** 저장 시 공백 제거, http(s) 보정 */
function normalizeApiUrlInput(raw) {
  let u = String(raw || "").trim().replace(/\s+/g, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/+$/, "");
}

/** localStorage 에 URL이 없을 때만, 옆에 두는 cloud-config.json 으로 API 주소 채움 */
async function hydrateCloudApiUrlFromDisk_() {
  if (state.meta?.apiUrl && String(state.meta.apiUrl).trim()) return;
  if (defaultApiUrlResolved_()) return;
  try {
    const r = await fetch("./cloud-config.json", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    const raw = j && j.apiUrl != null ? String(j.apiUrl) : "";
    const u = normalizeApiUrlInput(raw);
    if (!u) return;
    state.meta.apiUrl = u;
    flushSaveState();
    render();
  } catch (_) {
    // 없거나 막힌 경우 — 로컬만 쓰면 됨
  }
}

function shortApiUrlLabel() {
  const u = apiUrl();
  if (!u) return "";
  try {
    const host = new URL(u).host;
    return host.length > 28 ? host.slice(0, 26) + "…" : host;
  } catch {
    return "연결됨";
  }
}

async function apiCall(action, payload) {
  const url = apiUrl();
  if (!url) return { ok: false, error: "no_api_url" };
  try {
    /** application/json 은 CORS 사전요청(OPTIONS)을 유발해, 교육망/일부 기기에서 막히는 경우가 많음. 본문은 JSON 그대로 두고 단순 요청으로 보냄 */
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action, ...payload }),
      mode: "cors",
      credentials: "omit",
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        error: "http_error",
        httpStatus: res.status,
        detail: (text || "").replace(/\s+/g, " ").trim().slice(0, 240),
      };
    }
    if (!data || typeof data !== "object") {
      return {
        ok: false,
        error: "bad_response",
        detail: (text || "").replace(/\s+/g, " ").trim().slice(0, 240),
      };
    }
    return data;
  } catch (e) {
    return {
      ok: false,
      error: "network_error",
      detail: e && e.message ? String(e.message) : String(e),
    };
  }
}

function onlineEnabled() {
  return !!apiUrl();
}

function sameStudentIdentity_(s, schoolName, name, className) {
  return (
    String(s?.schoolName || "").trim() === String(schoolName || "").trim() &&
    String(s?.name || "").trim() === String(name || "").trim() &&
    String(s?.className || "").trim() === String(className || "").trim()
  );
}

function findRosterSeat_(schoolName, name, className) {
  return state.students.find((s) => sameStudentIdentity_(s, schoolName, name, className)) || null;
}

function studentHasPin_(s) {
  return !!(s && String(s.pinHash || "").trim());
}

function parseRosterLines_(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[,;\t]/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      out.push({ name: parts[0], className: parts.slice(1).join(" ") });
      continue;
    }
    const m = line.match(/^(.+?)\s+(\S+)$/);
    if (m) out.push({ name: m[1].trim(), className: m[2].trim() });
  }
  return out;
}

function getStudent(state, studentId) {
  return state.students.find((s) => s.id === studentId) ?? null;
}

function normalizeClassName(c) {
  return String(c ?? "").trim();
}

/** 담당 반이 없으면 빈 목록(로그인 시 선택 필요). '*' 이면 전체 */
function studentsInTeacherScope(students = state.students) {
  const cls = normalizeClassName(session.teacherClassName);
  if (!cls) return [];
  if (cls === "*") return students.slice();
  return students.filter((s) => normalizeClassName(s.className) === cls);
}

function listClassNames(students = state.students) {
  const set = new Set();
  for (const s of students) {
    const c = normalizeClassName(s.className);
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
}

function groupStudentsByClass(students) {
  const map = new Map();
  for (const s of students) {
    const c = normalizeClassName(s.className) || "(반 미정)";
    if (!map.has(c)) map.set(c, []);
    map.get(c).push(s);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0], "ko"));
}

function teacherScopeLabel() {
  const cls = normalizeClassName(session.teacherClassName);
  if (!cls) return "담당 반 미선택";
  if (cls === "*") return "전체 반";
  return `${cls}반`;
}

function normPin(pin) {
  const p = String(pin ?? "").replace(/\s+/g, "");
  if (!p) return null;
  if (p.length < 4) return null;
  if (p.length > 12) return null;
  return p;
}

/** 학교·이름·반 동일 또는 id 중복인 로컬 행을 한 명으로 합침 */
function studentTripleKey(s) {
  return `${String(s.schoolName ?? "").trim()}|${String(s.name ?? "").trim()}|${String(s.className ?? "").trim()}`.toLowerCase();
}

function normalizeDeletedStudents_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (!x) return null;
      if (typeof x === "string") return { id: x, key: "", at: "" };
      return {
        id: String(x.id || ""),
        key: String(x.key || ""),
        at: x.at || "",
      };
    })
    .filter((x) => x && (x.id || x.key))
    .slice(-2000);
}

function deletedStudents_() {
  if (!state.meta.deletedStudents) state.meta.deletedStudents = [];
  state.meta.deletedStudents = normalizeDeletedStudents_(state.meta.deletedStudents);
  return state.meta.deletedStudents;
}

function rememberDeletedStudent_(s) {
  if (!s) return;
  const list = deletedStudents_();
  const id = String(s.id || "");
  const key = studentTripleKey(s);
  const next = list.filter((x) => x.id !== id && !(key && key !== "||" && x.key === key));
  next.push({ id, key, at: nowISO() });
  state.meta.deletedStudents = next.slice(-2000);
}

function forgetDeletedStudent_(s) {
  if (!s) return;
  const id = String(s.id || "");
  const key = studentTripleKey(s);
  state.meta.deletedStudents = deletedStudents_().filter((x) => {
    if (id && x.id === id) return false;
    if (key && key !== "||" && x.key === key) return false;
    return true;
  });
}

function isDeletedStudent_(s) {
  if (!s) return false;
  const id = String(s.id || "");
  const key = studentTripleKey(s);
  return deletedStudents_().some((x) => (id && x.id === id) || (key && key !== "||" && x.key === key));
}

function mergeStudentRowPrefer(a, b) {
  const id = a.id === session.studentId ? a.id : b.id === session.studentId ? b.id : String(a.id) <= String(b.id) ? a.id : b.id;
  return {
    ...a,
    ...b,
    id,
    merits: Math.max(Number(a.merits || 0), Number(b.merits || 0)),
    offsets: Math.max(Number(a.offsets || 0), Number(b.offsets || 0)),
    demerits: Math.max(Number(a.demerits || 0), Number(b.demerits || 0)),
    trusted: !!(a.trusted || b.trusted),
    lastMonthlyGrantYYYYMM: a.lastMonthlyGrantYYYYMM || b.lastMonthlyGrantYYYYMM || null,
    pinHash: a.pinHash ?? b.pinHash ?? null,
    schoolName: a.schoolName || b.schoolName,
    name: a.name || b.name,
    className: a.className || b.className,
  };
}

function dedupeStudentsList(students) {
  const list = Array.isArray(students) ? students.filter((s) => s && s.id) : [];
  const byId = new Map();
  for (const s of list) {
    if (!byId.has(s.id)) byId.set(s.id, { ...s });
    else byId.set(s.id, mergeStudentRowPrefer(byId.get(s.id), s));
  }
  const arr = Array.from(byId.values());
  const tripleMap = new Map();
  for (const s of arr) {
    const k = studentTripleKey(s);
    if (!k || k === "||") {
      tripleMap.set(`id:${s.id}`, { ...s });
      continue;
    }
    if (!tripleMap.has(k)) tripleMap.set(k, { ...s });
    else tripleMap.set(k, mergeStudentRowPrefer(tripleMap.get(k), s));
  }
  return Array.from(tripleMap.values());
}

// Not cryptographically secure, but good enough for local/offline demo
function hashPin(pin) {
  const p = normPin(pin);
  if (!p) return null;
  let h = 2166136261;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function addLedger(state, entry) {
  state.ledger.unshift({
    id: uid(),
    at: nowISO(),
    deltaMerits: 0,
    deltaOffsets: 0,
    deltaDemerits: 0,
    note: "",
    ...entry,
  });
}

function applyDelta(state, studentId, { merits = 0, offsets = 0, demerits = 0 }, meta) {
  const s = getStudent(state, studentId);
  if (!s) return { ok: false, error: "학생을 찾을 수 없어요." };

  const nextMerits = clampNonNeg(s.merits + merits);
  const nextOffsets = clampNonNeg(s.offsets + offsets);
  const nextDemerits = clampNonNeg(s.demerits + demerits);

  // Prevent spending beyond available
  if (merits < 0 && nextMerits !== s.merits + merits) {
    return { ok: false, error: "상점이 부족해요." };
  }
  if (offsets < 0 && nextOffsets !== s.offsets + offsets) {
    return { ok: false, error: "상쇄점이 부족해요." };
  }
  if (demerits < 0 && nextDemerits !== s.demerits + demerits) {
    return { ok: false, error: "벌점이 부족해요." };
  }

  s.merits = nextMerits;
  s.offsets = nextOffsets;
  s.demerits = nextDemerits;

  addLedger(state, {
    studentId,
    type: meta?.type ?? "adjust",
    deltaMerits: merits,
    deltaOffsets: offsets,
    deltaDemerits: demerits,
    note: meta?.note ?? "",
  });

  markStudentsDirty();
  return { ok: true };
}

function couponTag(id, rewardId, title) {
  const safeTitle = String(title || "").replace(/[\]|]/g, "").slice(0, 40);
  return `[쿠폰:${id}|${rewardId || ""}|${safeTitle}]`;
}

function parseCouponTag(note) {
  const m = String(note || "").match(/\[쿠폰:([^\]|]+)(?:\|([^\]|]*)\|([^\]]*))?\]/);
  if (!m) return null;
  return { id: m[1], rewardId: m[2] || "", title: m[3] || "" };
}

function titleFromRewardNote(note) {
  const t = parseCouponTag(note);
  if (t && t.title) return t.title;
  const cleaned = String(note || "")
    .replace(/\s*\[쿠폰:[^\]]+\]\s*/g, "")
    .replace(/\s*·\s*.*$/, "")
    .replace(/\s*구매\s*$/, "")
    .trim();
  return cleaned || "보상";
}

function listCouponsForStudent(studentId) {
  const buys = state.ledger.filter((l) => l.studentId === studentId && l.type === "reward_buy");
  const usedById = new Map();
  for (const l of state.ledger) {
    if (l.studentId !== studentId || l.type !== "reward_use") continue;
    const t = parseCouponTag(l.note);
    if (t && t.id) usedById.set(t.id, l.at);
  }
  const byId = new Map();
  for (const b of buys) {
    const t = parseCouponTag(b.note);
    const id = (t && t.id) || b.id;
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      studentId,
      rewardId: (t && t.rewardId) || "",
      title: (t && t.title) || titleFromRewardNote(b.note),
      at: b.at,
      usedAt: usedById.get(id) || null,
    });
  }
  return [...byId.values()].sort((a, b) => {
    if (!!a.usedAt !== !!b.usedAt) return a.usedAt ? 1 : -1;
    return String(b.at || "").localeCompare(String(a.at || ""));
  });
}

function mergeLedgerRows_(rows) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const have = new Set(state.ledger.map((l) => String(l.id || "")));
  let added = false;
  for (const row of rows) {
    const id = String((row && row.id) || "");
    if (!id || have.has(id)) continue;
    state.ledger.push({
      id,
      at: row.at || nowISO(),
      studentId: row.studentId,
      type: row.type || "adjust",
      deltaMerits: Number(row.deltaMerits || 0),
      deltaOffsets: Number(row.deltaOffsets || 0),
      deltaDemerits: Number(row.deltaDemerits || 0),
      note: row.note || "",
    });
    have.add(id);
    added = true;
  }
  if (added) {
    state.ledger.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    saveState(state);
  }
  return added;
}

async function pullStudentLedger_() {
  if (!onlineEnabled() || !session.studentId || !session.studentPinForApi) return;
  const res = await apiCall("student_ledger", { studentId: session.studentId, pin: session.studentPinForApi });
  if (!res || !res.ok) return;
  if (mergeLedgerRows_(res.ledger || []) && (route === "students" || route === "rewards")) render();
}

function computeHomeStatsLocal_(pool) {
  const list = Array.isArray(pool) ? pool : state.students;
  const threshold = Number(state.classPolicy.specialActivityThresholdAvgMerits || 6);
  const groups = groupStudentsByClass(list);
  const classes = groups.map(([className, students]) => {
    const count = students.length;
    const sum = students.reduce((a, s) => a + Number(s.merits || 0), 0);
    const avg = count ? sum / count : 0;
    return { className, count, avgMerits: Math.round(avg * 100) / 100, specialOk: avg >= threshold };
  });
  const topMerits = [...list]
    .filter((s) => Number(s.merits) > 0)
    .sort((a, b) => Number(b.merits) - Number(a.merits))
    .slice(0, 5)
    .map((s) => ({ name: s.name, className: s.className, merits: s.merits }));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekly = new Map();
  for (const l of state.ledger) {
    if (Number(l.deltaMerits || 0) <= 0) continue;
    const at = Date.parse(String(l.at || ""));
    if (!Number.isFinite(at) || at < cutoff) continue;
    weekly.set(l.studentId, (weekly.get(l.studentId) || 0) + Number(l.deltaMerits));
  }
  const weeklyTop = [...weekly.entries()]
    .map(([id, gained]) => {
      const s = getStudent(state, id);
      if (!s) return null;
      return { name: s.name, className: s.className, gained };
    })
    .filter(Boolean)
    .sort((a, b) => b.gained - a.gained)
    .slice(0, 5);
  return { classes, topMerits, weeklyTop, threshold };
}

function homeStatsForDisplay_() {
  const cached = state.meta && state.meta.homeStats;
  const hasCached =
    cached &&
    ((Array.isArray(cached.classes) && cached.classes.length) ||
      (Array.isArray(cached.topMerits) && cached.topMerits.length) ||
      (Array.isArray(cached.weeklyTop) && cached.weeklyTop.length));
  if (hasCached) return cached;
  return computeHomeStatsLocal_(state.students);
}

const STAT_MAX_REPORTS = 12;
const STAT_MAX_SHEETS = 6;
const STAT_MAX_COLS = 24;
const STAT_MAX_ROWS = 600;
const STAT_MAX_CELL = 80;

function normalizeStatReports_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object")
    .slice(0, STAT_MAX_REPORTS)
    .map((r) => {
      const uploadedAt = r.uploadedAt || nowISO();
      return {
        id: String(r.id || uid()),
        title: String(r.title || r.fileName || "통계 자료").slice(0, 80),
        fileName: String(r.fileName || "").slice(0, 120),
        uploadedAt,
        sheets: stampStatSheetsUploadDate_(normalizeStatSheets_(r.sheets), uploadedAt),
      };
    })
    .filter((r) => r.sheets.length);
}

function normalizeStatSheets_(sheets) {
  if (!Array.isArray(sheets)) return [];
  return sheets
    .filter((s) => s && typeof s === "object")
    .slice(0, STAT_MAX_SHEETS)
    .map((s) =>
      polishStatSheet_({
        name: String(s.name || "시트").slice(0, 40),
        headers: (Array.isArray(s.headers) ? s.headers : []).slice(0, STAT_MAX_COLS).map((h) => String(h ?? "").slice(0, STAT_MAX_CELL)),
        rows: (Array.isArray(s.rows) ? s.rows : [])
          .slice(0, STAT_MAX_ROWS)
          .map((row) => (Array.isArray(row) ? row : []).slice(0, STAT_MAX_COLS).map((c) => String(c ?? "").slice(0, STAT_MAX_CELL))),
      })
    )
    .filter((s) => s.headers.length || s.rows.length);
}

function listStatReports_() {
  return normalizeStatReports_(state.meta && state.meta.statReports);
}

let viewingStatReportId_ = null;

function viewingStatReport_() {
  const reports = listStatReports_();
  if (!reports.length) return null;
  const id = viewingStatReportId_ || (state.meta && state.meta.activeStatReportId);
  return reports.find((r) => r.id === id) || reports[0];
}

function selectStatReport_(id) {
  const reports = listStatReports_();
  if (!reports.some((r) => r.id === id)) return;
  viewingStatReportId_ = id;
  if (state.meta) state.meta.activeStatReportId = id;
  saveState(state);
  render();
}

function activeStatReport_() {
  return viewingStatReport_();
}

function renderStatReportPager_(report) {
  const reports = listStatReports_();
  if (reports.length < 2 || !report) return null;
  const idx = Math.max(0, reports.findIndex((r) => r.id === report.id));
  const older = reports[idx + 1];
  const newer = reports[idx - 1];
  const pick = el(
    "select",
    {
      class: "stat-pager__pick",
      "aria-label": "통계 자료 선택",
      onChange: (e) => selectStatReport_(e.target.value),
    },
    reports.map((r) =>
      el("option", { value: r.id, selected: r.id === report.id }, [
        document.createTextNode(`${r.title || r.fileName || "통계 자료"} · ${fmtDate(r.uploadedAt)}`),
      ])
    )
  );
  return el("div", { class: "stat-pager" }, [
    el(
      "button",
      {
        class: "btn",
        disabled: !older,
        onClick: () => older && selectStatReport_(older.id),
      },
      [document.createTextNode("이전 자료")]
    ),
    el("div", { class: "stat-pager__mid" }, [
      el("div", { class: "stat-pager__count" }, [document.createTextNode(`${idx + 1} / ${reports.length}`)]),
      pick,
    ]),
    el(
      "button",
      {
        class: "btn",
        disabled: !newer,
        onClick: () => newer && selectStatReport_(newer.id),
      },
      [document.createTextNode("최근 자료")]
    ),
  ]);
}

function compactStatReports_(reports) {
  return normalizeStatReports_(reports);
}

function parseLooseNumber_(v) {
  let s = normalizeStatText_(v)
    .replace(/,/g, "")
    .replace(/%$/, "")
    .replace(/[점개]$/g, "")
    .replace(/^[+＋]/, "");
  if (!s || s === "-" || s === "—" || s === "–") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatText_(v) {
  let s = String(v ?? "");
  s = s.replace(/\uFEFF|\u200B|\u200C|\u200D|\u00A0/g, " ");
  s = s.replace(/[\uFF10-\uFF19]/g, (ch) => String(ch.charCodeAt(0) - 0xff10));
  s = s.replace(/[\uFF21-\uFF3A]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[\uFF41-\uFF5A]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[／⁄]/g, "/").replace(/[－–—~～]/g, "-").replace(/[．｡]/g, ".");
  s = s.replace(/[ \t\r\n]+/g, " ").trim();
  return s;
}

function trimEmptyStatColumns_(headers, rows) {
  const width = Math.max(headers.length, ...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 0);
  if (!width) return { headers, rows };
  let left = 0;
  let right = width - 1;
  const colEmpty = (i) =>
    !String(headers[i] || "").trim() && rows.every((r) => !String((r && r[i]) || "").trim());
  while (left <= right && colEmpty(left)) left += 1;
  while (right >= left && colEmpty(right)) right -= 1;
  if (left === 0 && right === width - 1) return { headers, rows };
  return {
    headers: headers.slice(left, right + 1),
    rows: rows.map((r) => (Array.isArray(r) ? r.slice(left, right + 1) : r)),
  };
}

function rowLooksLikeSummary_(row) {
  const first = normalizeStatText_((row || [])[0]);
  const blob = (row || []).map((c) => normalizeStatText_(c)).join(" ");
  if (/^(합계|총계|소계|평균|누계|계|합|총합|비고|참고|주)$/.test(first)) return true;
  if (/^(합계|총계|소계|평균|누계)\b/.test(blob) && !(parseNameOnly_(first) || parseClassAndName_(blob))) return true;
  return false;
}

function findBestHeaderRow_(peek, maxScan = 20) {
  if (!Array.isArray(peek) || !peek.length) return 0;
  let bestAt = 0;
  let best = -999;
  const limit = Math.min(maxScan, peek.length);
  for (let i = 0; i < limit; i++) {
    let sc = headerRowScore_(peek[i]);
    const next = peek[i + 1];
    if (next) {
      if (rowLooksLikeLog_(next) || parseNameOnly_(next[0]) || parseClassOnly_(next[0]) || parseClassAndName_(next[0])) sc += 3;
      if (headerRowScore_(next) > sc + 1) sc -= 2;
    }
    if (sc > best) {
      best = sc;
      bestAt = i;
    }
  }
  if (best < 2) {
    const dataish = peek.slice(0, Math.min(10, peek.length)).filter((row) => rowLooksLikeLog_(row)).length;
    if (dataish >= 2) return -1;
  }
  return bestAt;
}

function headerKey_(header) {
  return String(header || "").trim().toLowerCase().replace(/[\s_\-./]/g, "");
}

function headerLooksLike_(header, keys) {
  const h = headerKey_(header);
  return keys.some((k) => h === k || h.includes(k));
}

function headerIsDateLike_(header) {
  const h = headerKey_(header);
  if (!h) return false;
  if (/(학번|번호|전화|연락처|연도|년도|학년|회차|횟수)/.test(h) && !/(날짜|일자|일시|지급일)/.test(h)) return false;
  return /(날짜|일자|일시|시각|지급일|등록일|작성일|처리일|입력일|발생일|기준일|부여일|실시일|datetime|^date$|date$)/.test(h);
}

function headerIsGrantFlag_(header) {
  const h = headerKey_(header);
  if (!h) return false;
  if (/(지급일|날짜|일자|일시)/.test(h)) return false;
  if (h === "지급" || h === "상점지급") return true;
  return /(지급여부|지급유무|지급함|지급완료|지급상태|지급확인)/.test(h);
}

function headerIsGrantAmount_(header) {
  const h = headerKey_(header);
  if (headerIsGrantFlag_(header) || headerIsDateLike_(header)) return false;
  return /(지급점|지급량|지급상점|지급점수|부여상점)/.test(h);
}

const STAT_HEADER_HINTS_ = [
  "이름",
  "성명",
  "학생",
  "학생명",
  "반",
  "학급",
  "학년",
  "상점",
  "벌점",
  "날짜",
  "일자",
  "지급",
  "학번",
  "번호",
  "점수",
  "가점",
  "감점",
  "내용",
  "사유",
  "누계",
  "횟수",
];

function headerRowScore_(row) {
  const cells = (row || []).map((c) => normalizeStatText_(c));
  const filled = cells.filter(Boolean);
  if (!filled.length) return -8;
  if (filled.length <= 2 && filled[0] && filled[0].length >= 10) return -6;
  let score = 0;
  for (const t of filled) {
    const compact = t.replace(/\s+/g, "");
    if (parseClassAndName_(t) || parseNameOnly_(t) || parseClassOnly_(t) || looksLikeDateCell_(t)) {
      score -= 3;
      continue;
    }
    if (/\d/.test(compact) || /개지급|개$/.test(compact)) {
      score -= 2;
      continue;
    }
    if (/^(지급|미지급)$/.test(compact)) {
      score -= 2;
      continue;
    }
    if (STAT_HEADER_HINTS_.some((h) => compact === h || compact === h + "여부" || compact === h + "점수" || compact === h + "명")) score += 3;
    else if (compact.length <= 10 && STAT_HEADER_HINTS_.some((h) => compact.includes(h))) score += 1;
  }
  if (filled.length <= 2) score -= 3;
  return score;
}

function rowLooksLikeHeader_(headers, row) {
  if (!row || !headers || !headers.length) return false;
  let exact = 0;
  let compared = 0;
  for (let i = 0; i < headers.length; i++) {
    const a = headerKey_(headers[i]);
    const b = headerKey_(row[i]);
    if (!a) continue;
    compared += 1;
    if (b && b === a) exact += 1;
  }
  if (compared < 2) return false;
  return exact >= Math.max(3, Math.ceil(compared * 0.7));
}

function headerIsScoreLike_(header) {
  const h = headerKey_(header);
  if (headerIsDateLike_(header) || headerIsGrantFlag_(header)) return false;
  if (/(사유|내용|정보|비고|메모|설명)/.test(h)) return false;
  return /(상점|벌점|상쇄|가점|감점|점수|포인트|merit|demerit|point|지급점|지급량)/.test(h);
}

function pad2_(n) {
  return String(n).padStart(2, "0");
}

function excelSerialToDate_(serial, date1904) {
  let n = Number(serial);
  if (!Number.isFinite(n)) return null;
  if (date1904) n += 1462;
  if (n < 1 || n >= 2958466) return null;
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2200) return null;
  return d;
}

function formatExcelDate_(d, withTime) {
  const y = d.getUTCFullYear();
  const m = pad2_(d.getUTCMonth() + 1);
  const day = pad2_(d.getUTCDate());
  if (!withTime) return `${y}-${m}-${day}`;
  const hh = pad2_(d.getUTCHours());
  const mi = pad2_(d.getUTCMinutes());
  if (hh === "00" && mi === "00" && d.getUTCSeconds() === 0) return `${y}-${m}-${day}`;
  return `${y}-${m}-${day} ${hh}:${mi}`;
}

function looksLikeExcelSerial_(v) {
  const n = parseLooseNumber_(v);
  if (n == null) return false;
  if (n >= 20000 && n <= 80000) return true;
  if (n >= 1 && n < 20000 && n % 1 !== 0) return true;
  return false;
}

function normalizeLooseDateString_(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  let m = t.match(/^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})(?:\s*일?)?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const date = `${m[1]}-${pad2_(m[2])}-${pad2_(m[3])}`;
    return m[4] != null ? `${date} ${pad2_(m[4])}:${pad2_(m[5])}` : date;
  }
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = t.match(/^(\d{1,2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += y >= 70 ? 1900 : 2000;
    return `${y}-${pad2_(m[1])}-${pad2_(m[2])}`;
  }
  return t;
}

function formatGrantFlag_(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  if (["1", "true", "y", "yes", "예", "o", "○", "지급", "완료", "함", "지급됨", "지급완료"].includes(s)) return "지급";
  if (["0", "false", "n", "no", "아니오", "아니요", "x", "×", "미지급", "안함", "미완료"].includes(s)) return "미지급";
  return String(v).trim();
}

function formatScoreNumber_(v) {
  const n = parseLooseNumber_(v);
  if (n == null) return String(v ?? "").trim();
  if (Math.abs(n - Math.round(n)) < 1e-6) return String(Math.round(n));
  return String(Math.round(n * 100) / 100);
}

function formatStatCell_(header, value, kind) {
  if (value == null) return "";
  let s = String(value).trim();
  if (!s) return "";
  const colKind = kind || "";
  if (colKind === "flag" || headerIsGrantFlag_(header)) {
    const flagged = formatGrantFlag_(s);
    if (flagged === "지급" || flagged === "미지급") return flagged;
    if (colKind === "flag") return formatGrantFlag_(s);
  }
  if (colKind === "score" || headerIsGrantAmount_(header)) return formatScoreNumber_(s);
  if (/(지급정보|지급내역|지급사항|지급내용)/.test(headerKey_(header))) {
    const n = parseLooseNumber_(s);
    if (n != null && looksLikeExcelSerial_(s)) {
      const d = excelSerialToDate_(n, false);
      if (d) return formatExcelDate_(d, n % 1 !== 0);
    }
    return s;
  }
  if (headerIsDateLike_(header)) {
    const n = parseLooseNumber_(s);
    if (n != null && looksLikeExcelSerial_(s)) {
      const d = excelSerialToDate_(n, false);
      if (d) return formatExcelDate_(d, n % 1 !== 0);
    }
    return normalizeLooseDateString_(s);
  }
  if (headerIsScoreLike_(header)) return formatScoreNumber_(s);
  const n = parseLooseNumber_(s);
  if (n != null && /e/i.test(s)) return formatScoreNumber_(s);
  if (n != null && Math.abs(n - Math.round(n)) < 1e-6 && /^-?\d+\.\d+$/.test(s)) return String(Math.round(n));
  return s;
}

function inferStatColKind_(header, values) {
  const nonempty = (values || []).map((v) => String(v ?? "").trim()).filter(Boolean);
  if (headerIsDateLike_(header)) return "date";
  if (headerIsGrantFlag_(header)) return "flag";
  if (headerIsGrantAmount_(header)) return "score";
  const flagHits = nonempty.filter((v) => {
    const f = formatGrantFlag_(v);
    return f === "지급" || f === "미지급";
  }).length;
  const numHits = nonempty.filter((v) => {
    const n = parseLooseNumber_(v);
    return n != null && !looksLikeExcelSerial_(v);
  }).length;
  const h = headerKey_(header);
  if (/(지급)/.test(h) && !/(일|날짜|일자)/.test(h) && flagHits >= Math.max(1, nonempty.length * 0.35)) return "flag";
  if (headerIsScoreLike_(header) || (/(상점|벌점|점수)/.test(h) && numHits >= Math.max(1, nonempty.length * 0.35))) return "score";
  return "";
}

function looksLikeDateCell_(v) {
  const s = String(v ?? "").trim();
  if (!s) return false;
  if (/^\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
  if (/^\d{1,2}\s*월\s*\d{1,2}\s*일?/.test(s)) return true;
  if (/^\d{1,2}\s*[./]\s*\d{1,2}\s*[./]\s*\d{2,4}$/.test(s)) return true;
  if (looksLikeExcelSerial_(s)) return true;
  const n = normalizeLooseDateString_(s);
  return n !== s && /^\d{4}-\d{2}-\d{2}/.test(n);
}

function parseClassOnly_(v) {
  const s = normalizeStatText_(v);
  if (!s) return "";
  let m = s.match(/^(\d{1,2})\s*[-./]\s*(\d{1,2})\s*반?$/);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  m = s.match(/^(\d{1,2})\s*학년\s*(\d{1,2})\s*반$/);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  m = s.match(/^(\d{1,2})\s*학년(\d{1,2})\s*반$/);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  m = s.match(/^(\d{1,2})\s*반$/);
  if (m) return m[1];
  return "";
}

function parseNameOnly_(v) {
  const t = normalizeStatText_(v).replace(/[()（）]/g, "");
  if (!t || /^(지급|미지급|상점|벌점|내용|날짜|일자|이름|성명|반|학급|번호|학번|합계|평균)$/.test(t)) return "";
  if (/^[가-힣]{2,6}$/.test(t)) return t;
  if (/^[A-Za-z][A-Za-z .'-]{1,20}$/.test(t)) return t;
  const withNo = t.match(/^(?:\d{1,6}\s*번|[A-Za-z0-9]{4,12})\s+([가-힣]{2,6})$/);
  if (withNo) return withNo[1];
  return "";
}

function parseClassAndName_(v) {
  const s = normalizeStatText_(v);
  if (!s) return null;
  let m = s.match(/^(\d{1,2})\s*[-./]\s*(\d{1,2})\s*반?\s+(.+)$/);
  if (m && /[가-힣a-zA-Z]/.test(m[3])) return { className: `${Number(m[1])}-${Number(m[2])}`, name: m[3].trim() };
  m = s.match(/^(\d{1,2})\s*학년\s*(\d{1,2})\s*반\s*(.+)$/);
  if (m) return { className: `${Number(m[1])}-${Number(m[2])}`, name: m[3].trim() };
  m = s.match(/^(\d{1,2})\s*[-./]\s*(\d{1,2})([가-힣a-zA-Z].+)$/);
  if (m) return { className: `${Number(m[1])}-${Number(m[2])}`, name: m[3].trim() };
  m = s.match(/^([가-힣]{2,6})\s+(\d{1,2})\s*[-./]\s*(\d{1,2})\s*반?$/);
  if (m) return { className: `${Number(m[2])}-${Number(m[3])}`, name: m[1] };
  m = s.match(/^([가-힣]{2,6})\s*\(\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*반?\s*\)$/);
  if (m) return { className: `${Number(m[2])}-${Number(m[3])}`, name: m[1] };
  m = s.match(/^(\d{1,2})\s*[-./]\s*(\d{1,2})\s*반?\s*\(?\s*([가-힣]{2,6})\s*\)?$/);
  if (m) return { className: `${Number(m[1])}-${Number(m[2])}`, name: m[3] };
  return null;
}

function parseMeritGrantText_(v) {
  const s = String(v ?? "").trim();
  if (!s) return { amount: 0, granted: false };
  if (/미지급|안\s*줌|취소/.test(s)) return { amount: 0, granted: false };
  const hasMerit = /상점|가점/.test(s);
  const hasDemerit = /벌점|감점/.test(s);
  if (hasDemerit && !hasMerit) return { amount: 0, granted: false };
  const amt = s.match(/상점\s*([0-9]+(?:\.[0-9]+)?)\s*개?/) || s.match(/가점\s*([0-9]+(?:\.[0-9]+)?)/);
  const n = amt ? Number(amt[1]) : hasMerit && !hasDemerit ? parseLooseNumber_(s) : null;
  const granted = !!amt || (hasMerit && (/지급/.test(s) || (n != null && n > 0)));
  const amount = Number.isFinite(n) && n > 0 ? n : granted ? 1 : 0;
  return { amount, granted: granted && amount > 0 };
}

function parseDemeritGrantText_(v) {
  const s = String(v ?? "").trim();
  if (!s) return { amount: 0, granted: false };
  if (/미지급|안\s*줌|취소/.test(s)) return { amount: 0, granted: false };
  const hasMerit = /상점|가점/.test(s);
  const hasDemerit = /벌점|감점/.test(s);
  if (hasMerit && !hasDemerit) return { amount: 0, granted: false };
  const amt = s.match(/벌점\s*([0-9]+(?:\.[0-9]+)?)\s*개?/) || s.match(/감점\s*([0-9]+(?:\.[0-9]+)?)/);
  const n = amt ? Number(amt[1]) : hasDemerit && !hasMerit ? parseLooseNumber_(s) : null;
  const granted = !!amt || (hasDemerit && (/지급/.test(s) || (n != null && n > 0)));
  const amount = Number.isFinite(n) && n > 0 ? n : granted ? 1 : 0;
  return { amount, granted: granted && amount > 0 };
}

function extractDateFromText_(s) {
  const t = String(s ?? "");
  const m =
    t.match(/(\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}(?:\s*일)?)/) ||
    t.match(/(\d{4}-\d{2}-\d{2})/) ||
    t.match(/(\d{1,2}\s*월\s*\d{1,2}\s*일?)/) ||
    t.match(/(\d{1,2}\s*[./]\s*\d{1,2}\s*[./]\s*\d{2,4})/);
  if (!m) return "";
  const n = normalizeLooseDateString_(m[1]);
  return /^\d{4}-\d{2}-\d{2}/.test(n) ? n : "";
}

function isGrantNoiseCell_(cell) {
  const s = String(cell ?? "").trim();
  if (!s) return true;
  if (/^(지급|미지급|완료|함|상점|벌점|가점|감점)$/.test(s)) return true;
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(s)) return true;
  if (/^(상점|벌점|가점|감점)\s*[0-9]+(?:\.[0-9]+)?\s*개?(\s*지급)?$/.test(s)) return true;
  if (/^[0-9]+(?:\.[0-9]+)?\s*개(\s*지급)?$/.test(s)) return true;
  if (/^[0-9]+(?:\.[0-9]+)?\s*지급$/.test(s) || /^[0-9]+지급$/.test(s)) return true;
  return false;
}

function cleanStatNote_(note) {
  let s = String(note ?? "").trim();
  if (!s) return "";
  s = s.replace(/상점\s*[0-9]+(?:\.[0-9]+)?\s*개?(\s*지급)?/g, " ");
  s = s.replace(/벌점\s*[0-9]+(?:\.[0-9]+)?\s*개?(\s*지급)?/g, " ");
  s = s.replace(/가점\s*[0-9]+(?:\.[0-9]+)?/g, " ");
  s = s.replace(/감점\s*[0-9]+(?:\.[0-9]+)?/g, " ");
  s = s.replace(/[0-9]+(?:\.[0-9]+)?\s*개\s*지급/g, " ");
  s = s.replace(/[0-9]+(?:\.[0-9]+)?\s*지급/g, " ");
  s = s.replace(/[0-9]+지급/g, " ");
  s = s.replace(/(지급|미지급)/g, " ");
  s = s.replace(/^[0-9]+(?:\.[0-9]+)?\s+/, " ");
  return s.replace(/\s+/g, " ").trim();
}

function extractWhoFromText_(s) {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const direct = parseClassAndName_(t);
  if (direct) return direct;
  const m = t.match(/(\d{1,2})\s*[-.]\s*(\d{1,2})\s*반?\s+([가-힣]{2,5})/);
  if (m) return { className: `${Number(m[1])}-${Number(m[2])}`, name: m[3] };
  const r = t.match(/([가-힣]{2,5})\s+(\d{1,2})\s*[-.]\s*(\d{1,2})\s*반?/);
  if (r) return { className: `${Number(r[2])}-${Number(r[3])}`, name: r[1] };
  return null;
}

function extractStatFactsFromCells_(row) {
  const cells = (row || []).map((c) => normalizeStatText_(c)).filter(Boolean);
  const blob = cells.join(" ");
  let className = "";
  let name = "";
  let number = "";
  let sid = "";
  const notes = [];
  for (const cell of cells) {
    const who = parseClassAndName_(cell);
    if (who) {
      if (!className) className = who.className;
      if (!name) name = who.name;
      continue;
    }
    const cls = parseClassOnly_(cell);
    if (cls && !className) {
      className = cls;
      continue;
    }
    const nm = parseNameOnly_(cell);
    if (nm && !name) {
      name = nm;
      continue;
    }
    if (looksLikeDateCell_(cell) || looksLikeExcelSerial_(cell)) {
      notes.push(cell);
      continue;
    }
    const sidParts = parseStudentIdParts_(cell);
    if (sidParts && sidParts.id && String(sidParts.id).length >= 4 && !sid) {
      sid = sidParts.id;
      if (!className && sidParts.grade && sidParts.classNo) className = `${sidParts.grade}-${sidParts.classNo}`;
      if (!number && sidParts.number) number = String(sidParts.number);
      continue;
    }
    const noOnly = cell.match(/^(\d{1,3})\s*번$/);
    if (noOnly && !number) {
      number = String(Number(noOnly[1]));
      continue;
    }
    if (isGrantNoiseCell_(cell)) continue;
    notes.push(cell);
  }
  if (!name || !className) {
    const who2 = extractWhoFromText_(blob);
    if (who2) {
      name = name || who2.name;
      className = className || who2.className;
    }
  }
  const text = notes.join(" ") || blob;
  let merit = parseMeritGrantText_(text);
  let demerit = parseDemeritGrantText_(text);
  if (!(merit.amount > 0) && !(demerit.amount > 0)) {
    for (const cell of cells) {
      if (looksLikeDateCell_(cell) || parseClassOnly_(cell) || parseClassAndName_(cell) || parseNameOnly_(cell)) continue;
      const n = parseLooseNumber_(cell);
      if (n != null && n !== 0 && Math.abs(n) < 1000 && !looksLikeExcelSerial_(cell)) {
        const kind = cellPointKind_(blob) || cellPointKind_(cell);
        const mag = Math.abs(n);
        if (kind === "demerit" || n < 0 || (/벌점|감점/.test(blob) && !/상점|가점/.test(blob))) demerit = { amount: mag, granted: true };
        else if (kind === "merit" || (/상점|가점/.test(blob) && !/벌점|감점/.test(blob))) merit = { amount: mag, granted: true };
        else if (/벌점|감점/.test(blob) && /상점|가점/.test(blob)) {
          /* 둘 다 있으면 숫자만으로는 나누지 않음 */
        } else merit = { amount: mag, granted: true };
        break;
      }
    }
  }
  return {
    date: "",
    className,
    name,
    number,
    sid,
    grade: className && String(className).includes("-") ? String(className).split("-")[0] : "",
    amount: merit.amount,
    demerits: demerit.amount,
    granted: merit.granted || demerit.granted,
    note: cleanStatNote_(notes.join(" ")),
  };
}

function factsToStatRow_(f) {
  const cls = parseClassOnly_(f.className) || f.className || "";
  let grade = f.grade || "";
  if (!grade && cls.includes("-")) grade = cls.split("-")[0];
  return [
    grade || "",
    cls || "",
    f.number || "",
    f.sid || "",
    f.name || "",
    f.date || "",
    f.amount ? String(f.amount) : "",
    f.demerits ? String(f.demerits) : "",
    f.granted ? "지급" : "",
    f.note || "",
  ];
}

function parseStudentIdParts_(raw) {
  const s = String(raw || "").trim().replace(/\s+/g, "");
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{1,3})$/);
  if (m) return { grade: Number(m[1]), classNo: Number(m[2]), number: Number(m[3]), id: s };
  m = s.match(/^(\d{1,2})학년(\d{1,2})반(\d{1,3})번?$/);
  if (m) return { grade: Number(m[1]), classNo: Number(m[2]), number: Number(m[3]), id: s };
  m = s.match(/^(\d)(\d{2})(\d{2})$/);
  if (m) {
    const grade = Number(m[1]);
    const classNo = Number(m[2]);
    const number = Number(m[3]);
    if (grade >= 1 && grade <= 6 && classNo >= 1 && classNo <= 20 && number >= 1 && number <= 50) {
      return { grade, classNo, number, id: s };
    }
  }
  if (/^\d{4,12}$/.test(s)) return { grade: 0, classNo: 0, number: 0, id: s };
  return null;
}

function statHeaderRole_(header) {
  const h = headerKey_(header);
  if (!h) return "other";
  if (headerIsDateLike_(header)) return "date";
  if (headerIsGrantFlag_(header) || h === "지급") return "grant";
  if (headerIsMerit_(header)) return "merit";
  if (headerIsDemerit_(header)) return "demerit";
  if (h === "학년" || (h.startsWith("학년") && !/학년도|학년말/.test(h))) return "grade";
  if (h === "학번" || h === "학생학번" || h === "studentid" || h === "studentno") return "sid";
  if (h === "번호" || h === "출석번호" || h === "학생번호" || h === "no" || h === "num") return "no";
  if (h === "반" || h === "학급" || h === "반명" || h === "class" || h === "classname" || h === "반이름") return "class";
  if (h === "이름" || h === "성명" || h === "학생명" || h === "name" || h === "학생이름") return "name";
  if (/(사유|내용|정보|비고|메모|설명|note)/.test(h)) return "note";
  return "other";
}

function statRoleIndex_(headers, role) {
  return (headers || []).findIndex((h) => statHeaderRole_(h) === role);
}

function classSortParts_(cls) {
  const parsed = parseClassOnly_(cls) || String(cls || "").trim();
  const m = String(parsed).match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
  if (m) return [Number(m[1]) || 0, Number(m[2]) || 0];
  return [0, 0];
}

function identityFromStatRow_(headers, row) {
  const get = (role) => {
    const i = statRoleIndex_(headers, role);
    return i >= 0 ? String(row[i] ?? "").trim() : "";
  };
  let grade = get("grade");
  let cls = get("class");
  let no = get("no");
  let sid = get("sid");
  let name = get("name");
  const parsedClass = parseClassOnly_(cls);
  if (parsedClass) {
    cls = parsedClass;
    if (!grade && parsedClass.includes("-")) grade = parsedClass.split("-")[0];
  }
  const sidParts = parseStudentIdParts_(sid) || parseStudentIdParts_(no);
  if (sidParts) {
    if (!grade && sidParts.grade) grade = String(sidParts.grade);
    if ((!cls || !String(cls).includes("-")) && sidParts.grade && sidParts.classNo) {
      cls = `${sidParts.grade}-${sidParts.classNo}`;
    }
    if ((!no || no.length > 3) && sidParts.number) no = String(sidParts.number);
    if (!sid && sidParts.id && String(sidParts.id).length >= 4) sid = sidParts.id;
  }
  const who = parseClassAndName_(name);
  if (who) {
    name = who.name;
    if (!cls) cls = who.className;
    if (!grade && who.className && who.className.includes("-")) grade = who.className.split("-")[0];
  }
  if (grade) grade = String(Number(grade) || grade);
  if (no && /^\d+$/.test(no)) no = String(Number(no));
  return { grade: grade || "", className: cls || "", number: no || "", sid: sid || "", name: name || "" };
}

function ensureStatCol_(headers, rows, role, title) {
  if (statRoleIndex_(headers, role) >= 0) return;
  headers.push(title);
  for (const row of rows) row.push("");
}

function organizeStatIdentitySheet_(headers, rows) {
  const h = (headers || []).slice();
  const r = (rows || []).map((row) => {
    const next = Array.isArray(row) ? row.slice() : [];
    while (next.length < h.length) next.push("");
    return next;
  });
  ensureStatCol_(h, r, "grade", "학년");
  ensureStatCol_(h, r, "class", "반");
  ensureStatCol_(h, r, "no", "번호");
  ensureStatCol_(h, r, "name", "이름");
  const gI = statRoleIndex_(h, "grade");
  const cI = statRoleIndex_(h, "class");
  const nI = statRoleIndex_(h, "no");
  const sI = statRoleIndex_(h, "sid");
  const nmI = statRoleIndex_(h, "name");
  for (const row of r) {
    const idn = identityFromStatRow_(h, row);
    if (gI >= 0 && !String(row[gI] || "").trim() && idn.grade) row[gI] = idn.grade;
    if (cI >= 0 && !String(row[cI] || "").trim() && idn.className) row[cI] = idn.className;
    else if (cI >= 0 && idn.className) row[cI] = idn.className;
    if (nI >= 0 && !String(row[nI] || "").trim() && idn.number) row[nI] = idn.number;
    if (sI >= 0 && !String(row[sI] || "").trim() && idn.sid) row[sI] = idn.sid;
    if (nmI >= 0 && idn.name) row[nmI] = idn.name;
  }
  const roleOrder = ["grade", "class", "no", "sid", "name", "date", "merit", "demerit", "grant", "note"];
  const used = new Set();
  const order = [];
  for (const role of roleOrder) {
    h.forEach((_, i) => {
      if (!used.has(i) && statHeaderRole_(h[i]) === role) {
        used.add(i);
        order.push(i);
      }
    });
  }
  h.forEach((_, i) => {
    if (!used.has(i)) order.push(i);
  });
  const nextHeaders = order.map((i) => h[i]);
  const nextRows = r.map((row) => order.map((i) => row[i] ?? ""));
  nextRows.sort((a, b) => {
    const ia = identityFromStatRow_(nextHeaders, a);
    const ib = identityFromStatRow_(nextHeaders, b);
    const ga = Number(ia.grade) || classSortParts_(ia.className)[0];
    const gb = Number(ib.grade) || classSortParts_(ib.className)[0];
    if (ga !== gb) return ga - gb;
    const ca = classSortParts_(ia.className);
    const cb = classSortParts_(ib.className);
    if (ca[1] !== cb[1]) return ca[1] - cb[1];
    const na = Number(ia.number) || 0;
    const nb = Number(ib.number) || 0;
    if (na !== nb) return na - nb;
    return String(ia.name || "").localeCompare(String(ib.name || ""), "ko");
  });
  const emptyIdentity = (role) => {
    const i = statRoleIndex_(nextHeaders, role);
    if (i < 0) return false;
    return nextRows.every((row) => !String(row[i] || "").trim());
  };
  const drop = new Set();
  if (emptyIdentity("sid")) drop.add(statRoleIndex_(nextHeaders, "sid"));
  if (emptyIdentity("grade") && nextRows.some((row) => identityFromStatRow_(nextHeaders, row).className.includes("-"))) {
    /* 반은 2-3 형태면 학년 열은 유지 */
  } else if (emptyIdentity("grade")) drop.add(statRoleIndex_(nextHeaders, "grade"));
  if (emptyIdentity("no")) drop.add(statRoleIndex_(nextHeaders, "no"));
  if (!drop.size) return { headers: nextHeaders, rows: nextRows };
  const keep = nextHeaders.map((_, i) => !drop.has(i));
  return {
    headers: nextHeaders.filter((_, i) => keep[i]),
    rows: nextRows.map((row) => row.filter((_, i) => keep[i])),
  };
}

function statRowMatchesQuery_(info, row, q) {
  const raw = String(q || "").trim();
  if (!raw) return true;
  const cells = (info.headers || []).map((_, i) => String(row[i] ?? "").trim());
  const blob = cells.join(" ").toLowerCase();
  const compact = cells.join("").replace(/\s+/g, "").toLowerCase();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const idn = identityFromStatRow_(info.headers, row);
  return tokens.every((tok) => {
    const t = tok.toLowerCase();
    const tc = tok.replace(/\s+/g, "").toLowerCase();
    const tDigits = tok.replace(/\D/g, "");
    const tNum = String(Number(tDigits || NaN));
    const isSmallNo = /^\d{1,3}$/.test(tok) && Number(tok) >= 1 && Number(tok) <= 50;
    if (isSmallNo) {
      if (idn.number === tNum || idn.grade === tNum) return true;
      const cp = classSortParts_(idn.className);
      if (cp[0] === Number(tok) || cp[1] === Number(tok)) return true;
      if (idn.sid && (idn.sid === tok || idn.sid.endsWith(tok.padStart(2, "0")) || idn.sid.endsWith(tok))) return true;
      return false;
    }
    if (blob.includes(t) || compact.includes(tc)) return true;
    if (idn.name && idn.name.toLowerCase().includes(t)) return true;
    if (idn.className) {
      const ck = classKeyLoose_(idn.className).toLowerCase();
      if (ck.includes(tc) || ck.replace(/-/g, "").includes(tc.replace(/-/g, ""))) return true;
    }
    if (idn.grade && (idn.grade === t || idn.grade === tNum || `${idn.grade}학년`.includes(t))) return true;
    if (idn.number && (idn.number === t || idn.number === tNum || `${idn.number}번` === t)) return true;
    if (idn.sid) {
      const sid = idn.sid.replace(/\s+/g, "").toLowerCase();
      if (sid.includes(tc) || (tDigits && sid.includes(tDigits))) return true;
    }
    return false;
  });
}

function rowLooksLikeLog_(row) {
  const f = extractStatFactsFromCells_(row);
  return !!(f.name || (f.date && (f.amount > 0 || f.demerits > 0)) || (f.className && (f.amount > 0 || f.demerits > 0)));
}

function polishStatSheet_(sheet) {
  let headers = (sheet.headers || []).map((h) => normalizeStatText_(h) || "열");
  let rows = (sheet.rows || []).map((row) => (Array.isArray(row) ? row.map((c) => normalizeStatText_(c)) : []));
  const trimmed = trimEmptyStatColumns_(headers, rows);
  headers = trimmed.headers;
  rows = trimmed.rows.filter((row) => !rowLooksLikeSummary_(row));
  if (!sheetHasStructuredStatHeaders_(headers)) {
    const headerFacts = extractStatFactsFromCells_(headers);
    const headerIsReal = headerRowScore_(headers) >= 4 && !headerFacts.name;
    const rawRows = (headerIsReal ? rows : [headers, ...rows]).filter((r) => r && r.some((c) => String(c ?? "").trim()));
    const factsList = rawRows.map((r) => extractStatFactsFromCells_(r));
    const useful = factsList.filter((f) => f.name || f.amount > 0 || f.demerits > 0);
    if (useful.length && useful.length >= Math.max(1, Math.ceil(rawRows.length * 0.28))) {
      headers = ["학년", "반", "번호", "학번", "이름", "날짜", "상점", "벌점", "지급", "내용"];
      rows = factsList.filter((f) => f.name || f.amount > 0 || f.demerits > 0 || f.note).map(factsToStatRow_);
    }
  }
  const kept = rows.filter((row) => !rowLooksLikeHeader_(headers, row) && !rowLooksLikeSummary_(row));
  if (kept.length) rows = kept;
  const kinds = headers.map((h, i) => inferStatColKind_(h, rows.map((r) => r[i])));
  rows = rows.map((row) => headers.map((h, i) => formatStatCell_(h, row[i], kinds[i])));
  const organized = organizeStatIdentitySheet_(headers, rows);
  return { name: sheet.name || "시트", headers: organized.headers, rows: organized.rows };
}

function findHeaderIndex_(headers, keys) {
  const idx = headers.findIndex((h) => headerLooksLike_(h, keys));
  return idx >= 0 ? idx : -1;
}

function headerIsMerit_(header) {
  return headerIsScoreLike_(header) && headerLooksLike_(header, ["상점", "가점"]) && !headerLooksLike_(header, ["벌점", "감점", "demerit"]);
}

function headerIsDemerit_(header) {
  return headerIsScoreLike_(header) && (headerLooksLike_(header, ["벌점", "감점"]) || headerKey_(header) === "demerit");
}

function headerIsKind_(header) {
  if (!header || headerIsScoreLike_(header) || headerIsDateLike_(header) || headerIsGrantFlag_(header)) return false;
  return headerLooksLike_(header, ["구분", "종류", "유형", "항목", "분류", "타입", "type", "적요", "점수구분", "지급구분"]);
}

function sheetHasStructuredStatHeaders_(headers) {
  const hasName = (headers || []).some((h) => headerLooksLike_(h, ["이름", "성명", "학생명"]) || headerKey_(h) === "학생");
  const hasMerit = (headers || []).some((h) => headerIsMerit_(h));
  const hasDemerit = (headers || []).some((h) => headerIsDemerit_(h));
  return hasName && (hasMerit || hasDemerit);
}

function parseScoreCellAmount_(v) {
  const s = normalizeStatText_(v);
  if (!s) return null;
  if (/미지급|안\s*줌|취소/.test(s)) return 0;
  const labeled = s.match(/(?:상점|벌점|가점|감점)\s*([0-9]+(?:\.[0-9]+)?)/);
  if (labeled) {
    const n = Number(labeled[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (m && !looksLikeExcelSerial_(s) && !looksLikeDateCell_(s)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0 && n < 1000) return n;
  }
  const n = parseLooseNumber_(s);
  if (n != null && Math.abs(n) > 0 && Math.abs(n) < 1000 && !looksLikeExcelSerial_(s)) return n;
  return null;
}

function cellPointKind_(v) {
  const s = normalizeStatText_(v);
  if (!s) return "";
  const hasM = /상점|가점/.test(s);
  const hasD = /벌점|감점/.test(s);
  if (hasD && !hasM) return "demerit";
  if (hasM && !hasD) return "merit";
  if (/^[-−–—]/.test(s) && parseScoreCellAmount_(s)) return "demerit";
  return "";
}

function rowPointKind_(info, row) {
  if (info && info.kindCol >= 0) {
    const k = cellPointKind_(row[info.kindCol]);
    if (k) return k;
  }
  for (const cell of row || []) {
    const k = cellPointKind_(cell);
    if (k) return k;
  }
  return "";
}

function formatUploadDate_(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) {
    const n = new Date();
    return `${n.getFullYear()}-${pad2_(n.getMonth() + 1)}-${pad2_(n.getDate())}`;
  }
  return `${d.getFullYear()}-${pad2_(d.getMonth() + 1)}-${pad2_(d.getDate())}`;
}

function stampStatSheetsUploadDate_(sheets, iso) {
  const label = formatUploadDate_(iso);
  return (sheets || []).map((sheet) => {
    let headers = Array.isArray(sheet.headers) ? sheet.headers.slice() : [];
    let rows = Array.isArray(sheet.rows) ? sheet.rows.map((r) => (Array.isArray(r) ? r.slice() : [])) : [];
    let dateCol = headers.findIndex((h) => headerIsDateLike_(h) || headerKey_(h) === "날짜");
    if (dateCol < 0) {
      headers = ["날짜", ...headers];
      dateCol = 0;
      rows = rows.map((r) => [label, ...r]);
    } else {
      rows = rows.map((r) => {
        const row = r.slice();
        row[dateCol] = label;
        return row;
      });
    }
    const organized = organizeStatIdentitySheet_(headers, rows);
    return { ...sheet, headers: organized.headers, rows: organized.rows };
  });
}

function analyzeStatSheet_(sheet) {
  const headers = sheet.headers || [];
  const rows = sheet.rows || [];
  const cols = headers.map((header, index) => {
    const values = rows.map((r) => (r && r[index] != null ? r[index] : ""));
    const nums = values.map(parseLooseNumber_).filter((n) => n != null);
    const isNum =
      !headerIsDateLike_(header) &&
      !headerIsGrantFlag_(header) &&
      !/(지급정보|지급내역|지급사항|지급내용)/.test(headerKey_(header)) &&
      !["grade", "class", "no", "sid", "name"].includes(statHeaderRole_(header)) &&
      (rows.length ? nums.length >= Math.max(1, Math.ceil(rows.length * 0.4)) : false);
    const sum = nums.reduce((a, n) => a + n, 0);
    return {
      index,
      header: header || `${index + 1}열`,
      isNum,
      nums,
      sum,
      avg: nums.length ? sum / nums.length : 0,
      min: nums.length ? Math.min(...nums) : 0,
      max: nums.length ? Math.max(...nums) : 0,
    };
  });
  return {
    headers,
    rows,
    cols,
    numericCols: cols.filter((c) => c.isNum),
    nameCol: statRoleIndex_(headers, "name"),
    classCol: statRoleIndex_(headers, "class"),
    gradeCol: statRoleIndex_(headers, "grade"),
    noCol: statRoleIndex_(headers, "no"),
    sidCol: statRoleIndex_(headers, "sid"),
    kindCol: headers.findIndex((h) => headerIsKind_(h)),
    meritCol: (() => {
      const labeled = headers.findIndex((h) => headerIsMerit_(h));
      if (labeled >= 0) return labeled;
      const demerit = headers.findIndex((h) => headerIsDemerit_(h));
      if (demerit >= 0) return -1;
      const generic = headers
        .map((h, i) => (headerIsScoreLike_(h) && !headerIsGrantAmount_(h) ? i : -1))
        .filter((i) => i >= 0);
      return generic.length === 1 ? generic[0] : -1;
    })(),
    demeritCol: headers.findIndex((h) => headerIsDemerit_(h)),
    grantCol: headers.findIndex((h) => headerIsGrantFlag_(h) || headerKey_(h) === "지급"),
    grantAmountCol: headers.findIndex((h) => headerIsGrantAmount_(h)),
    dateCol: headers.findIndex((h) => headerIsDateLike_(h)),
  };
}

function groupNumericByClass_(info, colIndex) {
  if (info.classCol < 0) return [];
  const map = new Map();
  for (const row of info.rows) {
    const cls = String(row[info.classCol] || "").trim() || "(반 미정)";
    const n = parseLooseNumber_(row[colIndex]);
    if (n == null) continue;
    const prev = map.get(cls) || { className: cls, sum: 0, count: 0 };
    prev.sum += n;
    prev.count += 1;
    map.set(cls, prev);
  }
  return [...map.values()]
    .map((x) => ({ className: x.className, avg: x.count ? x.sum / x.count : 0, sum: x.sum, count: x.count }))
    .sort((a, b) => b.avg - a.avg);
}

function topRowsForCol_(info, colIndex, limit = 8) {
  return info.rows
    .map((row) => ({
      label:
        info.nameCol >= 0
          ? String(row[info.nameCol] || "").trim() || "-"
          : String(row[0] || "").trim() || "-",
      className: info.classCol >= 0 ? String(row[info.classCol] || "").trim() : "",
      value: parseLooseNumber_(row[colIndex]),
    }))
    .filter((x) => x.value != null)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function classKeyLoose_(c) {
  const parsed = parseClassOnly_(c);
  const s = parsed || String(c ?? "").trim();
  return s.replace(/\s+/g, "").replace(/[./]/g, "-");
}

function splitStatPerson_(name, className) {
  let n = String(name || "").trim();
  let c = normalizeClassName(className);
  const parsed = parseClassAndName_(n) || parseClassAndName_([c, n].filter(Boolean).join(" "));
  if (parsed) {
    n = parsed.name;
    if (!c) c = parsed.className;
  }
  return { name: n, className: c };
}

function isMyStatRow_(info, row) {
  const s = currentStudent();
  if (!s || info.nameCol < 0) return false;
  if (rowLooksLikeHeader_(info.headers, row)) return false;
  const person = splitStatPerson_(row[info.nameCol], info.classCol >= 0 ? row[info.classCol] : "");
  if (!person.name || person.name !== String(s.name || "").trim()) return false;
  if (!person.className) return true;
  return classKeyLoose_(person.className) === classKeyLoose_(s.className);
}

function nameKeyLoose_(n) {
  return String(n ?? "").replace(/\s+/g, "");
}

function findStudentForStatRow_(name, className) {
  const person = splitStatPerson_(name, className);
  if (!person.name) return null;
  const pool = state.students || [];
  const want = nameKeyLoose_(person.name);
  const exact = pool.filter(
    (s) =>
      !isDeletedStudent_(s) &&
      nameKeyLoose_(s.name) === want &&
      (!person.className || classKeyLoose_(s.className) === classKeyLoose_(person.className))
  );
  if (exact.length >= 1) return exact[0];
  const byName = pool.filter((s) => !isDeletedStudent_(s) && nameKeyLoose_(s.name) === want);
  return byName.length === 1 ? byName[0] : null;
}

function grantFlagAllows_(info, row) {
  const flag = info.grantCol >= 0 ? formatGrantFlag_(row[info.grantCol]) : "";
  if (flag === "미지급") return false;
  return flag === "지급" || flag === "" || info.grantCol < 0;
}

function positiveScore_(n) {
  return n != null && Number.isFinite(n) && n > 0 ? n : 0;
}

function rowScoreParts_(info, row) {
  if (!grantFlagAllows_(info, row)) return { amount: 0, demerits: 0 };
  const kind = rowPointKind_(info, row);
  let amount = 0;
  let demerits = 0;
  const hasMeritCol = info.meritCol >= 0;
  const hasDemeritCol = info.demeritCol >= 0;

  if (hasMeritCol) {
    const raw = row[info.meritCol];
    const n = parseScoreCellAmount_(raw);
    const mag = n == null ? 0 : Math.abs(n);
    if (cellPointKind_(raw) === "demerit" || (n != null && n < 0)) demerits += positiveScore_(mag);
    else amount += positiveScore_(mag);
  }
  if (hasDemeritCol) {
    const raw = row[info.demeritCol];
    const n = parseScoreCellAmount_(raw);
    const mag = n == null ? 0 : Math.abs(n);
    if (cellPointKind_(raw) === "merit") amount += positiveScore_(mag);
    else demerits += positiveScore_(mag);
  }

  if (!(amount > 0) && !(demerits > 0)) {
    if (info.grantAmountCol >= 0) {
      amount = positiveScore_(parseScoreCellAmount_(row[info.grantAmountCol]));
    }
    const blob = (row || []).join(" ");
    if (!(amount > 0) && !(demerits > 0)) {
      const merit = parseMeritGrantText_(blob);
      const demerit = parseDemeritGrantText_(blob);
      amount = merit.granted ? merit.amount : 0;
      demerits = demerit.granted ? demerit.amount : 0;
    }
    if (!(amount > 0) && !(demerits > 0) && !hasMeritCol && !hasDemeritCol) {
      for (const cell of row || []) {
        if (looksLikeDateCell_(cell) || parseClassOnly_(cell) || parseClassAndName_(cell) || parseNameOnly_(cell)) continue;
        const n = parseScoreCellAmount_(cell);
        if (n) {
          amount = n;
          break;
        }
      }
    }
  }

  if (!(hasMeritCol && hasDemeritCol)) {
    if (kind === "demerit" && amount > 0 && !(demerits > 0)) {
      demerits = amount;
      amount = 0;
    } else if (kind === "merit" && demerits > 0 && !(amount > 0)) {
      amount = demerits;
      demerits = 0;
    }
  }

  if (amount < 0) {
    demerits += Math.abs(amount);
    amount = 0;
  }
  if (demerits < 0) {
    amount += Math.abs(demerits);
    demerits = 0;
  }
  return { amount, demerits };
}

function grantAmountFromStatRow_(info, row) {
  return rowScoreParts_(info, row).amount;
}

function demeritAmountFromStatRow_(info, row) {
  return rowScoreParts_(info, row).demerits;
}

function grantFactsFromRow_(info, row, uploadedAt) {
  const extracted = extractStatFactsFromCells_(row);
  const labeledName = info.nameCol >= 0 ? String(row[info.nameCol] || "").trim() : "";
  const labeledClass = info.classCol >= 0 ? String(row[info.classCol] || "").trim() : "";
  const person = splitStatPerson_(labeledName || extracted.name, labeledClass || extracted.className);
  const parts = rowScoreParts_(info, row);
  return {
    name: person.name || extracted.name,
    className: person.className || extracted.className,
    when: formatUploadDate_(uploadedAt),
    amount: parts.amount,
    demerits: parts.demerits,
  };
}

async function applyStatGrantsFromReport_(report) {
  if (!report) return { added: 0, unmatched: 0, skipped: 0, unmatchedNames: [] };
  if (!Array.isArray(state.meta.appliedStatGrants)) state.meta.appliedStatGrants = [];
  const applied = new Set(state.meta.appliedStatGrants);
  let added = 0;
  let addedMerits = 0;
  let addedDemerits = 0;
  let unmatched = 0;
  let skipped = 0;
  const unmatchedNames = [];
  for (const sheet of report.sheets || []) {
    const info = analyzeStatSheet_(sheet);
    for (const row of info.rows) {
      if (rowLooksLikeHeader_(info.headers, row)) continue;
      const facts = grantFactsFromRow_(info, row, report.uploadedAt);
      if (!(facts.amount > 0 || facts.demerits > 0) || !facts.name) continue;
      const student = findStudentForStatRow_(facts.name, facts.className);
      if (!student || isDeletedStudent_(student)) {
        unmatched += 1;
        unmatchedNames.push(facts.className ? `${facts.className} ${facts.name}` : facts.name);
        continue;
      }
      const keyBase = `${student.id}|${facts.name}|${normalizeClassName(facts.className)}`;
      const keyTail = `|${facts.when}|${report.id || report.fileName || ""}`;
      const key = `${keyBase}|m${facts.amount}|d${facts.demerits}${keyTail}`;
      const swapped = `${keyBase}|m${facts.demerits}|d${facts.amount}${keyTail}`;
      if (applied.has(key)) {
        skipped += 1;
        continue;
      }
      let deltaMerits = facts.amount || 0;
      let deltaDemerits = facts.demerits || 0;
      let correcting = false;
      if (
        facts.amount !== facts.demerits &&
        applied.has(swapped) &&
        ((facts.amount === 0 && facts.demerits > 0) || (facts.demerits === 0 && facts.amount > 0))
      ) {
        correcting = true;
        deltaMerits = (facts.amount || 0) - (facts.demerits || 0);
        deltaDemerits = (facts.demerits || 0) - (facts.amount || 0);
        applied.delete(swapped);
      }
      const note = `${correcting ? "통계 정정" : "통계 지급"} ${report.title || report.fileName || ""}${facts.when ? ` · ${facts.when}` : ""}`.slice(0, 80);
      let ok = false;
      if (onlineEnabled() && session.teacherPinForApi) {
        const res = await apiCall("teacher_award", {
          teacherPin: session.teacherPinForApi,
          studentId: student.id,
          deltaMerits,
          deltaOffsets: 0,
          deltaDemerits,
          note,
          ledgerType: correcting ? "stat_grant_fix" : "stat_grant",
          className: "*",
        });
        if (res && res.ok) {
          if (res.student) {
            student.merits = res.student.merits;
            student.offsets = res.student.offsets;
            student.demerits = res.student.demerits;
          } else {
            student.merits = clampNonNeg((Number(student.merits) || 0) + deltaMerits);
            student.demerits = clampNonNeg((Number(student.demerits) || 0) + deltaDemerits);
          }
          addLedger(state, {
            studentId: student.id,
            type: correcting ? "stat_grant_fix" : "stat_grant",
            deltaMerits,
            deltaDemerits,
            note,
          });
          ok = true;
        }
      }
      if (!ok) {
        const r = applyDelta(
          state,
          student.id,
          { merits: deltaMerits, demerits: deltaDemerits },
          { type: correcting ? "stat_grant_fix" : "stat_grant", note }
        );
        if (!r.ok && correcting) {
          student.merits = clampNonNeg((Number(student.merits) || 0) + deltaMerits);
          student.demerits = clampNonNeg((Number(student.demerits) || 0) + deltaDemerits);
          addLedger(state, {
            studentId: student.id,
            type: "stat_grant_fix",
            deltaMerits,
            deltaDemerits,
            note,
          });
          markStudentsDirty();
        } else if (!r.ok) {
          continue;
        }
      }
      applied.add(key);
      added += 1;
      if (facts.amount > 0) addedMerits += 1;
      if (facts.demerits > 0) addedDemerits += 1;
    }
  }
  state.meta.appliedStatGrants = [...applied].slice(-2000);
  saveState(state);
  flushSaveState();
  return { added, addedMerits, addedDemerits, unmatched, skipped, unmatchedNames };
}

let applyingStatGrants_ = false;

async function applyPendingStatGrantsOnBoot_({ toast = false } = {}) {
  if (applyingStatGrants_) return { added: 0, unmatched: 0, skipped: 0 };
  applyingStatGrants_ = true;
  try {
    const reports = listStatReports_();
    let added = 0;
    let unmatched = 0;
    let skipped = 0;
    for (const report of reports) {
      const g = await applyStatGrantsFromReport_(report);
      added += g.added;
      unmatched += g.unmatched;
      skipped += g.skipped;
    }
    if (toast && added > 0) {
      showToast({
        title: "엑셀 점수를 반영했어요",
        detail: `${added}건을 학생 점수에 더했어요.`,
      });
      render();
    }
    return { added, unmatched, skipped };
  } finally {
    applyingStatGrants_ = false;
  }
}

async function inflateRawBytes_(bytes) {
  if (typeof DecompressionStream === "undefined") throw new Error("deflate_unsupported");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzipArrayBuffer_(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  let eocd = -1;
  const min = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip_eocd");
  const cdCount = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < cdCount; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOff = view.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(u8.subarray(p + 46, p + 46 + nameLen));
    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtra = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtra;
    const comp = u8.subarray(dataStart, dataStart + compSize);
    let data = null;
    if (method === 0) data = comp;
    else if (method === 8) data = await inflateRawBytes_(comp);
    if (data) files[name.replace(/\\/g, "/")] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function xmlText_(bytes) {
  let text = new TextDecoder("utf-8").decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function parseXmlDoc_(bytes) {
  return new DOMParser().parseFromString(xmlText_(bytes), "application/xml");
}

function colFromA1_(ref) {
  const m = String(ref || "").match(/^([A-Z]+)/i);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellXmlText_(elNode) {
  if (!elNode) return "";
  const parts = [];
  const walk = (n) => {
    if (!n) return;
    if (n.nodeType === 3) parts.push(n.textContent || "");
    else if (n.nodeType === 1 && String(n.localName || n.nodeName).toLowerCase() === "t") {
      parts.push(n.textContent || "");
      return;
    }
    for (const ch of n.childNodes || []) walk(ch);
  };
  walk(elNode);
  return parts.join("");
}

function readSharedStrings_(files) {
  const raw = files["xl/sharedStrings.xml"];
  if (!raw) return [];
  const doc = parseXmlDoc_(raw);
  return Array.from(doc.getElementsByTagName("si")).map((si) => cellXmlText_(si));
}

function a1ToRowCol_(a1) {
  const m = String(a1 || "").match(/^([A-Z]+)(\d+)$/i);
  if (!m) return { row: 0, col: 0 };
  return { col: colFromA1_(m[1]), row: Number(m[2]) - 1 };
}

function isDateFormatCode_(code) {
  const c = String(code || "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "");
  if (!c || /^[#0.,E+\-%_ ]+$/i.test(c)) return false;
  if (/[yY]/.test(c) || /[dD]/.test(c)) return true;
  if (/[hH]/.test(c)) return true;
  if (/[mM]/.test(c) && /[/\-.]/.test(c)) return true;
  return false;
}

function readXlsxDateStyles_(files) {
  const raw = files["xl/styles.xml"];
  const dateXfs = new Set();
  if (!raw) return dateXfs;
  const doc = parseXmlDoc_(raw);
  const builtIn = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  const custom = new Set();
  for (const nf of doc.getElementsByTagName("numFmt")) {
    const id = Number(nf.getAttribute("numFmtId"));
    if (Number.isFinite(id) && isDateFormatCode_(nf.getAttribute("formatCode") || "")) custom.add(id);
  }
  const cellXfs = doc.getElementsByTagName("cellXfs")[0];
  if (!cellXfs) return dateXfs;
  const xfs = cellXfs.getElementsByTagName("xf");
  for (let i = 0; i < xfs.length; i++) {
    const id = Number(xfs[i].getAttribute("numFmtId") || 0);
    if (builtIn.has(id) || custom.has(id)) dateXfs.add(i);
  }
  return dateXfs;
}

function applyMergeFills_(map, doc, minRow = 0) {
  for (const node of doc.getElementsByTagName("mergeCell")) {
    const parts = String(node.getAttribute("ref") || "").split(":");
    if (parts.length !== 2) continue;
    const a = a1ToRowCol_(parts[0]);
    const b = a1ToRowCol_(parts[1]);
    const r0 = Math.min(a.row, b.row);
    const r1 = Math.max(a.row, b.row);
    const c0 = Math.min(a.col, b.col);
    const c1 = Math.max(a.col, b.col);
    if (r0 < minRow) continue;
    const src = map.get(`${r0}:${c0}`);
    if (src == null || String(src).trim() === "") continue;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = `${r}:${c}`;
        if (!map.has(k) || String(map.get(k) || "").trim() === "") map.set(k, src);
      }
    }
  }
}

function readXlsxCellValue_(c, shared, styles, date1904) {
  const t = c.getAttribute("t") || "";
  const styleIdx = Number(c.getAttribute("s"));
  if (t === "s") {
    const v = c.getElementsByTagName("v")[0];
    const idx = Number(v && v.textContent);
    return Number.isFinite(idx) ? String(shared[idx] ?? "") : "";
  }
  if (t === "inlineStr") return cellXmlText_(c.getElementsByTagName("is")[0] || c);
  if (t === "str") return String((c.getElementsByTagName("v")[0] || {}).textContent || "");
  if (t === "b") {
    const v = c.getElementsByTagName("v")[0];
    return String(v && v.textContent) === "1" ? "TRUE" : "FALSE";
  }
  if (t === "d") {
    const v = c.getElementsByTagName("v")[0];
    return v ? String(v.textContent || "").replace("T", " ").slice(0, 16) : "";
  }
  const v = c.getElementsByTagName("v")[0];
  let val = v ? String(v.textContent || "") : cellXmlText_(c);
  const n = Number(val);
  if (Number.isFinite(n) && styles.has(styleIdx)) {
    const d = excelSerialToDate_(n, !!date1904);
    if (d) val = formatExcelDate_(d, n % 1 !== 0);
  }
  return val;
}

function sheetToTable_(doc, shared, { dateXfs, date1904 } = {}) {
  let maxRow = 0;
  let maxCol = 0;
  const map = new Map();
  const styles = dateXfs || new Set();
  const rowNodes = Array.from(doc.getElementsByTagName("row"));
  const cellNodes = rowNodes.length
    ? rowNodes.flatMap((rowNode) => {
        const rowAttr = Number(rowNode.getAttribute("r") || 0);
        let colCursor = 0;
        return Array.from(rowNode.children || rowNode.childNodes || [])
          .filter((n) => n && n.nodeType === 1 && String(n.localName || n.nodeName).replace(/^.*:/, "") === "c")
          .map((c) => {
            const ref = c.getAttribute("r") || "";
            let row;
            let col;
            if (ref) {
              col = colFromA1_(ref);
              row = Number((ref.match(/(\d+)/) || [0, rowAttr])[1] || rowAttr) - 1;
              colCursor = col + 1;
            } else {
              row = Math.max(0, rowAttr - 1);
              col = colCursor;
              colCursor += 1;
            }
            return { c, row, col };
          });
      })
    : Array.from(doc.getElementsByTagName("c")).map((c) => {
        const ref = c.getAttribute("r") || "";
        const rowMatch = ref.match(/(\d+)/);
        return { c, col: colFromA1_(ref), row: rowMatch ? Number(rowMatch[1]) - 1 : 0 };
      });
  for (const { c, row, col } of cellNodes) {
    const val = readXlsxCellValue_(c, shared, styles, !!date1904);
    map.set(`${row}:${col}`, val);
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  }
  maxCol = Math.min(maxCol, STAT_MAX_COLS - 1);
  maxRow = Math.min(maxRow, STAT_MAX_ROWS);
  const peek = [];
  for (let r = 0; r <= maxRow; r++) {
    const row = [];
    for (let c = 0; c <= maxCol; c++) row.push(map.get(`${r}:${c}`) ?? "");
    peek.push(row);
  }
  while (peek.length && peek[peek.length - 1].every((x) => String(x).trim() === "")) peek.pop();
  if (!peek.length) return { name: "시트", headers: [], rows: [] };
  const headAt = findBestHeaderRow_(peek, 20);
  applyMergeFills_(map, doc, headAt >= 0 ? headAt : 0);
  const lastRow = Math.max(peek.length - 1, maxRow);
  const grid = [];
  for (let r = 0; r <= lastRow; r++) {
    const row = [];
    for (let c = 0; c <= maxCol; c++) row.push(normalizeStatText_(map.get(`${r}:${c}`) ?? ""));
    if (row.some((x) => String(x).trim() !== "")) grid.push({ r, row });
  }
  if (headAt < 0) {
    const allRows = grid.map((g) => g.row);
    const dummy = allRows[0] ? allRows[0].map((_, i) => `${i + 1}열`) : [];
    return polishStatSheet_({ headers: dummy, rows: allRows });
  }
  const head = (grid.find((g) => g.r === headAt) || grid[0] || { row: [] }).row;
  const headers = head.map((h, i) => normalizeStatText_(h) || `${i + 1}열`);
  const rows = grid.filter((g) => g.r > headAt).map((g) => g.row);
  return polishStatSheet_({ headers, rows });
}

async function parseXlsxWorkbook_(arrayBuffer) {
  const files = await unzipArrayBuffer_(arrayBuffer);
  const wbRaw = files["xl/workbook.xml"];
  if (!wbRaw) throw new Error("xlsx_workbook");
  const shared = readSharedStrings_(files);
  const dateXfs = readXlsxDateStyles_(files);
  const relsRaw = files["xl/_rels/workbook.xml.rels"];
  const relMap = {};
  if (relsRaw) {
    const relDoc = parseXmlDoc_(relsRaw);
    for (const rel of relDoc.getElementsByTagName("Relationship")) {
      const id = rel.getAttribute("Id");
      let target = String(rel.getAttribute("Target") || "").replace(/\\/g, "/");
      if (target.startsWith("/")) target = target.slice(1);
      if (!target.startsWith("xl/")) target = "xl/" + target.replace(/^\.\//, "");
      relMap[id] = target;
    }
  }
  const wb = parseXmlDoc_(wbRaw);
  const pr = wb.getElementsByTagName("workbookPr")[0];
  const date1904 = !!(pr && /^(1|true)$/i.test(String(pr.getAttribute("date1904") || "")));
  const sheetNodes = Array.from(wb.getElementsByTagName("sheet"));
  const sheets = [];
  for (const node of sheetNodes.slice(0, STAT_MAX_SHEETS)) {
    const name = node.getAttribute("name") || `시트${sheets.length + 1}`;
    const rid =
      node.getAttribute("r:id") ||
      (typeof node.getAttributeNS === "function"
        ? node.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
        : "") ||
      node.getAttribute("Id") ||
      "";
    const path = relMap[rid] || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const raw = files[path] || files[path.replace(/^xl\//, "")];
    if (!raw) continue;
    const table = sheetToTable_(parseXmlDoc_(raw), shared, { dateXfs, date1904 });
    table.name = name;
    if (table.headers.length || table.rows.length) sheets.push(table);
  }
  if (!sheets.length) throw new Error("xlsx_empty");
  return sheets;
}

function detectCsvDelimiter_(text) {
  const sample = text.slice(0, 4000);
  const counts = {
    ",": (sample.match(/,/g) || []).length,
    "\t": (sample.match(/\t/g) || []).length,
    ";": (sample.match(/;/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ",";
}

function parseCsvText_(text) {
  let src = String(text || "");
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const delim = detectCsvDelimiter_(src);
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQ = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') {
      inQ = true;
      continue;
    }
    if (ch === delim) {
      row.push(cur);
      cur = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    if (ch === "\r") continue;
    cur += ch;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const cleaned = rows.filter((r) => r.some((x) => String(x).trim() !== "")).map((r) => r.map((c) => normalizeStatText_(c)));
  if (!cleaned.length) return [];
  const width = Math.min(STAT_MAX_COLS, Math.max(...cleaned.map((r) => r.length)));
  const padded = cleaned.map((r) => {
    const out = [];
    for (let i = 0; i < width; i++) out.push(String(r[i] ?? "").slice(0, STAT_MAX_CELL));
    return out;
  });
  const headAt = findBestHeaderRow_(padded, 20);
  if (headAt < 0) {
    const dummy = padded[0].map((_, i) => `${i + 1}열`);
    return [polishStatSheet_({ name: "시트1", headers: dummy, rows: padded })];
  }
  const headers = padded[headAt].map((h, i) => normalizeStatText_(h) || `${i + 1}열`);
  const body = padded.slice(headAt + 1, headAt + 1 + STAT_MAX_ROWS);
  return [polishStatSheet_({ name: "시트1", headers, rows: body })];
}

function decodeStatText_(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let utf8 = "";
  try {
    utf8 = new TextDecoder("utf-8", { fatal: false }).decode(u8);
  } catch (_) {
    utf8 = new TextDecoder().decode(u8);
  }
  const badUtf = (utf8.match(/\uFFFD/g) || []).length;
  const hangulUtf = (utf8.match(/[가-힣]/g) || []).length;
  if (badUtf === 0 && hangulUtf > 0) return utf8;
  for (const enc of ["euc-kr", "windows-949"]) {
    try {
      const alt = new TextDecoder(enc).decode(u8);
      const badAlt = (alt.match(/\uFFFD/g) || []).length;
      const hangulAlt = (alt.match(/[가-힣]/g) || []).length;
      if (badAlt < badUtf || (badUtf > 0 && hangulAlt > hangulUtf)) return alt;
    } catch (_) {}
  }
  return utf8;
}

async function parseStatFile_(file) {
  const name = String(file && file.name ? file.name : "자료");
  const lower = name.toLowerCase();
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 8));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isOle = head[0] === 0xd0 && head[1] === 0xcf;
  if (isOle || lower.endsWith(".xls")) {
    throw new Error("old_xls");
  }
  if (isZip || lower.endsWith(".xlsx")) {
    return { fileName: name, sheets: await parseXlsxWorkbook_(buf) };
  }
  const text = decodeStatText_(buf);
  const sheets = parseCsvText_(text);
  if (!sheets.length || !sheets[0].rows.length) throw new Error("empty");
  return { fileName: name, sheets };
}

function formatStatNumber_(n) {
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 100 || Number.isInteger(n)) return String(Math.round(n * 100) / 100);
  return (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, "");
}

function renderStatBars_(items, valueKey, labelKey) {
  const max = Math.max(...items.map((x) => Math.abs(Number(x[valueKey]) || 0)), 1);
  return el(
    "div",
    { class: "stat-bars" },
    items.map((x) => {
      const v = Number(x[valueKey]) || 0;
      const pct = Math.max(4, Math.round((Math.abs(v) / max) * 100));
      return el("div", { class: "stat-bar" }, [
        el("div", { class: "stat-bar__label", title: String(x[labelKey] || "") }, [document.createTextNode(String(x[labelKey] || "-"))]),
        el("div", { class: "stat-bar__track" }, [el("i", { style: `width:${pct}%` })]),
        el("div", { class: "stat-bar__val" }, [document.createTextNode(formatStatNumber_(v))]),
      ]);
    })
  );
}

function statViewerMode_({ manage = false } = {}) {
  if (manage || session.teacherAuthed) return "all";
  if (currentStudent()) return "self";
  return "hidden";
}

function renderStatLoginGate_() {
  return el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("통계 자료")]),
    el("div", { class: "card__sub" }, [
      document.createTextNode("통계는 로그인한 학생 본인 기록만 볼 수 있어요. 학생회는 전체 자료를 볼 수 있어요."),
    ]),
    el("div", { class: "empty", style: "margin-top:12px" }, [
      document.createTextNode("로그인하면 내 통계만 보여 줘요."),
    ]),
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn primary", onClick: () => openStudentLogin() }, [document.createTextNode("학생 로그인")]),
      el("button", { class: "btn", onClick: () => openStudentSignup() }, [document.createTextNode("가입하기")]),
    ]),
  ]);
}

function analyzeStatSheetForViewer_(sheet, mode) {
  const raw = analyzeStatSheet_(sheet);
  if (mode !== "self") return raw;
  if (raw.nameCol < 0) return analyzeStatSheet_({ ...sheet, rows: [] });
  const mine = raw.rows.filter((row) => !rowLooksLikeHeader_(raw.headers, row) && isMyStatRow_(raw, row));
  return analyzeStatSheet_({ ...sheet, rows: mine });
}

function renderStatReportCard_(report, { manage = false } = {}) {
  const mode = statViewerMode_({ manage });
  if (mode === "hidden") return renderStatLoginGate_();
  if (!report) {
    return el("div", { class: "card" }, [
      el("div", { class: "card__title" }, [document.createTextNode(mode === "self" ? "내 통계" : "학교 통계")]),
      el("div", { class: "empty", style: "margin-top:12px" }, [
        document.createTextNode(
          mode === "self"
            ? "아직 올라온 통계 자료가 없어요. 학생회가 엑셀·CSV를 올리면 내 기록만 여기에 나타나요."
            : "아직 올라온 통계 자료가 없어요. 학생회가 엑셀·CSV를 올리면 여기에 보기 쉽게 나타나요."
        ),
      ]),
      session.teacherAuthed
        ? el("div", { class: "row", style: "margin-top:12px" }, [
            el("button", { class: "btn primary", onClick: () => setRoute("teacher") }, [document.createTextNode("자료 올리기")]),
          ])
        : null,
    ]);
  }

  let sheetIndex = 0;
  const wrap = el("div", { class: "card stat-report" });

  const paint = () => {
    const sheet = report.sheets[sheetIndex] || report.sheets[0];
    const info = analyzeStatSheetForViewer_(sheet, mode);
    const chartCol =
      info.meritCol >= 0
        ? info.cols[info.meritCol]
        : info.numericCols[0] || null;
    const classGroups = mode === "all" && chartCol && info.classCol >= 0 ? groupNumericByClass_(info, chartCol.index) : [];
    const tops = mode === "all" && chartCol ? topRowsForCol_(info, chartCol.index, 8) : [];
    const myRow = info.rows.find((row) => isMyStatRow_(info, row));

    const sheetTabs =
      report.sheets.length > 1
        ? el(
            "div",
            { class: "stat-sheet-tabs" },
            report.sheets.map((sh, i) =>
              el(
                "button",
                {
                  class: `stat-sheet-tab${i === sheetIndex ? " is-on" : ""}`,
                  onClick: () => {
                    sheetIndex = i;
                    paint();
                  },
                },
                [document.createTextNode(sh.name)]
              )
            )
          )
        : null;

    const kpis = mode === "self"
      ? [
          kpiBox("내 기록 수", String(info.rows.length)),
          ...(info.grantCol >= 0 || info.meritCol >= 0
            ? [kpiBox("상점 지급", String(info.rows.filter((r) => grantAmountFromStatRow_(info, r) > 0).length))]
            : []),
          ...(info.demeritCol >= 0
            ? [kpiBox("벌점 지급", String(info.rows.filter((r) => demeritAmountFromStatRow_(info, r) > 0).length))]
            : []),
          ...(chartCol ? [kpiBox(`${chartCol.header} 합계`, formatStatNumber_(chartCol.sum))] : []),
        ]
      : [
          kpiBox("자료 행 수", String(info.rows.length)),
          kpiBox("열 수", String(info.headers.length)),
          ...(info.classCol >= 0
            ? [
                kpiBox(
                  "반 수",
                  String(new Set(info.rows.map((r) => String(r[info.classCol] || "").trim()).filter(Boolean)).size)
                ),
              ]
            : []),
          ...(info.grantCol >= 0 || info.meritCol >= 0
            ? (() => {
                const granted = info.rows.filter((r) => grantAmountFromStatRow_(info, r) > 0).length;
                return granted ? [kpiBox("상점 지급", String(granted))] : [];
              })()
            : []),
          ...(info.demeritCol >= 0
            ? (() => {
                const granted = info.rows.filter((r) => demeritAmountFromStatRow_(info, r) > 0).length;
                return granted ? [kpiBox("벌점 지급", String(granted))] : [];
              })()
            : []),
          ...(chartCol
            ? [
                kpiBox(`${chartCol.header} 평균`, formatStatNumber_(chartCol.avg)),
                kpiBox(`${chartCol.header} 합계`, formatStatNumber_(chartCol.sum)),
              ]
            : []),
          ...(info.demeritCol >= 0 && info.cols[info.demeritCol]
            ? [kpiBox(`${info.cols[info.demeritCol].header} 합계`, formatStatNumber_(info.cols[info.demeritCol].sum))]
            : []),
        ];

    const chartBlock =
      mode === "self"
        ? null
        : classGroups.length
          ? el("div", {}, [
              el("div", { class: "class-section__title" }, [document.createTextNode(`반별 ${chartCol.header} 평균`)]),
              renderStatBars_(classGroups, "avg", "className"),
            ])
          : tops.length
            ? el("div", {}, [
                el("div", { class: "class-section__title" }, [document.createTextNode(`${chartCol.header} 상위`)]),
                renderStatBars_(
                  tops.map((t) => ({ ...t, label: t.className ? `${t.label} (${t.className})` : t.label })),
                  "value",
                  "label"
                ),
              ])
            : el("div", { class: "empty" }, [document.createTextNode("숫자 열이 없어 표로만 보여 줘요.")]);

    const unmatchedGrant =
      mode === "all" && info.nameCol >= 0
        ? info.rows.filter((row) => {
            const amount = grantAmountFromStatRow_(info, row);
            if (!(amount > 0)) return false;
            const name = String(row[info.nameCol] || "").trim();
            const cls = info.classCol >= 0 ? String(row[info.classCol] || "").trim() : "";
            return !findStudentForStatRow_(name, cls);
          }).length
        : 0;
    const unmatchedHint =
      unmatchedGrant > 0
        ? el("div", { class: "empty", style: "margin-top:8px" }, [
            document.createTextNode(
              `지급 ${unmatchedGrant}건은 같은 이름·반으로 가입한 학생이 없어 점수에 넣지 못했어요.`
            ),
          ])
        : null;

    const search = el("input", {
      id: `stat-q-${report.id}`,
      placeholder: "이름·학번·번호·반 검색 (예: 홍길동, 15, 2-3, 10103)",
      value: wrap._q || "",
    });
    const q = String(wrap._q || "").trim();
    const dataRows = info.rows.filter((row) => !rowLooksLikeHeader_(info.headers, row));
    const filtered = q ? dataRows.filter((row) => statRowMatchesQuery_(info, row, q)) : dataRows;
    const showLimit = q ? 500 : 200;
    const shown = filtered.slice(0, showLimit);
    search.addEventListener("input", () => {
      wrap._q = search.value;
      if (wrap._searchTimer) clearTimeout(wrap._searchTimer);
      wrap._searchTimer = setTimeout(() => {
        paint();
        const next = wrap.querySelector("input");
        if (next) {
          next.focus();
          const n = next.value.length;
          try {
            next.setSelectionRange(n, n);
          } catch (_) {}
        }
      }, 160);
    });

    const table = el(
      "div",
      { class: "stat-table-wrap" },
      [
        el("table", { class: "table" }, [
          el(
            "thead",
            {},
            [
              el(
                "tr",
                {},
                info.headers.map((h) => el("th", {}, [document.createTextNode(h)]))
              ),
            ]
          ),
          el(
            "tbody",
            {},
            shown.map((row) =>
              el(
                "tr",
                { class: isMyStatRow_(info, row) ? "stat-me" : "" },
                info.headers.map((_, i) => el("td", {}, [document.createTextNode(String(row[i] ?? ""))]))
              )
            )
          ),
        ]),
      ]
    );

    wrap.replaceChildren(
      ...[
      renderStatReportPager_(report),
      el("div", { class: "row row--between" }, [
        el("div", {}, [
          el("div", { class: "card__title" }, [document.createTextNode(mode === "self" ? "내 통계" : report.title || "학교 통계")]),
          el("div", { class: "card__sub" }, [
            document.createTextNode(
              mode === "self"
                ? `${report.title || "통계 자료"} · 내 이름·반과 같은 기록만 보여 줘요.`
                : `${report.fileName || "업로드 자료"} · ${fmtDate(report.uploadedAt)} · 학생회가 올린 통계를 보기 쉽게 정리했어요.`
            ),
          ]),
        ]),
        manage
          ? el("div", { class: "row" }, [
              el("button", { class: "btn", onClick: () => openRenameStatReport_(report.id) }, [document.createTextNode("제목 수정")]),
              el("button", { class: "btn danger", onClick: () => removeStatReport_(report.id) }, [document.createTextNode("삭제")]),
            ])
          : currentStudent()
            ? el("button", { class: "btn primary", onClick: () => setRoute("rewards") }, [document.createTextNode("보상 사기")])
            : null,
      ]),
      el("div", { class: "stat-report__meta" }, [
        el("span", { class: "pill good" }, [document.createTextNode(`시트 ${report.sheets.length}개`)]),
        el("span", { class: "pill" }, [document.createTextNode(`${sheet.name} · ${info.rows.length}행`)]),
        mode === "all" && myRow
          ? el("span", { class: "pill warn" }, [document.createTextNode("표에서 내 줄이 노랗게 표시돼요")])
          : mode === "self"
            ? el("span", { class: "pill warn" }, [document.createTextNode("내 기록만 표시")])
            : null,
      ].filter(Boolean)),
      sheetTabs,
      kpis.length ? el("div", { class: `kpi kpi--4`, style: "margin-top:12px" }, kpis.slice(0, 6)) : null,
      chartBlock,
      unmatchedHint,
      mode === "all" && myRow
        ? el("div", { class: "notice", style: "margin-top:4px" }, [
            el("div", { style: "font-weight:900" }, [document.createTextNode("내 통계")]),
            el("div", { class: "muted", style: "font-size:13px;margin-top:6px;line-height:1.5" }, [
              document.createTextNode(
                info.headers
                  .map((h, i) => `${h} ${String(myRow[i] ?? "").trim() || "-"}`)
                  .slice(0, 6)
                  .join(" · ")
              ),
            ]),
            el("div", { class: "row", style: "margin-top:10px" }, [
              el("button", { class: "btn primary", onClick: () => setRoute("rewards") }, [document.createTextNode("보상 상점 가기")]),
              currentStudent()
                ? el("button", { class: "btn", onClick: () => openStudentDetail(currentStudent().id) }, [
                    document.createTextNode("내 기록"),
                  ])
                : el("button", { class: "btn", onClick: () => openStudentLogin() }, [document.createTextNode("로그인하고 관리")]),
            ]),
          ])
        : null,
      el("div", {}, [
        el("div", { class: "class-section__title" }, [document.createTextNode(mode === "self" ? "내 자료" : "자료 표")]),
        mode === "all" ? el("div", { class: "form", style: "margin-top:8px" }, [el("div", { class: "form__full" }, [search])]) : null,
        filtered.length
          ? table
          : el("div", { class: "empty", style: "margin-top:10px" }, [
              document.createTextNode(
                mode === "self" && !q
                  ? "이 자료에 내 이름·반으로 된 줄이 없어요."
                  : q
                    ? "이름·학번·번호와 맞는 기록이 없어요."
                    : "검색 결과가 없어요."
              ),
            ]),
        info.rows.length > showLimit || filtered.length > showLimit
          ? el("div", { class: "hint", style: "margin-top:8px" }, [
              document.createTextNode(
                q
                  ? `검색 ${filtered.length}건 중 ${shown.length}건을 보여 줘요.`
                  : `처음 ${showLimit}행만 표에 보여 줘요. (전체 ${info.rows.length}행)`
              ),
            ])
          : q && filtered.length
            ? el("div", { class: "hint", style: "margin-top:8px" }, [
                document.createTextNode(`${filtered.length}명의 기록이 검색됐어요. 학년·반·번호 순으로 정리돼 있어요.`),
              ])
            : null,
      ].filter(Boolean)),
      ].filter(Boolean)
    );
  };

  paint();
  return wrap;
}

function openRenameStatReport_(id) {
  const reports = listStatReports_();
  const report = reports.find((r) => r.id === id);
  if (!report) return;
  const input = el("input", { id: "stat-title", value: report.title, maxlength: "80" });
  const body = el("div", {}, [
    el("div", { class: "hint" }, [document.createTextNode("학생 홈·통계 탭에 이 제목으로 보여요.")]),
    el("div", { class: "form" }, [el("div", { class: "form__full" }, [el("label", { for: "stat-title" }, [document.createTextNode("제목")]), input])]),
  ]);
  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn primary",
        onClick: async () => {
          report.title = String(input.value || "").trim().slice(0, 80) || report.fileName || "통계 자료";
          await persistStatReports_(reports, report.id);
          closeModal();
          render();
        },
      },
      [document.createTextNode("저장")]
    ),
  ]);
  openModal({ title: "통계 제목", bodyNode: body, actionsNode: actions });
}

async function persistStatReports_(reports, activeId) {
  state.meta.statReports = compactStatReports_(reports);
  if (activeId) state.meta.activeStatReportId = activeId;
  else if (!state.meta.statReports.some((r) => r.id === state.meta.activeStatReportId)) {
    state.meta.activeStatReportId = state.meta.statReports[0] ? state.meta.statReports[0].id : null;
  }
  saveState(state);
  if (onlineEnabled() && session.teacherPinForApi) {
    const res = await pushTeacherMetaToServer({ statReports: state.meta.statReports, activeStatReportId: state.meta.activeStatReportId });
    if (!res.ok && !res.skipped) {
      const err = String(res.error || "unknown");
      alert(
        (err === "stat_too_large" ? "자료가 커서 서버에는 못 올렸어요. 행 수를 줄이거나 CSV로 다시 올려 주세요." : "서버 저장 실패: " + err) +
          "\n이 기기에는 저장됐어요."
      );
    }
  }
}

async function removeStatReport_(id) {
  if (!confirm("이 통계 자료를 삭제할까요?")) return;
  const next = listStatReports_().filter((r) => r.id !== id);
  viewingStatReportId_ = next[0] ? next[0].id : null;
  await persistStatReports_(next, next[0] ? next[0].id : null);
  render();
}

function renderStatUploadCard_() {
  const fileInput = el("input", {
    type: "file",
    accept: ".xlsx,.csv,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    style: "display:none",
  });
  const title = el("input", { id: "stat-up-title", placeholder: "예) 3월 생활점수 현황", maxlength: "80" });
  const pick = () => fileInput.click();
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    await withLoading("통계 자료를 읽고 있어요…", async () => {
      try {
        const parsed = await parseStatFile_(file);
        const uploadedAt = nowISO();
        const report = {
          id: uid(),
          title: String(title.value || "").trim() || parsed.fileName.replace(/\.[^.]+$/, "") || "통계 자료",
          fileName: parsed.fileName,
          uploadedAt,
          sheets: stampStatSheetsUploadDate_(parsed.sheets, uploadedAt),
        };
        const next = [report, ...listStatReports_().filter((r) => r.id !== report.id)].slice(0, STAT_MAX_REPORTS);
        viewingStatReportId_ = report.id;
        await persistStatReports_(next, report.id);
        const grant = await applyStatGrantsFromReport_(report);
        const grantBits = [];
        if (grant.addedMerits > 0) grantBits.push(`상점 ${grant.addedMerits}건`);
        if (grant.addedDemerits > 0) grantBits.push(`벌점 ${grant.addedDemerits}건`);
        const grantMsg =
          grantBits.length
            ? ` · ${grantBits.join(" · ")} 지급`
            : grant.unmatched > 0
              ? ` · ${grant.unmatched}건은 가입 학생 없음${grant.unmatchedNames?.length ? ` (${grant.unmatchedNames.slice(0, 3).join(", ")})` : ""}`
              : grant.skipped > 0
                ? ` · 이미 반영된 지급 ${grant.skipped}건`
                : "";
        showToast({
          title: "통계가 올라갔어요!",
          detail: `${report.title} · ${report.sheets.reduce((a, s) => a + s.rows.length, 0)}행${grantMsg}`,
        });
        render();
      } catch (err) {
        const code = String(err && err.message ? err.message : err);
        if (code === "old_xls") {
          alert("예전 .xls 형식은 바로 열 수 없어요.\n엑셀에서 .xlsx 또는 CSV로 저장한 뒤 다시 올려 주세요.");
        } else if (code === "deflate_unsupported") {
          alert("이 브라우저는 엑셀(.xlsx) 압축을 풀 수 없어요. Edge/Chrome을 쓰거나 CSV로 올려 주세요.");
        } else {
          alert("파일을 읽지 못했어요. 엑셀(.xlsx)이나 CSV로 다시 올려 주세요. 제목 행이 위에 있어도 되고, 이름·반·상점이 적혀 있으면 됩니다.");
        }
      }
    });
  });

  return el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("통계 자료 올리기")]),
    el("div", { class: "card__sub" }, [
      document.createTextNode("엑셀(.xlsx) 또는 CSV를 올리면 홈·통계 탭에 학년·반·번호·이름 순으로 정리해 보여 줘요. 이름이나 학번으로 검색할 수 있어요."),
    ]),
    el("div", { class: "form", style: "margin-top:12px" }, [
      el("div", { class: "form__full" }, [el("label", { for: "stat-up-title" }, [document.createTextNode("자료 제목(선택)")]), title]),
    ]),
    el("div", { class: "stat-upload", style: "margin-top:12px" }, [
      el("div", { class: "stat-upload__title" }, [document.createTextNode("엑셀 / CSV 파일")]),
      el("div", { class: "hint" }, [
        document.createTextNode("엑셀 열 순서가 달라도 학년·반·번호·이름 순으로 맞춰요. 통계 탭에서 이름·학번·번호로 바로 찾을 수 있어요. 엑셀(.xlsx) 또는 CSV, 최대 600행."),
      ]),
      el("div", { class: "row", style: "margin-top:12px;justify-content:center" }, [
        el("button", { class: "btn primary", onClick: pick }, [document.createTextNode("파일 선택해서 올리기")]),
        el(
          "button",
          {
            class: "btn",
            onClick: () => {
              const csv =
                "학년,반,번호,이름,상점,지급,날짜\n1,1,3,홍길동,2,지급,2026-03-01\n2,3,15,김민수,1,지급,2026-03-02\n1,2,8,이서연,1,미지급,2026-03-03\n";
              const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "통계양식.csv";
              a.click();
              URL.revokeObjectURL(a.href);
            },
          },
          [document.createTextNode("양식 CSV 받기")]
        ),
      ]),
      fileInput,
    ]),
  ]);
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  const merged = { ...attrs };
  // 모달이 <form method="dialog"> 안에 있어 type 미지정 시 submit이 됨 → Enter/터치 시 의도와 다른 제출·닫힘 방지
  if (String(tag).toLowerCase() === "button") {
    if (!("type" in merged)) merged.type = "button";
    if (merged.value === "cancel" && typeof merged.onClick !== "function") {
      merged.onClick = () => closeModal();
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === false || v == null) continue;
    else if (k === "disabled") node.disabled = !!v;
    else node.setAttribute(k, String(v));
  }
  for (const ch of children) node.append(ch);
  return node;
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

const ASSET = {
  nameMascot: "./assets/mascot-name.png",
  loadingMascot: "./assets/loading-mascot.png",
  toastMascot: "./assets/toast-mascot.png",
  logo: "./assets/logo.png",
};

/** 이름 앞 마스코트 — img 반복 디코딩 대신 CSS 배경 사용 */
function nameWithMascot(label, { large = false } = {}) {
  return el("span", { class: "name-with-mascot" }, [
    el("span", {
      class: large ? "name-with-mascot__img name-with-mascot__img--lg" : "name-with-mascot__img",
      "aria-hidden": "true",
    }),
    el("span", { class: "name-with-mascot__label" }, [document.createTextNode(String(label ?? ""))]),
  ]);
}

const loadingOverlayEl = document.getElementById("loading-overlay");
const loadingMsgEl = document.getElementById("loading-msg");
let loadingCount = 0;

loadingOverlayEl?.addEventListener("cancel", (e) => {
  // Esc로 로딩이 중간에 닫히지 않게
  e.preventDefault();
});

function showLoading(message = "처리 중이에요…") {
  loadingCount += 1;
  if (loadingMsgEl) loadingMsgEl.textContent = message;
  if (!loadingOverlayEl) return;
  loadingOverlayEl.setAttribute("aria-hidden", "false");
  try {
    if (typeof loadingOverlayEl.showModal === "function") {
      if (!loadingOverlayEl.open) loadingOverlayEl.showModal();
    } else {
      loadingOverlayEl.hidden = false;
      loadingOverlayEl.classList.add("is-on");
    }
  } catch {
    loadingOverlayEl.hidden = false;
    loadingOverlayEl.classList.add("is-on");
  }
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount > 0) return;
  if (!loadingOverlayEl) return;
  loadingOverlayEl.setAttribute("aria-hidden", "true");
  try {
    if (loadingOverlayEl.open) loadingOverlayEl.close();
  } catch {
    /* ignore */
  }
  loadingOverlayEl.hidden = true;
  loadingOverlayEl.classList.remove("is-on");
}

/** 모달을 먼저 닫은 뒤 잠깐 대기 (dialog top layer 해제) */
async function afterModalClose() {
  closeModal();
  await Promise.resolve();
}

async function withLoading(message, fn) {
  const started = Date.now();
  const minMs = 120;
  showLoading(message);
  await Promise.resolve();
  try {
    return await fn();
  } finally {
    const wait = Math.max(0, minMs - (Date.now() - started));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    hideLoading();
  }
}

const toastHostEl = document.getElementById("toast-host");

/** 상단 알림(3번 이미지 스타일) */
function showToast({ title = "알림", detail = "", duration = 3800 } = {}) {
  if (!toastHostEl) return;
  const toast = el("div", { class: "toast", role: "status" }, [
    el("div", { class: "toast__star", "aria-hidden": "true" }, [document.createTextNode("★")]),
    el("img", { class: "toast__mascot", src: ASSET.toastMascot, alt: "" }),
    el("div", { class: "toast__body" }, [
      (() => {
        const titleEl = el("div", { class: "toast__title" });
        const text = String(title);
        if (text.startsWith("상점")) {
          titleEl.append(
            el("span", { class: "accent" }, [document.createTextNode("상점")]),
            document.createTextNode(text.slice(2))
          );
        } else {
          titleEl.append(document.createTextNode(text));
        }
        return titleEl;
      })(),
      detail
        ? el("div", { class: "toast__detail" }, [document.createTextNode(String(detail))])
        : null,
    ].filter(Boolean)),
    el(
      "button",
      {
        type: "button",
        class: "toast__close",
        "aria-label": "닫기",
        onClick: () => dismissToast(toast),
      },
      [document.createTextNode("✕")]
    ),
  ]);
  toastHostEl.append(toast);
  const timer = setTimeout(() => dismissToast(toast), duration);
  toast._timer = timer;
}

function dismissToast(toast) {
  if (!toast || toast._leaving) return;
  toast._leaving = true;
  if (toast._timer) clearTimeout(toast._timer);
  toast.classList.add("toast--out");
  setTimeout(() => toast.remove(), 280);
}

// Modal helpers
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalActions = document.getElementById("modal-actions");

function openModal({ title, bodyNode, actionsNode }) {
  modalTitle.textContent = title;
  modalBody.replaceChildren(bodyNode);
  modalActions.replaceChildren(actionsNode);
  modal.showModal();
}

function closeModal() {
  if (modal && modal.open) modal.close();
}

document.getElementById("modal-close-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  closeModal();
});

// Router
const root = document.getElementById("app-root");
const tabs = Array.from(document.querySelectorAll(".tab"));
let state = loadState();
if (state.meta && (state.meta.deployCleanToast || state.meta.pendingServerWipe)) flushSaveState();
void hydrateCloudApiUrlFromDisk_();
if (!state.meta?.pendingServerWipe) void applyPendingStatGrantsOnBoot_({ toast: true });
let route = "students";
const schoolNameEl = document.getElementById("school-name");
const onlineHintEl = document.getElementById("online-hint");

const session = {
  studentId: null,
  teacherAuthed: false,
  rememberStudent: true,
  rememberTeacher: true,
  /** 온라인 API 호출용(메모리만, 저장 안 함) */
  studentPinForApi: null,
  teacherPinForApi: null,
  /** 담당 반(예: "2-3"). "*" = 전체 반 */
  teacherClassName: null,
};

function loadSession() {
  session.teacherPinForApi = null;
  session.studentPinForApi = null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s || typeof s !== "object") return;
    session.studentId = typeof s.studentId === "string" ? s.studentId : null;
    session.teacherAuthed = !!s.teacherAuthed;
    session.rememberStudent = s.rememberStudent !== false;
    session.rememberTeacher = !!s.rememberTeacher;
    session.teacherClassName = typeof s.teacherClassName === "string" && s.teacherClassName ? s.teacherClassName : null;
    if (session.rememberTeacher && typeof s.teacherPinCache === "string" && normPin(s.teacherPinCache)) {
      session.teacherPinForApi = s.teacherPinCache;
      const h = hashPin(s.teacherPinCache);
      if (h && h === String(state.settings?.teacherPinHash || "").trim()) {
        session.teacherAuthed = true;
      }
    }
    if (onlineEnabled() && !session.teacherAuthed) {
      session.teacherAuthed = false;
    }
    if (session.rememberStudent && typeof s.studentPinCache === "string" && normPin(s.studentPinCache)) {
      session.studentPinForApi = s.studentPinCache;
    }
  } catch {
    // ignore
  }
}

function saveSession() {
  const pinOk = session.rememberStudent && session.studentPinForApi && normPin(session.studentPinForApi);
  const teacherPinOk = session.rememberTeacher && session.teacherPinForApi && normPin(session.teacherPinForApi);
  const toSave = {
    studentId: session.rememberStudent ? session.studentId : null,
    teacherAuthed: session.rememberTeacher ? session.teacherAuthed : false,
    rememberStudent: !!session.rememberStudent,
    rememberTeacher: !!session.rememberTeacher,
    teacherClassName: session.teacherClassName || null,
    /** 자동 로그인 켬일 때만: 이 기기에서 온라인 동작용 PIN(공유 기기면 자동 로그인 끄기) */
    studentPinCache: pinOk ? session.studentPinForApi : null,
    teacherPinCache: teacherPinOk ? session.teacherPinForApi : null,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(toSave));
}

async function hydrateOnlineSchoolConfig() {
  if (!onlineEnabled()) return false;
  if (state.meta?.pendingServerWipe || state.meta?.blockServerRosterRestore) return false;
  const schoolName = state.meta?.schoolName ? String(state.meta.schoolName).trim() : "";
  const res = await apiCall("public_school_config", { schoolName });
  if (!res || !res.ok) return false;
  let changed = false;
  if (res.classPolicy && typeof res.classPolicy === "object" && Object.keys(res.classPolicy).length) {
    state.classPolicy = { ...state.classPolicy, ...res.classPolicy };
    changed = true;
  }
  if (Array.isArray(res.rewardCatalog) && res.rewardCatalog.length) {
    state.rewardCatalog = migrateRewardCatalog_(res.rewardCatalog);
    changed = true;
  }
  if (res.schoolNotice !== undefined) {
    state.meta.schoolNotice = String(res.schoolNotice || "").slice(0, 200);
    state.meta.schoolNoticeAt = res.schoolNoticeAt || null;
    changed = true;
  }
  if (res.homeStats && typeof res.homeStats === "object") {
    state.meta.homeStats = res.homeStats;
    state.meta.homeStatsAt = String(Date.now());
    changed = true;
  }
  if (Array.isArray(res.statReports)) {
    state.meta.statReports = normalizeStatReports_(res.statReports);
    if (res.activeStatReportId) state.meta.activeStatReportId = String(res.activeStatReportId);
    else if (!state.meta.statReports.some((r) => r.id === state.meta.activeStatReportId)) {
      state.meta.activeStatReportId = state.meta.statReports[0] ? state.meta.statReports[0].id : null;
    }
    changed = true;
    void applyPendingStatGrantsOnBoot_({ toast: true });
  }
  if (res.teacherPinOneTimeResetUsed) {
    state.settings.teacherPinOneTimeResetUsed = true;
    state.meta.teacherPinOneTimeResetAvailable = false;
    changed = true;
  } else if (res.teacherPinOneTimeResetAvailable === true || res.teacherPinOneTimeResetAvailable === false) {
    state.meta.teacherPinOneTimeResetAvailable = !!res.teacherPinOneTimeResetAvailable;
    changed = true;
  }
  if (changed) saveState(state);
  return changed;
}

function applyTeacherMetaFromResponse_(res) {
  if (!res || !res.ok) return;
  if (res.classPolicy && typeof res.classPolicy === "object" && Object.keys(res.classPolicy).length) {
    state.classPolicy = { ...state.classPolicy, ...res.classPolicy };
  }
  if (Array.isArray(res.rewardCatalog) && res.rewardCatalog.length) {
    state.rewardCatalog = migrateRewardCatalog_(res.rewardCatalog);
  }
  if (state.meta?.pendingServerWipe) return;
  if (res.schoolNotice !== undefined) {
    state.meta.schoolNotice = String(res.schoolNotice || "").slice(0, 200);
    state.meta.schoolNoticeAt = res.schoolNoticeAt || null;
  }
  if (Array.isArray(res.statReports)) {
    state.meta.statReports = normalizeStatReports_(res.statReports);
    if (res.activeStatReportId) state.meta.activeStatReportId = String(res.activeStatReportId);
    void applyPendingStatGrantsOnBoot_({ toast: true });
  }
}

async function pullTeacherMetaAfterLogin() {
  if (!onlineEnabled() || !session.teacherPinForApi) return;
  const res = await apiCall("teacher_get_meta", { teacherPin: session.teacherPinForApi });
  applyTeacherMetaFromResponse_(res);
}

/** teacher_students API와 동일한 병합 규칙(로그인 응답에 명단이 올 때 재사용) */
function applyTeacherRosterFromStudentsArray_(incoming, schoolName, { skipGrants = false } = {}) {
  if (state.meta?.blockServerRosterRestore || state.meta?.pendingServerWipe) {
    if (!allowServerRosterRestore_()) return;
  }
  const byId = new Map(state.students.map((s) => [s.id, s]));
  const mapped = (incoming || [])
    .filter((s) => !isDeletedStudent_(s))
    .map((s) => {
    const prev = byId.get(s.id);
    return {
      id: s.id,
      schoolName: s.schoolName,
      name: s.name,
      className: s.className,
      merits: Math.max(Number(s.merits || 0), Number(prev?.merits || 0)),
      offsets: s.offsets,
      demerits: Math.max(Number(s.demerits || 0), Number(prev?.demerits || 0)),
      trusted: !!s.trusted,
      lastMonthlyGrantYYYYMM: s.lastMonthlyGrantYYYYMM ?? null,
      pinHash: prev?.pinHash ?? null,
    };
  });
  if (!schoolName) {
    state.students = dedupeStudentsList(mapped);
  } else {
    const ids = new Set(mapped.map((x) => x.id));
    const others = state.students.filter((s) => !ids.has(s.id));
    state.students = dedupeStudentsList(others.concat(mapped));
  }
  state.students = state.students.filter((s) => !isDeletedStudent_(s));
  teacherRosterCooldownUntil = Date.now() + 450;
  markStudentsDirty();
  if (!skipGrants) void applyPendingStatGrantsOnBoot_({ toast: true });
}

async function pushTeacherMetaToServer(extra) {
  if (!onlineEnabled() || !session.teacherPinForApi) return { ok: false, skipped: true };
  return apiCall("teacher_set_meta", {
    teacherPin: session.teacherPinForApi,
    classPolicy: state.classPolicy,
    rewardCatalog: state.rewardCatalog,
    ...(extra && typeof extra === "object" ? extra : {}),
  });
}

let teacherRosterSyncPromise = null;
/** 직전 성공 직후 짧게 중복 teacher_students 호출 생략(로그인 직후 + 탭 렌더 이중 요청 등) */
let teacherRosterCooldownUntil = 0;

async function syncTeacherRosterFromServer() {
  if (!onlineEnabled() || !session.teacherPinForApi) return;
  if (state.meta?.pendingServerWipe) {
    const wiped = await maybeWipeServerDemoData_();
    if (!wiped) return;
  }
  if (state.meta?.blockServerRosterRestore) {
    if (!allowServerRosterRestore_()) return;
  }
  if (Date.now() < teacherRosterCooldownUntil) return;
  if (teacherRosterSyncPromise) return teacherRosterSyncPromise;

  teacherRosterSyncPromise = (async () => {
    try {
      const schoolName = state.meta?.schoolName ? String(state.meta.schoolName).trim() : "";
      const className = normalizeClassName(session.teacherClassName);
      const res = await apiCall("teacher_students", {
        teacherPin: session.teacherPinForApi,
        schoolName,
        className: className && className !== "*" ? className : "",
      });
      if (!res || !res.ok) return;
      applyTeacherRosterFromStudentsArray_(res.students || [], schoolName);
    } finally {
      teacherRosterSyncPromise = null;
    }
  })();

  return teacherRosterSyncPromise;
}

// PWA: register service worker (works when served via http/https; file:// may not allow)
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

window.addEventListener("pagehide", () => {
  try {
    flushSaveState();
    saveSession();
  } catch (_) {
    // ignore
  }
});

window.addEventListener("beforeunload", () => {
  try {
    flushSaveState();
    saveSession();
  } catch (_) {
    // ignore
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && onlineEnabled()) {
    if (route === "students" && state.meta?.schoolName) refreshPublicStudents();
    void pullStudentLedger_();
  }
});

function currentStudent() {
  if (!session.studentId) return null;
  return getStudent(state, session.studentId);
}

function requireStudent() {
  const s = currentStudent();
  if (!s) {
    openStudentLogin();
    return null;
  }
  return s;
}

function requireTeacher() {
  if (!session.teacherAuthed) {
    openTeacherLogin();
    return false;
  }
  return true;
}

function teacherPinOneTimeResetUsed_() {
  return !!state.settings?.teacherPinLocked;
}

/** 학생회에 한 번도 로그인하지 못했으면 다시 정할 수 있음. 로그인에 성공한 뒤에는 막음 */
function teacherPinOneTimeResetAvailable_() {
  if (session.teacherAuthed) return false;
  if (session.studentId) return false;
  return !state.settings?.teacherPinLocked;
}

function markTeacherPinOneTimeResetUsed_() {
  state.settings.teacherPinLocked = true;
  state.settings.teacherPinOneTimeResetUsed = true;
  state.meta.teacherPinOneTimeResetAvailable = false;
}

function unlockTeacherPinOneTimeReset_() {
  state.settings.teacherPinLocked = false;
  state.settings.teacherPinOneTimeResetUsed = false;
  state.meta.teacherPinOneTimeResetAvailable = true;
}

function loginTeacherWithPin_(pinValue) {
  const h = hashPin(pinValue);
  clearOppositeSession_("teacher");
  session.rememberTeacher = true;
  session.teacherPinForApi = pinValue;
  session.teacherAuthed = true;
  if (h) state.settings.teacherPinHash = h;
  state.settings.teacherPinLocked = true;
  saveState(state);
  saveSession();
}

function setRoute(next) {
  const prev = route;
  route = next;
  for (const t of tabs) {
    const active = t.dataset.route === route;
    t.setAttribute("aria-current", active ? "page" : "false");
  }
  render();
  if (route === "teacher" && route !== prev) {
    queueMicrotask(() => void ensureTeacherRosterFresh_());
  }
}

async function ensureTeacherRosterFresh_() {
  if (!onlineEnabled() || !session.teacherPinForApi) return;
  if (state.meta?.pendingServerWipe) {
    const wiped = await maybeWipeServerDemoData_();
    if (!wiped) return;
  }
  if (state.meta?.blockServerRosterRestore) {
    if (!allowServerRosterRestore_()) return;
    flushSaveState();
  }
  if (Date.now() - lastTeacherRosterSyncAt < 60_000) return;
  lastTeacherRosterSyncAt = Date.now();
  const before = JSON.stringify(state.students.map((s) => [s.id, s.merits, s.offsets, s.demerits]));
  await syncTeacherRosterFromServer();
  const after = JSON.stringify(state.students.map((s) => [s.id, s.merits, s.offsets, s.demerits]));
  if (route === "teacher" && before !== after) render();
}

tabs.forEach((t) => t.addEventListener("click", () => setRoute(t.dataset.route)));

let renderMicrotaskQueued = false;
let renderDidFirstPaint = false;

/** 같은 턴에서 render가 여러 번 불려도 한 번만 그리기(rAF보다 다음 프레임을 기다리지 않아 체감이 빠름) */
function render() {
  if (!renderDidFirstPaint) {
    renderDidFirstPaint = true;
    renderImpl();
    return;
  }
  if (renderMicrotaskQueued) return;
  renderMicrotaskQueued = true;
  queueMicrotask(() => {
    renderMicrotaskQueued = false;
    renderImpl();
  });
}

function renderImpl() {
  if (studentsNeedDedupe) {
    state.students = dedupeStudentsList(state.students);
    studentsNeedDedupe = false;
  }
  // session consistency (e.g., student deleted)
  if (session.studentId && !getStudent(state, session.studentId)) {
    session.studentId = null;
    scheduleSaveSession();
  }

  const schoolName = state.meta?.schoolName ? String(state.meta.schoolName) : "학교 미설정";
  if (schoolNameEl) schoolNameEl.textContent = schoolName;
  if (onlineHintEl) {
    onlineHintEl.textContent = onlineEnabled() ? ` · 온라인(${shortApiUrlLabel()})` : "";
  }
  document.title = `스쿨 럭키포인트 · ${schoolName}`;
  if (route === "students") renderStudentHome();
  else if (route === "teacher") renderTeacher();
  else if (route === "rewards") renderRewards();
  else if (route === "class") renderClass();
  else if (route === "settings") renderSettings();
  else renderStudentHome();
}

function studentPills(s) {
  return el("div", { class: "row" }, [
    el("span", { class: "pill good", title: "상점" }, [document.createTextNode(`상점 `), el("b", {}, [document.createTextNode(String(s.merits))])]),
    el("span", { class: "pill bad", title: "벌점" }, [document.createTextNode(`벌점 `), el("b", {}, [document.createTextNode(String(s.demerits))])]),
  ]);
}

function renderStudentHome() {
  const s = currentStudent();
  const guest = !s && !session.teacherAuthed;

  const welcome = guest
    ? el("div", { class: "card welcome-card" }, [
        el("div", { class: "welcome-card__kicker" }, [document.createTextNode("스쿨 럭키포인트")]),
        el("div", { class: "card__title welcome-card__title" }, [document.createTextNode("로그인하면 내 통계와 보상을 봐요")]),
        el("div", { class: "card__sub" }, [
          document.createTextNode("이 사이트에서는 상점·벌점을 주지 않아요. 학생으로 로그인하면 내 통계만 보이고, 보상을 살 수 있어요."),
        ]),
        el("ol", { class: "steps" }, [
          el("li", { class: "steps__item" }, [
            el("span", { class: "steps__num" }, [document.createTextNode("1")]),
            el("span", {}, [document.createTextNode("학생회 명단에 내 이름이 있으면 가입·로그인해요.")]),
          ]),
          el("li", { class: "steps__item" }, [
            el("span", { class: "steps__num" }, [document.createTextNode("2")]),
            el("span", {}, [document.createTextNode("로그인 후 내 쿠폰과 보상 상점을 쓸 수 있어요.")]),
          ]),
          el("li", { class: "steps__item" }, [
            el("span", { class: "steps__num" }, [document.createTextNode("3")]),
            el("span", {}, [document.createTextNode("학생회가 통계 자료와 홈페이지를 관리해요.")]),
          ]),
        ]),
        el("div", { class: "gate" }, [
          el("div", { class: "gate__box" }, [
            el("div", { class: "gate__label" }, [document.createTextNode("학생")]),
            el("div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;line-height:1.5" }, [
              document.createTextNode("내 통계 확인 · 보상 구매 · 쿠폰 보여주기"),
            ]),
            el("div", { class: "row" }, [
              el("button", { class: "btn primary", onClick: () => openStudentSignup() }, [document.createTextNode("가입하기")]),
              el("button", { class: "btn", onClick: () => openStudentLogin() }, [document.createTextNode("학생 로그인")]),
            ]),
          ]),
          el("div", { class: "gate__box" }, [
            el("div", { class: "gate__label" }, [document.createTextNode("학생회")]),
            el("div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;line-height:1.5" }, [
              document.createTextNode("엑셀 통계 업로드 · 공지 · 홈페이지 관리"),
            ]),
            el("div", { class: "row" }, [
              el("button", { class: "btn primary", onClick: () => openTeacherLogin() }, [document.createTextNode("학생회 로그인")]),
              el("button", { class: "btn", onClick: () => setRoute("settings") }, [document.createTextNode("PIN 등록")]),
            ]),
          ]),
        ]),
      ])
    : null;

  const noticeText = String(state.meta?.schoolNotice || "").trim();
  const noticeCard =
    noticeText || session.teacherAuthed
      ? el("div", { class: "card notice-banner" }, [
          el("div", { class: "row row--between" }, [
            el("div", { style: "min-width:0;flex:1" }, [
              el("div", { class: "card__title" }, [document.createTextNode("학생회 공지")]),
              noticeText
                ? el("div", { class: "notice-banner__text" }, [document.createTextNode(noticeText)])
                : el("div", { class: "card__sub" }, [document.createTextNode("아직 공지가 없어요. 학생 홈에 한 줄로 올릴 수 있어요.")]),
              state.meta?.schoolNoticeAt
                ? el("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, [
                    document.createTextNode(fmtDate(state.meta.schoolNoticeAt)),
                  ])
                : null,
            ]),
            session.teacherAuthed
              ? el("button", { class: "btn", onClick: () => openSetSchoolNotice() }, [
                  document.createTextNode(noticeText ? "공지 수정" : "공지 올리기"),
                ])
              : null,
          ]),
        ])
      : null;

  const left = el("div", { class: "card" }, [
    el("div", { class: "row row--between" }, [
      el("div", {}, [
        el("div", { class: "card__title" }, [document.createTextNode("학생")]),
        el("div", { class: "card__sub" }, [
          document.createTextNode(s ? "내 통계를 본 뒤 보상 상점에서 보상을 사고 쿠폰을 보여 줄 수 있어요." : "로그인하면 내 통계를 보고 보상을 살 수 있어요."),
        ]),
      ]),
      el("div", { class: "row" }, [
        s
          ? el("button", { class: "btn", onClick: () => doStudentLogout() }, [document.createTextNode("로그아웃")])
          : el("button", { class: "btn primary", onClick: () => openStudentLogin() }, [document.createTextNode("학생 로그인")]),
      ]),
    ]),
    s
      ? el("div", {}, [
          el("div", { class: "notice", style: "margin-top:12px" }, [
            el("div", { class: "row row--between" }, [
              el("div", {}, [
                el("div", { style: "font-weight:900" }, [nameWithMascot(`${s.name} (${s.className})`, { large: true })]),
                el("div", { class: "muted", style: "font-size:12px;margin-top:4px" }, [
                  document.createTextNode("내 계정으로 로그인됨 · 보상 구매는 ‘보상 상점’ 탭에서 할 수 있어요."),
                ]),
                el("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, [
                  document.createTextNode("학생회로 바꾸려면 로그아웃한 뒤 ‘학생회’ 탭에서 로그인하면 돼요."),
                ]),
              ]),
              studentPills(s),
            ]),
          ]),
          el("div", { class: "row", style: "margin-top:12px" }, [
            el("button", { class: "btn", onClick: () => openStudentDetail(s.id) }, [document.createTextNode("내 기록")]),
            el("button", { class: "btn", onClick: () => openChangeStudentPin() }, [document.createTextNode("PIN 변경")]),
          ]),
        ])
      : el("div", { class: "empty", style: "margin-top:12px" }, [
          document.createTextNode(
            guest
              ? "위 안내에서 명단에 있는 이름으로 가입·로그인하면 내 점수와 쿠폰이 이 자리에 나타나요."
              : "학생회 명단에 내 이름이 있으면 가입한 뒤 로그인해서 보상 구매가 가능해요."
          ),
        ]),
  ]);

  const right = s
    ? renderCouponsCard(s)
    : el("div", { class: "card" }, [
        el("div", { class: "card__title" }, [document.createTextNode("바로 시작")]),
        el("div", { class: "hint", style: "margin-top:10px" }, [
          el("div", {}, [document.createTextNode("- 학생회가 명단에 올린 이름·반만 가입할 수 있어요.")]),
          el("div", {}, [document.createTextNode("- 학교 이름은 학생회와 똑같이 써야 해요.")]),
          el("div", {}, [document.createTextNode("- 로그인 중에는 다른 계정으로 중복 로그인할 수 없어요.")]),
        ]),
        el("div", { class: "row", style: "margin-top:12px" }, [
          el("button", { class: "btn primary", onClick: () => openStudentSignup() }, [document.createTextNode("가입하기")]),
          el("button", { class: "btn primary", onClick: () => openStudentLogin() }, [document.createTextNode("학생 로그인")]),
          el("button", { class: "btn", onClick: () => setRoute("rewards") }, [document.createTextNode("보상 상점")]),
        ]),
      ]);

  const statsCard = s || session.teacherAuthed ? renderStatReportCard_(activeStatReport_()) : null;
  const board = session.teacherAuthed ? renderHomeBoard() : null;

  root.replaceChildren(
    el("div", { class: "home-stack" }, [welcome, noticeCard, statsCard, el("div", { class: "grid" }, [left, right]), board].filter(Boolean))
  );
}

function renderCouponsCard(s) {
  const coupons = listCouponsForStudent(s.id);
  const unused = coupons.filter((c) => !c.usedAt);
  const used = coupons.filter((c) => c.usedAt).slice(0, 5);
  return el("div", { class: "card" }, [
    el("div", { class: "row row--between" }, [
      el("div", {}, [
        el("div", { class: "card__title" }, [document.createTextNode("내 쿠폰")]),
        el("div", { class: "card__sub" }, [document.createTextNode("급식실·선생님께 이 화면을 보여 주면 돼요.")]),
      ]),
      el("button", { class: "btn primary", onClick: () => setRoute("rewards") }, [document.createTextNode("보상 사기")]),
    ]),
    unused.length
      ? el(
          "div",
          { class: "coupon-list", style: "margin-top:12px" },
          unused.map((c) =>
            el("div", { class: "coupon-ticket" }, [
              el("div", { class: "coupon-ticket__mark" }, [document.createTextNode("사용 가능")]),
              el("div", { class: "coupon-ticket__title" }, [document.createTextNode(c.title)]),
              couponIdentityNode_(s, c, { compact: true }),
              el("div", { class: "row", style: "margin-top:10px" }, [
                el("button", { class: "btn primary", onClick: () => openShowCoupon(c) }, [document.createTextNode("크게 보기")]),
                el("button", { class: "btn", onClick: () => openUseCoupon(c) }, [document.createTextNode("사용 완료")]),
              ]),
            ])
          )
        )
      : el("div", { class: "empty", style: "margin-top:12px" }, [
          document.createTextNode("아직 쓸 수 있는 쿠폰이 없어요. 보상 상점에서 사면 여기에 생겨요."),
        ]),
    used.length
      ? el("div", { class: "hint", style: "margin-top:12px" }, [
          document.createTextNode("최근 사용: " + used.map((c) => `${c.title}(${fmtDate(c.usedAt)})`).join(" · ")),
        ])
      : null,
  ]);
}

function renderHomeBoard() {
  const stats = homeStatsForDisplay_();
  const classes = Array.isArray(stats.classes) ? stats.classes : [];
  const weekly = Array.isArray(stats.weeklyTop) ? stats.weeklyTop : [];
  const top = Array.isArray(stats.topMerits) ? stats.topMerits : [];
  const threshold = Number(stats.threshold || state.classPolicy.specialActivityThresholdAvgMerits || 6);

  const age = state.meta.homeStatsAt ? Date.now() - Number(state.meta.homeStatsAt) : Infinity;
  if (onlineEnabled() && age > 60_000 && Date.now() - lastPublicStudentsFetchAt > 5_000) {
    lastPublicStudentsFetchAt = Date.now();
    queueMicrotask(() => void refreshPublicStudents());
  }

  const classBlock = classes.length
    ? el(
        "div",
        { class: "kpi", style: "margin-top:12px" },
        classes.slice(0, 6).map((c) =>
          el("div", { class: "kpi__box" }, [
            el("div", { class: "kpi__label" }, [document.createTextNode(`${c.className}반 · ${c.count}명`)]),
            el("div", { class: "kpi__value" }, [document.createTextNode(String(c.avgMerits))]),
            el("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, [
              document.createTextNode(c.specialOk ? `특별활동 가능 (기준 ${threshold})` : `평균 상점 · 기준 ${threshold}`),
            ]),
          ])
        )
      )
    : el("div", { class: "empty", style: "margin-top:12px" }, [
        document.createTextNode("아직 반 평균을 보여줄 가입자가 없어요."),
      ]);

  const rankTable = (rows, valueKey, valueLabel) => {
    if (!rows.length) {
      return el("div", { class: "empty", style: "margin-top:10px" }, [document.createTextNode("아직 기록이 없어요.")]);
    }
    return el(
      "table",
      { class: "table", style: "margin-top:10px" },
      [
        el("thead", {}, [
          el("tr", {}, [
            el("th", {}, [document.createTextNode("순위")]),
            el("th", {}, [document.createTextNode("이름")]),
            el("th", {}, [document.createTextNode("반")]),
            el("th", {}, [document.createTextNode(valueLabel)]),
          ]),
        ]),
        el(
          "tbody",
          {},
          rows.map((x, i) =>
            el("tr", {}, [
              el("td", {}, [document.createTextNode(String(i + 1))]),
              el("td", {}, [nameWithMascot(String(x.name || ""))]),
              el("td", {}, [document.createTextNode(String(x.className || ""))]),
              el("td", {}, [document.createTextNode(String(x[valueKey] ?? 0))]),
            ])
          )
        ),
      ]
    );
  };

  return el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("실시간 상점 현황")]),
    el("div", { class: "card__sub" }, [
      document.createTextNode("앱에 모인 상점 기록이에요. 학생회가 올린 엑셀 통계는 위(또는 통계 탭)에서 볼 수 있어요. 벌점은 공개하지 않아요."),
    ]),
    el("div", { class: "home-board" }, [
      el("div", {}, [
        el("div", { class: "class-section__title" }, [document.createTextNode("반 평균 상점")]),
        classBlock,
      ]),
      el("div", {}, [
        el("div", { class: "class-section__title" }, [document.createTextNode("이번 주 상점왕")]),
        el("div", { class: "card__sub" }, [document.createTextNode("최근 7일 동안 받은 상점")]),
        rankTable(weekly, "gained", "받은 상점"),
      ]),
      el("div", {}, [
        el("div", { class: "class-section__title" }, [document.createTextNode("상점 많은 학생")]),
        el("div", { class: "card__sub" }, [document.createTextNode("현재 보유 상점 (상위 5명)")]),
        rankTable(top, "merits", "상점"),
      ]),
    ]),
  ]);
}

function renderPublicStudentsBlock() {
  return renderHomeBoard();
}

function couponIdentityNode_(s, coupon, { compact = false } = {}) {
  const rows = [
    ["이름", String(s?.name || "-")],
    ["반", String(s?.className || "-")],
    ["구매", fmtDate(coupon?.at)],
  ];
  return el(
    "div",
    { class: compact ? "coupon-meta coupon-meta--compact" : "coupon-meta" },
    rows.map(([k, v]) =>
      el("div", { class: "coupon-meta__row" }, [
        el("span", { class: "coupon-meta__k" }, [document.createTextNode(k)]),
        el("span", { class: "coupon-meta__v" }, [document.createTextNode(v)]),
      ])
    )
  );
}

function openShowCoupon(coupon) {
  const s = currentStudent();
  if (!s || !coupon) return;
  const body = el("div", { class: "coupon-hero" }, [
    el("div", { class: "coupon-hero__badge" }, [document.createTextNode(coupon.usedAt ? "사용됨" : "사용 가능")]),
    el("div", { class: "coupon-hero__title" }, [document.createTextNode(coupon.title)]),
    couponIdentityNode_(s, coupon),
    el("div", { class: "muted", style: "margin-top:12px;text-align:center;line-height:1.5" }, [
      document.createTextNode("급식실이나 선생님께 이 화면을 보여 주세요. 확인이 끝나면 ‘사용 완료’를 눌러 주세요."),
    ]),
  ]);
  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("닫기")]),
    coupon.usedAt
      ? null
      : el("button", { class: "btn primary", onClick: () => openUseCoupon(coupon) }, [document.createTextNode("사용 완료")]),
  ].filter(Boolean));
  openModal({ title: "내 쿠폰", bodyNode: body, actionsNode: actions });
}

async function openUseCoupon(coupon) {
  const s = requireStudent();
  if (!s || !coupon || coupon.usedAt) return;
  if (!confirm(`${coupon.title}을(를) 사용 완료로 표시할까요?\n급식실·선생님 확인 뒤에 눌러 주세요.`)) return;
  const note = `${coupon.title} 사용 ${couponTag(coupon.id, coupon.rewardId, coupon.title)}`;
  if (onlineEnabled()) {
    const pinVal = session.studentPinForApi || "";
    if (!pinVal) return alert("PIN이 필요해요. 다시 로그인해 주세요.");
    const res = await withLoading("쿠폰 사용을 처리하는 중이에요…", () =>
      apiCall("student_self_apply", {
        studentId: s.id,
        pin: pinVal,
        deltaMerits: 0,
        deltaOffsets: 0,
        deltaDemerits: 0,
        note,
        type: "reward_use",
      })
    );
    if (!res.ok) return alert("사용 처리 실패: " + String(res.error || "unknown"));
  }
  addLedger(state, {
    studentId: s.id,
    type: "reward_use",
    note,
  });
  closeModal();
  render();
}

function collapsePublicStudentsByNameClass(list) {
  const m = new Map();
  for (const x of list || []) {
    const k = `${String(x.name ?? "").trim()}|${String(x.className ?? "").trim()}`.toLowerCase();
    if (!k) continue;
    m.set(k, x);
  }
  return Array.from(m.values());
}

async function refreshPublicStudents() {
  if (!onlineEnabled()) return;
  if (state.meta?.blockServerRosterRestore) {
    state.meta.homeStats = computeHomeStatsLocal_([]);
    state.meta.homeStatsAt = String(Date.now());
    return;
  }
  const changed = await hydrateOnlineSchoolConfig();
  if (changed && (route === "students" || route === "class")) render();
}

function openAddStudent() {
  if (!requireTeacher()) return;
  const name = el("input", { id: "name", placeholder: "예) 박서준" });
  const className = el("input", { id: "className", placeholder: "예) 2-3" });
  const schoolName = el("input", { id: "schoolName", placeholder: "예) 해연중학교" });
  schoolName.value = state.meta?.schoolName ? String(state.meta.schoolName) : "";
  const teacherCls = normalizeClassName(session.teacherClassName);
  if (teacherCls && teacherCls !== "*") className.value = teacherCls;
  const bulk = el("textarea", {
    id: "rosterBulk",
    placeholder: "여러 명이면 한 줄에 한 명씩\n예) 홍길동,2-3",
    rows: "5",
    style: "width:100%;margin-top:4px",
  });

  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode("명단에 올린 학생만 가입할 수 있어요. PIN은 비워 두고, 학생이 같은 이름·반으로 가입하면 그때 생깁니다."),
    ]),
    el("div", { class: "form" }, [
      el("div", { class: "form__full" }, [el("label", { for: "schoolName" }, [document.createTextNode("학교 이름")]), schoolName]),
      el("div", {}, [el("label", { for: "name" }, [document.createTextNode("이름")]), name]),
      el("div", {}, [el("label", { for: "className" }, [document.createTextNode("반")]), className]),
      el("div", { class: "form__full" }, [el("label", { for: "rosterBulk" }, [document.createTextNode("여러 명 한꺼번에 (선택)")]), bulk]),
    ]),
  ]);

  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn primary",
        value: "default",
        onClick: async (e) => {
          e.preventDefault();
          const sc = schoolName.value.trim() || (state.meta?.schoolName ? String(state.meta.schoolName) : "");
          if (!sc) return alert("학교 이름을 입력해 주세요.");
          const list = parseRosterLines_(bulk.value);
          const nm = name.value.trim();
          const cl = className.value.trim();
          if (nm && cl) list.unshift({ name: nm, className: cl });
          const unique = [];
          const seen = new Set();
          for (const it of list) {
            const key = `${it.name}|${it.className}`.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(it);
          }
          if (!unique.length) return alert("이름과 반을 입력해 주세요.");

          const addLocal = (id, person) => {
            forgetDeletedStudent_({ id, schoolName: sc, name: person.name, className: person.className });
            if (findRosterSeat_(sc, person.name, person.className)) return;
            state.students.push({
              id: id || uid(),
              schoolName: sc,
              name: person.name,
              className: person.className,
              merits: 0,
              offsets: 0,
              demerits: 0,
              trusted: false,
              lastMonthlyGrantYYYYMM: null,
              pinHash: null,
            });
          };

          if (onlineEnabled()) {
            if (!session.teacherPinForApi) return alert("온라인 명단에 올리려면 학생회 PIN으로 다시 로그인해 주세요.");
            let errMsg = "";
            let skipped = 0;
            let addedCount = 0;
            await withLoading("명단에 올리는 중이에요…", async () => {
              const res = await apiCall("teacher_add_students", {
                teacherPin: session.teacherPinForApi,
                schoolName: sc,
                students: unique,
              });
              if (!res.ok) {
                const err = String(res.error || "");
                errMsg =
                  err === "unknown_action"
                    ? "서버에 명단 추가 기능이 없어요. Apps Script를 최신 파일로 다시 배포해 주세요."
                    : "명단 저장 실패: " + err;
                return;
              }
              for (const st of res.students || []) addLocal(st.id, st);
              for (const sk of res.skipped || []) addLocal(sk.id, sk);
              skipped = Array.isArray(res.skipped) ? res.skipped.length : 0;
              addedCount = Array.isArray(res.students) ? res.students.length : 0;
              markStudentsDirty();
              closeModal();
              render();
            });
            if (errMsg) return alert(errMsg);
            if (skipped) alert(`${addedCount}명을 올렸어요. 이미 명단에 있는 ${skipped}명은 건너뛰었어요.`);
            return;
          }

          let added = 0;
          for (const person of unique) {
            const before = state.students.length;
            addLocal(null, person);
            if (state.students.length > before) added += 1;
          }
          if (!added) return alert("이미 명단에 있는 이름이에요.");
          markStudentsDirty();
          closeModal();
          render();
        },
      },
      [document.createTextNode("명단에 올리기")]
    ),
  ]);

  openModal({ title: "학생 명단 추가", bodyNode: body, actionsNode: actions });
}

function openStudentDetail(studentId) {
  const s = getStudent(state, studentId);
  if (!s) return;
  const items = state.ledger.filter((l) => l.studentId === studentId).slice(0, 40);

  const body = el("div", {}, [
    el("div", { class: "row row--between" }, [
      el("div", {}, [
        el("div", { class: "card__title" }, [nameWithMascot(s.name, { large: true })]),
        el("div", { class: "card__sub" }, [document.createTextNode(`반: ${s.className}`)]),
      ]),
      studentPills(s),
    ]),
    session.teacherAuthed
      ? el("div", { class: "row" }, [
          el("button", { class: "btn danger", onClick: () => deleteStudent(studentId) }, [document.createTextNode("학생 삭제")]),
        ])
      : null,
    items.length
      ? el(
          "table",
          { class: "table" },
          [
            el("thead", {}, [
              el("tr", {}, [
                el("th", {}, [document.createTextNode("시간")]),
                el("th", {}, [document.createTextNode("변동")]),
                el("th", {}, [document.createTextNode("내용")]),
              ]),
            ]),
            el(
              "tbody",
              {},
              items.map((it) =>
                el("tr", {}, [
                  el("td", {}, [document.createTextNode(fmtDate(it.at))]),
                  el("td", {}, [
                    el("span", { class: "pill good", style: "margin-right:6px" }, [
                      document.createTextNode("상점 "),
                      el("b", {}, [document.createTextNode(String(it.deltaMerits))]),
                    ]),
                    el("span", { class: "pill bad" }, [
                      document.createTextNode("벌점 "),
                      el("b", {}, [document.createTextNode(String(it.deltaDemerits))]),
                    ]),
                  ]),
                  el("td", {}, [document.createTextNode(it.note || it.type)]),
                ])
              )
            ),
          ].filter(Boolean)
        )
      : el("div", { class: "empty" }, [document.createTextNode("아직 기록이 없어요.")]),
  ].filter(Boolean));

  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn", value: "cancel" }, [document.createTextNode("닫기")]),
  ]);

  openModal({ title: "학생 기록", bodyNode: body, actionsNode: actions });
}

function deleteStudent(studentId) {
  const s = getStudent(state, studentId);
  if (!s) return;
  if (!confirm(`${s.name} 학생을 삭제할까요? (기록도 함께 숨김 처리돼요)`)) return;
  rememberDeletedStudent_(s);
  state.students = state.students.filter((x) => x.id !== studentId);
  state.ledger = state.ledger.filter((l) => l.studentId !== studentId);
  markStudentsDirty();
  closeModal();
  render();
  if (onlineEnabled() && session.teacherPinForApi) {
    const schoolName = String(s.schoolName || state.meta?.schoolName || "").trim();
    void withLoading("학생을 삭제하는 중이에요…", () =>
      apiCall("teacher_delete_students", {
        teacherPin: session.teacherPinForApi,
        schoolName,
        studentIds: [studentId],
        students: [{ name: s.name, className: s.className }],
      })
    );
  }
}

function renderTeacher() {
  if (!requireTeacher()) {
    root.replaceChildren(
      el("div", { class: "card" }, [
        el("div", { class: "card__title" }, [document.createTextNode("학생회")]),
        el("div", { class: "card__sub" }, [document.createTextNode("학생회 PIN으로 로그인해야 통계 업로드와 홈페이지 관리를 할 수 있어요.")]),
        el("div", { class: "row", style: "margin-top:12px" }, [
          el("button", { class: "btn primary", onClick: () => openTeacherLogin() }, [document.createTextNode("학생회 로그인")]),
        ]),
      ])
    );
    return;
  }

  if (!normalizeClassName(session.teacherClassName)) {
    const classInput = el("input", {
      id: "teacher-class-quick",
      placeholder: "예) 2-3",
      autocomplete: "off",
    });
    const applyClass = (cls) => {
      const v = normalizeClassName(cls);
      if (!v) {
        alert("반 이름을 입력해 주세요. 예: 2-3");
        classInput.focus();
        return;
      }
      session.teacherClassName = v;
      saveSession();
      render();
    };
    classInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      applyClass(classInput.value);
    });

    root.replaceChildren(
      el("div", { class: "card" }, [
        el("div", { class: "card__title" }, [document.createTextNode("담당 반을 선택해 주세요")]),
        el("div", { class: "card__sub" }, [
          document.createTextNode("학생회는 담당 반 학생만 보고 관리할 수 있어요. 반 이름을 입력하거나 전체 반을 고르세요."),
        ]),
        el("div", { class: "form", style: "margin-top:14px" }, [
          el("div", { class: "form__full" }, [
            el("label", { for: "teacher-class-quick" }, [document.createTextNode("담당 반")]),
            classInput,
          ]),
        ]),
        el("div", { class: "row", style: "margin-top:12px" }, [
          el(
            "button",
            {
              class: "btn primary",
              onClick: () => applyClass(classInput.value),
            },
            [document.createTextNode("이 반으로 시작")]
          ),
          el(
            "button",
            {
              class: "btn",
              onClick: () => applyClass("*"),
            },
            [document.createTextNode("전체 반으로 시작")]
          ),
          el("button", { class: "btn-ghost", onClick: () => doTeacherLogout() }, [document.createTextNode("로그아웃")]),
        ]),
        el("div", { class: "hint", style: "margin-top:10px" }, [
          document.createTextNode("학생이 아직 없어도 반 이름(예: 1-1, 2-3)을 적고 시작하면 됩니다."),
        ]),
      ])
    );
    queueMicrotask(() => classInput.focus());
    return;
  }

  const scoped = studentsInTeacherScope();
  const byClass = groupStudentsByClass(scoped);

  const classSelect = el(
    "select",
    {
      id: "teacher-class-switch",
      onChange: (e) => {
        session.teacherClassName = e.target.value || null;
        saveSession();
        render();
      },
    },
    [
      ...listClassNames(state.students).map((c) => el("option", { value: c }, [document.createTextNode(c)])),
      el("option", { value: "*" }, [document.createTextNode("전체 반")]),
    ]
  );
  if (![...classSelect.options].some((o) => o.value === session.teacherClassName)) {
    classSelect.append(el("option", { value: session.teacherClassName }, [document.createTextNode(session.teacherClassName)]));
  }
  classSelect.value = session.teacherClassName;

  const scopeBar = el("div", { class: "card" }, [
    el("div", { class: "row row--between" }, [
      el("div", {}, [
        el("div", { class: "card__title" }, [document.createTextNode(`학생회 · ${teacherScopeLabel()}`)]),
        el("div", { class: "card__sub" }, [
          document.createTextNode("담당 반만 보이고, 다른 반 기록은 볼 수 없어요. (전체 반은 학교 관리용)"),
        ]),
      ]),
      el("div", { class: "row" }, [
        el("div", {}, [el("label", { for: "teacher-class-switch" }, [document.createTextNode("담당 반")]), classSelect]),
        el("button", { class: "btn", onClick: () => openTeacherClassPicker() }, [document.createTextNode("반 변경")]),
        el("button", { class: "btn", onClick: () => doTeacherLogout() }, [document.createTextNode("로그아웃")]),
      ]),
    ]),
  ]);

  const manageCard = el("div", { class: "card" }, [
    el("div", { class: "row row--between" }, [
      el("div", {}, [
        el("div", { class: "card__title" }, [document.createTextNode("홈페이지 관리")]),
        el("div", { class: "card__sub" }, [
          document.createTextNode("이 사이트에서는 상점·벌점을 주지 않아요. 통계 자료와 공지, 학생 명단만 관리해요."),
        ]),
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "btn primary", onClick: () => openSetSchoolNotice() }, [document.createTextNode("학생 홈 공지")]),
        el("button", { class: "btn", onClick: () => openTeacherLedger() }, [document.createTextNode("반 기록 보기")]),
      ]),
    ]),
  ]);

  const classBlocks = byClass.length
    ? byClass.map(([className, list]) => {
        return el("div", { class: "class-section" }, [
          el("div", { class: "class-section__title" }, [
            document.createTextNode(className === "(반 미정)" ? className : `${className}반`),
            el("span", { class: "badge" }, [document.createTextNode(`${list.length}명`)]),
          ]),
          el(
            "table",
            { class: "table" },
            [
              el("thead", {}, [
                el("tr", {}, [
                  el("th", {}, [document.createTextNode("이름")]),
                  el("th", {}, [document.createTextNode("상점")]),
                  el("th", {}, [document.createTextNode("벌점")]),
                  el("th", {}, [document.createTextNode("기록")]),
                ]),
              ]),
              el(
                "tbody",
                {},
                list
                  .slice()
                  .sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"))
                  .map((s) =>
                    el("tr", {}, [
                      el("td", {}, [nameWithMascot(s.name)]),
                      el("td", {}, [document.createTextNode(String(s.merits))]),
                      el("td", {}, [document.createTextNode(String(s.demerits))]),
                      el("td", {}, [
                        el("button", { class: "btn-ghost", onClick: () => openStudentDetail(s.id) }, [
                          document.createTextNode("보기"),
                        ]),
                      ]),
                    ])
                  )
              ),
            ]
          ),
        ]);
      })
    : [
        el("div", { class: "empty", style: "margin-top:12px" }, [
          document.createTextNode("이 반에 학생이 없어요. 학생이 가입하거나 학생회 설정에서 학생을 추가해 주세요."),
        ]),
      ];

  const roster = el("div", { class: "card" }, [
    el("div", { class: "row row--between" }, [
      el("div", {}, [
        el("div", { class: "card__title" }, [document.createTextNode("반별 학생")]),
        el("div", { class: "card__sub" }, [
          document.createTextNode(`표시 중: ${teacherScopeLabel()} · ${scoped.length}명`),
        ]),
      ]),
    ]),
    ...classBlocks,
  ]);

  const upload = renderStatUploadCard_();
  const published = activeStatReport_()
    ? renderStatReportCard_(activeStatReport_(), { manage: true })
    : el("div", { class: "card" }, [
        el("div", { class: "card__title" }, [document.createTextNode("게시된 통계")]),
        el("div", { class: "empty", style: "margin-top:12px" }, [
          document.createTextNode("아직 올린 자료가 없어요. 위에서 엑셀·CSV를 올리면 학생 홈에 바로 보여요."),
        ]),
      ]);

  root.replaceChildren(el("div", { class: "grid" }, [scopeBar, upload, published, manageCard, roster]));
}

function openTeacherClassPicker() {
  if (!session.teacherAuthed) return;
  const known = listClassNames(state.students);
  const select = el(
    "select",
    { id: "pick-class" },
    [
      el("option", { value: "__custom" }, [document.createTextNode("반 이름 직접 입력")]),
      ...known.map((c) => el("option", { value: c }, [document.createTextNode(c)])),
      el("option", { value: "*" }, [document.createTextNode("전체 반 (학교 관리)")]),
    ]
  );
  const custom = el("input", {
    id: "pick-class-custom",
    placeholder: "예) 2-3",
    value:
      session.teacherClassName && session.teacherClassName !== "*" && !known.includes(session.teacherClassName)
        ? session.teacherClassName
        : "",
  });

  if (session.teacherClassName === "*") select.value = "*";
  else if (session.teacherClassName && known.includes(session.teacherClassName)) select.value = session.teacherClassName;
  else select.value = "__custom";

  const syncCustomVisibility = () => {
    custom.style.display = select.value === "__custom" ? "block" : "none";
  };
  syncCustomVisibility();
  select.addEventListener("change", syncCustomVisibility);

  const save = () => {
    let cls = select.value;
    if (cls === "__custom") cls = normalizeClassName(custom.value);
    if (!cls) {
      alert("담당 반을 선택하거나 입력해 주세요. 예: 2-3");
      if (select.value === "__custom") custom.focus();
      return;
    }
    session.teacherClassName = cls;
    saveSession();
    closeModal();
    render();
  };

  custom.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    save();
  });

  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode("담당한 반을 고르면 그 반 학생만 보이고 기록을 볼 수 있어요. 학생이 없어도 반 이름을 직접 입력할 수 있어요."),
    ]),
    el("div", { class: "form" }, [
      el("div", { class: "form__full" }, [el("label", { for: "pick-class" }, [document.createTextNode("담당 반")]), select]),
      el("div", { class: "form__full" }, [el("label", { for: "pick-class-custom" }, [document.createTextNode("반 이름")]), custom]),
    ]),
  ]);

  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el("button", { class: "btn primary", type: "button", onClick: (e) => { e.preventDefault(); save(); } }, [
      document.createTextNode("저장"),
    ]),
  ]);
  openModal({ title: "담당 반 선택", bodyNode: body, actionsNode: actions });
  queueMicrotask(() => {
    if (select.value === "__custom") custom.focus();
  });
}

function renderRewards() {
  const s = currentStudent();
  const body = el("div", { class: "card" }, [
    el("div", { class: "row row--between" }, [
      el("div", {}, [
        el("div", { class: "card__title" }, [document.createTextNode("보상 상점")]),
        el("div", { class: "card__sub" }, [document.createTextNode("상점을 사용해 보상을 구매하면 기록에 남아요.")]),
      ]),
      el(
        "button",
        {
          class: "btn primary",
          onClick: () => openBuyReward(),
          disabled: !s,
          title: s ? "보상 구매" : "학생 로그인 후 구매 가능",
        },
        [document.createTextNode("보상 구매")]
      ),
    ]),
    !s
      ? el("div", { class: "notice", style: "margin-top:12px" }, [
          el("div", { style: "font-weight:900" }, [document.createTextNode("학생 로그인 필요")]),
          el("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, [
            document.createTextNode("학생은 본인 계정으로 로그인한 뒤에만 보상을 구매할 수 있어요."),
          ]),
          el("div", { class: "row", style: "margin-top:10px" }, [
            el("button", { class: "btn", onClick: () => openStudentLogin() }, [document.createTextNode("학생 로그인")]),
          ]),
        ])
      : null,
    el(
      "div",
      { class: "kpi", style: "margin-top:12px" },
      [
        kpiBox("카탈로그 보상 수", String(state.rewardCatalog.length)),
        kpiBox("내 상점", String(s ? s.merits : 0)),
        kpiBox("내 벌점", String(s ? s.demerits : 0)),
      ]
    ),
    el(
      "table",
      { class: "table", style: "margin-top:12px" },
      [
        el("thead", {}, [
          el("tr", {}, [
            el("th", {}, [document.createTextNode("보상")]),
            el("th", {}, [document.createTextNode("가격(상점)")]),
            el("th", {}, [document.createTextNode("설명")]),
          ]),
        ]),
        el(
          "tbody",
          {},
          sortedRewardCatalog_().map((r) =>
            el("tr", {}, [
              el("td", {}, [document.createTextNode(r.title)]),
              el("td", {}, [el("span", { class: "pill good" }, [document.createTextNode("상점 "), el("b", {}, [document.createTextNode(rewardPriceLabel_(r))])])]),
              el("td", {}, [document.createTextNode(r.detail)]),
            ])
          )
        ),
      ]
    ),
  ]);

  const history = el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("최근 구매 기록")]),
    el("div", { class: "card__sub" }, [document.createTextNode("최근 25건")]),
    (() => {
      const items = state.ledger.filter((l) => l.type === "reward_buy").slice(0, 25);
      if (!items.length) return el("div", { class: "empty", style: "margin-top:12px" }, [document.createTextNode("아직 구매 기록이 없어요.")]);
      return el(
        "table",
        { class: "table", style: "margin-top:12px" },
        [
          el("thead", {}, [
            el("tr", {}, [
              el("th", {}, [document.createTextNode("시간")]),
              el("th", {}, [document.createTextNode("학생")]),
              el("th", {}, [document.createTextNode("내용")]),
            ]),
          ]),
          el(
            "tbody",
            {},
            items.map((it) => {
              const s = getStudent(state, it.studentId);
              return el("tr", {}, [
                el("td", {}, [document.createTextNode(fmtDate(it.at))]),
                el("td", {}, [document.createTextNode(s ? s.name : "(삭제됨)")]),
                el("td", {}, [document.createTextNode(it.note || "보상 구매")]),
              ]);
            })
          ),
        ]
      );
    })(),
  ]);

  root.replaceChildren(el("div", { class: "grid" }, [body, history]));
}

function kpiBox(label, value) {
  return el("div", { class: "kpi__box" }, [el("div", { class: "kpi__label" }, [document.createTextNode(label)]), el("div", { class: "kpi__value" }, [document.createTextNode(value)])]);
}

function openBuyReward() {
  const s = requireStudent();
  if (!s) return;
  const reward = el(
    "select",
    { id: "reward" },
    sortedRewardCatalog_().map((r) =>
      el("option", { value: r.id }, [document.createTextNode(`${r.title} · 상점 ${rewardPriceLabel_(r)}`)])
    )
  );
  const note = el("input", { id: "note", placeholder: "선택: 메모" });
  const buddyCount = el("input", {
    id: "lunchBuddyCount",
    type: "number",
    min: "0",
    max: String(LUNCH_BUDDY_MAX),
    value: "0",
    inputMode: "numeric",
  });
  const buddyWrap = el("div", { class: "form__full" }, [
    el("label", { for: "lunchBuddyCount" }, [document.createTextNode("함께 갈 친구 수")]),
    buddyCount,
    el("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, [
      document.createTextNode(`친구 1명당 상점 ${LUNCH_BUDDY_EXTRA_MERITS}점이 추가돼요. 최대 ${LUNCH_BUDDY_MAX}명.`),
    ]),
  ]);
  const costHint = el("div", { class: "hint" }, [document.createTextNode("")]);
  const syncBuyForm = () => {
    const rwd = state.rewardCatalog.find((x) => x.id === reward.value);
    const isLunch = reward.value === LUNCH_PRIORITY_ID;
    buddyWrap.style.display = isLunch ? "" : "none";
    if (!isLunch) buddyCount.value = "0";
    if (reward.value === "book_reprint") note.placeholder = "과목 적기 (예: 영어 교과서)";
    else if (reward.value === "worksheet_reprint") note.placeholder = "과목 적기 (예: 수학 학습지)";
    else if (isLunch) note.placeholder = "선택: 메모(예: 오늘 점심, 친구 이름)";
    else note.placeholder = "선택: 메모";
    const cost = rwd ? rewardPurchaseCost_(rwd, buddyCount.value) : 0;
    costHint.textContent = rwd ? `결제 상점 ${cost}점` : "";
  };
  reward.addEventListener("change", syncBuyForm);
  buddyCount.addEventListener("input", syncBuyForm);
  const pinSelf =
    onlineEnabled() && !session.studentPinForApi
      ? el("input", { type: "password", id: "pinBuy", placeholder: "본인 PIN (온라인 반영)" })
      : null;

  const body = el("div", {}, [
    el("div", { class: "notice" }, [
      nameWithMascot(`${s.name} (${s.className})`, { large: true }),
      el("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, [document.createTextNode("본인 계정으로만 구매할 수 있어요.")]),
    ]),
    el("div", { class: "hint" }, [document.createTextNode("보상을 구매하면 상점이 차감되고, 학생 홈의 ‘내 쿠폰’에 사용권이 생겨요.")]),
    onlineEnabled()
      ? el("div", { class: "hint" }, [document.createTextNode("온라인 모드에서는 구매가 서버에도 저장돼요.")])
      : null,
    costHint,
    el("div", { class: "form" }, [
      el("div", { class: "form__full" }, [el("label", { for: "reward" }, [document.createTextNode("보상")]), reward]),
      buddyWrap,
      el("div", { class: "form__full" }, [el("label", { for: "note" }, [document.createTextNode("메모")]), note]),
      pinSelf ? el("div", { class: "form__full" }, [el("label", { for: "pinBuy" }, [document.createTextNode("PIN")]), pinSelf]) : null,
    ]),
  ]);
  syncBuyForm();

  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn primary",
        value: "default",
        onClick: async (e) => {
          e.preventDefault();
          const rwd = state.rewardCatalog.find((x) => x.id === reward.value);
          if (!rwd) return;
          const buddies = rwd.id === LUNCH_PRIORITY_ID ? clampLunchBuddyCount_(buddyCount.value) : 0;
          const cost = rewardPurchaseCost_(rwd, buddies);
          const buyTitle = rewardPurchaseTitle_(rwd, buddies);
          if (cost > Number(s.merits || 0)) return alert("상점이 부족해요.");
          const pinVal = session.studentPinForApi || (pinSelf && pinSelf.value) || "";
          const couponId = uid();
          const extra = note.value.trim() ? ` · ${note.value.trim()}` : "";
          const buyNote = `${buyTitle} 구매${extra} ${couponTag(couponId, rwd.id, buyTitle)}`;
          if (onlineEnabled()) {
            if (!pinVal) return alert("PIN을 입력해 주세요.");
            const res = await withLoading("보상을 구매하는 중이에요…", () =>
              apiCall("student_self_apply", {
                studentId: s.id,
                pin: pinVal,
                deltaMerits: -cost,
                deltaOffsets: 0,
                deltaDemerits: 0,
                note: buyNote,
                type: "reward_buy",
              })
            );
            if (!res.ok) return alert("구매 실패: " + String(res.error || "unknown"));
            session.studentPinForApi = pinVal;
            s.merits = res.student.merits;
            s.offsets = res.student.offsets;
            s.demerits = res.student.demerits;
            addLedger(state, {
              studentId: s.id,
              type: "reward_buy",
              deltaMerits: -cost,
              deltaOffsets: 0,
              deltaDemerits: 0,
              note: buyNote,
            });
            closeModal();
            render();
            refreshPublicStudents();
            setTimeout(() => {
              const created = listCouponsForStudent(s.id).find((c) => c.id === couponId);
              if (created) openShowCoupon(created);
            }, 0);
            return;
          }
          const r = applyDelta(
            state,
            s.id,
            { merits: -cost },
            { type: "reward_buy", note: buyNote }
          );
          if (!r.ok) return alert(r.error);
          closeModal();
          render();
          setTimeout(() => {
            const created = listCouponsForStudent(s.id).find((c) => c.id === couponId);
            if (created) openShowCoupon(created);
          }, 0);
        },
      },
      [document.createTextNode("구매")]
    ),
  ]);

  openModal({ title: "보상 구매", bodyNode: body, actionsNode: actions });
}

function renderClass() {
  if (!session.teacherAuthed && !currentStudent()) {
    root.replaceChildren(
      el("div", { class: "grid" }, [
        el("div", { class: "card" }, [
          el("div", { class: "card__title" }, [document.createTextNode("통계")]),
          el("div", { class: "card__sub" }, [
            document.createTextNode("통계 자료는 로그인해야 볼 수 있어요. 학생은 자기 기록만, 학생회는 전체를 봐요."),
          ]),
        ]),
        renderStatLoginGate_(),
      ])
    );
    return;
  }

  if (currentStudent() && !session.teacherAuthed) {
    root.replaceChildren(
      el("div", { class: "grid" }, [
        el("div", { class: "card" }, [
          el("div", { class: "card__title" }, [document.createTextNode("내 통계")]),
          el("div", { class: "card__sub" }, [
            document.createTextNode("내 이름·반과 같은 기록만 보여 줘요. 다른 학생 자료는 보이지 않아요."),
          ]),
        ]),
        renderStatReportCard_(activeStatReport_()),
      ])
    );
    return;
  }

  const teacherMode = session.teacherAuthed && normalizeClassName(session.teacherClassName);
  const pool = teacherMode ? studentsInTeacherScope() : state.students;
  const groups = groupStudentsByClass(pool);
  const uploaded = renderStatReportCard_(activeStatReport_(), { manage: !!session.teacherAuthed });

  const blocks = groups.map(([className, list]) => {
    const total = list.length;
    const sumMerits = list.reduce((a, s) => a + s.merits, 0);
    const avgMerits = total ? sumMerits / total : 0;
    const specialOk = avgMerits >= state.classPolicy.specialActivityThresholdAvgMerits;
    const title = className === "(반 미정)" ? className : `${className}반`;
    return el("div", { class: "card" }, [
      el("div", { class: "class-section__title" }, [
        document.createTextNode(title),
        el("span", { class: "badge" }, [document.createTextNode(`${total}명`)]),
      ]),
      el("div", { class: "kpi", style: "margin-top:10px" }, [
        kpiBox("학생 수", String(total)),
        kpiBox("상점 합계", String(sumMerits)),
        kpiBox("상점 평균", avgMerits.toFixed(2)),
      ]),
      el("div", { class: "row", style: "margin-top:10px" }, [
        el("span", { class: "badge" }, [
          el("span", { class: `dot ${specialOk ? "good" : "warn"}` }),
          document.createTextNode(
            specialOk
              ? `특별활동 가능 (평균 ≥ ${state.classPolicy.specialActivityThresholdAvgMerits})`
              : `특별활동 대기 (평균 < ${state.classPolicy.specialActivityThresholdAvgMerits})`
          ),
        ]),
      ]),
      el(
        "table",
        { class: "table", style: "margin-top:12px" },
        [
          el("thead", {}, [
            el("tr", {}, [
              el("th", {}, [document.createTextNode("순위")]),
              el("th", {}, [document.createTextNode("이름")]),
              el("th", {}, [document.createTextNode("상점")]),
              session.teacherAuthed ? el("th", {}, [document.createTextNode("벌점")]) : null,
              session.teacherAuthed ? el("th", {}, [document.createTextNode("기록")]) : null,
            ].filter(Boolean)),
          ]),
          el(
            "tbody",
            {},
            [...list]
              .sort((a, b) => b.merits - a.merits)
              .map((s, idx) =>
                el("tr", {}, [
                  el("td", {}, [document.createTextNode(String(idx + 1))]),
                  el("td", {}, [nameWithMascot(s.name)]),
                  el("td", {}, [document.createTextNode(String(s.merits))]),
                  session.teacherAuthed ? el("td", {}, [document.createTextNode(String(s.demerits))]) : null,
                  session.teacherAuthed
                    ? el("td", {}, [
                        el("button", { class: "btn-ghost", onClick: () => openStudentDetail(s.id) }, [
                          document.createTextNode("보기"),
                        ]),
                      ])
                    : null,
                ].filter(Boolean))
              )
          ),
        ]
      ),
    ]);
  });

  const head = el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("통계")]),
    el("div", { class: "card__sub" }, [
      document.createTextNode(
        teacherMode
          ? `학생회가 올린 엑셀 자료와, 담당 ${teacherScopeLabel()} 실시간 상점 현황을 함께 보여줘요.`
          : "학생회가 올린 엑셀 통계가 먼저 나오고, 그다음 실시간 상점 현황이에요. 벌점은 학생회만 볼 수 있어요."
      ),
    ]),
    session.teacherAuthed
      ? el("div", { class: "row", style: "margin-top:10px" }, [
          el("button", { class: "btn primary", onClick: () => setRoute("teacher") }, [document.createTextNode("자료 올리기")]),
          el("button", { class: "btn", onClick: () => openTeacherClassPicker() }, [document.createTextNode("담당 반 변경")]),
          el("span", { class: "pill" }, [document.createTextNode(teacherScopeLabel())]),
        ])
      : el("div", { class: "row", style: "margin-top:10px" }, [
          el("button", { class: "btn primary", onClick: () => openTeacherLogin() }, [document.createTextNode("학생회 로그인")]),
        ]),
  ]);

  const liveEmpty = !groups.length
    ? el("div", { class: "card" }, [
        el("div", { class: "card__title" }, [document.createTextNode("실시간 상점 현황")]),
        el("div", { class: "empty", style: "margin-top:12px" }, [
          document.createTextNode("아직 가입된 학생이 없어 실시간 상점 표는 비어 있어요."),
        ]),
      ])
    : null;

  root.replaceChildren(el("div", { class: "grid" }, [head, uploaded, liveEmpty, ...blocks].filter(Boolean)));
}
function renderSettings() {
  if (!session.teacherAuthed) {
    root.replaceChildren(
      el("div", { class: "grid" }, [
        el("div", { class: "card" }, [
          el("div", { class: "card__title" }, [document.createTextNode("설정")]),
          el("div", { class: "card__sub" }, [
            document.createTextNode(
              "교실 규칙, 보상 상점, 학생 관리, 백업 등은 학생회만 바꿀 수 있어요. 앱을 닫아도 이 기기에 저장되고, 온라인이면 서버와도 맞춰 집니다."
            ),
          ]),
        ]),
        el("div", { class: "card" }, [
          el("div", { class: "card__title" }, [document.createTextNode("학생회 시작하기 (가입 없음)")]),
          el("div", { class: "card__sub" }, [
            document.createTextNode(
              teacherPinOneTimeResetAvailable_()
                ? "비밀번호를 잊었다면 지금 한 번만 새 PIN을 정할 수 있어요. 저장한 뒤에는 로그인한 사람만 PIN을 바꿀 수 있습니다."
                : "학생회는 학생처럼 ‘가입’하지 않습니다. PIN이 없을 때만 처음 한 번 등록할 수 있어요. 이미 PIN이 있으면 로그인한 뒤에만 바꿀 수 있고, 로그인하지 않은 상태에서는 바꿀 수 없습니다."
            ),
          ]),
          el("div", { class: "hint", style: "margin-top:8px" }, [
            document.createTextNode(
              teacherPinOneTimeResetAvailable_()
                ? "한 번만: 새 PIN 저장 → 그 PIN으로 로그인 → 이후 PIN 변경은 로그인 후에만"
                : "순서: ① 학생회 PIN 첫 등록 → ② 학생회 로그인(같은 PIN) → ③ 통계 업로드·설정·PIN 변경(로그인 후에만)"
            ),
          ]),
          el("div", { class: "hint", style: "margin-top:8px" }, [
            document.createTextNode("학생으로 로그인한 상태라면 로그아웃한 뒤 학생회로 전환할 수 있어요."),
          ]),
          el("div", { class: "row", style: "margin-top:12px" }, [
            String(state.settings.teacherPinHash || "").trim() || teacherPinOneTimeResetAvailable_()
              ? el("button", { class: "btn primary", onClick: () => openTeacherLogin() }, [document.createTextNode("학생회 로그인")])
              : el("button", { class: "btn primary", onClick: () => openSetTeacherPin() }, [document.createTextNode("학생회 PIN 첫 등록")]),
            teacherPinOneTimeResetAvailable_()
              ? el("button", { class: "btn", onClick: () => openSetTeacherPin({ oneTimeReset: true }) }, [document.createTextNode("비밀번호를 잊었어요 (한 번만)")])
              : String(state.settings.teacherPinHash || "").trim()
                ? null
                : el("button", { class: "btn", onClick: () => openTeacherLogin() }, [document.createTextNode("학생회 로그인")]),
          ].filter(Boolean)),
        ]),
        el("div", { class: "card" }, [
          el("div", { class: "card__title" }, [document.createTextNode("같은 학교로 묶기 (URL 없이)")]),
          el("div", { class: "card__sub" }, [
            document.createTextNode(
              "온라인일 때는 학교 이름이 같으면 같은 스프레드시트 안에서 서로 목록·가입이 맞춰져요. 학생회가 정한 표기(띄어쓰기 포함)를 그대로 쓰면 됩니다."
            ),
          ]),
          el("div", { class: "row", style: "margin-top:12px" }, [
            el("button", { class: "btn primary", onClick: () => openSetSchoolName() }, [document.createTextNode("학교 이름 설정")]),
            el("button", { class: "btn", onClick: () => testApi() }, [document.createTextNode("연결 테스트")]),
          ]),
          !onlineEnabled()
            ? el("div", { class: "hint", style: "margin-top:10px" }, [
                document.createTextNode(
                  "지금은 로컬 모드예요. 앱에 기본 주소가 들어 있거나, 폴더에 cloud-config.json 이 있으면 자동으로 온라인이 켜질 수 있어요. 그래도 안 되면 아래에서 API 주소를 넣어 주세요."
                ),
              ])
            : null,
        ]),
        el("div", { class: "card" }, [
          el("div", { class: "card__title" }, [document.createTextNode("고급: 온라인 API 주소")]),
          el("div", { class: "card__sub" }, [
            document.createTextNode(
              defaultApiUrlResolved_()
                ? "이 배포본에는 이미 공용 웹앱 주소가 들어 있어요. 다른 스프레드시트로 바꿀 때만 여기서 수정하면 됩니다."
                : "웹앱 배포 URL(/exec)을 넣으면 상단에 ‘온라인’이 붙고, 가입·로그인이 스프레드시트와 연결돼요."
            ),
          ]),
          el("div", { class: "row", style: "margin-top:12px" }, [
            el("button", { class: "btn primary", onClick: () => openSetApiUrl() }, [document.createTextNode("API URL 설정·변경")]),
          ]),
          onlineEnabled()
            ? el("div", { class: "notice", style: "margin-top:12px" }, [
                el("div", { style: "font-weight:800" }, [document.createTextNode("온라인 연결됨")]),
                el("div", { class: "muted", style: "font-size:12px;margin-top:4px" }, [
                  document.createTextNode(shortApiUrlLabel() + (defaultApiUrlResolved_() ? " (기본 주소)" : "")),
                ]),
              ])
            : null,
        ]),
      ])
    );
    return;
  }

  const specialAvg = el("input", {
    type: "number",
    id: "avg",
    min: "0",
    step: "0.5",
    value: String(state.classPolicy.specialActivityThresholdAvgMerits),
  });

  const rewardsJson = el("textarea", {
    rows: "10",
    id: "rewardsJson",
    style: "width:100%;font-family:ui-monospace,monospace;font-size:12px;margin-top:8px",
  });
  rewardsJson.value = JSON.stringify(state.rewardCatalog, null, 2);

  const card = el("div", { class: "card" }, [
    el("div", { class: "row row--between" }, [
      el("div", {}, [
        el("div", { class: "card__title" }, [document.createTextNode("설정")]),
        el("div", { class: "card__sub" }, [document.createTextNode("학교/반에 맞게 규칙 수치를 조정할 수 있어요.")]),
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "btn", onClick: () => doTeacherLogout() }, [document.createTextNode("학생회 설정 나가기")]),
        el("button", { class: "btn danger", onClick: () => void resetAll() }, [document.createTextNode("데이터 초기화")]),
      ]),
    ]),
    el("div", { class: "form", style: "margin-top:12px" }, [
      el("div", {}, [el("label", { for: "avg" }, [document.createTextNode("특별활동 기준(반 평균 상점)")]), specialAvg]),
    ]),
    el("div", { class: "row", style: "margin-top:10px" }, [
      el(
        "button",
        {
          class: "btn primary",
          onClick: async () => {
            const a = Math.max(0, Number(specialAvg.value || 6));
            state.classPolicy.specialActivityThresholdAvgMerits = a;
            if (onlineEnabled() && session.teacherPinForApi) {
              const res = await pushTeacherMetaToServer();
              if (!res.ok && !res.skipped) return alert("서버 저장 실패: " + String(res.error || "unknown"));
            }
            render();
          },
        },
        [document.createTextNode("저장")]
      ),
      el("span", { class: "hint" }, [
        document.createTextNode(
          onlineEnabled()
            ? "이 기기에 저장되고, 학생회로 로그인된 상태에서는 서버에도 동기화돼요."
            : "이 설정은 이 브라우저(PC) 안에 저장돼요. 다른 PC/폰에서는 별도로 저장됩니다."
        ),
      ]),
    ]),
  ]);

  const noticeInput = el("textarea", {
    id: "schoolNotice",
    rows: "3",
    maxlength: "200",
    placeholder: "예) 이번 주 금요일에 3월 생활점수 통계를 올려 두었어요",
  });
  noticeInput.value = String(state.meta?.schoolNotice || "");
  const noticeCard = el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("학생 홈 공지")]),
    el("div", { class: "card__sub" }, [
      document.createTextNode("홈 맨 위에 한 줄로 보여요. 200자까지, 온라인이면 같은 학교 모두에게 보입니다."),
    ]),
    noticeInput,
    el("div", { class: "row", style: "margin-top:10px" }, [
      el(
        "button",
        {
          class: "btn primary",
          onClick: async () => {
            state.meta.schoolNotice = String(noticeInput.value || "").trim().slice(0, 200);
            state.meta.schoolNoticeAt = nowISO();
            if (onlineEnabled() && session.teacherPinForApi) {
              const res = await pushTeacherMetaToServer({ schoolNotice: String(state.meta.schoolNotice || "") });
              if (!res.ok && !res.skipped) return alert("서버 저장 실패: " + String(res.error || "unknown"));
            }
            render();
          },
        },
        [document.createTextNode("공지 저장")]
      ),
      el("button", { class: "btn", onClick: () => openSetSchoolNotice() }, [document.createTextNode("크게 편집")]),
    ]),
  ]);

  const rewardsCard = el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("보상 상점(학생회 전용)")]),
    el("div", { class: "card__sub" }, [
      document.createTextNode("보상 목록(JSON). id·title·costMerits·detail 필드를 사용해요. 저장 시 온라인이면 서버에도 반영돼요."),
    ]),
    rewardsJson,
    el("div", { class: "row", style: "margin-top:10px" }, [
      el(
        "button",
        {
          class: "btn",
          onClick: () => {
            state.rewardCatalog = cloneDefaultRewards();
            rewardsJson.value = JSON.stringify(state.rewardCatalog, null, 2);
          },
        },
        [document.createTextNode("기본 보상으로 되돌리기")]
      ),
      el(
        "button",
        {
          class: "btn primary",
          onClick: async () => {
            try {
              const parsed = JSON.parse(rewardsJson.value || "[]");
              if (!Array.isArray(parsed) || !parsed.length) return alert("보상은 배열 형식이어야 해요.");
              for (const it of parsed) {
                if (!it || typeof it !== "object" || !it.id || !it.title) return alert("각 항목에 id와 title이 필요해요.");
                if (!Number.isFinite(Number(it.costMerits))) return alert("costMerits는 숫자여야 해요.");
              }
              state.rewardCatalog = parsed;
              if (onlineEnabled() && session.teacherPinForApi) {
                const res = await pushTeacherMetaToServer();
                if (!res.ok && !res.skipped) return alert("서버 저장 실패: " + String(res.error || "unknown"));
              }
              render();
            } catch {
              alert("JSON 형식을 확인해 주세요.");
            }
          },
        },
        [document.createTextNode("보상 저장")]
      ),
    ]),
  ]);

  const exportCard = el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("백업/복원")]),
    el("div", { class: "card__sub" }, [document.createTextNode("데이터를 텍스트로 내보내거나 붙여넣어 복원할 수 있어요.")]),
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn", onClick: () => openExport() }, [document.createTextNode("내보내기")]),
      el("button", { class: "btn", onClick: () => openImport() }, [document.createTextNode("복원하기")]),
    ]),
  ]);

  const onlineCard = el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("온라인 · 같은 학교 공유")]),
    el("div", { class: "card__sub" }, [
      document.createTextNode(
        "학생·학부모는 학교 이름만 학생회와 똑같이 맞추면 됩니다. 웹앱 주소는 앱에 기본으로 넣거나 cloud-config.json 으로 배포할 수 있어요."
      ),
    ]),
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn primary", onClick: () => openSetSchoolName() }, [document.createTextNode("학교 이름 설정")]),
      el("button", { class: "btn", onClick: () => openSetApiUrl() }, [document.createTextNode("API URL (고급)")]),
      el("button", { class: "btn", onClick: () => testApi() }, [document.createTextNode("연결 테스트")]),
    ]),
    el("div", { class: "hint", style: "margin-top:10px" }, [
      document.createTextNode(
        `현재: ${onlineEnabled() ? "온라인" : "로컬"} · ${apiUrl() ? shortApiUrlLabel() + (defaultApiUrlResolved_() && !(state.meta?.apiUrl && String(state.meta.apiUrl).trim()) ? " (기본)" : "") : "API 미설정"} · 학교: ${state.meta?.schoolName ? String(state.meta.schoolName) : "미설정"}`
      ),
    ]),
  ]);

  const security = el("div", { class: "card" }, [
    el("div", { class: "card__title" }, [document.createTextNode("권한/보안")]),
    el("div", { class: "card__sub" }, [document.createTextNode("학생은 본인만 확인/구매, 학생회는 통계 업로드·홈페이지 관리")]),
    el("div", { class: "row", style: "margin-top:12px" }, [
      el("button", { class: "btn primary", onClick: () => openSetTeacherPin() }, [
        document.createTextNode(state.settings.teacherPinHash ? "학생회 PIN 변경" : "학생회 PIN 설정"),
      ]),
      el("button", { class: "btn", onClick: () => openManageStudents() }, [document.createTextNode("학생 관리")]),
      el("button", { class: "btn", onClick: () => openSetSchoolName() }, [document.createTextNode("학교 이름 설정")]),
    ]),
    el("div", { class: "hint", style: "margin-top:10px" }, [
      el("div", {}, [document.createTextNode("- 이 앱은 교실 편의용이며, PIN은 기기 메모리·로컬 저장소에만 다룹니다.")]),
      el("div", {}, [document.createTextNode("- 학생회 PIN 변경은 로그인한 상태에서만 가능하고, 로그인하지 않으면 바꿀 수 없습니다.")]),
      el("div", {}, [document.createTextNode("- 온라인 모드에서 학생회 작업은 서버에도 기록됩니다.")]),
    ]),
  ]);

  root.replaceChildren(el("div", { class: "grid" }, [card, noticeCard, rewardsCard, onlineCard, security, exportCard]));
}

function openSetApiUrl() {
  const input = el("input", { id: "api", placeholder: "https://script.google.com/macros/s/.../exec" });
  input.value = apiUrl() || "";
  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode(
        defaultApiUrlResolved_()
          ? "이 배포본에는 이미 기본 웹앱 주소가 들어 있어요. 다른 스프레드시트로 바꿀 때만 여기서 덮어쓰면 됩니다. (끝이 /exec 인 배포 URL)"
          : "웹앱 배포 URL(끝이 /exec)을 붙여넣으세요. 저장하면 상단에 ‘온라인’이 표시되고, 가입·로그인이 스프레드시트와 연결돼요."
      ),
    ]),
    el("div", { class: "hint", style: "margin-top:8px" }, [
      document.createTextNode(
        "index.html을 파일로만 더블클릭(file://)해서 열면 브라우저가 서버 연결을 막을 수 있어요. 가능하면 VS Code Live Server 등으로 http 주소로 여세요."
      ),
    ]),
    el("div", {}, [el("label", { for: "api" }, [document.createTextNode("온라인 API URL")]), input]),
  ]);
  const actions = el("div", { class: "row" }, [
    el("button", { type: "button", class: "btn-ghost", onClick: () => closeModal() }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        type: "button",
        class: "btn primary",
        onClick: async (e) => {
          e.preventDefault();
          let u = normalizeApiUrlInput(input.value);
          if (u && !/script\.google\.com\/macros\/s\//i.test(u) && !/script\.googleusercontent\.com\//i.test(u)) {
            if (!confirm("Google 스크립트 웹앱 주소처럼 보이지 않아요. 그래도 저장할까요?")) return;
          }
          if (/\/dev(\/|\?|$)/i.test(u)) {
            if (!confirm("/dev 주소는 로그인한 본인만 쓸 수 있어요. 학급용이면 배포(/exec) URL을 권장합니다. 그래도 저장할까요?")) return;
          }
          state.meta.apiUrl = u || null;
          state.meta.publicStudentsCache = null;
          state.meta.publicStudentsCacheAt = null;
          closeModal();
          render();
          const ping = await withLoading("서버에 연결하는 중이에요…", () => apiCall("ping", {}));
          if (ping.ok) {
            alert(
              "저장했고 서버와 통신도 됐어요.\n\n· 상단에 ‘온라인’이 보이는지 확인하세요.\n· 같은 학교 목록은 학교 이름을 설정·가입한 뒤에 보여요."
            );
          } else {
            alert("URL은 이 브라우저에 저장했어요.\n\n" + formatApiFailureMessage(ping));
          }
          void hydrateOnlineSchoolConfig().then(() => render());
        },
      },
      [document.createTextNode("저장")]
    ),
  ]);
  openModal({ title: "온라인 API URL 설정", bodyNode: body, actionsNode: actions });
}

function formatApiFailureMessage(res) {
  const lines = [];
  if (typeof window !== "undefined" && window.location && window.location.protocol === "file:") {
    lines.push("지금 주소가 file:// 이면, 다른 사이트(script.google.com)로의 연결이 브라우저에서 막히는 경우가 많아요.");
    lines.push("Live Server, GitHub Pages, Netlify 등으로 이 앱을 http(s) 주소로 연 뒤 다시 시험해 주세요.");
    lines.push("");
  }
  lines.push("연결 실패: " + String(res.error || "unknown"));
  if (res.httpStatus) lines.push("(HTTP " + res.httpStatus + ")");
  if (res.detail) lines.push(String(res.detail));
  lines.push("");
  lines.push("자주 있는 원인:");
  lines.push("· 다른 기기·학교 Wi-Fi만 안 될 때: 망에서 script.google.com 또는 외부 POST를 막는 경우가 많아요. 휴대폰 데이터(LTE/5G)로만 잠깐 테스트해 보세요.");
  lines.push("· index.html을 파일로만 연 경우(file://) — 위와 같이 http(s)로 앱을 여세요.");
  lines.push("· Apps Script 배포: 실행「나」, 액세스「모든 사용자(익명 포함)」, 주소는 …/exec 배포 URL인지 확인하세요.");
  lines.push("· /dev 가 아닌 배포(/exec) URL인지, URL 앞뒤 공백·따옴표가 없는지 확인하세요.");
  if (res.error === "network_error") {
    lines.push("");
    lines.push("참고: ‘Failed to fetch’ 는 보통 망 차단·CORS·file:// 중 하나예요. 앱은 이제 JSON 대신 text/plain으로 보내 사전요청을 줄였습니다.");
  }
  return lines.join("\n");
}

async function testApi() {
  if (!onlineEnabled()) return alert("먼저 온라인 API URL을 설정해 주세요.");
  const res = await withLoading("서버에 연결하는 중이에요…", () => apiCall("ping", {}));
  if (!res.ok) {
    return alert(formatApiFailureMessage(res));
  }
  alert("연결 성공! 서버 시간: " + String(res.now || ""));
}

function wipeStudentRecordsLocal_() {
  const keepSchool = state.meta?.schoolName || defaultSchoolNameResolved_() || null;
  const keepApi = state.meta?.apiUrl || null;
  const keepTeacherPin = state.settings?.teacherPinHash || null;
  const keepOneTime = !!state.settings?.teacherPinOneTimeResetUsed;
  const keepLocked = !!state.settings?.teacherPinLocked;
  const keepPolicy = state.classPolicy;
  const keepRewards = state.rewardCatalog;
  state = seedState();
  state.meta.schoolName = keepSchool;
  state.meta.apiUrl = keepApi;
  state.meta.publicStudentsCache = null;
  state.meta.publicStudentsCacheAt = null;
  /** 서버에서 학생을 다시 당겨오지 않음(서버 초기화 전까지) */
  state.meta.blockServerRosterRestore = true;
  state.settings.teacherPinHash = keepTeacherPin;
  state.settings.teacherPinOneTimeResetUsed = keepOneTime;
  state.settings.teacherPinLocked = keepLocked;
  if (keepPolicy) state.classPolicy = keepPolicy;
  if (keepRewards) state.rewardCatalog = keepRewards;
  session.studentId = null;
  session.studentPinForApi = null;
  flushSaveState();
  saveSession();
}

async function wipeServerRecordsIfPossible_() {
  if (!onlineEnabled()) return { ok: true, skipped: true };
  if (!session.teacherPinForApi) return { ok: false, error: "need_teacher_login" };
  return apiCall("teacher_wipe_records", {
    teacherPin: session.teacherPinForApi,
    schoolName: state.meta?.schoolName ? String(state.meta.schoolName).trim() : "",
  });
}

async function resetAll() {
  if (!requireTeacher()) return;
  const stored = String(state.settings?.teacherPinHash || "").trim();
  if (!stored && !onlineEnabled()) {
    alert("학생회 PIN이 없어요. 설정에서 PIN을 먼저 등록해 주세요.");
    return;
  }
  const pin = el("input", {
    id: "reset-confirm-pin",
    type: "password",
    placeholder: "학생회 PIN",
    autocomplete: "current-password",
  });
  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode("모든 학생·상점·벌점·쿠폰·기록이 삭제돼요. 실수로 누르지 않도록 학생회 PIN을 다시 입력해 주세요. 학생회 PIN·학교 이름·규칙은 유지됩니다."),
    ]),
    el("div", { class: "form", style: "margin-top:12px" }, [
      el("div", { class: "form__full" }, [el("label", { for: "reset-confirm-pin" }, [document.createTextNode("학생회 PIN")]), pin]),
    ]),
  ]);
  const goBtn = el(
    "button",
    {
      class: "btn danger",
      value: "default",
      onClick: async (e) => {
        e.preventDefault();
        if (goBtn.disabled) return;
        const pinValue = pin.value;
        const h = hashPin(pinValue);
        if (!h) {
          alert("PIN을 입력해 주세요.");
          pin.focus();
          return;
        }
        if (stored && h !== stored) {
          alert("학생회 PIN이 틀렸어요.");
          pin.focus();
          return;
        }
        goBtn.disabled = true;
        try {
          if (onlineEnabled()) {
            const schoolName = state.meta?.schoolName ? String(state.meta.schoolName).trim() : "";
            const res = await withLoading("PIN을 확인하는 중이에요…", async () => {
              let r = await apiCall("teacher_login", { pin: pinValue, schoolName, quick: true });
              if (!r.ok && String(r.error || "") === "unknown_action") {
                r = await apiCall("teacher_login", { pin: pinValue, schoolName });
              }
              return r;
            });
            const err = String((res && res.error) || "");
            if (!res || !res.ok) {
              if (err === "wrong_pin" || err === "bad_pin") {
                alert("학생회 PIN이 틀렸어요.");
                pin.focus();
                return;
              }
              if (err === "no_teacher_pin" && stored && h === stored) {
                /* 로컬 PIN은 맞음. 서버에 PIN이 없으면 이 기기만 지울 수 있음 */
              } else if (err && err !== "no_teacher_pin") {
                alert("PIN 확인에 실패했어요: " + err);
                pin.focus();
                return;
              }
            } else {
              session.teacherPinForApi = pinValue;
            }
          }
          closeModal();
          await performResetAllAfterPin_();
        } finally {
          goBtn.disabled = false;
        }
      },
    },
    [document.createTextNode("초기화")]
  );
  pin.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    goBtn.click();
  });
  openModal({
    title: "데이터 초기화",
    bodyNode: body,
    actionsNode: el("div", { class: "row" }, [
      el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
      goBtn,
    ]),
  });
  queueMicrotask(() => pin.focus());
}

async function performResetAllAfterPin_() {
  if (onlineEnabled()) {
    if (!session.teacherPinForApi) {
      alert("온라인 모드입니다. 학생회로 로그인한 뒤 다시 ‘데이터 초기화’를 눌러 서버 학생도 함께 지워 주세요.\n\n지금은 이 기기 기록만 지웁니다.");
    } else {
      const wipeServer = confirm("스프레드시트(서버)에 있는 학생·기록도 함께 지울까요?\n\n확인 = 로컬+서버 모두 삭제\n취소 = 이 기기만 삭제");
      if (wipeServer) {
        const res = await withLoading("서버 기록을 지우는 중이에요…", () => wipeServerRecordsIfPossible_());
        if (!res.ok) return alert("서버 초기화 실패: " + String(res.error || "unknown") + "\n\nApps Script를 최신으로 다시 배포했는지 확인해 주세요.");
        state.meta.blockServerRosterRestore = false;
      }
    }
  }

  wipeStudentRecordsLocal_();
  if (onlineEnabled() && session.teacherPinForApi && !state.meta.blockServerRosterRestore) {
    state.meta.blockServerRosterRestore = false;
    flushSaveState();
  }
  render();
  alert("초기화했어요. 학생이 다시 보이면 서버에 남은 데이터입니다. 학생회 로그인 후 데이터 초기화에서 서버도 지워 주세요.");
}

function openExport() {
  const text = el("textarea", { readonly: "true" });
  text.value = JSON.stringify(state, null, 2);
  const body = el("div", {}, [
    el("div", { class: "hint" }, [document.createTextNode("아래 텍스트를 복사해서 저장해두면 백업이에요.")]),
    text,
  ]);
  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("닫기")]),
    el(
      "button",
      {
        class: "btn primary",
        value: "default",
        onClick: async (e) => {
          e.preventDefault();
          try {
            await navigator.clipboard.writeText(text.value);
            alert("클립보드에 복사했어요.");
          } catch {
            alert("복사에 실패했어요. 직접 선택해서 복사해 주세요.");
          }
        },
      },
      [document.createTextNode("복사")]
    ),
  ]);
  openModal({ title: "내보내기", bodyNode: body, actionsNode: actions });
}

function openImport() {
  const text = el("textarea", { placeholder: "여기에 내보내기 텍스트(JSON)를 붙여넣으세요." });
  const body = el("div", {}, [
    el("div", { class: "hint" }, [document.createTextNode("붙여넣은 데이터로 현재 데이터를 덮어써요.")]),
    text,
  ]);
  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn primary",
        value: "default",
        onClick: (e) => {
          e.preventDefault();
          try {
            const parsed = JSON.parse(text.value);
            if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.students) || !Array.isArray(parsed.ledger)) {
              return alert("형식이 올바르지 않아요.");
            }
            state = {
              version: 4,
              students: parsed.students,
              ledger: parsed.ledger,
              classPolicy: parsed.classPolicy ?? state.classPolicy,
              rewardCatalog: migrateRewardCatalog_(parsed.rewardCatalog),
              settings: parsed.settings ?? state.settings,
              meta: parsed.meta ?? state.meta,
            };
            closeModal();
            render();
            flushSaveState();
          } catch {
            alert("JSON 파싱에 실패했어요.");
          }
        },
      },
      [document.createTextNode("복원")]
    ),
  ]);
  openModal({ title: "복원하기", bodyNode: body, actionsNode: actions });
}

function doStudentLogout() {
  session.studentId = null;
  session.studentPinForApi = null;
  session.rememberStudent = true;
  saveSession();
  render();
}

function doTeacherLogout() {
  session.teacherAuthed = false;
  session.teacherPinForApi = null;
  session.teacherClassName = null;
  saveSession();
  render();
}


function finishStudentSession_(s, pinValue, schoolName) {
  clearOppositeSession_("student");
  const h = hashPin(pinValue);
  session.studentPinForApi = pinValue;
  session.studentId = s.id;
  if (h) s.pinHash = h;
  if (schoolName) state.meta.schoolName = schoolName;
  saveSession();
  queueMicrotask(() => void pullStudentLedger_());
}

function upsertStudentFromServer_(st, pinValue) {
  const h = hashPin(pinValue);
  let local = state.students.find((x) => x.id === st.id);
  if (!local) {
    local = {
      id: st.id,
      schoolName: st.schoolName,
      name: st.name,
      className: st.className,
      merits: st.merits,
      offsets: st.offsets,
      demerits: st.demerits,
      trusted: false,
      lastMonthlyGrantYYYYMM: st.lastMonthlyGrantYYYYMM ?? null,
      pinHash: h,
    };
    state.students.push(local);
  } else {
    local.schoolName = st.schoolName;
    local.name = st.name;
    local.className = st.className;
    local.merits = st.merits;
    local.offsets = st.offsets;
    local.demerits = st.demerits;
    if (st.lastMonthlyGrantYYYYMM != null) local.lastMonthlyGrantYYYYMM = st.lastMonthlyGrantYYYYMM;
    if (h) local.pinHash = h;
  }
  markStudentsDirty();
  return local;
}
function openStudentLogin() {
  if (!guardNoActiveLogin("학생 로그인")) return;
  if (!state.students.length && !onlineEnabled()) return alert("아직 명단에 학생이 없어요. 학생회가 먼저 이름과 반을 올려 주세요.");

  const schoolId = "student-login-school";
  const nameId = "student-login-name";
  const classId = "student-login-class";
  const pinId = "student-login-pin";
  const rememberId = "student-login-remember";
  const school = el("input", { id: schoolId, placeholder: "예) 서울OO중학교", autocomplete: "organization" });
  school.value = state.meta?.schoolName ? String(state.meta.schoolName) : "";
  const name = el("input", { id: nameId, placeholder: "예) 홍길동", autocomplete: "name" });
  const className = el("input", { id: classId, placeholder: "예) 2-3" });
  const pin = el("input", { id: pinId, type: "password", placeholder: "PIN 4~12자리", autocomplete: "current-password" });
  const remember = el("select", { id: rememberId }, [
    el("option", { value: "true" }, [document.createTextNode("자동 로그인: 켬")]),
    el("option", { value: "false" }, [document.createTextNode("자동 로그인: 끔")]),
  ]);
  remember.value = session.rememberStudent ? "true" : "false";
  const errorBox = el("div", { class: "form-error", role: "alert" });

  const clearLoginError = () => {
    errorBox.classList.remove("is-on");
    errorBox.textContent = "";
    pin.classList.remove("input-invalid");
    school.classList.remove("input-invalid");
    name.classList.remove("input-invalid");
    className.classList.remove("input-invalid");
  };

  const showLoginError = (message, { focusPin = false, highlightFields = [] } = {}) => {
    errorBox.textContent = message;
    errorBox.classList.add("is-on");
    for (const field of highlightFields) field.classList.add("input-invalid");
    if (focusPin) {
      pin.classList.add("input-invalid");
      pin.focus();
      pin.select();
    }
  };

  for (const field of [school, name, className, pin, remember]) {
    field.addEventListener("input", clearLoginError);
    field.addEventListener("change", clearLoginError);
  }

  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode("학교/이름/반/PIN으로 로그인해요. PIN은 가입할 때 정하고, 바꾸고 싶으면 로그인한 뒤 ‘PIN 변경’에서만 바꿀 수 있어요."),
    ]),
    el("div", { class: "hint", style: "margin-top:6px" }, [
      document.createTextNode(
        "‘자동 로그인’을 켜면 이 기기에 로그인 정보가 저장돼, 앱을 닫았다 열어도 같은 계정으로 이어집니다. PC를 여러 사람이 쓰면 끄는 것이 좋아요."
      ),
    ]),
    el("div", { class: "form" }, [
      el("div", { class: "form__full" }, [el("label", { for: schoolId }, [document.createTextNode("학교 이름")]), school]),
      el("div", {}, [el("label", { for: nameId }, [document.createTextNode("이름")]), name]),
      el("div", {}, [el("label", { for: classId }, [document.createTextNode("반")]), className]),
      el("div", { class: "form__full" }, [el("label", { for: pinId }, [document.createTextNode("PIN")]), pin]),
      el("div", { class: "form__full" }, [el("label", { for: rememberId }, [document.createTextNode("로그인 유지")]), remember]),
    ]),
    errorBox,
  ]);

  const runStudentLogin = async () => {
    clearLoginError();
    const sc = school.value.trim();
    const nm = name.value.trim();
    const cl = className.value.trim();
    if (!sc || !nm || !cl) {
      return void showLoginError("학교/이름/반을 입력해 주세요.", {
        highlightFields: [!sc && school, !nm && name, !cl && className].filter(Boolean),
      });
    }

    session.rememberStudent = remember.value === "true";
    const pinValue = pin.value;
    const h = hashPin(pinValue);

    const matched = state.students.filter((s) => {
      const sSchool = s.schoolName || state.meta?.schoolName || "";
      return String(sSchool).trim() === sc && String(s.name).trim() === nm && String(s.className).trim() === cl;
    });

    if (matched.length === 1 && !matched[0].pinHash) {
      return void showLoginError("아직 PIN이 없어요. ‘가입하기’에서 PIN을 먼저 정해 주세요. 로그인 화면에서는 비밀번호를 바꿀 수 없어요.");
    }

    // 로컬 PIN이 맞으면 즉시 로그인(서버 확인은 백그라운드)
    if (matched.length === 1 && h && matched[0].pinHash === h) {
      finishStudentSession_(matched[0], pinValue, sc);
      closeModal();
      render();
      if (onlineEnabled()) {
        void apiCall("login", { schoolName: sc, name: nm, className: cl, pin: pinValue }).then((res) => {
          if (!res || !res.ok) {
            const err = String(res && res.error || "");
            if (err === "wrong_pin" || err === "bad_pin") {
              session.studentId = null;
              session.studentPinForApi = null;
              saveSession();
              showToast({ title: "비밀번호가 틀렸어요!", detail: "다시 로그인해 주세요." });
              render();
            }
            return;
          }
          upsertStudentFromServer_(res.student, pinValue);
          finishStudentSession_(getStudent(state, res.student.id) || matched[0], pinValue, sc);
          render();
          refreshPublicStudents();
        });
      }
      return;
    }

    if (onlineEnabled()) {
      const res = await withLoading("로그인하고 있어요…", () =>
        apiCall("login", { schoolName: sc, name: nm, className: cl, pin: pinValue })
      );
      if (!res.ok) {
        const err = String(res.error || "");
        if (err === "wrong_pin" || err === "bad_pin") {
          return void showLoginError("비밀번호(PIN)가 틀렸어요. 다시 입력해 주세요. PIN을 바꾸려면 로그인한 뒤 ‘PIN 변경’을 이용해 주세요.", { focusPin: true });
        }
        if (err === "need_signup") {
          return void showLoginError("아직 PIN이 없어요. ‘가입하기’에서 PIN을 먼저 정해 주세요. 로그인 화면에서는 비밀번호를 바꿀 수 없어요.");
        }
        if (err === "not_found") {
          return void showLoginError("일치하는 학생을 찾지 못했어요. 학교/이름/반을 확인해 주세요.", {
            highlightFields: [school, name, className],
          });
        }
        if (err === "missing_fields") {
          return void showLoginError("학교/이름/반을 입력해 주세요.");
        }
        return void showLoginError("로그인에 실패했어요: " + (err || "unknown"));
      }
      const local = upsertStudentFromServer_(res.student, pinValue);
      finishStudentSession_(local, pinValue, sc);
      closeModal();
      render();
      void refreshPublicStudents();
      return;
    }

    if (!matched.length) {
      return void showLoginError("일치하는 학생을 찾지 못했어요. 가입 정보(학교/이름/반)를 확인해 주세요.", {
        highlightFields: [school, name, className],
      });
    }
    if (matched.length > 1) {
      return void showLoginError("동일 정보 학생이 2명 이상이에요. 학생회에 계정 정리를 요청해 주세요.");
    }
    const s = matched[0];
    if (!h) return void showLoginError("PIN은 4~12자리로 입력해 주세요.", { focusPin: true });
    if (!s.pinHash) {
      return void showLoginError("아직 PIN이 없어요. ‘가입하기’에서 PIN을 먼저 정해 주세요. 로그인 화면에서는 비밀번호를 바꿀 수 없어요.");
    }
    if (s.pinHash !== h) {
      return void showLoginError("비밀번호(PIN)가 틀렸어요. 다시 입력해 주세요.", { focusPin: true });
    }
    finishStudentSession_(s, pinValue, sc);
    closeModal();
    render();
  };
  const loginBtn = el(
    "button",
    {
      class: "btn primary",
      onClick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (loginBtn.disabled) return;
        loginBtn.disabled = true;
        try {
          await runStudentLogin();
        } finally {
          loginBtn.disabled = false;
          loginBtn.textContent = "로그인";
        }
      },
    },
    [document.createTextNode("로그인")]
  );

  pin.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (loginBtn.disabled) return;
    loginBtn.click();
  });

  const actions = el("div", { class: "row" }, [el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]), loginBtn]);

  openModal({ title: "학생 로그인", bodyNode: body, actionsNode: actions });
}

function openChangeStudentPin() {
  const s = currentStudent();
  if (!s || !session.studentId) {
    alert("PIN을 바꾸려면 먼저 학생으로 로그인해 주세요.\n로그인하지 않은 상태에서는 바꿀 수 없어요.");
    openStudentLogin();
    return;
  }
  const oldPin = el("input", { id: "old", type: "password", placeholder: "현재 PIN" });
  const a = el("input", { id: "pinA", type: "password", placeholder: "새 PIN (4~12자리)" });
  const b = el("input", { id: "pinB", type: "password", placeholder: "새 PIN 다시 입력" });
  const body = el("div", {}, [
    el("div", { class: "hint" }, [document.createTextNode("로그인한 본인 계정의 PIN만 바꿀 수 있어요.")]),
    el("div", { class: "form" }, [
      el("div", { class: "form__full" }, [el("label", { for: "old" }, [document.createTextNode("현재 PIN")]), oldPin]),
      el("div", { class: "form__full" }, [el("label", { for: "pinA" }, [document.createTextNode("새 PIN")]), a]),
      el("div", { class: "form__full" }, [el("label", { for: "pinB" }, [document.createTextNode("새 PIN 확인")]), b]),
    ]),
  ]);
  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn primary",
        value: "default",
        onClick: async (e) => {
          e.preventDefault();
          if (!session.studentId || session.studentId !== s.id) {
            return alert("로그인한 뒤에만 PIN을 바꿀 수 있어요.");
          }
          const hOld = hashPin(oldPin.value);
          if (!hOld) return alert("현재 PIN을 입력해 주세요.");
          if (!s.pinHash) return alert("이 계정은 아직 PIN이 없어요. 로그아웃한 뒤 ‘가입하기’에서 PIN을 정해 주세요.");
          if (s.pinHash !== hOld) return alert("현재 PIN이 맞지 않아요.");
          const pa = normPin(a.value);
          const pb = normPin(b.value);
          if (!pa || !pb) return alert("새 PIN은 4~12자리로 입력해 주세요.");
          if (pa !== pb) return alert("새 PIN이 서로 달라요.");
          if (onlineEnabled()) {
            const res = await withLoading("PIN을 저장하는 중이에요…", () =>
              apiCall("student_change_pin", { studentId: s.id, currentPin: normPin(oldPin.value) || oldPin.value, pin: pa })
            );
            if (!res.ok) {
              const err = String(res.error || "");
              if (err === "unknown_action") {
                return alert("서버에 PIN 변경 기능이 없어요. Apps Script를 최신 파일로 다시 배포해 주세요.");
              }
              if (err === "wrong_pin") return alert("현재 PIN이 맞지 않아요.");
              if (err === "need_signup") return alert("아직 PIN이 없어요. ‘가입하기’에서 PIN을 정해 주세요.");
              return alert("서버에 PIN 저장 실패: " + (err || "unknown"));
            }
          }
          s.pinHash = hashPin(pa);
          if (session.studentId === s.id) session.studentPinForApi = pa;
          addLedger(state, { studentId: s.id, type: "pin_change", note: "학생 PIN 변경" });
          saveState(state);
          saveSession();
          closeModal();
          render();
          showToast({ title: "PIN을 바꿨어요", detail: "앞으로 새 PIN으로 로그인하면 됩니다." });
        },
      },
      [document.createTextNode("변경")]
    ),
  ]);
  openModal({ title: "PIN 변경", bodyNode: body, actionsNode: actions });
}

function openTeacherLogin() {
  if (!guardNoActiveLogin("학생회 로그인")) return;
  const pinId = "teacher-login-pin";
  const rememberId = "teacher-login-remember";
  const pin = el("input", { id: pinId, type: "password", placeholder: "학생회 PIN", autocomplete: "current-password" });
  const remember = el("select", { id: rememberId }, [
    el("option", { value: "true" }, [document.createTextNode("로그인 유지: 켬")]),
    el("option", { value: "false" }, [document.createTextNode("로그인 유지: 끔")]),
  ]);
  remember.value = session.rememberTeacher !== false ? "true" : "false";
  const errorBox = el("div", { class: "form-error", role: "alert" });

  const clearLoginError = () => {
    errorBox.classList.remove("is-on");
    errorBox.textContent = "";
    pin.classList.remove("input-invalid");
  };

  const showLoginError = (message, { focusPin = false } = {}) => {
    errorBox.textContent = message;
    errorBox.classList.add("is-on");
    if (focusPin) {
      pin.classList.add("input-invalid");
      pin.focus();
      pin.select();
    }
  };

  pin.addEventListener("input", clearLoginError);
  remember.addEventListener("change", clearLoginError);

  const hintText = onlineEnabled()
    ? "온라인 모드에서는 서버(스프레드시트)에 등록된 학생회 PIN으로 로그인해요. 앱을 다시 열면 보안을 위해 학생회 로그인이 한 번 더 필요해요."
    : state.settings.teacherPinHash
      ? "학생회 PIN을 입력해 로그인하세요."
      : "아직 학생회 PIN이 설정되지 않았어요. ‘설정’ 탭에서 PIN을 먼저 설정하면 학생회 탭이 잠겨요.";

  const body = el("div", {}, [
    el("div", { class: "hint" }, [document.createTextNode(hintText)]),
    el("div", { class: "form" }, [
      el("div", { class: "form__full" }, [el("label", { for: pinId }, [document.createTextNode("PIN")]), pin]),
      el("div", { class: "form__full" }, [el("label", { for: rememberId }, [document.createTextNode("로그인 유지")]), remember]),
    ]),
    errorBox,
  ]);

  const runTeacherLogin = async () => {
    clearLoginError();
    const pinValue = normPin(pin.value);
    const h = hashPin(pinValue);
    if (!h) return void showLoginError("PIN은 4~12자리로 입력해 주세요.", { focusPin: true });
    session.rememberTeacher = remember.value === "true";

    const finishTeacherUi = () => {
      loginTeacherWithPin_(pinValue);
      closeModal();
      render();
      lastTeacherRosterSyncAt = 0;
      queueMicrotask(() => void ensureTeacherRosterFresh_());
    };

    const syncTeacherInBackground = () => {
      if (!onlineEnabled()) return;
      const schoolName = state.meta?.schoolName ? String(state.meta.schoolName).trim() : "";
      void withLoading("학생 명단을 불러오는 중이에요…", async () => {
        await maybeWipeServerDemoData_();
        if (state.meta?.pendingServerWipe) return;
        const res = await apiCall("teacher_login", { pin: pinValue, schoolName });
        if (!res || !res.ok) {
          const err = String((res && res.error) || "");
          if (err === "wrong_pin" || err === "bad_pin") {
            showToast({
              title: "이 기기에서는 로그인됐어요",
              detail: "서버 PIN과 달라 명단 동기화는 안 될 수 있어요. 학생회 탭은 이 기기에서 쓸 수 있습니다.",
              duration: 5200,
            });
          }
          return;
        }
        state.settings.teacherPinHash = h;
        if (Array.isArray(res.students)) {
          applyTeacherMetaFromResponse_(res);
          applyTeacherRosterFromStudentsArray_(res.students, schoolName);
        } else {
          await Promise.all([pullTeacherMetaAfterLogin(), syncTeacherRosterFromServer()]);
        }
        if (route === "teacher") render();
      });
    };

    // 이 기기에 저장된 PIN이 맞으면 로그인. 서버가 예전 PIN이어도 쫓아내지 않아요.
    if (state.settings.teacherPinHash && state.settings.teacherPinHash === h) {
      finishTeacherUi();
      syncTeacherInBackground();
      return;
    }

    if (onlineEnabled()) {
      const schoolName = state.meta?.schoolName ? String(state.meta.schoolName).trim() : "";
      let res = null;
      await withLoading("학생회 로그인 중이에요…", async () => {
        res = await apiCall("teacher_login", { pin: pinValue, schoolName, quick: true });
        if (!res.ok && String(res.error || "") === "unknown_action") {
          res = await apiCall("teacher_login", { pin: pinValue, schoolName });
        }
      });
      if (!res || !res.ok) {
        const err = String((res && res.error) || "");
        if (err === "wrong_pin" || err === "bad_pin") {
          return void showLoginError(
            teacherPinOneTimeResetAvailable_()
              ? "비밀번호(PIN)가 틀렸어요. 잊었다면 아래에서 한 번만 새 PIN을 정할 수 있어요."
              : "비밀번호(PIN)가 틀렸어요. 다시 입력해 주세요.",
            { focusPin: true }
          );
        }
        if (err === "no_teacher_pin") {
          return void showLoginError("서버에 학생회 PIN이 없어요. 설정에서 먼저 등록해 주세요.");
        }
        return void showLoginError("로그인에 실패했어요: " + (err || "unknown"));
      }
      finishTeacherUi();
      if (state.meta?.pendingServerWipe || !Array.isArray(res.students)) {
        syncTeacherInBackground();
      } else {
        applyTeacherMetaFromResponse_(res);
        applyTeacherRosterFromStudentsArray_(res.students, schoolName);
        if (route === "teacher") render();
      }
      return;
    }

    if (!state.settings.teacherPinHash) {
      return void showLoginError("설정 탭에서 학생회 PIN을 먼저 설정해 주세요.");
    }
    return void showLoginError(
      teacherPinOneTimeResetAvailable_()
        ? "비밀번호(PIN)가 틀렸어요. 잊었다면 아래에서 한 번만 새 PIN을 정할 수 있어요."
        : "비밀번호(PIN)가 틀렸어요. 다시 입력해 주세요.",
      { focusPin: true }
    );
  };
  const loginBtn = el(
    "button",
    {
      class: "btn primary",
      type: "button",
      onClick: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (loginBtn.disabled) return;
        loginBtn.disabled = true;
        try {
          await runTeacherLogin();
        } finally {
          loginBtn.disabled = false;
          loginBtn.textContent = "로그인";
        }
      },
    },
    [document.createTextNode("로그인")]
  );

  pin.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (loginBtn.disabled) return;
    loginBtn.click();
  });

  const actions = el(
    "div",
    { class: "row" },
    [
      el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("닫기")]),
      teacherPinOneTimeResetAvailable_()
        ? el(
            "button",
            {
              class: "btn",
              onClick: (e) => {
                e.preventDefault();
                closeModal();
                openSetTeacherPin({ oneTimeReset: true });
              },
            },
            [document.createTextNode("비밀번호를 잊었어요")]
          )
        : null,
      loginBtn,
    ].filter(Boolean)
  );

  openModal({ title: "학생회 로그인", bodyNode: body, actionsNode: actions });
}
function openSetTeacherPin(opts = {}) {
  if (session.studentId) {
    alert("학생으로 로그인 중이에요.\n로그아웃한 뒤 학생회 PIN을 등록·변경해 주세요.");
    return;
  }
  const oneTimeReset = !!opts.oneTimeReset;
  const pinAlreadySet = !!String(state.settings.teacherPinHash || "").trim();
  if (oneTimeReset) {
    if (!teacherPinOneTimeResetAvailable_()) {
      alert("이미 한 번 사용했어요.\n이제 PIN은 학생회로 로그인한 뒤에만 바꿀 수 있어요.");
      openTeacherLogin();
      return;
    }
  } else if (pinAlreadySet && !session.teacherAuthed) {
    if (teacherPinOneTimeResetAvailable_()) {
      alert("PIN을 바꾸려면 먼저 학생회로 로그인해 주세요.\n비밀번호를 잊었다면 설정에서 ‘한 번만’ 다시 정할 수 있어요.");
      return;
    }
    alert("학생회 PIN을 바꾸려면 먼저 학생회로 로그인해 주세요.\n로그인하지 않은 상태에서는 바꿀 수 없어요.");
    openTeacherLogin();
    return;
  }
  const needCurrent = pinAlreadySet && !oneTimeReset;
  const current = needCurrent
    ? el("input", { id: "pinCurrent", type: "password", placeholder: "지금 쓰는 PIN" })
    : null;
  const a = el("input", { id: "pinA", type: "password", placeholder: "새 PIN (4~12자리)" });
  const b = el("input", { id: "pinB", type: "password", placeholder: "새 PIN 다시 입력" });
  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode(
        oneTimeReset
          ? "새 PIN을 넣고 ‘저장’을 눌러야 적용돼요. 확인 창만으로는 저장되지 않아요. 저장에 성공하면 바로 로그인됩니다. 이후 변경은 로그인한 뒤에만 가능해요."
          : pinAlreadySet
            ? "지금 쓰는 PIN을 확인한 뒤에만 바꿀 수 있어요. PIN 변경은 학생회로 로그인한 상태에서만 가능해요."
            : onlineEnabled()
              ? "처음 한 번만 학생회 PIN을 정해요. 저장 후에는 로그인한 뒤에만 바꿀 수 있어요."
              : "학생회 PIN을 설정하면 학생회 탭에서 통계 업로드와 홈페이지 관리가 잠겨요. 이후 변경은 로그인한 뒤에만 가능해요."
      ),
    ]),
    el("div", { class: "form" }, [
      current ? el("div", { class: "form__full" }, [el("label", { for: "pinCurrent" }, [document.createTextNode("지금 PIN")]), current]) : null,
      el("div", { class: "form__full" }, [el("label", { for: "pinA" }, [document.createTextNode("새 PIN")]), a]),
      el("div", { class: "form__full" }, [el("label", { for: "pinB" }, [document.createTextNode("새 PIN 확인")]), b]),
    ].filter(Boolean)),
  ]);
  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn primary",
        type: "button",
        value: "default",
        onClick: async (e) => {
          e.preventDefault();
          if (oneTimeReset && !teacherPinOneTimeResetAvailable_()) {
            return alert("이미 한 번 사용했어요. 이제 로그인한 뒤에만 PIN을 바꿀 수 있어요.");
          }
          if (!oneTimeReset && pinAlreadySet && !session.teacherAuthed) {
            return alert("로그인한 뒤에만 PIN을 바꿀 수 있어요.");
          }
          const pa = normPin(a.value);
          const pb = normPin(b.value);
          const cur = current ? normPin(current.value) : "";
          if (!pa || !pb) return alert("PIN은 4~12자리로 입력해 주세요.");
          if (pa !== pb) return alert("새 PIN이 서로 달라요.");
          if (needCurrent) {
            if (!cur) return alert("지금 쓰는 PIN을 입력해 주세요.");
            if (hashPin(cur) !== state.settings.teacherPinHash) return alert("지금 쓰는 PIN이 틀렸어요.");
            if (pa === cur) return alert("새 PIN이 지금 쓰는 PIN과 같아요. 다른 번호로 바꿔 주세요.");
          }
          let serverSaveFailed = false;
          if (onlineEnabled()) {
            const attempts = oneTimeReset
              ? [{ pin: pa, oneTimeReset: true }]
              : pinAlreadySet
                ? [
                    { pin: pa, currentPin: cur },
                    { pin: pa, currentPin: cur, oneTimeReset: true },
                  ]
                : [{ pin: pa }, { pin: pa, oneTimeReset: true }];
            let errMsg = "";
            await withLoading("PIN을 저장하는 중이에요…", async () => {
              let res = { ok: false, error: "unknown" };
              for (const payload of attempts) {
                res = await apiCall("teacher_set_pin", payload);
                if (res && res.ok) break;
              }
              if (!res || !res.ok) {
                const err = String((res && res.error) || "");
                errMsg = "서버는 아직 다른 PIN을 쓰고 있어요. 이 기기 PIN은 지금 바꿉니다.";
                if (err && err !== "need_current_pin" && err !== "one_time_reset_used") {
                  errMsg = "서버에 PIN 저장 실패: " + err + "\n이 기기 PIN은 지금 바꿉니다.";
                }
                serverSaveFailed = true;
                return;
              }
              const m = await apiCall("teacher_set_meta", {
                teacherPin: pa,
                classPolicy: state.classPolicy,
                rewardCatalog: state.rewardCatalog,
              });
              if (!m.ok) errMsg = "PIN은 이 기기에 저장했어요. 교실 규칙 서버 동기화만 실패: " + String(m.error || "unknown");
            });
            if (errMsg && !serverSaveFailed && String(errMsg).indexOf("PIN은 이 기기") !== 0) {
              alert(errMsg);
              return;
            }
          }
          clearOppositeSession_("teacher");
          state.settings.teacherPinHash = hashPin(pa);
          if (oneTimeReset) markTeacherPinOneTimeResetUsed_();
          loginTeacherWithPin_(pa);
          closeModal();
          render();
          lastTeacherRosterSyncAt = 0;
          queueMicrotask(() => void ensureTeacherRosterFresh_());
          if (serverSaveFailed) {
            alert(
              "이 기기의 학생회 PIN을 바꿨습니다. 지금부터 새 PIN으로 로그인하면 됩니다.\n\n서버(다른 폰·PC)는 아직 예전 PIN일 수 있어요. 같이 쓰려면 Apps Script를 다시 배포한 뒤, 로그인된 상태에서 PIN을 한 번 더 저장해 주세요."
            );
          } else {
            alert("학생회 PIN을 바꿨습니다. 지금부터 새 PIN으로 로그인하면 됩니다.");
          }
          showToast({
            title: "학생회 PIN을 바꿨어요",
            detail: "이제 새 PIN이 이 기기에 적용됐어요.",
          });
        },
      },
      [document.createTextNode("저장")]
    ),
  ]);
  openModal({
    title: oneTimeReset ? "학생회 PIN 다시 정하기 (한 번만)" : pinAlreadySet ? "학생회 PIN 변경" : "학생회 PIN 설정",
    bodyNode: body,
    actionsNode: actions,
  });
}

function openManageStudents() {
  if (!requireTeacher()) return;
  const scoped = studentsInTeacherScope();

  const rows = el(
    "table",
    { class: "table", style: "margin-top:12px" },
    [
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, [document.createTextNode("이름")]),
          el("th", {}, [document.createTextNode("반")]),
          el("th", {}, [document.createTextNode("학교")]),
          el("th", {}, [document.createTextNode("PIN")]),
          el("th", {}, [document.createTextNode("작업")]),
        ]),
      ]),
      el(
        "tbody",
        {},
        scoped.map((s) =>
          el("tr", {}, [
            el("td", {}, [nameWithMascot(s.name)]),
            el("td", {}, [document.createTextNode(s.className)]),
            el("td", {}, [document.createTextNode(s.schoolName || state.meta?.schoolName || "")]),
            el("td", {}, [document.createTextNode(s.pinHash ? "설정됨" : "미설정")]),
            el("td", {}, [
              el("div", { class: "row" }, [
                el("button", { class: "btn-ghost", onClick: () => openStudentDetail(s.id) }, [document.createTextNode("기록")]),
                el("button", { class: "btn-ghost", onClick: () => void openResetStudentPin(s.id) }, [document.createTextNode("PIN 초기화")]),
              ]),
            ]),
          ])
        )
      ),
    ]
  );

  const body = el("div", {}, [
    el("div", { class: "row row--between" }, [
      el("div", { class: "hint" }, [document.createTextNode(`담당 ${teacherScopeLabel()} 학생만 표시돼요.`)]),
      el("button", { class: "btn primary", onClick: () => openAddStudent() }, [document.createTextNode("학생 추가")]),
    ]),
    rows,
  ]);

  const actions = el("div", { class: "row" }, [el("button", { class: "btn", value: "cancel" }, [document.createTextNode("닫기")])]);
  openModal({ title: `학생 관리 · ${teacherScopeLabel()}`, bodyNode: body, actionsNode: actions });
}

async function openResetStudentPin(studentId) {
  const s = getStudent(state, studentId);
  if (!s) return;
  if (
    !confirm(
      `${s.name} 학생의 PIN을 초기화할까요?\n초기화하면 기존 비밀번호는 사라집니다. 학생은 ‘가입하기’에서 새 PIN을 정해야 하고, 로그인 화면에서는 비밀번호를 바꿀 수 없습니다.`
    )
  )
    return;
  if (onlineEnabled() && session.teacherPinForApi) {
    const res = await withLoading("PIN을 초기화하는 중이에요…", () =>
      apiCall("teacher_reset_student_pin", { teacherPin: session.teacherPinForApi, studentId })
    );
    if (!res.ok) return alert("서버 반영 실패: " + String(res.error || "unknown"));
  }
  s.pinHash = null;
  if (session.studentId === s.id) {
    session.studentId = null;
    session.studentPinForApi = null;
  }
  render();
  alert(
    `${s.name} 학생 PIN을 지웠어요.\n\n학생은 ‘가입하기’에서 새 PIN을 정하면 됩니다.\n로그인하지 않은 상태에서는 비밀번호를 바꿀 수 없고, 가입 후 로그인한 뒤에만 바꿀 수 있습니다.`
  );
}

function openTeacherLedger() {
  if (!requireTeacher()) return;
  const scopedIds = new Set(studentsInTeacherScope().map((s) => s.id));
  const items = state.ledger.filter((l) => scopedIds.has(l.studentId)).slice(0, 60);
  const body = el("div", {}, [
    el("div", { class: "hint" }, [document.createTextNode(`담당 ${teacherScopeLabel()} · 최근 60건`)]),
    items.length
      ? el(
          "table",
          { class: "table" },
          [
            el("thead", {}, [
              el("tr", {}, [
                el("th", {}, [document.createTextNode("시간")]),
                el("th", {}, [document.createTextNode("학생")]),
                el("th", {}, [document.createTextNode("변동")]),
                el("th", {}, [document.createTextNode("내용")]),
              ]),
            ]),
            el(
              "tbody",
              {},
              items.map((it) => {
                const s = getStudent(state, it.studentId);
                return el("tr", {}, [
                  el("td", {}, [document.createTextNode(fmtDate(it.at))]),
                  el("td", {}, [document.createTextNode(s ? `${s.name} (${s.className})` : "(삭제됨)")]),
                  el("td", {}, [
                    el("span", { class: "pill good", style: "margin-right:6px" }, [
                      document.createTextNode("상점 "),
                      el("b", {}, [document.createTextNode(String(it.deltaMerits))]),
                    ]),
                    el("span", { class: "pill bad" }, [
                      document.createTextNode("벌점 "),
                      el("b", {}, [document.createTextNode(String(it.deltaDemerits))]),
                    ]),
                  ]),
                  el("td", {}, [document.createTextNode(it.note || it.type)]),
                ]);
              })
            ),
          ]
        )
      : el("div", { class: "empty" }, [document.createTextNode("이 반 기록이 없어요.")]),
  ]);
  const actions = el("div", { class: "row" }, [el("button", { class: "btn", value: "cancel" }, [document.createTextNode("닫기")])]);
  openModal({ title: `반 기록 · ${teacherScopeLabel()}`, bodyNode: body, actionsNode: actions });
}

function openSetSchoolNotice() {
  if (!session.teacherAuthed) return;
  const text = el("textarea", {
    id: "schoolNoticeModal",
    rows: "4",
    maxlength: "200",
    placeholder: "예) 이번 주 금요일에 3월 생활점수 통계를 올려 두었어요",
  });
  text.value = String(state.meta?.schoolNotice || "");
  const count = el("div", { class: "muted", style: "font-size:12px;margin-top:6px" }, [
    document.createTextNode(`${text.value.length}/200`),
  ]);
  text.addEventListener("input", () => {
    count.textContent = `${String(text.value).slice(0, 200).length}/200`;
  });
  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode("홈 맨 위에 보여요. 짧게 쓰는 것이 좋아요."),
    ]),
    el("div", {}, [el("label", { for: "schoolNoticeModal" }, [document.createTextNode("공지")]), text]),
    count,
  ]);
  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn",
        onClick: async () => {
          state.meta.schoolNotice = "";
          state.meta.schoolNoticeAt = nowISO();
          if (onlineEnabled() && session.teacherPinForApi) {
            const res = await pushTeacherMetaToServer({ schoolNotice: "" });
            if (!res.ok && !res.skipped) return alert("서버 저장 실패: " + String(res.error || "unknown"));
          }
          closeModal();
          render();
        },
      },
      [document.createTextNode("공지 지우기")]
    ),
    el(
      "button",
      {
        class: "btn primary",
        value: "default",
        onClick: async (e) => {
          e.preventDefault();
          state.meta.schoolNotice = String(text.value || "").trim().slice(0, 200);
          state.meta.schoolNoticeAt = nowISO();
          if (onlineEnabled() && session.teacherPinForApi) {
            const res = await pushTeacherMetaToServer({ schoolNotice: String(state.meta.schoolNotice || "") });
            if (!res.ok && !res.skipped) return alert("서버 저장 실패: " + String(res.error || "unknown"));
          }
          closeModal();
          render();
        },
      },
      [document.createTextNode("저장")]
    ),
  ]);
  openModal({ title: "학생 홈 공지", bodyNode: body, actionsNode: actions });
}

function openSetSchoolName() {
  const school = el("input", { id: "school", placeholder: "예) 서울OO중학교 / 부산OO고등학교" });
  school.value = state.meta?.schoolName ? String(state.meta.schoolName) : "";

  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode(
        "상단에 보이는 이름이에요. 온라인일 때는 이 글자가 같은 사람끼리 같은 DB로 묶이니, 반·학교에서 정한 표기(띄어쓰기 포함)를 통일해 주세요."
      ),
    ]),
    el("div", {}, [el("label", { for: "school" }, [document.createTextNode("학교 이름")]), school]),
  ]);

  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn primary",
        value: "default",
        onClick: (e) => {
          e.preventDefault();
          const name = school.value.trim();
          state.meta.schoolName = name || null;
          closeModal();
          render();
          void refreshPublicStudents();
        },
      },
      [document.createTextNode("저장")]
    ),
  ]);

  openModal({ title: "학교 이름 설정", bodyNode: body, actionsNode: actions });
}

function openStudentSignup() {
  if (!guardNoActiveLogin("학생 가입")) return;
  const school = el("input", { id: "school", placeholder: "예) 해연중학교" });
  school.value = state.meta?.schoolName ? String(state.meta.schoolName) : "";
  const name = el("input", { id: "name", placeholder: "예) 홍길동" });
  const className = el("input", { id: "className", placeholder: "예) 2-3" });
  const pinA = el("input", { id: "pinA", type: "password", placeholder: "PIN (4~12자리)" });
  const pinB = el("input", { id: "pinB", type: "password", placeholder: "PIN 다시 입력" });
  const remember = el("select", { id: "rememberSu" }, [
    el("option", { value: "true" }, [document.createTextNode("자동 로그인: 켬 (이 기기에서 앱 다시 열어도 유지)")]),
    el("option", { value: "false" }, [document.createTextNode("자동 로그인: 끔")]),
  ]);
  remember.value = session.rememberStudent !== false ? "true" : "false";

  const body = el("div", {}, [
    el("div", { class: "hint" }, [
      document.createTextNode("학생회가 명단에 올린 이름·반만 가입할 수 있어요. 처음(또는 PIN 초기화 후)에만 여기서 PIN을 정하고, 이후 변경은 로그인한 뒤 ‘PIN 변경’에서만 할 수 있어요."),
    ]),
    el("div", { class: "form" }, [
      el("div", { class: "form__full" }, [el("label", { for: "school" }, [document.createTextNode("학교 이름(대한민국)")]), school]),
      el("div", {}, [el("label", { for: "name" }, [document.createTextNode("이름")]), name]),
      el("div", {}, [el("label", { for: "className" }, [document.createTextNode("반")]), className]),
      el("div", { class: "form__full" }, [el("label", { for: "pinA" }, [document.createTextNode("PIN")]), pinA]),
      el("div", { class: "form__full" }, [el("label", { for: "pinB" }, [document.createTextNode("PIN 확인")]), pinB]),
      el("div", { class: "form__full" }, [el("label", { for: "rememberSu" }, [document.createTextNode("로그인 유지")]), remember]),
    ]),
  ]);

  const actions = el("div", { class: "row" }, [
    el("button", { class: "btn-ghost", value: "cancel" }, [document.createTextNode("취소")]),
    el(
      "button",
      {
        class: "btn primary",
        value: "default",
        onClick: async (e) => {
          e.preventDefault();
          const sc = school.value.trim();
          const nm = name.value.trim();
          const cl = className.value.trim();
          const pa = normPin(pinA.value);
          const pb = normPin(pinB.value);
          if (!sc) return alert("학교 이름을 입력해 주세요.");
          if (!nm || !cl) return alert("이름/반을 입력해 주세요.");
          if (!pa || !pb) return alert("PIN은 4~12자리로 입력해 주세요.");
          if (pa !== pb) return alert("PIN이 서로 달라요.");

          const takeSeat = (student) => {
            session.rememberStudent = remember.value === "true";
            clearOppositeSession_("student");
            state.meta.schoolName = sc;
            const local = upsertStudentFromServer_(student, pa);
            session.studentPinForApi = pa;
            session.studentId = local.id;
            saveSession();
            closeModal();
            render();
            setTimeout(() => void refreshPublicStudents(), 800);
          };

          if (onlineEnabled()) {
            let errMsg = "";
            await withLoading("가입하고 있어요…", async () => {
              await refreshPublicStudents();
              const pub = Array.isArray(state.meta.publicStudentsCache) ? state.meta.publicStudentsCache : [];
              if (pub.length) {
                const onRoster = pub.some(
                  (p) => String(p.name || "").trim() === nm && String(p.className || "").trim() === cl
                );
                if (!onRoster) {
                  errMsg = "학생회 명단에 없는 이름이에요.\n담임 선생님이나 학생회에 이름을 올려 달라고 해 주세요.";
                  return;
                }
              }
              const res = await apiCall("signup", { schoolName: sc, name: nm, className: cl, pin: pa });
              if (res && res.ok && res.student) {
                takeSeat(res.student);
                return;
              }
              const err = String((res && res.error) || "");
              if (err === "not_on_roster") {
                errMsg = "학생회 명단에 없는 이름이에요.\n담임 선생님이나 학생회에 이름을 올려 달라고 해 주세요.";
                return;
              }
              if (err === "already_exists") {
                errMsg = "이미 가입된 계정이에요. ‘학생 로그인’으로 들어가 주세요.";
                return;
              }
              errMsg = "가입에 실패했어요: " + (err || "unknown") + (res && res.detail ? "\n" + res.detail : "");
            });
            if (errMsg) return alert(errMsg);
            return;
          }

          const seat = findRosterSeat_(sc, nm, cl);
          if (!seat) {
            return alert("학생회 명단에 없는 이름이에요.\n학생회가 먼저 이름과 반을 올려야 가입할 수 있어요.");
          }
          if (studentHasPin_(seat)) {
            return alert("이미 가입된 계정이에요. ‘학생 로그인’으로 들어가 주세요.");
          }
          takeSeat(seat);
        },
      },
      [document.createTextNode("가입")]
    ),
  ]);

  openModal({ title: "학생 가입", bodyNode: body, actionsNode: actions });
}

// Initial paint
loadSession();
if (session.studentId && !getStudent(state, session.studentId)) {
  session.studentId = null;
  session.studentPinForApi = null;
  saveSession();
}
render();
if (state.meta?.deployCleanToast) {
  state.meta.deployCleanToast = false;
  flushSaveState();
  showToast({
    title: "연습 데이터를 지웠어요",
    detail: "학생·쿠폰 구매·통계 기록을 비웠습니다. 학생회로 로그인하면 서버(스프레드시트) 기록도 지워집니다.",
  });
}
void hydrateOnlineSchoolConfig().then((changed) => {
  if (changed) render();
});
void pullStudentLedger_();
