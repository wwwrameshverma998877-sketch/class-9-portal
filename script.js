const SUPABASE_URL = "https://jscgedmfzdxpbtmokazf.supabase.co/rest/v1/";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzY2dlZG1memR4cGJ0bW9rYXpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMTYwNjAsImV4cCI6MjEwNDc5MjA2MH0.bGFzIlqtQYfByOC9dGNEihIhX-jfX72g7tZ8-wZeTeg";
const SUPABASE_PROJECT_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");
const supabaseClient = supabase.createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY);
const MAX_PDF_SIZE = 10 * 1024 * 1024;
const SUBJECTS = ["English", "Algebra", "Geometry", "Science I", "Science II", "Hindi", "Marathi", "History", "Political Science", "Geography", "Other"];
let activeSession = null;
let isLoggedIn = false;
let isAdmin = false;
let allQuestions = [];
let allNotes = [];
let activeSubject = "All";
let activeNotesSubject = "All";
let activeNotesSearch = "";
let searchTerm = "";
let unansweredOnly = false;
let locallyPostedAnswerIds = new Set();
let realtimeQuestionsChannel = null;
let realtimeNotesChannel = null;
let realtimeAnswersChannel = null;
let realtimePollsChannel = null;
let initPromise = null;
let notesListObserver = null;
let activeNoteUploadXhr = null;
let noteUploadCancelRequested = false;
let sessionHeartbeat = null;
let portalNoticeRefreshTimer = null;

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
  const fileInput = document.getElementById("note-file-input");
  if (!fileInput) return;
  fileInput.disabled = !isLoggedIn;
  fileInput.required = true;
}

const FOCUS_ACTIVITY_KEY = "classPortal.studentFocusActivity";
const PROFILE_NOTES_VIEWED_KEY = "northstar.profileNotesViewed";
const PROFILE_NOTIFICATIONS_KEY = "northstar.profileNotificationsEnabled";
const NOTIFICATION_STATE_PREFIX = "northstar.notificationCenter.v1.";
const NOTIFICATION_PROMPT_ANSWERED_SUFFIX = ".permissionPromptAnswered";
let profileDataRequestId = 0;
let profileActivityLoaded = false;
let profileRecentQuestions = [];
let profileRecentReplies = [];
let profileStats = { questions: 0, notesViewed: 0, pollVotes: 0 };
let notificationStateKey = "";
let notificationState = {
  lastCheckedAt: 0,
  items: [],
  knownPollIds: null,
  noticeFingerprint: null
};

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
      control.textContent = "➤";
      control.setAttribute("aria-label", loggedIn ? "Send reply" : "Login to reply");
      control.title = loggedIn ? "Post a reply" : "Log in to participate.";
    } else {
      control.placeholder = loggedIn ? "Write a reply..." : "Login to reply...";
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
  if (!currentSession?.rollNo || currentSession.rollNo === "-" || !currentSession.division) return;
  try {
    const response = await fetch(`${SUPABASE_URL}rpc/release_credentials_session`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_division: currentSession.division,
        p_roll_number: String(currentSession.rollNo),
        p_access_code: currentSession.accessCode || currentSession.access_code,
        p_device_token: currentSession.deviceToken || currentSession.device_token || getDeviceToken()
      }),
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
  const homeFeed = document.getElementById("home-questions-feed");
  if (!feed) return;
  feed.replaceChildren(...allQuestions.map((item) => renderQuestionCard(item, "all")));
  const recentQuestions = allQuestions.slice(0, 3);
  if (homeFeed) {
    homeFeed.replaceChildren(...recentQuestions.map((item) => renderQuestionCard(item, "home")));
    if (!recentQuestions.length) {
      const emptyState = document.createElement("p");
      emptyState.className = "home-questions-empty";
      emptyState.textContent = "No questions yet. Be the first to ask your classmates.";
      homeFeed.appendChild(emptyState);
    }
  }
  applyQuestionFilters();
  [...new Set([...allQuestions, ...recentQuestions]
    .map((item) => item.id)
    .filter((id) => id !== undefined && id !== null))]
    .forEach((questionId) => void fetchAnswersForQuestion(questionId));
}

function applyQuestionFilters() {
  const feed = document.getElementById("questions-feed");
  const emptyState = document.getElementById("questions-empty-state");
  if (!feed || !emptyState) return;

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
  const cards = [...feed.querySelectorAll(".question-card")];
  let visibleCount = 0;
  const hasPendingReplyCounts = unansweredOnly && cards.some((card) => {
    const matchesSubject = activeSubject === "All"
      || (card.dataset.subject || "General").toLocaleLowerCase() === activeSubject.toLocaleLowerCase();
    const searchableText = card.dataset.searchText || card.textContent.toLocaleLowerCase();
    const matchesSearch = !normalizedSearch || searchableText.includes(normalizedSearch);
    return matchesSubject && matchesSearch && card.dataset.replyCount === "unknown";
  });

  cards.forEach((card) => {
    const matchesSubject = activeSubject === "All"
      || (card.dataset.subject || "General").toLocaleLowerCase() === activeSubject.toLocaleLowerCase();
    const searchableText = card.dataset.searchText || card.textContent.toLocaleLowerCase();
    const matchesSearch = !normalizedSearch || searchableText.includes(normalizedSearch);
    const matchesUnanswered = !unansweredOnly || card.dataset.replyCount === "0";
    const isVisible = matchesSubject && matchesSearch && matchesUnanswered;
    card.hidden = !isVisible;
    if (isVisible) visibleCount += 1;
  });

  emptyState.hidden = visibleCount > 0;
  const message = emptyState.querySelector("p");
  const resetButton = document.getElementById("reset-question-filters");
  if (message) {
    message.textContent = hasPendingReplyCounts
      ? "Checking reply counts..."
      : cards.length
        ? "No questions match these filters."
        : "No questions have been posted yet.";
  }
  if (resetButton) resetButton.hidden = hasPendingReplyCounts || (!cards.length && !normalizedSearch && activeSubject === "All" && !unansweredOnly);
}

function populateSubjectOptions() {
  const questionSubject = document.getElementById("question-subject");
  const questionFilter = document.getElementById("question-subject-filter");
  const noteCategory = document.getElementById("note-category-input");
  const questionPills = document.getElementById("question-subject-pills");

  SUBJECTS.forEach((subject) => {
    const questionOption = new Option(subject, subject);
    questionSubject.add(questionOption);
    questionFilter.add(new Option(subject, subject));
    noteCategory.add(new Option(subject, subject));
  });

  if (questionPills) {
    const featuredSubjects = ["Algebra", "Geometry", "Science I", "Science II"];
    const orderedSubjects = [
      "All",
      ...featuredSubjects.filter((subject) => SUBJECTS.includes(subject)),
      ...SUBJECTS.filter((subject) => !featuredSubjects.includes(subject))
    ];
    questionPills.replaceChildren(...orderedSubjects.map((subject) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "subject-filter-pill";
      pill.dataset.subjectFilter = subject;
      pill.setAttribute("aria-pressed", String(subject === "All"));
      pill.textContent = subject;
      return pill;
    }));
  }
}

