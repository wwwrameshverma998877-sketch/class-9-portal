const SUPABASE_URL = "https://jscgedmfzdxpbtmokazf.supabase.co/rest/v1/";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzY2dlZG1memR4cGJ0bW9rYXpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMTYwNjAsImV4cCI6MjEwNDc5MjA2MH0.bGFzIlqtQYfByOC9dGNEihIhX-jfX72g7tZ8-wZeTeg";
const SUPABASE_PROJECT_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");
const supabaseClient = supabase.createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY);
const DRIVE_FOLDER_ID = "1kvzcnMaijD6g06GT5loXUtJ1xom7N2t0";
const DRIVE_API_KEY = "AIzaSyDL9mJG7q0JFRXSKNjLKIdYR4nyS8I5ZE0";
const MAX_PDF_SIZE = 10 * 1024 * 1024;
const SUBJECTS = ["English", "Algebra", "Geometry", "Science I", "Science II", "Hindi", "Marathi"];
let activeSession = null;
let isLoggedIn = false;
let isAdmin = false;
let allQuestions = [];
let allNotes = [];
let activeSubject = "All";
let activeNotesSubject = "All";
let searchTerm = "";
let locallyPostedAnswerIds = new Set();
let realtimeQuestionsChannel = null;
let realtimeNotesChannel = null;
let realtimeAnswersChannel = null;
let realtimePollsChannel = null;
let initPromise = null;
let notesListObserver = null;
let driveSyncPromise = null;
let activeNoteUploadXhr = null;
let noteUploadCancelRequested = false;
let sessionHeartbeat = null;

const loginModal = document.getElementById("login-modal");
const welcomePage = document.getElementById("welcome-page");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const changeNameModal = document.getElementById("change-name-modal");
const changeNameForm = document.getElementById("change-name-form");
const loginMessage = document.getElementById("login-message");
const adminPanel = document.querySelector(".admin-panel");
const questionSection = document.querySelector(".ask-section");

function syncUploadSourceUI() {
  const localSource = document.querySelector("input[name='uploadSource'][value='local']");
  const driveSource = document.getElementById("drive-source-option");
  const fileInput = document.getElementById("note-file-input");
  const driveLinkInput = document.getElementById("drive-link-input");
  if (!localSource || !driveSource || !fileInput || !driveLinkInput) return;

  const isDriveAllowed = isLoggedIn && isAdmin;
  driveSource.disabled = !isDriveAllowed;
  if (!isDriveAllowed && driveSource.checked) localSource.checked = true;

  const isDriveSource = driveSource.checked && isDriveAllowed;
  fileInput.hidden = isDriveSource;
  fileInput.required = !isDriveSource;
  fileInput.disabled = !isLoggedIn;
  driveLinkInput.hidden = !isDriveSource;
  driveLinkInput.required = isDriveSource;
  driveLinkInput.disabled = !isDriveAllowed;
}

const FOCUS_ACTIVITY_KEY = "classPortal.studentFocusActivity";