function renderNotes() {
  const notesContainer = document.getElementById("notes-list-container");
  const emptyState = document.getElementById("notes-empty-state");
  if (!notesContainer) return;
  const normalizedSearch = activeNotesSearch.trim().toLocaleLowerCase();
  const filteredNotes = allNotes.filter((note) => {
    const matchesSubject = activeNotesSubject === "All"
      || String(note.subject || "").toLocaleLowerCase() === activeNotesSubject.toLocaleLowerCase();
    const fileName = String(note.file_url || "").split(/[/?#]/).pop().replace(/%20/g, " ");
    const searchableText = [
      note.title,
      note.subject,
      note.uploaded_by,
      note.uploader_name,
      note.student_name,
      note.author_name,
      fileName
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return matchesSubject && (!normalizedSearch || searchableText.includes(normalizedSearch));
  });
  notesContainer.replaceChildren(...filteredNotes.map(renderNoteCard));
  if (emptyState) {
    emptyState.hidden = filteredNotes.length > 0;
    emptyState.textContent = allNotes.length
      ? "No notes match your search or subject filter."
      : "No study notes have been uploaded yet.";
  }
  document.querySelectorAll(".notes-filter-chip").forEach((chip) => {
    const isActive = chip.dataset.notesSubject === activeNotesSubject;
    chip.classList.toggle("is-active", isActive);
    chip.setAttribute("aria-pressed", String(isActive));
  });
  const resetButton = document.getElementById("reset-notes-filters");
  if (resetButton) resetButton.hidden = activeNotesSubject === "All" && !activeNotesSearch;
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
  const profileName = document.getElementById("profile-student-name");
  const profileDivision = document.getElementById("profile-student-division");
  const profileRoll = document.getElementById("profile-student-roll");
  if (nameElement) nameElement.textContent = session.name;
  if (rollElement) rollElement.textContent = isAdmin
    ? "Portal administrator"
    : `Roll no ${getRollNo(session)} · ${session.division || "Division not set"}`;
  if (welcomeElement) welcomeElement.textContent = session.name.split(" ")[0];
  if (avatarElement) avatarElement.textContent = session.name.charAt(0).toUpperCase();
  if (profileName) profileName.textContent = session.name || "Student";
  if (profileDivision) profileDivision.textContent = session.division || "-";
  if (profileRoll) profileRoll.textContent = getRollNo(session);
  if (adminPanel) adminPanel.hidden = !isAdmin;
  if (questionSection) questionSection.hidden = String(session.role || "").toLowerCase() === "admin";
}

function getProfileStudentKey(session) {
  const rollNo = String(getRollNo(session) || "").trim();
  const division = String(session?.division || "").trim().toLowerCase();
  if (!rollNo || rollNo === "-") return "";
  return `${division}:${rollNo}`;
}

function getProfileNotesViewedMap() {
  try {
    const raw = localStorage.getItem(PROFILE_NOTES_VIEWED_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    console.error("Saved Notes Viewed data has an invalid format.");
  } catch (error) {
    console.error("Unable to read Notes Viewed data.", error);
  }
  return {};
}

function getProfileNotesViewedCount(session) {
  const studentKey = getProfileStudentKey(session);
  const count = Number(getProfileNotesViewedMap()[studentKey]);
  return studentKey && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function renderProfileStats() {
  const values = {
    "profile-total-questions": profileStats.questions,
    "profile-notes-viewed": profileStats.notesViewed,
    "profile-poll-votes": profileStats.pollVotes
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (!element) return;
    const count = Number(value);
    element.textContent = String(Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
  });
}

function recordProfileNoteView() {
  const studentKey = getProfileStudentKey(activeSession);
  if (!studentKey) return;
  const viewedMap = getProfileNotesViewedMap();
  const count = Number(viewedMap[studentKey]);
  const nextCount = (Number.isFinite(count) && count > 0 ? Math.floor(count) : 0) + 1;
  viewedMap[studentKey] = nextCount;
  profileStats.notesViewed = nextCount;
  renderProfileStats();
  try {
    localStorage.setItem(PROFILE_NOTES_VIEWED_KEY, JSON.stringify(viewedMap));
  } catch (error) {
    console.error("Unable to save Notes Viewed data.", error);
  }
}

async function fetchProfileQuestions(session) {
  const rollNo = String(getRollNo(session) || "").trim();
  if (!rollNo || rollNo === "-" || !session.name) return { count: 0, items: [] };
  const { data, count, error } = await supabaseClient
    .from("questions")
    .select("id, subject, question_text, created_at", { count: "exact" })
    .eq("standard", rollNo)
    .eq("author_name", session.name)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  const items = data || [];
  return { count: Number.isFinite(count) ? count : items.length, items };
}

async function fetchProfileReplies(session) {
  if (!session.name) return [];
  const { data, error } = await supabaseClient
    .from("answers")
    .select("id, answer_text, created_at")
    .eq("answered_by", session.name)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  return data || [];
}

async function fetchProfilePollVotes(session) {
  const rollNo = String(getRollNo(session) || "").trim();
  if (!rollNo || rollNo === "-") return 0;
  const { count, error } = await supabaseClient
    .from("poll_votes")
    .select("poll_id", { count: "exact", head: true })
    .eq("roll_number", rollNo);
  if (error) throw error;
  return Number.isFinite(count) ? count : 0;
}

async function refreshProfileData(session = activeSession) {
  if (!session) return;
  const requestId = ++profileDataRequestId;
  profileActivityLoaded = false;
  profileRecentQuestions = [];
  profileRecentReplies = [];
  profileStats = {
    questions: 0,
    notesViewed: getProfileNotesViewedCount(session),
    pollVotes: 0
  };
  renderProfileStats();

  const [questions, replies, pollVotes] = await Promise.all([
    fetchProfileQuestions(session).catch((error) => {
      console.error("Unable to load profile question activity.", error);
      return null;
    }),
    fetchProfileReplies(session).catch((error) => {
      console.error("Unable to load profile reply activity.", error);
      return null;
    }),
    fetchProfilePollVotes(session).catch((error) => {
      console.error("Unable to load profile poll vote count.", error);
      return null;
    })
  ]);
  if (requestId !== profileDataRequestId || activeSession !== session) return;

  profileStats.questions = questions?.count || 0;
  profileStats.pollVotes = pollVotes || 0;
  profileRecentQuestions = questions?.items || [];
  profileRecentReplies = replies || [];
  profileActivityLoaded = true;
  renderProfileStats();
  const activityDialog = document.getElementById("profile-activity-dialog");
  if (activityDialog?.open) renderProfileActivity();
}

function appendProfileActivityGroup(container, title, records, getText, emptyText) {
  const group = document.createElement("section");
  const heading = document.createElement("h3");
  heading.className = "profile-activity-heading";
  heading.textContent = title;
  group.className = "profile-activity-group";
  group.appendChild(heading);

  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "profile-dialog-muted";
    empty.textContent = emptyText;
    group.appendChild(empty);
  } else {
    records.forEach((record) => {
      const item = document.createElement("article");
      const text = document.createElement("p");
      item.className = "profile-activity-item";
      text.textContent = getText(record);
      item.appendChild(text);
      if (record.created_at) {
        const date = new Date(record.created_at);
        if (!Number.isNaN(date.getTime())) {
          const time = document.createElement("time");
          time.dateTime = date.toISOString();
          time.textContent = date.toLocaleString();
          item.appendChild(time);
        }
      }
      group.appendChild(item);
    });
  }
  container.appendChild(group);
}

function renderProfileActivity() {
  const content = document.getElementById("profile-activity-content");
  if (!content) return;
  content.replaceChildren();
  if (!profileActivityLoaded) {
    const loading = document.createElement("p");
    loading.className = "profile-dialog-muted";
    loading.textContent = "Loading your activity…";
    content.appendChild(loading);
    return;
  }

  appendProfileActivityGroup(
    content,
    "Recent Questions",
    profileRecentQuestions,
    (question) => `${question.subject ? `${question.subject}: ` : ""}${question.question_text || "Question"}`,
    "No questions posted yet."
  );
  appendProfileActivityGroup(
    content,
    "Recent Replies",
    profileRecentReplies,
    (reply) => reply.answer_text || "Reply",
    "No replies posted yet."
  );
  const votes = document.createElement("section");
  const heading = document.createElement("h3");
  const summary = document.createElement("p");
  votes.className = "profile-activity-group";
  heading.className = "profile-activity-heading";
  heading.textContent = "Poll Votes";
  summary.className = "profile-dialog-muted";
  summary.textContent = `${profileStats.pollVotes} ${profileStats.pollVotes === 1 ? "vote" : "votes"} recorded for this account.`;
  votes.append(heading, summary);
  content.appendChild(votes);
}

function openProfileDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeProfileDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function readProfileNotificationsPreference() {
  try {
    const savedValue = localStorage.getItem(PROFILE_NOTIFICATIONS_KEY);
    return savedValue === null ? true : savedValue === "true";
  } catch (error) {
    console.error("Unable to read the notification preference.", error);
    return true;
  }
}

function setProfileSettingsMessage(message) {
  const status = document.getElementById("profile-settings-message");
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
}

function renderProfileNotificationsToggle(enabled) {
  const toggle = document.getElementById("profile-notifications-toggle");
  if (!toggle) return;
  toggle.setAttribute("aria-checked", String(enabled));
  toggle.classList.toggle("is-enabled", enabled);
  toggle.title = enabled ? "Notifications enabled" : "Notifications disabled";
}

function createEmptyNotificationState() {
  return {
    lastCheckedAt: 0,
    items: [],
    knownPollIds: null,
    noticeFingerprint: null
  };
}

function getNotificationStorageKey(session) {
  const identity = `${String(session.division || "unknown").trim().toLowerCase()}:${String(getRollNo(session) || "unknown").trim()}`;
  return `${NOTIFICATION_STATE_PREFIX}${encodeURIComponent(identity)}`;
}

function readNotificationState(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return createEmptyNotificationState();
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return createEmptyNotificationState();
    const items = Array.isArray(saved.items) ? saved.items.filter((item) => {
      return item
        && item.key
        && item.title
        && ["home", "doubts", "polls"].includes(item.panel)
        && Number.isFinite(Number(item.createdAt));
    }).map((item) => ({
      ...item,
      key: String(item.key),
      title: String(item.title),
      message: String(item.message || ""),
      createdAt: Number(item.createdAt),
      unread: Boolean(item.unread)
    })).slice(0, 50) : [];
    return {
      lastCheckedAt: Number.isFinite(saved.lastCheckedAt) ? saved.lastCheckedAt : 0,
      items,
      knownPollIds: Array.isArray(saved.knownPollIds) ? saved.knownPollIds.map(String) : null,
      noticeFingerprint: typeof saved.noticeFingerprint === "string" ? saved.noticeFingerprint : null
    };
  } catch (error) {
    console.error("Unable to read saved notifications.", error);
    return createEmptyNotificationState();
  }
}

function persistNotificationState() {
  if (!notificationStateKey) return;
  try {
    localStorage.setItem(notificationStateKey, JSON.stringify(notificationState));
  } catch (error) {
    console.error("Unable to save notification state.", error);
  }
}

function initializeNotificationState(session) {
  notificationStateKey = getNotificationStorageKey(session);
  notificationState = readNotificationState(notificationStateKey);
  if (!notificationState.lastCheckedAt) notificationState.lastCheckedAt = Date.now();
  closeNotificationPopover();
  persistNotificationState();
  renderNotificationCenter();
}

function addNotification({ key, title, message, panel, createdAt = Date.now() }) {
  if (!notificationStateKey || !key || notificationState.items.some((item) => item.key === String(key))) return;
  const timestamp = new Date(createdAt).getTime();
  const createdAtMs = Number.isFinite(timestamp) ? timestamp : Date.now();
  const notification = {
    key: String(key),
    title: String(title || "New notification"),
    message: String(message || ""),
    panel,
    createdAt: createdAtMs,
    unread: readProfileNotificationsPreference() && createdAtMs > notificationState.lastCheckedAt
  };
  notificationState.items.push(notification);
  notificationState.items.sort((left, right) => right.createdAt - left.createdAt);
  notificationState.items = notificationState.items.slice(0, 50);
  persistNotificationState();
  renderNotificationCenter();
  if (notification.unread) void deliverSystemNotification(notification);
}

function observeNewPolls(polls) {
  if (!notificationStateKey) return;
  const pollIds = polls.map((poll) => String(poll.poll_id));
  if (Array.isArray(notificationState.knownPollIds)) {
    const knownPolls = new Set(notificationState.knownPollIds);
    polls.forEach((poll) => {
      const pollId = String(poll.poll_id);
      if (knownPolls.has(pollId)) return;
      addNotification({
        key: `poll:${pollId}`,
        title: "New class poll",
        message: poll.title || poll.question || "A new class poll is available.",
        panel: "polls",
        createdAt: poll.created_at || Date.now()
      });
    });
  }
  notificationState.knownPollIds = pollIds.slice(0, 500);
  persistNotificationState();
}

function observePortalNotice(notice) {
  if (!notificationStateKey) return;
  const fingerprint = notice?.is_active && notice.notice_text
    ? JSON.stringify([notice.notice_text, notice.target_at || ""])
    : "";
  if (notificationState.noticeFingerprint === null) {
    notificationState.noticeFingerprint = fingerprint;
    persistNotificationState();
    return;
  }
  if (fingerprint && fingerprint !== notificationState.noticeFingerprint) {
    addNotification({
      key: `notice:${Date.now()}:${fingerprint}`,
      title: "New class announcement",
      message: notice.notice_text,
      panel: "home",
      createdAt: Date.now()
    });
  }
  notificationState.noticeFingerprint = fingerprint;
  persistNotificationState();
}

function isOwnedQuestion(question, session = activeSession) {
  if (!question || !session) return false;
  const questionRoll = String(question.standard || question.roll_number || question.rollNo || "").trim();
  const studentRoll = String(getRollNo(session) || "").trim();
  const questionName = String(question.author_name || question.author || "").trim().toLowerCase();
  const studentName = String(session.name || "").trim().toLowerCase();
  const sameDivision = !question.division || String(question.division).toLowerCase() === String(session.division || "").toLowerCase();
  return questionRoll === studentRoll && questionName === studentName && sameDivision;
}

function recordQuestionReplyNotification(reply) {
  if (!reply?.id || !activeSession) return;
  const question = allQuestions.find((item) => String(item.id) === String(reply.doubt_id));
  if (!isOwnedQuestion(question)) return;
  if (String(reply.answered_by || "").trim().toLowerCase() === String(activeSession.name || "").trim().toLowerCase()) return;
  const author = String(reply.answered_by || "A classmate").trim();
  addNotification({
    key: `reply:${reply.id}`,
    title: `New reply from ${author}`,
    message: reply.answer_text || "A classmate replied to your question.",
    panel: "doubts",
    createdAt: reply.created_at || Date.now()
  });
}

async function checkForRecentQuestionReplies(questions) {
  if (!notificationStateKey || !activeSession) return;
  const questionIds = questions.filter((question) => isOwnedQuestion(question)).map((question) => question.id).filter(Boolean);
  if (!questionIds.length) return;
  const { data: replies, error } = await supabaseClient
    .from("answers")
    .select("id, doubt_id, answered_by, answer_text, created_at")
    .in("doubt_id", questionIds)
    .gt("created_at", new Date(notificationState.lastCheckedAt).toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    console.error("Unable to check for new replies to your questions.", error);
    return;
  }
  (replies || []).forEach(recordQuestionReplyNotification);
}

function renderNotificationCenter() {
  const bell = document.getElementById("notification-bell");
  const badge = document.getElementById("notification-unread-badge");
  const list = document.getElementById("notification-list");
  const empty = document.getElementById("notification-empty");
  const preferenceNote = document.getElementById("notification-preference-note");
  const markReadButton = document.getElementById("notification-mark-all-read");
  if (!bell || !badge || !list || !empty || !preferenceNote || !markReadButton) return;

  const notificationsEnabled = readProfileNotificationsPreference();
  const unreadCount = notificationsEnabled ? notificationState.items.filter((item) => item.unread).length : 0;
  badge.hidden = unreadCount === 0;
  badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
  bell.setAttribute("aria-label", unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications");
  preferenceNote.hidden = notificationsEnabled;
  markReadButton.disabled = !notificationState.items.some((item) => item.unread);
  updateDeviceAlertControls();
  list.replaceChildren();

  notificationState.items.forEach((notification) => {
    const item = document.createElement("button");
    const dot = document.createElement("span");
    const copy = document.createElement("span");
    const title = document.createElement("span");
    const message = document.createElement("span");
    const time = document.createElement("time");
    const isUnread = notificationsEnabled && notification.unread;
    item.type = "button";
    item.className = `notification-item${isUnread ? " is-unread" : ""}`;
    item.setAttribute("role", "listitem");
    dot.className = "notification-item-dot";
    dot.setAttribute("aria-hidden", "true");
    copy.className = "notification-item-copy";
    title.className = "notification-item-title";
    title.textContent = notification.title;
    message.className = "notification-item-message";
    message.textContent = notification.message;
    time.className = "notification-item-time";
    time.dateTime = new Date(notification.createdAt).toISOString();
    time.textContent = formatTimestamp(time.dateTime);
    copy.append(title, message, time);
    item.append(dot, copy);
    item.addEventListener("click", () => {
      if (notification.unread) {
        notification.unread = false;
        persistNotificationState();
        renderNotificationCenter();
      }
      navigateToNotificationPanel(notification.panel);
      closeNotificationPopover();
      bell.focus();
    });
    list.appendChild(item);
  });
  empty.hidden = notificationState.items.length > 0;
}

function closeNotificationPopover() {
  const popover = document.getElementById("notification-popover");
  const bell = document.getElementById("notification-bell");
  if (!popover || !bell) return;
  popover.hidden = true;
  bell.setAttribute("aria-expanded", "false");
}

function getDeviceNotificationPermission() {
  try {
    if (typeof window === "undefined" || !("Notification" in window) || typeof window.Notification !== "function") return "unsupported";
    return window.Notification.permission || "default";
  } catch (error) {
    console.warn("System notification permission is unavailable.", error);
    return "unsupported";
  }
}

function updateDeviceAlertControls() {
  const button = document.getElementById("notification-enable-device-alerts");
  const status = document.getElementById("notification-device-status");
  if (!button || !status) return;
  const permission = getDeviceNotificationPermission();
  const requestSupported = permission !== "unsupported" && typeof window.Notification.requestPermission === "function";

  if (permission === "unsupported") {
    button.disabled = true;
    button.textContent = "Device Alerts Unavailable";
    status.textContent = "System alerts are not supported here; in-app notifications still work.";
  } else if (permission === "granted") {
    button.disabled = true;
    button.textContent = "Device Alerts Enabled";
    status.textContent = readProfileNotificationsPreference()
      ? "System alerts are enabled on this device."
      : "Permission is ready; turn on Notifications to receive alerts.";
  } else if (permission === "denied") {
    button.disabled = true;
    button.textContent = "Device Alerts Blocked";
    status.textContent = "System alerts are blocked in browser settings; in-app notifications still work.";
  } else if (!requestSupported) {
    button.disabled = true;
    button.textContent = "Device Alerts Unavailable";
    status.textContent = "This browser cannot request system notification permission.";
  } else {
    button.disabled = false;
    button.textContent = "Enable Device Alerts";
    status.textContent = readProfileNotificationsPreference()
      ? "Allow system alerts on this device."
      : "You can grant permission here; the Profile toggle still controls delivery.";
  }
}

async function requestDeviceAlertPermission() {
  const permission = getDeviceNotificationPermission();
  if (permission === "unsupported" || typeof window.Notification.requestPermission !== "function") {
    updateDeviceAlertControls();
    return;
  }
  if (permission !== "default") {
    updateDeviceAlertControls();
    return;
  }

  try {
    await window.Notification.requestPermission();
  } catch (error) {
    console.warn("Unable to request system notification permission.", error);
  }
  updateDeviceAlertControls();
}

function navigateToNotificationPanel(panel) {
  const tab = [...document.querySelectorAll(".dashboard-tab")]
    .find((dashboardTab) => dashboardTab.dataset.panel === panel);
  tab?.click();
}

async function deliverSystemNotification(notification) {
  const isDeliveryEnabled = () => readProfileNotificationsPreference() && getDeviceNotificationPermission() === "granted";
  if (!isDeliveryEnabled()) return;
  const options = {
    body: notification.message,
    icon: "/assets/icon.png",
    badge: "/assets/icon.png",
    tag: `northstar-${notification.key}`,
    renotify: false,
    timestamp: notification.createdAt,
    data: { panel: notification.panel }
  };

  let registration = null;
  if ("serviceWorker" in navigator && typeof navigator.serviceWorker.getRegistration === "function") {
    try {
      registration = await navigator.serviceWorker.getRegistration();
    } catch (error) {
      console.warn("Unable to find the service worker registration.", error);
    }
  }
  if (!isDeliveryEnabled()) return;
  if (registration && typeof registration.showNotification === "function") {
    try {
      await registration.showNotification(notification.title, options);
      return;
    } catch (error) {
      console.warn("Service worker notification failed; trying the browser fallback.", error);
    }
  }
  if (!isDeliveryEnabled()) return;
  try {
    if (typeof window.Notification === "function") {
      const systemNotification = new window.Notification(notification.title, options);
      systemNotification.onclick = () => {
        window.focus();
        navigateToNotificationPanel(notification.panel);
        systemNotification.close();
      };
    }
  } catch (error) {
    console.warn("System notifications are unavailable in this browser context.", error);
  }
}

function initializeNotificationCenter() {
  const bell = document.getElementById("notification-bell");
  const popover = document.getElementById("notification-popover");
  const center = document.getElementById("notification-center");
  if (!bell || !popover || !center) return;

  bell.addEventListener("click", () => {
    popover.hidden = !popover.hidden;
    bell.setAttribute("aria-expanded", String(!popover.hidden));
    if (!popover.hidden) document.getElementById("notification-mark-all-read")?.focus();
  });
  document.getElementById("notification-enable-device-alerts")?.addEventListener("click", () => {
    void requestDeviceAlertPermission();
  });
  document.getElementById("notification-mark-all-read")?.addEventListener("click", () => {
    const checkedAt = Date.now();
    notificationState.items.forEach((item) => {
      item.unread = false;
    });
    notificationState.lastCheckedAt = checkedAt;
    persistNotificationState();
    renderNotificationCenter();
  });
  document.addEventListener("click", (event) => {
    if (!center.contains(event.target)) closeNotificationPopover();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) {
      closeNotificationPopover();
      bell.focus();
    }
  });
  renderNotificationCenter();
}

function getNotificationPromptAnsweredKey(session) {
  return `${getNotificationStorageKey(session)}${NOTIFICATION_PROMPT_ANSWERED_SUFFIX}`;
}

function hasAnsweredNotificationPrompt(session) {
  try {
    return ["allowed", "later"].includes(localStorage.getItem(getNotificationPromptAnsweredKey(session)));
  } catch (error) {
    console.error("Unable to read notification prompt preference.", error);
    return false;
  }
}

function recordNotificationPromptAnswer(session, answer) {
  try {
    localStorage.setItem(getNotificationPromptAnsweredKey(session), answer);
  } catch (error) {
    console.error("Unable to save notification prompt preference.", error);
  }
}

function closeNotificationPermissionPrompt() {
  const modal = document.getElementById("notification-permission-modal");
  if (!modal) return;
  modal.hidden = true;
  document.getElementById("notification-bell")?.focus();
}

function showNotificationPermissionPrompt(session) {
  if (!session || activeSession !== session || String(session.role || "").toLowerCase() === "admin" || hasAnsweredNotificationPrompt(session)) return;
  const modal = document.getElementById("notification-permission-modal");
  if (!modal || !modal.hidden) return;
  modal.hidden = false;
  document.getElementById("notification-permission-allow")?.focus();
}

function initializeNotificationPermissionPrompt() {
  const modal = document.getElementById("notification-permission-modal");
  const allowButton = document.getElementById("notification-permission-allow");
  const laterButton = document.getElementById("notification-permission-later");
  if (!modal || !allowButton || !laterButton) return;

  allowButton.addEventListener("click", () => {
    if (!activeSession) return;
    recordNotificationPromptAnswer(activeSession, "allowed");
    renderProfileNotificationsToggle(true);
    try {
      localStorage.setItem(PROFILE_NOTIFICATIONS_KEY, "true");
      setProfileSettingsMessage("Notifications enabled for this device.");
    } catch (error) {
      console.error("Unable to save the notification preference.", error);
      setProfileSettingsMessage("Notifications are enabled for this session but could not be saved.");
    }
    renderNotificationCenter();
    void requestDeviceAlertPermission();
    closeNotificationPermissionPrompt();
  });

  laterButton.addEventListener("click", () => {
    if (activeSession) recordNotificationPromptAnswer(activeSession, "later");
    closeNotificationPermissionPrompt();
  });

  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      laterButton.click();
      return;
    }
    if (event.key !== "Tab") return;
    const firstButton = allowButton;
    const lastButton = laterButton;
    if (event.shiftKey && document.activeElement === firstButton) {
      event.preventDefault();
      lastButton.focus();
    } else if (!event.shiftKey && document.activeElement === lastButton) {
      event.preventDefault();
      firstButton.focus();
    }
  });
}

function initializeProfileSettings() {
  renderProfileNotificationsToggle(readProfileNotificationsPreference());

  const activityButton = document.getElementById("profile-activity-button");
  activityButton?.addEventListener("click", () => {
    openProfileDialog("profile-activity-dialog");
    renderProfileActivity();
    void refreshProfileData(activeSession);
  });

  document.getElementById("profile-notifications-toggle")?.addEventListener("click", (event) => {
    const toggle = event.currentTarget;
    const enabled = toggle.getAttribute("aria-checked") !== "true";
    renderProfileNotificationsToggle(enabled);
    try {
      localStorage.setItem(PROFILE_NOTIFICATIONS_KEY, String(enabled));
      setProfileSettingsMessage(`Notifications ${enabled ? "enabled" : "disabled"} for this device.`);
    } catch (error) {
      console.error("Unable to save the notification preference.", error);
      setProfileSettingsMessage("The notification preference could not be saved on this device.");
    }
    if (enabled) void requestDeviceAlertPermission();
    renderNotificationCenter();
  });

  document.getElementById("profile-appearance-button")?.addEventListener("click", () => {
    openProfileDialog("profile-appearance-dialog");
  });
  document.getElementById("profile-about-button")?.addEventListener("click", () => {
    openProfileDialog("profile-about-dialog");
  });
  document.getElementById("profile-help-button")?.addEventListener("click", () => {
    openProfileDialog("profile-help-dialog");
  });
  document.getElementById("profile-logout-button")?.addEventListener("click", () => {
    document.querySelectorAll(".profile-dialog[open]").forEach(closeProfileDialog);
    void performLogout();
  });

  document.querySelectorAll(".profile-dialog").forEach((dialog) => {
    dialog.querySelectorAll("[data-profile-dialog-close]").forEach((button) => {
      button.addEventListener("click", () => closeProfileDialog(dialog));
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeProfileDialog(dialog);
    });
  });

  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#profile-view" && activeSession) {
      void refreshProfileData(activeSession);
    }
  });
}