function getFocusActivityMap() {
  try {
    const raw = localStorage.getItem(FOCUS_ACTIVITY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error("Unable to read focus activity.", error);
    return {};
  }
}

function getCurrentStudentFocusState() {
  const currentRollNo = String(activeSession?.roll_number || activeSession?.rollNo || "anonymous").trim();
  const stateMap = getFocusActivityMap();
  const current = stateMap[currentRollNo] || {
    dailyLogins: 0,
    notes: 0,
    questions: 0,
    answers: 0,
    votes: 0,
    lastLoginDate: ""
  };
  return { currentRollNo, stateMap, current };
}

function persistFocusActivity(nextState) {
  if (!nextState || !nextState.currentRollNo) return;
  const stateMap = getFocusActivityMap();
  stateMap[nextState.currentRollNo] = nextState.current;
  localStorage.setItem(FOCUS_ACTIVITY_KEY, JSON.stringify(stateMap));
}

function trackStudentActivity(type) {
  const { currentRollNo, stateMap, current } = getCurrentStudentFocusState();
  if (!currentRollNo || currentRollNo === "anonymous") return;

  const today = new Date().toISOString().slice(0, 10);
  if (type === "login") {
    if (current.lastLoginDate !== today) {
      current.dailyLogins = Number(current.dailyLogins || 0) + 1;
    }
    current.lastLoginDate = today;
  } else if (type === "note") {
    current.notes = Number(current.notes || 0) + 1;
  } else if (type === "question") {
    current.questions = Number(current.questions || 0) + 1;
  } else if (type === "answer") {
    current.answers = Number(current.answers || 0) + 1;
  } else if (type === "vote") {
    current.votes = Number(current.votes || 0) + 1;
  }

  stateMap[currentRollNo] = current;
  localStorage.setItem(FOCUS_ACTIVITY_KEY, JSON.stringify(stateMap));
  renderFocusScore();
}

function calculateStudentFocusScore() {
  const { currentRollNo, current } = getCurrentStudentFocusState();
  if (!currentRollNo || currentRollNo === "anonymous") return 42;

  const score = Math.min(96, 22 + (Number(current.dailyLogins || 0) * 18) + (Number(current.notes || 0) * 12) + (Number(current.questions || 0) * 15) + (Number(current.answers || 0) * 10) + (Number(current.votes || 0) * 8));
  return Math.max(20, score);
}

function renderFocusScore() {
  const orbit = document.querySelector(".progress-orbit .progress-inner");
  if (!orbit) return;

  const score = calculateStudentFocusScore();
  let label = "steady focus";
  if (score >= 80) label = "strong focus";
  else if (score >= 60) label = "steady focus";
  else if (score >= 40) label = "building focus";
  else label = "needs reset";

  orbit.innerHTML = `<strong>${score}%</strong><span>${label}</span>`;
  orbit.setAttribute("aria-label", `Personal focus score: ${score} percent`);
}

function updateUIState(loggedIn) {
  isLoggedIn = loggedIn;
  if (adminPanel) adminPanel.hidden = !isAdmin;
  document.querySelectorAll(".reply-button, .reply-form input").forEach((control) => {
    control.disabled = !loggedIn;
    if (control.matches(".reply-button")) {
      control.textContent = loggedIn ? "Post Reply" : "Login to reply...";
      control.title = loggedIn ? "Post a reply" : "Log in to participate.";
    } else {
      control.placeholder = loggedIn ? "Write an answer..." : "Login to reply...";
    }
  });
  const uploadForm = document.getElementById("upload-notes-form");
  if (uploadForm) {
    uploadForm.querySelectorAll("input, button").forEach((control) => {
      control.disabled = !loggedIn;
      control.title = loggedIn ? "Upload notes or documents" : "Log in to participate.";
    });
    syncUploadSourceUI();
  }
  const postQuestionButton = document.getElementById("post-question-button");
  if (postQuestionButton) postQuestionButton.disabled = !loggedIn;
  document.querySelectorAll("#poll-create-form input, #poll-create-form button").forEach((control) => {
    control.disabled = !loggedIn;
  });
  const profile = document.getElementById("user-profile");
  if (profile) profile.hidden = !loggedIn;
}

function showWelcomePage() {
  activeSession = null;
  isAdmin = false;
  appView.hidden = true;
  welcomePage.hidden = false;
  loginModal.hidden = true;
  updateUIState(false);
}

function titleCaseName(name) {
  return name.trim().replace(/\s+/g, " ").split(" ").map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

function getRollNo(record) {
  return record.rollNo || record.roll_number || record.standard || record.std || record.studentClass || "-";
}

async function releaseActiveSession(session = activeSession) {
  const currentSession = session || activeSession;
  if (!currentSession?.rollNo || currentSession.rollNo === "-") return;
  try {
    const response = await fetch(`${SUPABASE_URL}Credentials?roll_number=eq.${encodeURIComponent(currentSession.rollNo)}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ current_session_token: null }),
      keepalive: true
    });
    if (!response.ok) throw new Error(`Session release failed (${response.status}).`);
  } catch (error) {
    console.error("Unable to release the active roll number.", error);
  }
}

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "just now";
  const minutesAgo = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
  if (minutesAgo < 1) return "just now";
  if (minutesAgo < 60) return `${minutesAgo} min ago`;
  const hoursAgo = Math.floor(minutesAgo / 60);
  if (hoursAgo < 24) return `${hoursAgo} hr ago`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function subjectClass(subject) {
  return subject.toLowerCase().replace(/\s+/g, "-");
}

function renderFilteredQuestions() {
  const feed = document.getElementById("questions-feed");
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredQuestions = allQuestions.filter((item) => {
    const subject = item.subject || "General";
    const matchesSubject = activeSubject === "All" || subject === activeSubject;
    const searchableText = `${item.author_name || item.author || ""} ${subject} ${item.question_text || item.question || ""}`.toLowerCase();
    return matchesSubject && (!normalizedSearch || searchableText.includes(normalizedSearch));
  });
  feed.replaceChildren(...filteredQuestions.map(renderQuestionCard));
}

function populateSubjectOptions() {
  const questionSubject = document.getElementById("question-subject");
  const questionFilter = document.getElementById("question-subject-filter");
  const noteCategory = document.getElementById("note-category-input");
  const notesFilter = document.getElementById("notes-filter");

  SUBJECTS.forEach((subject) => {
    const questionOption = new Option(subject, subject);
    questionSubject.add(questionOption);
    questionFilter.add(new Option(subject, subject));
    noteCategory.add(new Option(subject, subject));
    notesFilter.add(new Option(subject, subject));
  });
}

async function fetchGoogleDriveNotes() {
  try {
    const query = encodeURIComponent(`'${DRIVE_FOLDER_ID}' in parents and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&key=${DRIVE_API_KEY}&fields=files(id,name,mimeType,webViewLink,webContentLink,iconLink,size)`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error("Google Drive API Error:", data.error.message);
      return [];
    }

    return (data.files || []).filter((file) => {
      if (!file || !file.name || typeof file.name !== "string") return false;
      return Boolean(file.webViewLink || file.webContentLink);
    });
  } catch (error) {
    console.error("Failed to fetch notes from Google Drive:", error);
    return [];
  }
}

async function renderGoogleDriveNotes() {
  const notesContainer = document.getElementById("google-drive-notes-container");
  if (!notesContainer) return;

  notesContainer.innerHTML = '<p style="margin: 0; color: #94a3b8; text-align: center;">Loading latest notes from Google Drive...</p>';
  const files = await fetchGoogleDriveNotes();

  if (!files.length) {
    notesContainer.innerHTML = '<p style="margin: 0; color: #94a3b8; text-align: center;">No notes found in the Drive folder yet. Drop a PDF in Google Drive to see it here!</p>';
    return;
  }

  notesContainer.innerHTML = "";
  files.forEach((file) => {
    const card = document.createElement("div");
    card.className = "note-card";
    card.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding: 14px 16px; border: 1px solid rgba(17, 94, 89, 0.12); border-radius: 12px; background: rgba(17, 94, 89, 0.04);";

    const info = document.createElement("div");
    info.style.cssText = "display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;";
    info.innerHTML = `
      <div style="display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: rgba(20, 184, 166, 0.12); color: #0f766e; font-size: 18px;">📄</div>
      <div style="min-width: 0; flex: 1;">
        <h4 style="margin: 0; color: #17222d; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${file.name}</h4>
        <small style="color: #64748b; font-size: 0.75rem;">Google Drive file</small>
      </div>
    `;

    const actions = document.createElement("div");
    actions.style.cssText = "display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap;";
    actions.innerHTML = `
      <a href="${file.webViewLink}" target="_blank" rel="noreferrer" style="padding: 8px 12px; border-radius: 8px; background: #0f766e; color: #ffffff; text-decoration: none; font-size: 0.78rem; font-weight: 700;">View</a>
      ${file.webContentLink ? `<a href="${file.webContentLink}" target="_blank" rel="noreferrer" download style="padding: 8px 12px; border-radius: 8px; background: rgba(17, 94, 89, 0.08); color: #0f766e; text-decoration: none; font-size: 0.78rem; font-weight: 700;">Download</a>` : ""}
    `;

    card.append(info, actions);
    notesContainer.appendChild(card);
  });
}

function renderNotes() {
  const notesContainer = document.getElementById("notes-list-container");
  const filteredNotes = allNotes.filter((note) => activeNotesSubject === "All" || note.subject === activeNotesSubject);
  notesContainer.replaceChildren(...filteredNotes.map(renderNoteCard));
  updateNotesCount();
}

function showMessage(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.style.color = isError ? "#c05252" : "";
}

function updateNotesCount() {
  const notesList = document.getElementById("notes-list-container");
  const notesCount = document.getElementById("notes-count");
  if (notesList && notesCount) {
    const fileCount = notesList.querySelectorAll(".note-card").length;
    notesCount.textContent = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
  }
}

function renderUser(session) {
  const nameElement = document.getElementById("user-display-name");
  const rollElement = document.getElementById("header-class");
  const welcomeElement = document.getElementById("welcome-name");
  const avatarElement = document.getElementById("header-avatar");
  if (nameElement) nameElement.textContent = session.name;
  if (rollElement) rollElement.textContent = isAdmin ? "Portal administrator" : `Roll no ${getRollNo(session)}`;
  if (welcomeElement) welcomeElement.textContent = session.name.split(" ")[0];
  if (avatarElement) avatarElement.textContent = session.name.charAt(0).toUpperCase();
  if (adminPanel) adminPanel.hidden = !isAdmin;
  if (questionSection) questionSection.hidden = String(session.role || "").toLowerCase() === "admin";
}

function getDeviceToken() {
  let token = localStorage.getItem("classPortal.deviceToken");
  if (!token) {
    token = "token_" + Math.random().toString(36).substring(2) + "_" + Date.now();
    localStorage.setItem("classPortal.deviceToken", token);
  }
  return token;
}

function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem("northstar_device_id");
  if (!deviceId) {
    deviceId = "device_" + Math.random().toString(36).substring(2, 15) + "_" + Date.now();
    localStorage.setItem("northstar_device_id", deviceId);
  }
  return deviceId;
}

function persistSession(session) {
  if (!session) return;
  const deviceId = getOrCreateDeviceId();
  const appSession = {
    name: session.name || "",
    role: session.role || "student",
    rollNo: session.rollNo || session.roll_number || "",
    roll_number: session.roll_number || session.rollNo || "",
    accessCode: session.accessCode || session.access_code || "",
    access_code: session.access_code || session.accessCode || "",
    deviceId
  };

  try {
    localStorage.setItem("northstar_session", JSON.stringify({
      roll_number: appSession.roll_number,
      access_code: appSession.access_code,
      name: appSession.name,
      role: appSession.role,
      device_id: deviceId,
      deviceId
    }));
    localStorage.setItem("northstar_auth_token", "true");
    if (appSession.roll_number) {
      localStorage.setItem("northstar_user_roll", String(appSession.roll_number));
    }
  } catch (error) {
    console.error("Unable to persist Northstar session.", error);
  }

  try {
    localStorage.setItem("classPortal.activeSession", JSON.stringify(appSession));
  } catch (error) {
    console.error("Unable to persist legacy portal session.", error);
  }
}

function clearPersistedSession() {
  try {
    localStorage.removeItem("northstar_session");
    localStorage.removeItem("northstar_auth_token");
    localStorage.removeItem("northstar_user_roll");
    localStorage.removeItem("classPortal.deviceToken");
  } catch (error) {
    console.error("Unable to clear saved portal session.", error);
  }
}

function normalizeStoredSession(rawSession) {
  if (!rawSession) return null;
  const normalized = {
    name: rawSession.name || rawSession.student_name || "",
    role: rawSession.role || "student",
    rollNo: rawSession.rollNo || rawSession.roll_number || "",
    roll_number: rawSession.roll_number || rawSession.rollNo || "",
    accessCode: rawSession.accessCode || rawSession.access_code || "",
    access_code: rawSession.access_code || rawSession.accessCode || "",
    deviceId: rawSession.deviceId || rawSession.device_id || ""
  };
  return normalized.rollNo || normalized.roll_number ? normalized : null;
}

async function showApp(session) {
  activeSession = session;
  persistSession(session);
  isAdmin = session.role?.toLowerCase() === "admin";
  renderUser(session);
  trackStudentActivity("login");
  renderFocusScore();
  welcomePage.hidden = true;
  loginModal.hidden = true;
  appView.hidden = false;
  updateUIState(true);
  subscribeToQuestionChanges();
  subscribeToAnswerChanges();
  subscribeToNoteChanges();
  subscribeToPollChanges();
  await Promise.all([renderCodes(), fetchQuestions(), fetchNotes(), fetchPolls()]);
}

async function bypassLoginToDashboard(session) {
  const rawSession = normalizeStoredSession(session);
  const rollNo = rawSession?.rollNo || rawSession?.roll_number;
  const accessCode = rawSession?.accessCode || rawSession?.access_code;
  const savedDeviceId = localStorage.getItem("northstar_device_id") || getOrCreateDeviceId();
  const sessionDeviceId = rawSession?.deviceId || rawSession?.device_id || "";

  if (!rollNo || !accessCode) return false;
  if (sessionDeviceId && savedDeviceId && sessionDeviceId !== savedDeviceId) {
    clearPersistedSession();
    return false;
  }

  try {
    const verifiedSession = await login(String(rollNo), String(accessCode), false);
    if (!verifiedSession || verifiedSession.occupied) return false;
    persistSession(verifiedSession);
    await showApp(verifiedSession);
    return true;
  } catch (error) {
    console.error("Unable to auto-restore the saved portal session.", error);
    return false;
  }
}

async function autoLoginFromStoredToken() {
  const authToken = localStorage.getItem("northstar_auth_token");
  const storedRollNo = localStorage.getItem("northstar_user_roll");
  if (!authToken || !storedRollNo) return false;

  const storedSession = localStorage.getItem("northstar_session");
  if (storedSession) {
    try {
      const parsedSession = JSON.parse(storedSession);
      const bypassed = await bypassLoginToDashboard(parsedSession);
      if (bypassed) return true;
    } catch (error) {
      console.error("Unable to parse the stored Northstar auth session.", error);
    }
  }

  try {
    const { data: credential, error } = await supabaseClient
      .from("Credentials")
      .select("access_code, role, student_name, roll_number, current_session_token")
      .eq("roll_number", storedRollNo)
      .maybeSingle();

    if (error || !credential) {
      clearPersistedSession();
      return false;
    }

    const currentDeviceToken = getDeviceToken();
    if (credential.current_session_token && credential.current_session_token !== currentDeviceToken) {
      clearPersistedSession();
      return false;
    }

    const verifiedSession = await login(String(storedRollNo), String(credential.access_code), false);
    if (!verifiedSession || verifiedSession.occupied) {
      clearPersistedSession();
      return false;
    }

    persistSession(verifiedSession);
    await showApp(verifiedSession);
    return true;
  } catch (error) {
    console.error("Unable to auto-login from stored auth token.", error);
    return false;
  }
}

async function restoreSavedSession() {
  const rawNorthstarSession = localStorage.getItem("northstar_session");
  const legacySession = localStorage.getItem("classPortal.activeSession");
  const savedSession = rawNorthstarSession || legacySession;
  let storedSession;
  try {
    storedSession = savedSession ? JSON.parse(savedSession) : null;
  } catch (error) {
    console.error("Unable to parse saved session.", error);
    return null;
  }

  const normalizedSession = normalizeStoredSession(storedSession);
  const rollNo = normalizedSession?.rollNo || normalizedSession?.roll_number;
  if (!rollNo) return null;

  const myToken = getDeviceToken();
  const { data: credential, error } = await supabaseClient
    .from("Credentials")
    .select("access_code, role, student_name, roll_number, current_session_token")
    .eq("roll_number", rollNo)
    .maybeSingle();

  if (error) {
    console.error("Unable to restore the Credentials session.", error);
    return null;
  }
  if (!credential) return null;
  if (credential.current_session_token && credential.current_session_token !== myToken) return { securityConflict: true };

  const { data: claimedRows, error: claimError } = await supabaseClient
    .from("Credentials")
    .update({ current_session_token: myToken })
    .eq("roll_number", rollNo)
    .select("roll_number");
  if (claimError) throw claimError;
  if (!claimedRows?.length) return { securityConflict: true };

  const session = {
    name: titleCaseName(credential.student_name?.trim() || `Student ${credential.roll_number}`),
    role: credential.role || "student",
    rollNo: credential.roll_number,
    accessCode: credential.access_code
  };
  localStorage.setItem("classPortal.activeSession", JSON.stringify(session));
  return session;
}

async function login(rollNo, accessCode, force = false) {
  const normalizedCode = accessCode.trim().toUpperCase();
  const myToken = getDeviceToken();
  const { data: accessCodeRecord, error } = await supabaseClient
    .from("Credentials")
    .select("access_code, role, student_name, roll_number, current_session_token")
    .eq("access_code", normalizedCode)
    .eq("roll_number", rollNo)
    .maybeSingle();

  if (error) throw error;
  if (!accessCodeRecord) return null;

  const isOccupiedByOther = Boolean(accessCodeRecord.current_session_token && accessCodeRecord.current_session_token !== myToken);
  if (isOccupiedByOther && !force) return { occupied: true };

  const { data: claimedRows, error: claimError } = await supabaseClient
    .from("Credentials")
    .update({ current_session_token: myToken })
    .eq("access_code", normalizedCode)
    .eq("roll_number", rollNo)
    .select("roll_number");
  if (claimError) throw claimError;
  if (!claimedRows?.length) return { occupied: true };

  return {
    name: titleCaseName(accessCodeRecord.student_name?.trim() || `Student ${accessCodeRecord.roll_number || rollNo}`),
    role: accessCodeRecord.role || "student",
    rollNo: accessCodeRecord.roll_number || rollNo || "-",
    accessCode: accessCodeRecord.access_code
  };
}

async function isStudentNameTaken(customName, currentRollNo) {
  const { data: matches, error } = await supabaseClient
    .from("Credentials")
    .select("roll_number")
    .ilike("student_name", customName)
    .limit(20);
  if (error) throw error;
  return matches.some((record) => String(record.roll_number) !== String(currentRollNo));
}

async function renderCodes() {
  const codeList = document.getElementById("code-list");
  const { data: codes, error } = await supabaseClient
    .from("Credentials")
    .select("access_code, role")
    .order("created_at", { ascending: false });

  if (error) {
    codeList.replaceChildren();
    showMessage(document.getElementById("code-count"), "Unable to load codes", true);
    return;
  }

  codeList.replaceChildren();
  codes.forEach((codeRecord) => {
    const item = document.createElement("li");
    const codeElement = document.createElement("code");
    const status = document.createElement("span");
    codeElement.textContent = codeRecord.access_code;
    status.textContent = codeRecord.role === "admin" ? "Admin" : "Active now";
    item.append(codeElement, status);
    codeList.append(item);
  });
  const codeCount = document.getElementById("code-count");
  if (codeCount) codeCount.textContent = `${codes.length} active`;
}

function renderAnswerCard(answer) {
  const card = document.createElement("article");
  const metadata = document.createElement("div");
  const author = document.createElement("strong");
  const roleBadge = document.createElement("span");
  const time = document.createElement("time");
  const text = document.createElement("p");

  card.className = "answer-card";
  metadata.className = "answer-card-meta";
  author.textContent = answer.answered_by || "Student";
  roleBadge.className = "note-role-badge";
  roleBadge.textContent = answer.author_role === "admin" ? "Admin" : "Student";
  time.textContent = formatTimestamp(answer.created_at);
  text.textContent = answer.answer_text || "";
  metadata.append(author, roleBadge, time);
  card.append(metadata, text);
  return card;
}

async function fetchAnswersForQuestion(questionId) {
  const answersContainer = document.getElementById(`answers-for-${questionId}`);
  if (!answersContainer) return;

  const { data: answers, error } = await supabaseClient
    .from("answers")
    .select("*")
    .eq("doubt_id", questionId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Unable to load answers for question.", error);
    return;
  }

  answersContainer.replaceChildren(...answers.map(renderAnswerCard));
}

async function postReply(questionId) {
  const replyInput = document.getElementById(`reply-input-${questionId}`);
  const replyButton = document.getElementById(`reply-btn-${questionId}`);
  const answerText = replyInput?.value.trim();
  if (!answerText || !activeSession || !isLoggedIn) return;

  replyButton.disabled = true;
  const { data: insertedAnswers, error } = await supabaseClient
    .from("answers")
    .insert({
      doubt_id: questionId,
      answer_text: answerText,
      answered_by: activeSession.name,
      author_role: isAdmin ? "admin" : "student"
    })
    .select("id");

  if (error) {
    console.error("Unable to post reply.", error);
    window.alert(error.message || "Unable to post reply.");
  } else {
    insertedAnswers?.forEach((answer) => locallyPostedAnswerIds.add(answer.id));
    replyInput.value = "";
    await fetchAnswersForQuestion(questionId);
  }
  replyButton.disabled = false;
}

function renderReplySection(body, question) {
  const questionId = question.id || `question-${Date.now()}`;
  const answersList = document.createElement("div");
  const replyForm = document.createElement("form");
  const replyInput = document.createElement("input");
  const replyButton = document.createElement("button");

  answersList.className = "answers-list";
  answersList.id = `answers-for-${questionId}`;
  replyForm.className = "reply-form";
  replyInput.id = `reply-input-${questionId}`;
  replyInput.type = "text";
  replyInput.placeholder = isLoggedIn ? "Write an answer..." : "Login to reply...";
  replyInput.required = true;
  replyInput.disabled = !isLoggedIn;
  replyButton.id = `reply-btn-${questionId}`;
  replyButton.className = "reply-button button button-outline";
  replyButton.type = "submit";
  replyButton.textContent = isLoggedIn ? "Post Reply" : "Login to reply...";
  replyButton.disabled = !isLoggedIn;
  replyButton.title = isLoggedIn ? "Post a reply" : "Log in to participate.";

  replyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isLoggedIn) {
      window.alert("Please log in to participate.");
      return;
    }
    void postReply(questionId);
  });

  replyForm.append(replyInput, replyButton);
  body.append(answersList, replyForm);
  void fetchAnswersForQuestion(questionId);
}

async function resolveUploaderName(note) {
  const directName = note.uploaded_by || note.uploader_name || note.student_name || note.author_name || "";
  if (directName) return directName;

  const rollNumber = note.roll_number || note.rollNo;
  if (!rollNumber || String(rollNumber).trim() === "" || String(rollNumber).toLowerCase() === "admin") return "Portal member";

  const { data, error } = await supabaseClient
    .from("Credentials")
    .select("student_name")
    .eq("roll_number", rollNumber)
    .maybeSingle();

  if (error) {
    console.error("Unable to resolve note uploader name.", error);
    return "Portal member";
  }

  return data?.student_name || "Portal member";
}

function canDeleteNote(note) {
  if (isAdmin) return true;
  const currentRollNo = activeSession?.rollNo;
  return Boolean(currentRollNo) && String(note.roll_number || "") === String(currentRollNo);
}

function renderNoteCard(note) {
  const card = document.createElement("article");
  const title = document.createElement("h4");
  const metadata = document.createElement("div");
  const uploader = document.createElement("span");
  const roleBadge = document.createElement("span");
  const link = document.createElement("a");
  const deleteButton = document.createElement("button");

  card.className = "note-card";
  title.textContent = note.title || "Untitled note";
  metadata.className = "note-card-meta";
  const uploaderName = note.uploaded_by || note.uploader_name || note.student_name || note.author_name || note.roll_number || "Portal member";
  uploader.textContent = `Uploaded by: ${uploaderName}`;
  roleBadge.className = "note-role-badge";
  roleBadge.textContent = String(note.role || "student").toLowerCase() === "admin" ? "Admin" : "Student";
  metadata.append(uploader, roleBadge);
  if (note.subject) {
    const subjectBadge = document.createElement("span");
    subjectBadge.className = "note-role-badge note-subject-badge";
    subjectBadge.textContent = note.subject;
    metadata.append(subjectBadge);
  }
  link.className = "note-card-link";
  link.href = `https://docs.google.com/viewer?url=${encodeURIComponent(note.file_url)}&embedded=true`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View PDF";
  deleteButton.className = "button button-outline delete-note-button";
  deleteButton.type = "button";
  deleteButton.textContent = "Delete Note";
  const canDelete = canDeleteNote(note);
  deleteButton.disabled = !canDelete;
  deleteButton.title = canDelete ? "Delete this note" : "Only the uploader or an admin can delete this note";
  deleteButton.addEventListener("click", () => void deleteNote(note, card));
  card.append(title, metadata, link, deleteButton);
  return card;
}

function getNotesStoragePath(fileUrl) {
  try {
    const pathname = new URL(fileUrl).pathname;
    const match = pathname.match(/\/storage\/v1\/object\/(?:public|sign)\/notes-bucket\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch (error) {
    return null;
  }
}

async function deleteNote(note, card) {
  if (!canDeleteNote(note)) {
    window.alert("Only the uploader or an admin can delete this note.");
    return;
  }
  if (!window.confirm("Are you sure you want to delete this note?")) return;

  const deleteButton = card.querySelector(".delete-note-button");
  deleteButton.disabled = true;
  try {
    const storagePath = getNotesStoragePath(note.file_url);
    if (storagePath) {
      const { error: storageError } = await supabaseClient.storage
        .from("notes-bucket")
        .remove([storagePath]);
      if (storageError) throw storageError;
    }

    const { error: databaseError } = await supabaseClient
      .from("notes")
      .delete()
      .eq("id", note.id);
    if (databaseError) throw databaseError;

    card.remove();
    updateNotesCount();
  } catch (error) {
    console.error("Unable to delete note.", error);
    window.alert(error.message || "Unable to delete note.");
    deleteButton.disabled = false;
  }
}

async function fetchNotes() {
  const notesContainer = document.getElementById("notes-list-container");
  if (!notesContainer) return;

  await syncAdminDriveFolder();

  const { data: notes, error } = await supabaseClient
    .from("notes")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    notesContainer.replaceChildren();
    showMessage(document.getElementById("upload-message"), "Unable to load notes.", true);
    return;
  }

  const enrichedNotes = await Promise.all(notes.map(async (note) => {
    const resolvedName = await resolveUploaderName(note);
    return { ...note, uploaded_by: note.uploaded_by || resolvedName };
  }));

  allNotes = enrichedNotes;
  renderNotes();
}

function addPollOptionInput(value = "") {
  const optionsContainer = document.getElementById("poll-option-inputs");
  if (optionsContainer.children.length >= 4) return;

  const row = document.createElement("div");
  const input = document.createElement("input");
  const removeButton = document.createElement("button");
  row.className = "poll-option-row";
  input.type = "text";
  input.name = "pollOption";
  input.className = "poll-option-input";
  input.placeholder = `Option ${optionsContainer.children.length + 1}`;
  input.value = value;
  input.required = true;
  removeButton.type = "button";
  removeButton.className = "button button-outline remove-poll-option";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => {
    if (optionsContainer.children.length <= 2) return;
    row.remove();
    updatePollOptionControls();
  });
  row.append(input, removeButton);
  optionsContainer.append(row);
  updatePollOptionControls();
}

function updatePollOptionControls() {
  const optionsContainer = document.getElementById("poll-option-inputs");
  const addButton = document.getElementById("add-poll-option");
  const optionRows = [...optionsContainer.querySelectorAll(".poll-option-row")];
  addButton.disabled = optionRows.length >= 4;
  optionRows.forEach((row) => {
    row.querySelector(".remove-poll-option").disabled = optionRows.length <= 2;
  });
}

function initializePollCreator() {
  const optionsContainer = document.getElementById("poll-option-inputs");
  if (!optionsContainer || optionsContainer.children.length) return;
  addPollOptionInput();
  addPollOptionInput();
  document.getElementById("add-poll-option").addEventListener("click", () => addPollOptionInput());

  document.getElementById("poll-create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isLoggedIn || !activeSession) {
      window.alert("Please login to create a poll.");
      return;
    }

    const form = event.currentTarget;
    const submitButton = form.querySelector("button[type='submit']");
    const question = document.getElementById("poll-question-input").value.trim();
    const options = [...optionsContainer.querySelectorAll(".poll-option-input")]
      .map((input) => input.value.trim())
      .filter(Boolean);
    if (options.length < 2 || options.length > 4) {
      showMessage(document.getElementById("poll-create-message"), "A poll needs 2 to 4 options.", true);
      return;
    }

    submitButton.disabled = true;
    try {
      const creatorRollNumber = String(activeSession?.roll_number || activeSession?.rollNo || "anonymous").trim();
      if (!creatorRollNumber || creatorRollNumber === "" || creatorRollNumber === "anonymous") {
        window.alert("Session expired. Please log in again.");
        return;
      }

      const pollPayload = {
        question,
        created_by: String(creatorRollNumber)
      };

      const { data: poll, error: pollError } = await supabaseClient
        .from("polls")
        .insert(pollPayload)
        .select("poll_id")
        .single();
      if (pollError) {
        console.error("Poll insert error payload:", pollError);
        throw pollError;
      }

      const { error: optionsError } = await supabaseClient
        .from("poll_options")
        .insert(options.map((optionText) => ({ poll_id: poll.poll_id, option_text: optionText, vote_count: 0 })));
      if (optionsError) {
        console.error("Poll option insert error payload:", optionsError);
        await supabaseClient.from("polls").delete().eq("poll_id", poll.poll_id);
        throw optionsError;
      }

      form.reset();
      optionsContainer.replaceChildren();
      addPollOptionInput();
      addPollOptionInput();
      showMessage(document.getElementById("poll-create-message"), "Poll created.");
      await fetchPolls();
    } catch (error) {
      console.error("Unable to create poll.", error);
      showMessage(document.getElementById("poll-create-message"), error.message || "Unable to create poll.", true);
    } finally {
      submitButton.disabled = false;
      updateUIState(isLoggedIn);
    }
  });
}

function renderPollCard(poll, options, userVote) {
  const card = document.createElement("article");
  const question = document.createElement("h4");
  card.className = "poll-card";
  question.textContent = poll.question || poll.question_text || "Poll";
  card.append(question);

  if (userVote) {
    const results = document.createElement("div");
    results.className = "poll-results";
    const totalVotes = options.reduce((total, option) => total + Number(option.vote_count || 0), 0);
    options.forEach((option) => {
      const row = document.createElement("div");
      const metadata = document.createElement("div");
      const label = document.createElement("strong");
      const count = document.createElement("span");
      const track = document.createElement("div");
      const fill = document.createElement("div");
      const votes = Number(option.vote_count || 0);
      const percentage = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
      row.className = `poll-result-row${String(userVote.option_id) === String(option.id) ? " is-voted" : ""}`;
      metadata.className = "poll-result-meta";
      label.textContent = option.option_text || option.text || "Option";
      count.textContent = `${percentage}% · ${votes} ${votes === 1 ? "vote" : "votes"}`;
      track.className = "poll-result-track";
      fill.className = "poll-result-fill";
      fill.style.width = "0%";
      requestAnimationFrame(() => { fill.style.width = `${percentage}%`; });
      track.append(fill);
      metadata.append(label, count);
      row.append(metadata, track);
      results.append(row);
    });
    card.append(results);
    return card;
  }

  const optionsForm = document.createElement("form");
  const choices = document.createElement("div");
  const voteButton = document.createElement("button");
  optionsForm.className = "poll-vote-form";
  choices.className = "poll-vote-options";
  options.forEach((option, index) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    const optionText = document.createElement("span");
    label.className = "poll-vote-option";
    input.type = "radio";
    input.name = `poll-choice-${poll.poll_id}`;
    input.value = String(option.id ?? "");
    input.required = true;
    input.disabled = !isLoggedIn;
    optionText.textContent = option.option_text || option.text || `Option ${index + 1}`;
    label.append(input, optionText);
    choices.append(label);
  });
  voteButton.className = "button button-primary";
  voteButton.type = "submit";
  voteButton.textContent = "Vote";
  voteButton.disabled = !isLoggedIn;
  voteButton.title = isLoggedIn ? "Submit your vote" : "Log in to vote";
  optionsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = choices.querySelector("input:checked");
    if (selected) void voteInPoll(poll, selected.value, voteButton);
  });
  optionsForm.append(choices, voteButton);
  card.append(optionsForm);
  return card;
}

async function fetchPolls() {
  const pollList = document.getElementById("polls-list");
  const { data: polls, error: pollsError } = await supabaseClient
    .from("polls")
    .select("*")
    .order("created_at", { ascending: false });
  if (pollsError) {
    console.error("Unable to fetch polls.", pollsError);
    showMessage(document.getElementById("poll-create-message"), "Unable to load polls.", true);
    return;
  }
  if (!polls.length) {
    pollList.replaceChildren();
    return;
  }

  const pollIds = polls.map((poll) => poll.poll_id);
  const { data: options, error: optionsError } = await supabaseClient
    .from("poll_options")
    .select("*")
    .in("poll_id", pollIds);
  if (optionsError) {
    console.error("Unable to fetch poll options.", optionsError);
    return;
  }

  let votes = [];
  const rollNo = activeSession?.rollNo;
  if (isLoggedIn && rollNo && rollNo !== "-") {
    const { data: userVotes, error: votesError } = await supabaseClient
      .from("poll_votes")
      .select("poll_id, option_id")
      .eq("roll_number", String(rollNo))
      .in("poll_id", pollIds);
    if (votesError) console.error("Unable to fetch poll votes.", votesError);
    else votes = userVotes;
  }

  pollList.replaceChildren(...polls.map((poll) => renderPollCard(
    poll,
    options.filter((option) => String(option.poll_id) === String(poll.poll_id)),
    votes.find((vote) => String(vote.poll_id) === String(poll.poll_id))
  )));
}