function initializeProfileNoteTracking() {
  const notesList = document.getElementById("notes-list-container");
  if (!notesList) return;
  notesList.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("a.note-card-link")) recordProfileNoteView();
  });
}

function getDeviceToken(preferredToken = "") {
  let token = localStorage.getItem("classPortal.deviceToken") || preferredToken;
  if (!token) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    token = `token_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  localStorage.setItem("classPortal.deviceToken", token);
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
  const deviceToken = getDeviceToken(session.deviceToken || session.device_token);
  const appSession = {
    name: session.name || "",
    role: session.role || "student",
    division: session.division || "",
    rollNo: session.rollNo || session.roll_number || "",
    roll_number: session.roll_number || session.rollNo || "",
    accessCode: session.accessCode || session.access_code || "",
    access_code: session.access_code || session.accessCode || "",
    deviceId,
    deviceToken,
    device_token: deviceToken
  };

  try {
    localStorage.setItem("northstar_session", JSON.stringify({
      roll_number: appSession.roll_number,
      access_code: appSession.access_code,
      name: appSession.name,
      role: appSession.role,
      division: appSession.division,
      device_token: deviceToken,
      device_id: deviceId,
      deviceId
    }));
    localStorage.setItem("northstar_auth_token", "true");
    if (appSession.roll_number) {
      localStorage.setItem("northstar_user_roll", String(appSession.roll_number));
    }
    if (appSession.division) {
      localStorage.setItem("northstar_user_division", appSession.division);
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
    localStorage.removeItem("northstar_user_division");
    localStorage.removeItem("classPortal.activeSession");
  } catch (error) {
    console.error("Unable to clear saved portal session.", error);
  }
}

function normalizeStoredSession(rawSession) {
  if (!rawSession) return null;
  const normalized = {
    name: rawSession.name || rawSession.student_name || "",
    role: rawSession.role || "student",
    division: rawSession.division || "",
    rollNo: rawSession.rollNo || rawSession.roll_number || "",
    roll_number: rawSession.roll_number || rawSession.rollNo || "",
    accessCode: rawSession.accessCode || rawSession.access_code || "",
    access_code: rawSession.access_code || rawSession.accessCode || "",
    deviceId: rawSession.deviceId || rawSession.device_id || "",
    deviceToken: rawSession.deviceToken || rawSession.device_token || localStorage.getItem("classPortal.deviceToken") || ""
  };
  return normalized.rollNo || normalized.roll_number ? normalized : null;
}

async function showApp(session) {
  activeSession = session;
  initializeNotificationState(session);
  persistSession(session);
  isAdmin = session.role?.toLowerCase() === "admin";
  renderUser(session);
  void refreshProfileData(session);
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
  await loadPortalNotice(isAdmin);
  if (portalNoticeRefreshTimer) clearInterval(portalNoticeRefreshTimer);
  portalNoticeRefreshTimer = setInterval(() => {
    void loadPortalNotice(false);
  }, 60000);
  await Promise.all([renderCodes(), fetchQuestions(), fetchNotes(), fetchPolls()]);
  showNotificationPermissionPrompt(session);
}

function renderPortalNotice(notice) {
  const banner = document.getElementById("portal-notice-banner");
  const textElement = document.getElementById("portal-notice-text");
  const targetElement = document.getElementById("portal-notice-target");
  const countdown = document.getElementById("portal-notice-countdown");
  if (!banner || !textElement || !targetElement || !countdown) return;

  if (!notice?.is_active || !notice.notice_text) {
    banner.hidden = true;
    return;
  }

  textElement.textContent = notice.notice_text;
  banner.hidden = false;
  const targetAt = notice.target_at ? new Date(notice.target_at) : null;
  if (!targetAt || Number.isNaN(targetAt.getTime())) {
    targetElement.hidden = true;
    countdown.hidden = true;
    return;
  }

  targetElement.hidden = false;
  targetElement.textContent = `Target: ${targetAt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  const remaining = targetAt.getTime() - Date.now();
  if (remaining <= 0) {
    targetElement.textContent += " · Target time has passed";
    countdown.hidden = true;
    return;
  }

  countdown.hidden = false;
  const totalMinutes = Math.floor(remaining / 60000);
  document.getElementById("notice-countdown-days").textContent = String(Math.floor(totalMinutes / 1440));
  document.getElementById("notice-countdown-hours").textContent = String(Math.floor((totalMinutes % 1440) / 60)).padStart(2, "0");
  document.getElementById("notice-countdown-minutes").textContent = String(totalMinutes % 60).padStart(2, "0");
}

async function loadPortalNotice(populateAdminForm = false) {
  const banner = document.getElementById("portal-notice-banner");
  const { data: notice, error } = await supabaseClient
    .from("PortalNotices")
    .select("notice_text, target_at, is_active")
    .eq("notice_id", 1)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("Unable to load the portal notice.", error);
    if (populateAdminForm && isAdmin) {
      showMessage(document.getElementById("portal-notice-admin-message"), error.message || "Unable to load the current notice.", true);
    }
    if (banner && banner.hidden) {
      banner.hidden = false;
      document.getElementById("portal-notice-text").textContent = "The current notice could not be loaded. Please try again later.";
      document.getElementById("portal-notice-target").hidden = true;
      document.getElementById("portal-notice-countdown").hidden = true;
    }
    return;
  }

  observePortalNotice(notice);
  renderPortalNotice(notice);
  if (populateAdminForm && isAdmin) {
    document.getElementById("portal-notice-input").value = notice?.notice_text || "";
    if (notice?.target_at) {
      const localTarget = new Date(notice.target_at);
      localTarget.setMinutes(localTarget.getMinutes() - localTarget.getTimezoneOffset());
      document.getElementById("portal-notice-date").value = localTarget.toISOString().slice(0, 16);
    } else {
      document.getElementById("portal-notice-date").value = "";
    }
    showMessage(document.getElementById("portal-notice-admin-message"), "");
  }
}