async function voteInPoll(poll, optionId, voteButton) {
  const rollNo = activeSession?.roll_number || activeSession?.rollNo;
  if (!isLoggedIn || !rollNo || rollNo === "-" || !optionId || String(optionId) === "undefined") {
    window.alert("Please log in with your Roll Number to vote.");
    return;
  }
  voteButton.disabled = true;
  let voteRecorded = false;
  try {
    const sanitizedOptionId = Number(optionId);
    if (!Number.isFinite(sanitizedOptionId)) {
      throw new Error("Poll option ID is invalid.");
    }

    const { error: voteError } = await supabaseClient
      .from("poll_votes")
      .insert({ poll_id: poll.poll_id, roll_number: String(rollNo), option_id: sanitizedOptionId });
    if (voteError) throw voteError;
    voteRecorded = true;

    const { data: option, error: optionError } = await supabaseClient
      .from("poll_options")
      .select("vote_count")
      .eq("id", sanitizedOptionId)
      .single();
    if (optionError) throw optionError;

    const { error: updateError } = await supabaseClient
      .from("poll_options")
      .update({ vote_count: Number(option.vote_count || 0) + 1 })
      .eq("id", sanitizedOptionId);
    if (updateError) throw updateError;
    await fetchPolls();
  } catch (error) {
    console.error("Unable to submit poll vote.", error);
    window.alert(error.message || "Unable to submit your vote.");
    if (voteRecorded) await fetchPolls();
    else voteButton.disabled = false;
  }
}