async function persistPortalNotice({ isActive, noticeText = null, targetAt = null }) {
  if (!isAdmin || String(activeSession?.role || "").toLowerCase() !== "admin" || !activeSession) {
    throw new Error("Only an administrator can manage portal notices.");
  }

  const { error } = await supabaseClient.rpc("set_portal_notice", {
    p_division: activeSession.division,
    p_roll_number: String(activeSession.rollNo || activeSession.roll_number),
    p_access_code: String(activeSession.accessCode || activeSession.access_code),
    p_notice_text: noticeText,
    p_target_at: targetAt,
    p_is_active: isActive
  });
  if (error) throw error;
}

function readPersistedSession() {
  for (const key of ["northstar_session", "classPortal.activeSession"]) {
    const savedSession = localStorage.getItem(key);
    if (!savedSession) continue;
    try {
      const session = normalizeStoredSession(JSON.parse(savedSession));
      if (session?.rollNo && session.division && session.accessCode) return session;
    } catch (error) {
      console.error(`Unable to parse saved session from ${key}.`, error);
    }
  }
  return null;
}

async function login(rollNo, division, accessCode, deviceToken = getDeviceToken()) {
  const normalizedCode = String(accessCode || "").trim().toUpperCase();
  const myToken = getDeviceToken(deviceToken);
  const { data: claim, error } = await supabaseClient.rpc("claim_credentials_session", {
    p_division: division,
    p_roll_number: String(rollNo),
    p_access_code: normalizedCode,
    p_device_token: myToken
  });
  if (error) throw error;
  if (claim?.status === "not_found") return null;
  if (claim?.status === "limit_reached") return { limitReached: true };
  if (claim?.status !== "claimed") throw new Error("Unable to claim this device session.");

  return {
    name: titleCaseName(claim.name?.trim() || `Student ${claim.roll_number || rollNo}`),
    role: claim.role || "student",
    division: claim.division,
    rollNo: claim.roll_number || rollNo || "-",
    accessCode: claim.access_code,
    deviceToken: myToken,
    device_token: myToken
  };
}

async function isStudentNameTaken(customName, currentRollNo, currentDivision) {
  const { data: matches, error } = await supabaseClient
    .from("Credentials")
    .select("roll_number, division")
    .ilike("student_name", customName)
    .limit(20);
  if (error) throw error;
  return matches.some((record) =>
    String(record.roll_number) !== String(currentRollNo) ||
    String(record.division || "") !== String(currentDivision || "")
  );
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
  const avatar = document.createElement("div");
  const author = document.createElement("strong");
  const roleBadge = document.createElement("span");
  const time = document.createElement("time");
  const text = document.createElement("p");
  const controls = document.createElement("div");

  card.className = "answer-card";
  if (answer.is_verified) card.classList.add("is-verified");
  metadata.className = "answer-card-meta";
  avatar.className = "answer-avatar";
  avatar.textContent = (answer.answered_by || "S").trim().charAt(0).toUpperCase();
  author.textContent = answer.answered_by || "Student";
  roleBadge.className = "note-role-badge";
  roleBadge.textContent = answer.author_role === "admin" ? "Admin" : "Student";
  time.textContent = formatTimestamp(answer.created_at);
  text.textContent = answer.answer_text || "";
  metadata.append(avatar, author, roleBadge);
  if (answer.is_verified) {
    const verifiedHeading = document.createElement("div");
    const verifiedBadge = document.createElement("span");
    verifiedHeading.className = "answer-verified-heading";
    verifiedHeading.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 1.5 17 4v5c0 4.2-2.8 7.4-7 9.5C5.8 16.4 3 13.2 3 9V4l7-2.5Z" fill="currentColor"/><path d="m6.8 9.8 2.1 2.1 4.5-4.7" stroke="#09251c" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    verifiedBadge.className = "answer-verified-badge";
    verifiedBadge.textContent = "Admin Verified";
    verifiedHeading.appendChild(verifiedBadge);
    card.appendChild(verifiedHeading);
  }
  metadata.append(time);
  card.append(metadata, text);

  if (isAdmin && activeSession?.role?.toLowerCase() === "admin") {
    controls.className = "answer-admin-controls";
    const verifyButton = document.createElement("button");
    verifyButton.className = "answer-verify-button";
    verifyButton.type = "button";
    verifyButton.textContent = answer.is_verified ? "Unverify" : "Verify / Pin Answer";
    verifyButton.setAttribute("aria-pressed", String(Boolean(answer.is_verified)));
    verifyButton.addEventListener("click", async () => {
      verifyButton.disabled = true;
      try {
        await setAnswerVerified(answer.id, !answer.is_verified);
        await fetchAnswersForQuestion(answer.doubt_id);
      } catch (error) {
        console.error("Unable to update answer verification.", error);
        window.alert(error.message || "Unable to update answer verification.");
        verifyButton.disabled = false;
      }
    });
    controls.appendChild(verifyButton);
    card.appendChild(controls);
  }
  return card;
}

async function setAnswerVerified(answerId, isVerified) {
  if (!isAdmin || activeSession?.role?.toLowerCase() !== "admin" || !activeSession) {
    throw new Error("Only an administrator can verify or unverify replies.");
  }
  const { data: updated, error } = await supabaseClient.rpc("set_answer_verified", {
    p_division: activeSession.division,
    p_roll_number: String(activeSession.rollNo || activeSession.roll_number),
    p_access_code: String(activeSession.accessCode || activeSession.access_code),
    p_answer_id: String(answerId),
    p_is_verified: isVerified
  });
  if (error) throw error;
  if (!updated) throw new Error("The reply could not be found.");
}

async function fetchAnswersForQuestion(questionId) {
  const answersContainers = [...document.querySelectorAll(".answers-list")]
    .filter((container) => container.dataset.questionId === String(questionId));
  if (!answersContainers.length) return;

  const { data: answers, error } = await supabaseClient
    .from("answers")
    .select("*")
    .eq("doubt_id", questionId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Unable to load answers for question.", error);
    answersContainers.forEach((container) => {
      container.replaceChildren();
      const errorMessage = document.createElement("p");
      errorMessage.className = "answers-empty";
      errorMessage.textContent = "Replies could not be loaded. Please try again.";
      container.appendChild(errorMessage);
      const card = container.closest(".question-card");
      if (card) card.dataset.replyCount = "error";
    });
    applyQuestionFilters();
    return;
  }

  answers.sort((left, right) => {
    const verificationOrder = Number(Boolean(right.is_verified)) - Number(Boolean(left.is_verified));
    if (verificationOrder) return verificationOrder;
    return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
  });

  answersContainers.forEach((container) => {
    if (answers.length) {
      container.replaceChildren(...answers.map(renderAnswerCard));
    } else {
      const emptyState = document.createElement("p");
      emptyState.className = "answers-empty";
      emptyState.textContent = "No replies yet. You can add the first one below.";
      container.replaceChildren(emptyState);
    }
    const answerCount = container.closest(".question-card")?.querySelector(".answer-count");
    const questionCard = container.closest(".question-card");
    if (questionCard) {
      questionCard.dataset.replyCount = String(answers.length);
    }
    if (answerCount) {
      answerCount.textContent = answers.length
        ? `💬 ${answers.length}`
        : "💬 0";
    }
  });
  applyQuestionFilters();
}

async function postReply(questionId, replyInput, replyButton) {
  const answerText = replyInput?.value.trim();
  if (!answerText || !activeSession || !isLoggedIn) return;

  if (replyButton) replyButton.disabled = true;
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
  if (replyButton) replyButton.disabled = false;
}

function renderReplySection(body, question) {
  const questionId = question.id;
  if (questionId === undefined || questionId === null) return;
  const threadHeader = document.createElement("div");
  const backButton = document.createElement("button");
  const threadTitle = document.createElement("strong");
  const answersList = document.createElement("div");
  const repliesHeading = document.createElement("h4");
  const replyForm = document.createElement("form");
  const replyInput = document.createElement("input");
  const replyButton = document.createElement("button");
  threadHeader.className = "question-thread-header";
  backButton.className = "question-thread-back";
  backButton.type = "button";
  backButton.textContent = "< Back";
  threadTitle.textContent = "Doubt Thread";
  threadHeader.append(backButton, threadTitle);
  backButton.addEventListener("click", () => {
    const summary = body.closest(".question-card")?.querySelector(".question-summary");
    if (!summary) return;
    toggleQuestionThread(summary);
    summary.focus();
  });
  answersList.className = "answers-list";
  answersList.dataset.questionId = String(questionId);
  answersList.setAttribute("aria-live", "polite");
  repliesHeading.className = "replies-heading";
  repliesHeading.textContent = "Replies";
  const loadingMessage = document.createElement("p");
  loadingMessage.className = "answers-empty";
  loadingMessage.textContent = "Loading replies…";
  answersList.appendChild(loadingMessage);
  replyForm.className = "reply-form";
  replyInput.type = "text";
  replyInput.className = "reply-input";
  replyInput.placeholder = isLoggedIn ? "Write a reply..." : "Login to reply...";
  replyInput.required = true;
  replyInput.disabled = !isLoggedIn;
  replyButton.className = "reply-button reply-submit button button-outline";
  replyButton.type = "submit";
  replyButton.textContent = "➤";
  replyButton.setAttribute("aria-label", isLoggedIn ? "Send reply" : "Login to reply");
  replyButton.disabled = !isLoggedIn;
  replyButton.title = isLoggedIn ? "Post a reply" : "Log in to participate.";

  replyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isLoggedIn) {
      window.alert("Please log in to participate.");
      return;
    }
    void postReply(questionId, replyInput, replyButton);
  });

  replyForm.append(replyInput, replyButton);
  body.append(threadHeader, repliesHeading, answersList, replyForm);
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
  const icon = document.createElement("span");
  const content = document.createElement("div");
  const title = document.createElement("h4");
  const metadata = document.createElement("div");
  const uploader = document.createElement("span");
  const roleBadge = document.createElement("span");
  const actions = document.createElement("div");
  const link = document.createElement("a");
  const deleteButton = document.createElement("button");

  card.className = "note-card";
  icon.className = "note-card-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 3.75h8l4.25 4.3v12.2H6a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 4v4.5h4.5M8 12h8M8 15.5h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  content.className = "note-card-content";
  title.textContent = note.title || "Untitled note";
  metadata.className = "note-card-meta";
  const uploaderName = note.uploaded_by || note.uploader_name || note.student_name || note.author_name || note.roll_number || "Portal member";
  uploader.textContent = `Uploaded by: ${uploaderName}`;
  roleBadge.className = "note-role-badge";
  const isAdminUploader = String(note.role || "student").toLowerCase() === "admin";
  roleBadge.textContent = isAdminUploader ? "Admin" : "Student";
  if (isAdminUploader) roleBadge.classList.add("note-admin-badge");
  metadata.append(uploader, roleBadge);
  if (note.subject) {
    const subjectBadge = document.createElement("span");
    subjectBadge.className = "note-role-badge note-subject-badge";
    subjectBadge.textContent = note.subject;
    metadata.append(subjectBadge);
  }
  actions.className = "note-card-actions";
  link.className = "note-card-link";
  link.href = `https://docs.google.com/viewer?url=${encodeURIComponent(note.file_url)}&embedded=true`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View PDF";
  const linkArrow = document.createElement("span");
  linkArrow.setAttribute("aria-hidden", "true");
  linkArrow.textContent = " \u2192";
  link.appendChild(linkArrow);
  deleteButton.className = "button button-outline delete-note-button";
  deleteButton.type = "button";
  deleteButton.setAttribute("aria-label", "Delete note");
  const deleteIcon = document.createElement("span");
  deleteIcon.className = "delete-note-icon";
  deleteIcon.setAttribute("aria-hidden", "true");
  deleteIcon.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="M3.5 5.5h13M8 5.5V3.7h4v1.8m-6.5 0 .8 10.8h7.4l.8-10.8M8.2 8.3v5.3m3.6-5.3v5.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const deleteLabel = document.createElement("span");
  deleteLabel.textContent = "Delete";
  deleteButton.append(deleteIcon, deleteLabel);
  const canDelete = canDeleteNote(note);
  deleteButton.disabled = !canDelete;
  deleteButton.title = canDelete ? "Delete this note" : "Only the uploader or an admin can delete this note";
  deleteButton.addEventListener("click", () => void deleteNote(note, card));
  content.append(title, metadata);
  actions.append(link, deleteButton);
  card.append(icon, content, actions);
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
  const heading = document.createElement("div");
  const question = document.createElement("h4");
  const liveBadge = document.createElement("span");
  card.className = "poll-card";
  card.dataset.pollId = String(poll.poll_id);
  heading.className = "poll-card-heading";
  liveBadge.className = "poll-live-badge";
  liveBadge.innerHTML = '<i aria-hidden="true"></i><span>Live</span>';
  question.textContent = poll.question || poll.question_text || "Poll";
  heading.append(question, liveBadge);
  card.append(heading);

  if (userVote) {
    card.append(createPollResults(options, userVote), createPollCardFooter(options));
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
  card.append(optionsForm, createPollCardFooter(options));
  return card;
}

function createPollCardFooter(options) {
  const footer = document.createElement("div");
  const totalGroup = document.createElement("span");
  const icon = document.createElement("span");
  const count = document.createElement("span");
  const liveUpdate = document.createElement("span");

  footer.className = "poll-card-footer";
  totalGroup.className = "poll-total-votes";
  totalGroup.setAttribute("aria-label", "Total poll votes");
  icon.className = "poll-total-votes-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="M7.2 9a2.35 2.35 0 1 0 0-4.7 2.35 2.35 0 0 0 0 4.7ZM13.4 8.3a1.9 1.9 0 1 0 0-3.8M2.8 15.6c.4-2.3 2-3.5 4.4-3.5s4 1.2 4.4 3.5M12 12.4c2.6-.4 4.3.8 4.8 3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  count.className = "poll-total-votes-count";
  liveUpdate.className = "poll-live-update";
  liveUpdate.innerHTML = '<i aria-hidden="true"></i><span>Updates in real-time</span>';
  totalGroup.append(icon, count);
  footer.append(totalGroup, liveUpdate);
  updatePollCardFooter(footer, options);
  return footer;
}

function updatePollCardFooter(footer, options) {
  const totalVotes = options.reduce((total, option) => total + Number(option.vote_count || 0), 0);
  const count = footer.querySelector(".poll-total-votes-count");
  if (count) count.textContent = `${totalVotes} ${totalVotes === 1 ? "vote" : "votes"}`;
  const totalGroup = footer.querySelector(".poll-total-votes");
  if (totalGroup) totalGroup.setAttribute("aria-label", `Total poll votes: ${totalVotes}`);
}