function subscribeToPollChanges() {
  if (realtimePollsChannel) return realtimePollsChannel;
  realtimePollsChannel = supabaseClient
    .channel("realtime-polls")
    .on("postgres_changes", { event: "*", schema: "public", table: "poll_options" }, () => fetchPolls())
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.error("Unable to subscribe to poll updates.");
    });
  return realtimePollsChannel;
}

async function syncAdminDriveFolder() {
  if (!isAdmin) return;
  if (driveSyncPromise) return driveSyncPromise;

  driveSyncPromise = (async () => {
    const driveQuery = `'${DRIVE_FOLDER_ID}'+in+parents+and+mimeType='application/pdf'+and+trashed=false`;
    const driveUrl = `https://www.googleapis.com/drive/v3/files?q=${driveQuery}&key=${DRIVE_API_KEY}&fields=files(id,name,webViewLink)`;
    const response = await fetch(driveUrl);
    if (!response.ok) throw new Error(`Google Drive request failed (${response.status}).`);
    const { files = [] } = await response.json();
    let addedCount = 0;

    for (const file of files) {
      const fileUrl = `https://drive.google.com/file/d/${file.id}/view`;
      const { data: titleMatches, error: titleLookupError } = await supabaseClient
        .from("notes")
        .select("id")
        .eq("title", file.name)
        .limit(1);

      if (titleLookupError) throw titleLookupError;
      if (titleMatches?.length) continue;

      const { data: urlMatches, error: urlLookupError } = await supabaseClient
        .from("notes")
        .select("id")
        .eq("file_url", fileUrl)
        .limit(1);

      if (urlLookupError) throw urlLookupError;
      if (urlMatches?.length) continue;

      const { error: insertError } = await supabaseClient
        .from("notes")
        .insert({
          title: file.name,
          file_url: fileUrl,
          subject: "General",
          roll_number: "admin",
          role: "admin"
        });
      if (insertError) throw insertError;
      addedCount += 1;
    }

    return addedCount;
  })().catch((error) => {
    console.error("Unable to sync Admin notes from Drive.", error);
  }).finally(() => {
    driveSyncPromise = null;
  });

  return driveSyncPromise;
}

function renderQuestionCard(item) {
  const card = document.createElement("article");
  const avatar = document.createElement("div");
  const body = document.createElement("div");
  const metadata = document.createElement("div");
  const author = document.createElement("strong");
  const time = document.createElement("span");
  const question = document.createElement("p");
  const answers = document.createElement("div");
  const badge = document.createElement("span");
  const subject = item.subject || "General";

  card.className = "question-card";
  avatar.className = "feed-avatar blue";
  avatar.textContent = (item.author_name || item.author || "S").charAt(0).toUpperCase();
  body.className = "question-body";
  metadata.className = "question-meta";
  author.textContent = item.author_name || item.author || "Student";
  time.textContent = `Roll no ${getRollNo(item)} · ${formatTimestamp(item.created_at || item.timestamp)}`;
  question.textContent = item.question_text || item.question || "";
  answers.className = "answer-count";
  answers.textContent = `↩ ${item.answers ? `${item.answers} answers` : "Awaiting answers"}`;
  badge.className = `subject-badge ${subjectClass(subject)}`;
  badge.textContent = subject.charAt(0);
  metadata.append(author, time);
  body.append(badge, metadata, question, answers);
  renderReplySection(body, item);
  card.append(avatar, body);
  return card;
}

async function fetchQuestions() {
  const feed = document.getElementById("questions-feed");
  const { data: questions, error } = await supabaseClient
    .from("questions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    feed.replaceChildren();
    showMessage(document.getElementById("feed-title"), "Questions feed unavailable", true);
    return;
  }

  allQuestions = questions;
  renderFilteredQuestions();
}

function subscribeToQuestionChanges() {
  if (realtimeQuestionsChannel) return realtimeQuestionsChannel;
  realtimeQuestionsChannel = supabaseClient
    .channel("realtime-questions")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "questions" },
      () => fetchQuestions()
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") {
        console.error("Unable to subscribe to question updates.");
      }
    });
  return realtimeQuestionsChannel;
}

function subscribeToAnswerChanges() {
  if (realtimeAnswersChannel) return realtimeAnswersChannel;
  realtimeAnswersChannel = supabaseClient
    .channel("realtime-answers")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "answers" },
      (payload) => {
        const answerId = payload.new?.id;
        if (answerId && locallyPostedAnswerIds.has(answerId)) {
          locallyPostedAnswerIds.delete(answerId);
          return;
        }
        if (payload.new?.doubt_id) void fetchAnswersForQuestion(payload.new.doubt_id);
      }
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.error("Unable to subscribe to answer updates.");
    });
  return realtimeAnswersChannel;
}

function subscribeToNoteChanges() {
  if (realtimeNotesChannel) return realtimeNotesChannel;
  realtimeNotesChannel = supabaseClient
    .channel("realtime-notes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "notes" },
      () => {
        void fetchNotes();
      }
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.error("Unable to subscribe to note updates.");
    });
  return realtimeNotesChannel;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = loginForm.querySelector("button[type='submit']");
  const formData = new FormData(loginForm);
  const rollNo = String(formData.get("rollNo") || "").trim();
  submitButton.disabled = true;
  showMessage(loginMessage, "Checking access...");

  try {
    const session = await login(rollNo, formData.get("accessCode"));
    if (session?.occupied) {
      showMessage(loginMessage, "This Roll Number is already logged in on another device.", true);
      const forceButton = document.createElement("button");
      forceButton.type = "button";
      forceButton.className = "button button-outline force-session-button";
      forceButton.textContent = "Force Logout Other Device";
      forceButton.addEventListener("click", async () => {
        forceButton.disabled = true;
        try {
          const forcedSession = await login(rollNo, formData.get("accessCode"), true);
          if (!forcedSession || forcedSession.occupied) throw new Error("Unable to claim this Roll Number.");
          persistSession(forcedSession);
          loginForm.reset();
          showMessage(loginMessage, "");
          await showApp(forcedSession);
        } catch (error) {
          console.error("Unable to override the previous Roll Number session.", error);
          window.alert(error.message || "Unable to log out the other device.");
          forceButton.disabled = false;
        }
      });
      loginMessage.append(document.createTextNode(" "), forceButton);
      return;
    }
    if (!session) {
      showMessage(loginMessage, "That access code was not found.", true);
      return;
    }
    persistSession(session);
    loginForm.reset();
    showMessage(loginMessage, "");
    await showApp(session);
  } catch (error) {
    showMessage(loginMessage, error.message || "Unable to verify your Roll Number and Access Code.", true);
    console.error(error);
  } finally {
    submitButton.disabled = false;
  }
});

function openLoginModal() {
  loginModal.hidden = false;
  document.getElementById("roll-no").focus();
}

document.getElementById("open-login-button").addEventListener("click", (event) => {
  event.preventDefault();
  openLoginModal();
});
document.getElementById("welcome-login-button").addEventListener("click", openLoginModal);