function createPollResults(options, userVote) {
  const results = document.createElement("div");
  results.className = "poll-results";
  const totalVotes = options.reduce((total, option) => total + Number(option.vote_count || 0), 0);
  options.forEach((option, index) => {
    const row = document.createElement("div");
    const metadata = document.createElement("div");
    const label = document.createElement("strong");
    const count = document.createElement("span");
    const track = document.createElement("div");
    const fill = document.createElement("div");
    const votes = Number(option.vote_count || 0);
    const percentage = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
    row.className = `poll-result-row poll-result-color-${index % 4}${String(userVote.option_id) === String(option.id) ? " is-voted" : ""}`;
    row.dataset.optionId = String(option.id);
    metadata.className = "poll-result-meta";
    label.textContent = option.option_text || option.text || "Option";
    count.className = "poll-result-count";
    count.textContent = `${percentage}%`;
    count.setAttribute("aria-label", `${percentage}%, ${votes} ${votes === 1 ? "vote" : "votes"}`);
    track.className = "poll-result-track";
    fill.className = "poll-result-fill";
    fill.style.width = "0%";
    requestAnimationFrame(() => { fill.style.width = `${percentage}%`; });
    track.append(fill);
    metadata.append(label, count);
    row.append(metadata, track);
    results.append(row);
  });
  return results;
}

function updatePollCardResults(card, options, userVote) {
  let results = card.querySelector(".poll-results");
  if (!results) {
    card.querySelector(".poll-vote-form")?.remove();
    results = createPollResults(options, userVote);
    const footer = card.querySelector(".poll-card-footer");
    if (footer) card.insertBefore(results, footer);
    else card.append(results);
    updatePollCardFooter(card, options);
    return;
  }

  const totalVotes = options.reduce((total, option) => total + Number(option.vote_count || 0), 0);
  options.forEach((option, index) => {
    const row = [...results.querySelectorAll(".poll-result-row")]
      .find((resultRow) => resultRow.dataset.optionId === String(option.id));
    if (!row) {
      results.replaceWith(createPollResults(options, userVote));
      updatePollCardFooter(card, options);
      return;
    }

    const votes = Number(option.vote_count || 0);
    const percentage = totalVotes ? Math.round((votes / totalVotes) * 100) : 0;
    const count = row.querySelector(".poll-result-count");
    const fill = row.querySelector(".poll-result-fill");
    if (count) {
      count.textContent = `${percentage}%`;
      count.setAttribute("aria-label", `${percentage}%, ${votes} ${votes === 1 ? "vote" : "votes"}`);
    }
    if (fill) fill.style.width = `${percentage}%`;
    row.classList.remove("poll-result-color-0", "poll-result-color-1", "poll-result-color-2", "poll-result-color-3");
    row.classList.add(`poll-result-color-${index % 4}`);
    row.classList.toggle("is-voted", String(userVote.option_id) === String(option.id));
  });
  updatePollCardFooter(card, options);
}

async function fetchPolls({ updateResultsOnly = false, pollId = null } = {}) {
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
  observeNewPolls(polls || []);
  if (!polls.length) {
    if (!updateResultsOnly) pollList.replaceChildren();
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

  if (updateResultsOnly) {
    polls.forEach((poll) => {
      if (pollId !== null && String(poll.poll_id) !== String(pollId)) return;
      const card = [...pollList.querySelectorAll(".poll-card")]
        .find((pollCard) => pollCard.dataset.pollId === String(poll.poll_id));
      const userVote = votes.find((vote) => String(vote.poll_id) === String(poll.poll_id));
      if (!card || !userVote) return;
      const pollOptions = options.filter((option) => String(option.poll_id) === String(poll.poll_id));
      updatePollCardResults(card, pollOptions, userVote);
    });
    return;
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
    await fetchPolls({ updateResultsOnly: true, pollId: poll.poll_id });
  } catch (error) {
    console.error("Unable to submit poll vote.", error);
    window.alert(error.message || "Unable to submit your vote.");
    if (voteRecorded) await fetchPolls({ updateResultsOnly: true, pollId: poll.poll_id });
    else voteButton.disabled = false;
  }
}

function subscribeToPollChanges() {
  if (realtimePollsChannel) return realtimePollsChannel;
  realtimePollsChannel = supabaseClient
    .channel("realtime-polls")
    .on("postgres_changes", { event: "*", schema: "public", table: "poll_options" }, () => fetchPolls({ updateResultsOnly: true }))
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.error("Unable to subscribe to poll updates.");
    });
  return realtimePollsChannel;
}

function renderQuestionCard(item, feedName) {
  const card = document.createElement("article");
  const summary = document.createElement("button");
  const avatar = document.createElement("div");
  const body = document.createElement("div");
  const metadata = document.createElement("div");
  const author = document.createElement("strong");
  const division = document.createElement("span");
  const time = document.createElement("span");
  const question = document.createElement("p");
  const answers = document.createElement("div");
  const badge = document.createElement("span");
  const subject = item.subject || "General";
  const divisionName = item.division || item.student_division || "";
  const thread = document.createElement("div");

  card.className = "question-card";
  card.dataset.subject = subject;
  card.dataset.searchText = `${item.author_name || item.author || ""} ${divisionName} ${subject} ${item.question_text || item.question || ""}`.toLocaleLowerCase();
  card.dataset.replyCount = "unknown";
  card.dataset.feed = feedName;
  summary.className = "question-summary";
  summary.type = "button";
  summary.setAttribute("aria-expanded", "false");
  avatar.className = "feed-avatar blue";
  avatar.textContent = (item.author_name || item.author || "S").charAt(0).toUpperCase();
  body.className = "question-body";
  metadata.className = "question-meta";
  author.textContent = item.author_name || item.author || "Student";
  time.className = "question-time";
  time.textContent = formatTimestamp(item.created_at || item.timestamp);
  question.textContent = item.question_text || item.question || "";
  answers.className = "answer-count";
  answers.textContent = "💬 …";
  badge.className = "question-subject-badge";
  badge.textContent = subject;
  division.className = "question-division-badge";
  division.textContent = divisionName;
  if (divisionName) metadata.append(author, division);
  else metadata.append(author);
  metadata.append(time);
  body.append(metadata, badge, question, answers);
  thread.className = "question-thread";
  thread.hidden = true;
  renderReplySection(thread, item);
  const threadHeader = thread.querySelector(".question-thread-header");
  if (threadHeader) {
    threadHeader.hidden = true;
    card.appendChild(threadHeader);
  }
  summary.append(avatar, body);
  summary.addEventListener("click", () => toggleQuestionThread(summary));
  card.append(summary, thread);
  return card;
}

function toggleQuestionThread(summary) {
  const thread = summary.closest(".question-card")?.querySelector(".question-thread");
  if (!thread) return;
  const expanded = summary.getAttribute("aria-expanded") === "true";
  summary.setAttribute("aria-expanded", String(!expanded));
  const threadHeader = summary.closest(".question-card")?.querySelector(".question-thread-header");
  if (threadHeader) threadHeader.hidden = expanded;
  thread.hidden = expanded;
}

document.querySelectorAll("#questions-feed .question-summary").forEach((summary) => {
  summary.addEventListener("click", () => toggleQuestionThread(summary));
});