const passwordToggleButton = document.getElementById("toggle-password-visibility");
const passwordInput = document.getElementById("access-code");
if (passwordToggleButton && passwordInput) {
  passwordToggleButton.addEventListener("click", () => {
    const isHidden = passwordInput.type === "password";
    passwordInput.type = isHidden ? "text" : "password";
    passwordToggleButton.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    passwordToggleButton.setAttribute("aria-pressed", String(isHidden));
    passwordToggleButton.innerHTML = isHidden ? '<span aria-hidden="true">🙈</span>' : '<span aria-hidden="true">👁</span>';
  });
}

const dashboardTabs = document.querySelectorAll(".dashboard-tab");
const dashboardPanels = document.querySelectorAll(".dashboard-panel");

dashboardTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const targetPanel = tab.dataset.panel;
    dashboardTabs.forEach((item) => {
      const isActive = item === tab;
      item.classList.toggle("is-active", isActive);
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-selected", String(isActive));
    });
    dashboardPanels.forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === targetPanel);
    });
  });
});

document.querySelectorAll(".accordion-toggle").forEach((toggleButton) => {
  toggleButton.addEventListener("click", () => {
    const isExpanded = toggleButton.getAttribute("aria-expanded") === "true";
    const targetForm = toggleButton.nextElementSibling;

    if (!targetForm) return;

    const willExpand = !isExpanded;
    toggleButton.setAttribute("aria-expanded", String(willExpand));
    toggleButton.querySelector(".accordion-plus").textContent = willExpand ? "−" : "+";
    targetForm.classList.toggle("is-collapsed", !willExpand);
  });
});
document.getElementById("close-login").addEventListener("click", () => {
  loginModal.hidden = true;
});

document.getElementById("change-name-button").addEventListener("click", () => {
  if (!activeSession) return;
  document.getElementById("profile-name-input").value = activeSession.name || "";
  changeNameModal.hidden = false;
});

document.getElementById("close-name-modal").addEventListener("click", () => {
  changeNameModal.hidden = true;
});

changeNameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeSession) return;
  const input = document.getElementById("profile-name-input");
  const message = document.getElementById("change-name-message");
  const customName = input.value.trim();
  if (!customName) return;

  const submitButton = changeNameForm.querySelector("button[type='submit']");
  submitButton.disabled = true;
  try {
    if (await isStudentNameTaken(customName, activeSession.rollNo)) {
      window.alert("This name is already in use. Please choose a different display name.");
      showMessage(message, "Choose a different display name.", true);
      return;
    }

    const { error } = await supabaseClient
      .from("Credentials")
      .update({ student_name: customName })
      .eq("roll_number", activeSession.rollNo);
    if (error) throw error;

    activeSession.name = titleCaseName(customName);
    localStorage.setItem("classPortal.activeSession", JSON.stringify(activeSession));
    changeNameForm.reset();
    renderUser(activeSession);
    changeNameModal.hidden = true;
  } catch (error) {
    console.error("Unable to update display name.", error);
    showMessage(message, error.message || "Unable to update display name.", true);
  } finally {
    submitButton.disabled = false;
  }
});

const logoutButton = document.getElementById("logout-button");
const floatingLogoutButton = document.getElementById("floating-logout-button");

async function performLogout() {
  await releaseActiveSession();
  if (sessionHeartbeat) clearInterval(sessionHeartbeat);
  sessionHeartbeat = null;
  activeSession = null;
  isAdmin = false;
  updateUIState(false);
  localStorage.removeItem("northstar_session");
  localStorage.removeItem("northstar_auth_token");
  localStorage.removeItem("northstar_user_roll");
  localStorage.removeItem("classPortal.activeSession");
  localStorage.removeItem("classPortal.deviceToken");
  loginForm.reset();
  showMessage(loginMessage, "");
  showWelcomePage();
}

if (logoutButton) {
  logoutButton.addEventListener("click", () => {
    void performLogout();
  });
}

if (floatingLogoutButton) {
  floatingLogoutButton.addEventListener("click", () => {
    void performLogout();
  });
}

window.addEventListener("beforeunload", () => {
  void releaseActiveSession();
});

document.getElementById("admin-code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isAdmin) {
    isAdmin = false;
    window.alert("Only Admin users can create access codes.");
    return;
  }
  const form = event.currentTarget;
  const generateButton = document.getElementById("generate-code");
  const formData = new FormData(form);
  const code = formData.get("code").trim().toUpperCase();
  const role = formData.get("role");
  const studentName = titleCaseName(formData.get("studentName"));
  const rollNo = formData.get("rollNo");
  generateButton.disabled = true;

  const { error } = await supabaseClient
    .from("Credentials")
    .insert({ access_code: code, role, student_name: studentName, roll_number: rollNo });

  if (error) {
    generateButton.disabled = false;
    showMessage(document.getElementById("admin-code-message"), "Unable to create code", true);
    return;
  }

  form.reset();
  showMessage(document.getElementById("admin-code-message"), "Access code created.");
  await renderCodes();
  generateButton.textContent = "Created";
  setTimeout(() => {
    generateButton.textContent = "Create code";
    generateButton.disabled = false;
  }, 1400);
});

document.getElementById("question-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isLoggedIn || !activeSession) {
    window.alert("Please log in to participate.");
    return;
  }

  const normalizedRole = String(activeSession.role || "").toLowerCase();
  if (normalizedRole === "admin") {
    window.alert("Admin accounts cannot post student questions.");
    return;
  }

  const form = event.currentTarget;
  const submitButton = form.querySelector("button[type='submit']");
  const subject = document.getElementById("question-subject").value;
  const questionText = document.getElementById("question-text").value.trim();
  if (!subject || !questionText) {
    showMessage(document.getElementById("question-message"), "Please choose a subject and write your question.", true);
    return;
  }
  submitButton.disabled = true;

  const { error } = await supabaseClient
    .from("questions")
    .insert({
      author_name: activeSession.name,
      standard: getRollNo(activeSession),
      subject,
      question_text: questionText
    });

  if (error) {
    console.error("Unable to submit question.", error);
    showMessage(document.getElementById("question-message"), error.message || "Unable to submit question.", true);
  } else {
    trackStudentActivity("question");
    form.reset();
    showMessage(document.getElementById("question-message"), "Your question is now in the feed.");
    await fetchQuestions();
  }
  submitButton.disabled = false;
});

async function uploadPdfWithProgress(file, filePath) {
  if (noteUploadCancelRequested) {
    const canceledError = new Error("Upload canceled.");
    canceledError.name = "AbortError";
    throw canceledError;
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    activeNoteUploadXhr = xhr;
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    xhr.open("POST", `${SUPABASE_PROJECT_URL}/storage/v1/object/notes-bucket/${encodedPath}`);
    xhr.setRequestHeader("apikey", SUPABASE_ANON_KEY);
    xhr.setRequestHeader("Authorization", `Bearer ${SUPABASE_ANON_KEY}`);
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.setRequestHeader("x-upsert", "false");

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      document.getElementById("upload-progress").value = percent;
      document.getElementById("upload-progress-label").textContent = `${percent}%`;
    });

    xhr.onload = () => {
      activeNoteUploadXhr = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      let message = xhr.statusText || "Storage upload failed.";
      try {
        message = JSON.parse(xhr.responseText).message || message;
      } catch (error) {
        // Keep the HTTP status message when the response is not JSON.
      }
      reject(new Error(message));
    };
    xhr.onerror = () => {
      activeNoteUploadXhr = null;
      reject(new Error("Network error during PDF upload."));
    };
    xhr.onabort = () => {
      activeNoteUploadXhr = null;
      const error = new Error("Upload canceled.");
      error.name = "AbortError";
      reject(error);
    };
    xhr.send(file);
  });
}

document.getElementById("cancel-upload-button").addEventListener("click", () => {
  noteUploadCancelRequested = true;
  if (activeNoteUploadXhr) activeNoteUploadXhr.abort();
});

document.getElementById("note-file-input").addEventListener("change", (event) => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  if (file.type !== "application/pdf") {
    window.alert("Please select a PDF file only.");
    event.currentTarget.value = "";
    return;
  }
  if (file.size > MAX_PDF_SIZE) {
    window.alert("File size exceeds the 10 MB limit. Please upload a smaller PDF.");
    event.currentTarget.value = "";
  }
});

document.getElementById("upload-notes-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isLoggedIn) {
    window.alert("Please log in to participate.");
    return;
  }

  const form = event.currentTarget;
  const uploadButton = form.querySelector("button[type='submit']");
  const source = form.querySelector("input[name='uploadSource']:checked")?.value;
  const title = document.getElementById("note-title-input").value.trim();
  const subject = document.getElementById("note-category-input").value;
  const file = document.getElementById("note-file-input").files[0];
  const driveLink = document.getElementById("drive-link-input").value.trim();
  const uploaderRole = isAdmin ? "admin" : "student";
  const uploaderName = activeSession?.name || "Student";
  const uploaderId = activeSession?.rollNo || "student";

  if (source === "drive") {
    if (!isAdmin) {
      window.alert("Only Admin users can import Drive links.");
      return;
    }
    try {
      const parsedDriveUrl = new URL(driveLink);
      if (!parsedDriveUrl.hostname.endsWith("drive.google.com")) throw new Error("Enter a valid Google Drive URL.");
    } catch (error) {
      window.alert(error.message || "Enter a valid Google Drive URL.");
      return;
    }
  }

  if (source === "local" && (!file || file.type !== "application/pdf")) {
    window.alert("Please select a PDF file only.");
    return;
  }
  if (!subject) {
    window.alert("Choose a subject for this note.");
    document.getElementById("note-category-input").focus();
    return;
  }
  if (source === "local" && file.size > MAX_PDF_SIZE) {
    window.alert("File size exceeds the 10 MB limit. Please upload a smaller PDF.");
    document.getElementById("note-file-input").value = "";
    return;
  }
  if (uploaderRole === "admin") {
    if (source !== "drive") {
      window.alert("Admins should import PDFs using a Google Drive link.");
      return;
    }
  } else if (source !== "local") {
    window.alert("Students can upload local PDF files only.");
    return;
  }

  uploadButton.disabled = true;
  showMessage(document.getElementById("upload-message"), "Uploading note...");
  const progressContainer = document.getElementById("upload-progress-container");
  const progress = document.getElementById("upload-progress");
  const progressLabel = document.getElementById("upload-progress-label");
  const cancelButton = document.getElementById("cancel-upload-button");
  progress.value = 0;
  progressLabel.textContent = "0%";
  progressContainer.hidden = source !== "local";
  cancelButton.hidden = source !== "local";
  noteUploadCancelRequested = false;
  try {
    let fileUrl = source === "drive" ? driveLink : null;
    if (uploaderRole === "student") {
      const filePath = `${uploaderId || "student"}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      try {
        await uploadPdfWithProgress(file, filePath);
        progressContainer.hidden = true;
        cancelButton.hidden = true;
      } catch (error) {
        if (error.name === "AbortError") {
          window.alert("Upload canceled.");
          return;
        }
        console.error("Storage Upload Error:", error);
        window.alert(`Storage Upload Error: ${error.message}`);
        return;
      }
      const { data: publicUrlData } = supabaseClient.storage.from("notes-bucket").getPublicUrl(filePath);
      fileUrl = publicUrlData.publicUrl;
    }

    let insertedNote = null;
    try {
      const notePayload = {
        title: String(title || "Untitled note").trim(),
        file_url: String(fileUrl || "").trim(),
        uploaded_by: String(activeSession?.name || activeSession?.roll_number || activeSession?.rollNo || "anonymous").trim(),
        role: String(activeSession?.role || uploaderRole || "student").trim() || "student",
        roll_number: String(activeSession?.roll_number || activeSession?.rollNo || uploaderId || "anonymous").trim(),
        subject: String(subject || "General").trim() || "General"
      };

      const hasRequiredNoteValues = notePayload.title && notePayload.file_url && notePayload.uploaded_by && notePayload.roll_number && notePayload.subject;
      if (!hasRequiredNoteValues) {
        throw new Error("Missing required note fields before insert: title, file_url, uploaded_by, roll_number, subject.");
      }

      const { data, error: insertError } = await supabaseClient
        .from("notes")
        .insert(notePayload)
        .select();
      if (insertError) {
        console.error("Note insert error payload:", insertError);
        window.alert(`Database Error: ${insertError.message}`);
        return;
      }
      insertedNote = data?.[0] || null;
    } catch (error) {
      console.error("Database Error:", error);
      window.alert(`Database Error: ${error.message}`);
      return;
    }

    if (insertedNote) {
      trackStudentActivity("note");
      const enrichedNote = {
        ...insertedNote,
        uploaded_by: uploaderName
      };
      allNotes = [enrichedNote, ...allNotes];
      renderNotes();
    }

    form.reset();
    document.getElementById("note-file-input").value = "";
    document.getElementById("note-category-input").value = "";
    document.getElementById("note-file-input").hidden = false;
    showMessage(document.getElementById("upload-message"), "Note uploaded successfully.");
    await fetchNotes();
  } catch (error) {
    console.error("Unable to upload note.", error);
    showMessage(document.getElementById("upload-message"), error.message || "Unable to upload note.", true);
  } finally {
    uploadButton.disabled = false;
    progress.value = 0;
    progressLabel.textContent = "0%";
    progressContainer.hidden = true;
    cancelButton.hidden = true;
    activeNoteUploadXhr = null;
    noteUploadCancelRequested = false;
  }
});

const noteFileInput = document.getElementById("note-file-input");
const driveLinkInput = document.getElementById("drive-link-input");
document.querySelectorAll("input[name='uploadSource']").forEach((sourceOption) => {
  sourceOption.addEventListener("change", () => {
    syncUploadSourceUI();
  });
});

populateSubjectOptions();

document.getElementById("question-subject-filter").addEventListener("change", (event) => {
  activeSubject = event.target.value;
  renderFilteredQuestions();
});

document.getElementById("notes-filter").addEventListener("change", (event) => {
  activeNotesSubject = event.target.value;
  renderNotes();
});

document.getElementById("question-search").addEventListener("input", (event) => {
  searchTerm = event.target.value;
  renderFilteredQuestions();
});

async function initApp() {
  if (initPromise) return initPromise;
  initPromise = initializeApp();
  return initPromise;
}

async function initializeApp() {
  const authTokenExists = Boolean(localStorage.getItem("northstar_auth_token"));
  const storedRollNo = localStorage.getItem("northstar_user_roll");

  if (authTokenExists && storedRollNo) {
    const bypassedFromToken = await autoLoginFromStoredToken();
    if (bypassedFromToken) {
      return;
    }
  }

  const savedNorthstarSession = localStorage.getItem("northstar_session");
  if (savedNorthstarSession) {
    try {
      const session = JSON.parse(savedNorthstarSession);
      const bypassed = await bypassLoginToDashboard(session);
      if (bypassed) {
        return;
      }
    } catch (error) {
      console.error("Unable to parse the persistent Northstar session.", error);
    }
  }

  let restoredSession;
  try {
    restoredSession = await restoreSavedSession();
  } catch (error) {
    console.error("Unable to restore local portal session.", error);
  }

  if (restoredSession?.securityConflict) {
    localStorage.removeItem("classPortal.activeSession");
    window.alert("Session active on another device. Please log out there first.");
    showWelcomePage();
    return;
  }
  if (!restoredSession) {
    showWelcomePage();
    return;
  }
  await showApp(restoredSession);
  updateNotesCount();
  await renderGoogleDriveNotes();

  const notesList = document.getElementById("notes-list-container");
  if (notesList && !notesListObserver) {
    notesListObserver = new MutationObserver(updateNotesCount);
    notesListObserver.observe(notesList, { childList: true });
  }
}

initializePollCreator();

document.addEventListener("DOMContentLoaded", () => {
  void initApp();
}, { once: true });