document.querySelectorAll("#questions-feed .question-thread-back").forEach((backButton) => {
  backButton.addEventListener("click", () => {
    const summary = backButton.closest(".question-card")?.querySelector(".question-summary");
    if (!summary) return;
    toggleQuestionThread(summary);
    summary.focus();
  });
});

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
  void checkForRecentQuestionReplies(questions);
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
      { event: "*", schema: "public", table: "answers" },
      (payload) => {
        const answerId = payload.new?.id;
        if (payload.eventType === "INSERT" && answerId && locallyPostedAnswerIds.has(answerId)) {
          locallyPostedAnswerIds.delete(answerId);
          return;
        }
        if (payload.eventType === "INSERT" && payload.new) recordQuestionReplyNotification(payload.new);
        const questionId = payload.new?.doubt_id || payload.old?.doubt_id;
        if (questionId) void fetchAnswersForQuestion(questionId);
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
  const division = String(formData.get("division") || "").trim();
  submitButton.disabled = true;
  showMessage(loginMessage, "Checking access...");

  try {
    const session = await login(rollNo, division, formData.get("accessCode"));
    if (session?.limitReached) {
      showMessage(loginMessage, "This account is already active on 2 devices. Log out on one device before signing in here.", true);
      return;
    }
    if (!session) {
      showMessage(loginMessage, "No account matches that division, roll number, and access code.", true);
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

document.querySelectorAll("[data-open-panel]").forEach((button) => {
  button.addEventListener("click", () => {
    const targetPanel = button.dataset.openPanel;
    [...dashboardTabs].find((tab) => tab.dataset.panel === targetPanel)?.click();
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
    if (await isStudentNameTaken(customName, activeSession.rollNo, activeSession.division)) {
      window.alert("This name is already in use. Please choose a different display name.");
      showMessage(message, "Choose a different display name.", true);
      return;
    }

    const { error } = await supabaseClient
      .from("Credentials")
      .update({ student_name: customName })
      .eq("division", activeSession.division)
      .eq("roll_number", activeSession.rollNo);
    if (error) throw error;

    activeSession.name = titleCaseName(customName);
    persistSession(activeSession);
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
  const sessionToRelease = activeSession;
  if (sessionToRelease) await releaseActiveSession(sessionToRelease);
  if (sessionHeartbeat) clearInterval(sessionHeartbeat);
  if (portalNoticeRefreshTimer) clearInterval(portalNoticeRefreshTimer);
  sessionHeartbeat = null;
  portalNoticeRefreshTimer = null;
  activeSession = null;
  isAdmin = false;
  updateUIState(false);
  clearPersistedSession();
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
  const division = String(formData.get("division") || "").trim();
  const rollNo = formData.get("rollNo");
  generateButton.disabled = true;

  try {
    const { data: existingAccounts, error: lookupError } = await supabaseClient
      .from("Credentials")
      .select("roll_number")
      .eq("division", division)
      .eq("roll_number", rollNo)
      .limit(1);
    if (lookupError) throw lookupError;
    if (existingAccounts?.length) {
      showMessage(document.getElementById("admin-code-message"), "An account already exists for this division and roll number.", true);
      generateButton.disabled = false;
      return;
    }

    const { error: insertError } = await supabaseClient
      .from("Credentials")
      .insert({ access_code: code, role, student_name: studentName, division, roll_number: rollNo });

    if (insertError) throw insertError;

    form.reset();
    showMessage(document.getElementById("admin-code-message"), "Access code created.");
    await renderCodes();
    generateButton.textContent = "Created";
    setTimeout(() => {
      generateButton.textContent = "Create code";
      generateButton.disabled = false;
    }, 1400);
  } catch (error) {
    console.error("Unable to create account credentials.", error);
    const message = error.code === "23505"
      ? "An account already exists for this division and roll number."
      : error.message || "Unable to create code.";
    showMessage(document.getElementById("admin-code-message"), message, true);
    generateButton.disabled = false;
  }
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
    const askDoubtToggle = document.getElementById("ask-doubt-toggle");
    if (askDoubtToggle?.getAttribute("aria-expanded") === "true") askDoubtToggle.click();
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
  const title = document.getElementById("note-title-input").value.trim();
  const subject = document.getElementById("note-category-input").value;
  const file = document.getElementById("note-file-input").files[0];
  const uploaderRole = isAdmin ? "admin" : "student";
  const uploaderName = activeSession?.name || "Student";
  const uploaderId = activeSession?.rollNo || "student";

  if (!file || file.type !== "application/pdf") {
    window.alert("Please select a PDF file only.");
    return;
  }
  if (!subject) {
    window.alert("Choose a subject for this note.");
    document.getElementById("note-category-input").focus();
    return;
  }
  if (file.size > MAX_PDF_SIZE) {
    window.alert("File size exceeds the 10 MB limit. Please upload a smaller PDF.");
    document.getElementById("note-file-input").value = "";
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
  progressContainer.hidden = false;
  cancelButton.hidden = false;
  noteUploadCancelRequested = false;
  try {
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
    const fileUrl = publicUrlData.publicUrl;

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

document.getElementById("portal-notice-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("portal-notice-admin-message");
  const submitButton = document.getElementById("save-portal-notice");
  if (!isAdmin || String(activeSession?.role || "").toLowerCase() !== "admin") {
    showMessage(message, "Only an administrator can manage portal notices.", true);
    return;
  }

  const noticeText = document.getElementById("portal-notice-input").value.trim();
  const dateValue = document.getElementById("portal-notice-date").value;
  const targetDate = dateValue ? new Date(dateValue) : null;
  if (!noticeText) {
    showMessage(message, "Enter notice text before publishing.", true);
    return;
  }
  if (targetDate && Number.isNaN(targetDate.getTime())) {
    showMessage(message, "Enter a valid target date and time.", true);
    return;
  }

  submitButton.disabled = true;
  try {
    await persistPortalNotice({
      isActive: true,
      noticeText,
      targetAt: targetDate ? targetDate.toISOString() : null
    });
    renderPortalNotice({ is_active: true, notice_text: noticeText, target_at: targetDate?.toISOString() || null });
    showMessage(message, "Notice published.");
  } catch (error) {
    console.error("Unable to publish portal notice.", error);
    showMessage(message, error.message || "Unable to publish notice.", true);
  } finally {
    submitButton.disabled = false;
  }
});

document.getElementById("clear-portal-notice").addEventListener("click", async (event) => {
  const clearButton = event.currentTarget;
  const message = document.getElementById("portal-notice-admin-message");
  if (!isAdmin || String(activeSession?.role || "").toLowerCase() !== "admin") {
    showMessage(message, "Only an administrator can manage portal notices.", true);
    return;
  }
  if (!window.confirm("Clear the active portal notice?")) return;

  clearButton.disabled = true;
  try {
    await persistPortalNotice({ isActive: false });
    renderPortalNotice(null);
    document.getElementById("portal-notice-form").reset();
    showMessage(message, "Active notice cleared.");
  } catch (error) {
    console.error("Unable to clear portal notice.", error);
    showMessage(message, error.message || "Unable to clear notice.", true);
  } finally {
    clearButton.disabled = false;
  }
});

populateSubjectOptions();

document.getElementById("question-subject-filter").addEventListener("change", (event) => {
  activeSubject = event.target.value;
  document.querySelectorAll(".subject-filter-pill").forEach((pill) => {
    const isActive = pill.dataset.subjectFilter === activeSubject;
    pill.classList.toggle("is-active", isActive);
    pill.setAttribute("aria-pressed", String(isActive));
  });
  applyQuestionFilters();
});

document.getElementById("question-subject-pills").addEventListener("click", (event) => {
  const pill = event.target.closest("[data-subject-filter]");
  if (!pill) return;
  const subjectFilter = document.getElementById("question-subject-filter");
  subjectFilter.value = pill.dataset.subjectFilter;
  subjectFilter.dispatchEvent(new Event("change", { bubbles: true }));
});

document.getElementById("notes-search").addEventListener("input", (event) => {
  activeNotesSearch = event.target.value;
  renderNotes();
});

document.getElementById("notes-subject-filters").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-notes-subject]");
  if (!chip) return;
  activeNotesSubject = chip.dataset.notesSubject || "All";
  renderNotes();
});

document.getElementById("reset-notes-filters").addEventListener("click", () => {
  activeNotesSearch = "";
  activeNotesSubject = "All";
  document.getElementById("notes-search").value = "";
  renderNotes();
});

document.getElementById("question-search").addEventListener("input", (event) => {
  searchTerm = event.target.value;
  applyQuestionFilters();
});

document.getElementById("unanswered-only-filter").addEventListener("change", (event) => {
  unansweredOnly = event.target.checked;
  applyQuestionFilters();
});

document.getElementById("reset-question-filters").addEventListener("click", () => {
  activeSubject = "All";
  searchTerm = "";
  unansweredOnly = false;
  document.getElementById("question-subject-filter").value = "All";
  document.getElementById("question-search").value = "";
  document.getElementById("unanswered-only-filter").checked = false;
  document.querySelectorAll(".subject-filter-pill").forEach((pill) => {
    const isActive = pill.dataset.subjectFilter === "All";
    pill.classList.toggle("is-active", isActive);
    pill.setAttribute("aria-pressed", String(isActive));
  });
  applyQuestionFilters();
});

async function initApp() {
  if (initPromise) return initPromise;
  initPromise = initializeApp();
  return initPromise;
}

async function initializeApp() {
  const savedSession = readPersistedSession();
  if (!savedSession) {
    showWelcomePage();
    return;
  }

  const deviceToken = getDeviceToken(savedSession.deviceToken);
  savedSession.deviceToken = deviceToken;
  savedSession.device_token = deviceToken;
  if (navigator.onLine === false) {
    await showApp(savedSession);
  } else {
    try {
      const restoredSession = await login(
        String(savedSession.rollNo),
        savedSession.division,
        savedSession.accessCode,
        deviceToken
      );
      if (!restoredSession) {
        clearPersistedSession();
        showWelcomePage();
        openLoginModal();
        showMessage(loginMessage, "This saved session is no longer valid. Please sign in again.", true);
        return;
      }
      if (restoredSession.limitReached) {
        showWelcomePage();
        openLoginModal();
        showMessage(loginMessage, "This account is active on 2 devices. The saved session was kept; log out on one device before trying again.", true);
        return;
      }
      await showApp(restoredSession);
    } catch (error) {
      console.error("Unable to validate the saved session; restoring the saved portal view.", error);
      await showApp(savedSession);
    }
  }

  updateNotesCount();

  const notesList = document.getElementById("notes-list-container");
  if (notesList && !notesListObserver) {
    notesListObserver = new MutationObserver(updateNotesCount);
    notesListObserver.observe(notesList, { childList: true });
  }
}

initializePollCreator();

document.addEventListener("DOMContentLoaded", () => {
  initializeNotificationCenter();
  initializeNotificationPermissionPrompt();
  initializeProfileSettings();
  initializeProfileNoteTracking();
  void initApp();
}, { once: true });
