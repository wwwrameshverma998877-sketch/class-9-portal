const SUPABASE_URL = "https://jscgedmfzdxpbtmokazf.supabase.co/rest/v1/";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzY2dlZG1memR4cGJ0bW9rYXpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMTYwNjAsImV4cCI6MjEwNDc5MjA2MH0.bGFzIlqtQYfByOC9dGNEihIhX-jfX72g7tZ8-wZeTeg";
const SUPABASE_PROJECT_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");
const supabaseClient = supabase.createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY);
const DRIVE_FOLDER_ID = "1kvzcnMaijD6g06GT5loXUtJ1xom7N2t0";
const DRIVE_API_KEY = "AIzaSyDL9mJG7q0JFRXSKNjLKIdYR4nyS8I5ZE0";
const ADMIN_EMAIL = "www.rameshverma998877@gmail.com";

let activeSession = null;
let isLoggedIn = false;
let isAdmin = false;
let onboardingAuthUser = null;
let onboardingAccess = null;
let allQuestions = [];
let activeSubject = "All";
let searchTerm = "";
const locallyPostedAnswerIds = new Set();
let realtimeQuestionsChannel = null;
let realtimeNotesChannel = null;
let realtimeAnswersChannel = null;
let authStateSubscription = null;
let initPromise = null;
let notesListObserver = null;
let driveSyncPromise = null;

const loginModal = document.getElementById("login-modal");
const appView = document.getElementById("app-view");
const accessForm = document.getElementById("access-form");
const nameForm = document.getElementById("name-form");
const changeNameModal = document.getElementById("change-name-modal");
const changeNameForm = document.getElementById("change-name-form");
const loginMessage = document.getElementById("login-message");
const adminPanel = document.querySelector(".admin-panel");
const questionSection = document.querySelector(".ask-section");

function updateUIState(loggedIn) {
  isLoggedIn = loggedIn;
  if (adminPanel) adminPanel.hidden = !isAdmin;
  document.querySelectorAll(".reply-button").forEach((button) => {
    button.disabled = !loggedIn;
    button.textContent = loggedIn ? "Post Reply" : "Login to reply...";
    button.title = loggedIn ? "Post a reply" : "Please login with Google to participate.";
  });
  document.querySelectorAll(".reply-form input").forEach((input) => {
    input.disabled = !loggedIn;
    input.placeholder = loggedIn ? "Write an answer..." : "Login to reply...";
  });
  const uploadForm = document.getElementById("upload-notes-form");
  if (uploadForm) {
    uploadForm.querySelectorAll("input, button").forEach((control) => {
      control.disabled = !loggedIn;
      control.title = loggedIn ? "Upload notes or documents" : "Please login with Google to participate.";
    });
  }
  const postQuestionButton = document.getElementById("post-question-button");
  if (postQuestionButton) {
    postQuestionButton.disabled = !loggedIn;
    postQuestionButton.title = loggedIn ? "Post a new question" : "Please login with Google to participate.";
  }
  document.getElementById("nav-login-button").hidden = loggedIn;
  document.querySelector(".user-menu").hidden = !loggedIn;
}

async function signInWithGoogle() {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google"
  });
  if (error) {
    showMessage(loginMessage, "Unable to start Google sign-in.", true);
    console.error(error);
  }
}

async function handleAuthSession(authSession) {
  if (!authSession) {
    onboardingAuthUser = null;
    isAdmin = false;
    updateUIState(false);
    if (adminPanel) adminPanel.hidden = true;
    appView.hidden = true;
    loginModal.hidden = false;
    return;
  }

  onboardingAuthUser = authSession.user;
  isAdmin = onboardingAuthUser.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
  updateUIState(true);
  if (adminPanel) adminPanel.hidden = !isAdmin;
  if (activeSession?.authUserId === onboardingAuthUser.id) return;
  appView.hidden = true;
  loginModal.hidden = false;
  document.getElementById("onboarding-step-1").hidden = true;
  accessForm.hidden = false;
  document.getElementById("access-code").disabled = false;
  document.getElementById("roll-no").disabled = false;
  showMessage(loginMessage, "");
}

function titleCaseName(name) {
  return name.trim().replace(/\s+/g, " ").split(" ").map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

function getRollNo(record) {
  return record.rollNo || record.std || record.studentClass || "-";
}

async function releaseActiveSession(session = activeSession || onboardingAccess) {
  if (!session?.authUserId || !session.rollNo || session.rollNo === "-") return;
  try {
    const response = await fetch(`${SUPABASE_URL}Credentials?roll_no=eq.${encodeURIComponent(session.rollNo)}&active_session_id=eq.${encodeURIComponent(session.authUserId)}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({ active_session_id: null }),
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

function subjectsMatch(questionSubject, selectedSubject) {
  if (selectedSubject === "All") return true;
  const aliases = {
    Mathematics: ["mathematics", "math"],
    "Social Studies": ["social studies", "social science"]
  };
  const acceptedSubjects = aliases[selectedSubject] || [selectedSubject.toLowerCase()];
  return acceptedSubjects.includes((questionSubject || "").trim().toLowerCase());
}

function renderFilteredQuestions() {
  const feed = document.getElementById("questions-feed");
  const normalizedSearch = searchTerm.trim().toLowerCase();
  const filteredQuestions = allQuestions.filter((item) => {
    const subject = item.subject || "General";
    const matchesSubject = subjectsMatch(subject, activeSubject);
    const searchableText = `${item.author_name || item.author || ""} ${subject} ${item.question_text || item.question || ""}`.toLowerCase();
    return matchesSubject && (!normalizedSearch || searchableText.includes(normalizedSearch));
  });
  feed.replaceChildren(...filteredQuestions.map(renderQuestionCard));
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
  if (questionSection) questionSection.hidden = session.role === "admin";
}

async function showApp(session) {
  activeSession = session;
  renderUser(session);
  loginModal.hidden = true;
  appView.hidden = false;
  await Promise.all([renderCodes(), fetchQuestions(), fetchNotes()]);
}

async function login(name, rollNo, accessCode, authUserId) {
  const normalizedCode = accessCode.trim().toUpperCase();
  const { data: accessCodeRecord, error } = await supabaseClient
    .from("Credentials")
    .select("code, role, student_name, roll_no, active_session_id")
    .eq("code", normalizedCode)
    .eq("roll_no", rollNo)
    .maybeSingle();

  if (error) throw error;
  if (!accessCodeRecord) return null;
  if (accessCodeRecord.active_session_id && accessCodeRecord.active_session_id !== authUserId) return { occupied: true };

  const { data: claimedRows, error: claimError } = await supabaseClient
    .from("Credentials")
    .update({ active_session_id: authUserId })
    .eq("code", accessCodeRecord.code)
    .eq("roll_no", rollNo)
    .or(`active_session_id.is.null,active_session_id.eq.${authUserId}`)
    .select("code");

  if (claimError) throw claimError;
  if (!claimedRows?.length) return { occupied: true };

  return {
    name: accessCodeRecord.student_name?.trim() ? titleCaseName(accessCodeRecord.student_name) : "",
    code: accessCodeRecord.code,
    role: accessCodeRecord.role || "student",
    rollNo: accessCodeRecord.roll_no || rollNo || "-",
    authUserId
  };
}

async function renderCodes() {
  const codeList = document.getElementById("code-list");
  const { data: codes, error } = await supabaseClient
    .from("Credentials")
    .select("code, role")
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
    codeElement.textContent = codeRecord.code;
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
    .eq("question_id", questionId)
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
      question_id: questionId,
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
  replyButton.title = isLoggedIn ? "Post a reply" : "Please login with Google to participate.";

  replyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isLoggedIn) {
      window.alert("Please login with Google to participate.");
      return;
    }
    void postReply(questionId);
  });

  replyForm.append(replyInput, replyButton);
  body.append(answersList, replyForm);
  void fetchAnswersForQuestion(questionId);
}

function renderNoteCard(note) {
  const card = document.createElement("article");
  const title = document.createElement("h4");
  const metadata = document.createElement("div");
  const uploader = document.createElement("span");
  const roleBadge = document.createElement("span");
  const link = document.createElement("a");

  card.className = "note-card";
  title.textContent = note.title || "Untitled note";
  metadata.className = "note-card-meta";
  uploader.textContent = note.uploader_name || note.uploaded_by || "Portal member";
  roleBadge.className = "note-role-badge";
  roleBadge.textContent = note.uploader_role === "admin" ? "Admin" : "Student";
  metadata.append(uploader, roleBadge);
  link.className = "note-card-link";
  link.href = note.file_url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "View / Download PDF";
  card.append(title, metadata, link);
  return card;
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

  notesContainer.replaceChildren(...notes.map(renderNoteCard));
  updateNotesCount();
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
          uploaded_by: "Admin",
          uploader_role: "admin"
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
        if (payload.new?.question_id) void fetchAnswersForQuestion(payload.new.question_id);
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
      { event: "INSERT", schema: "public", table: "notes" },
      () => fetchNotes()
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR") console.error("Unable to subscribe to note updates.");
    });
  return realtimeNotesChannel;
}

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = accessForm.querySelector("button[type='submit']");
  const formData = new FormData(accessForm);
  if (!onboardingAuthUser) {
    showMessage(loginMessage, "Please sign in with Google first.", true);
    return;
  }
  submitButton.disabled = true;
  showMessage(loginMessage, "Checking access...");

  try {
    const session = await login("", formData.get("rollNo"), formData.get("accessCode"), onboardingAuthUser.id);
    if (session?.occupied) {
      window.alert("This Roll Number is already logged in on another device.");
      showMessage(loginMessage, "This Roll Number is already logged in on another device.", true);
      return;
    }
    if (!session) {
      showMessage(loginMessage, "That access code was not found.", true);
      return;
    }
    onboardingAccess = session;
    if (session.name?.trim()) {
      sessionStorage.setItem("classPortal.activeSession", JSON.stringify(session));
      accessForm.hidden = true;
      loginModal.hidden = true;
      await showApp(session);
    } else {
      accessForm.hidden = true;
      nameForm.hidden = false;
      document.getElementById("custom-name").focus();
      showMessage(loginMessage, "");
    }
  } catch (error) {
    showMessage(loginMessage, "Unable to connect to Supabase. Check your project settings.", true);
    console.error(error);
  } finally {
    submitButton.disabled = false;
  }
});

nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nameMessage = document.getElementById("name-message");
  const customName = new FormData(nameForm).get("customName").trim();
  if (!customName || !onboardingAuthUser || !onboardingAccess) {
    showMessage(nameMessage, "Enter a display name to continue.", true);
    return;
  }

  const submitButton = nameForm.querySelector("button[type='submit']");
  const rollNo = onboardingAccess.rollNo;
  let updateErrorAlerted = false;
  submitButton.disabled = true;
  showMessage(nameMessage, "Saving your profile...");

  try {
    const { data, error } = await supabaseClient
      .from("Credentials")
      .update({ student_name: customName })
      .eq("roll_no", rollNo);

    if (error) {
      console.error("Supabase Update Error:", error);
      window.alert(error.message);
      updateErrorAlerted = true;
      throw error;
    }

    const { error: metadataError } = await supabaseClient.auth.updateUser({ data: { display_name: customName } });
    if (metadataError) throw metadataError;

    const session = {
      ...onboardingAccess,
      name: titleCaseName(customName),
      authUserId: onboardingAuthUser.id
    };
    sessionStorage.setItem("customName", customName);
    sessionStorage.setItem("classPortal.activeSession", JSON.stringify(session));
    nameForm.reset();
    nameForm.hidden = true;
    await showApp(session);
  } catch (error) {
    console.error("Unable to complete onboarding profile setup.", error);
    await releaseActiveSession(onboardingAccess);
    if (!updateErrorAlerted) {
      window.alert(error.message || "We couldn't save your name. Please try signing in again.");
    }
  } finally {
    loginModal.hidden = true;
    appView.hidden = !activeSession;
    submitButton.disabled = false;
  }
});

document.getElementById("nav-login-button").addEventListener("click", () => {
  loginModal.hidden = false;
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
    const { error } = await supabaseClient
      .from("Credentials")
      .update({ student_name: customName })
      .eq("roll_no", activeSession.rollNo);
    if (error) throw error;

    const { error: metadataError } = await supabaseClient.auth.updateUser({ data: { display_name: customName } });
    if (metadataError) throw metadataError;
    activeSession.name = titleCaseName(customName);
    sessionStorage.setItem("customName", customName);
    sessionStorage.setItem("classPortal.activeSession", JSON.stringify(activeSession));
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

document.getElementById("logout-button").addEventListener("click", () => {
  void releaseActiveSession();
  activeSession = null;
  isAdmin = false;
  onboardingAuthUser = null;
  onboardingAccess = null;
  updateUIState(false);
  sessionStorage.removeItem("classPortal.activeSession");
  appView.hidden = true;
  loginModal.hidden = false;
  accessForm.reset();
  nameForm.reset();
  accessForm.hidden = true;
  nameForm.hidden = true;
  document.getElementById("onboarding-step-1").hidden = false;
  document.getElementById("access-code").disabled = true;
  document.getElementById("roll-no").disabled = true;
  showMessage(loginMessage, "");
});

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
    .insert({ code, role, student_name: studentName, roll_no: rollNo });

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
  if (!isLoggedIn) {
    window.alert("Please login with Google to participate.");
    return;
  }
  if (!activeSession || activeSession.role === "admin") return;

  const form = event.currentTarget;
  const submitButton = form.querySelector("button[type='submit']");
  const subject = document.getElementById("question-subject").value;
  const questionText = document.getElementById("question-text").value.trim();
  submitButton.disabled = true;

  const { error } = await supabaseClient
    .from("questions")
    .insert({
      author_name: activeSession.name,
      std: getRollNo(activeSession),
      subject,
      question_text: questionText
    });

  if (error) {
    showMessage(document.getElementById("question-message"), "Unable to submit question.", true);
  } else {
    form.reset();
    showMessage(document.getElementById("question-message"), "Your question is now in the feed.");
    await fetchQuestions();
  }
  submitButton.disabled = false;
});

document.getElementById("upload-notes-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!isLoggedIn) {
    window.alert("Please login with Google to participate.");
    return;
  }

  const form = event.currentTarget;
  const uploadButton = form.querySelector("button[type='submit']");
  const source = form.querySelector("input[name='uploadSource']:checked")?.value;
  const title = document.getElementById("note-title-input").value.trim();
  const file = document.getElementById("note-file-input").files[0];
  const driveLink = document.getElementById("drive-link-input").value.trim();
  const uploaderRole = isAdmin ? "admin" : "student";
  const uploaderId = activeSession?.authUserId || onboardingAuthUser?.id;

  if (source === "local" && (!file || file.type !== "application/pdf")) {
    window.alert("Please select a PDF file only.");
    return;
  }
  if (source === "drive" && !driveLink) {
    window.alert("Please enter a Google Drive link.");
    return;
  }
  if (uploaderRole === "admin" && source !== "drive") {
    window.alert("Admins must provide a direct Google Drive link.");
    return;
  }

  uploadButton.disabled = true;
  showMessage(document.getElementById("upload-message"), "Uploading note...");
  try {
    let fileUrl = driveLink;
    if (uploaderRole === "student") {
      const filePath = `${uploaderId || "student"}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      try {
        const { error: uploadError } = await supabaseClient.storage
          .from("notes-bucket")
          .upload(filePath, file, { contentType: "application/pdf", upsert: false });
        if (uploadError) {
          console.error("Storage Upload Error:", uploadError);
          window.alert(`Storage Upload Error: ${uploadError.message}`);
          return;
        }
      } catch (error) {
        console.error("Storage Upload Error:", error);
        window.alert(`Storage Upload Error: ${error.message}`);
        return;
      }
      const { data: publicUrlData } = supabaseClient.storage.from("notes-bucket").getPublicUrl(filePath);
      fileUrl = publicUrlData.publicUrl;
    }

    try {
      const { error: insertError } = await supabaseClient
        .from("notes")
        .insert({ title, file_url: fileUrl, uploaded_by: uploaderId, uploader_role: uploaderRole });
      if (insertError) {
        console.error("Database Error:", insertError);
        window.alert(`Database Error: ${insertError.message}`);
        return;
      }
    } catch (error) {
      console.error("Database Error:", error);
      window.alert(`Database Error: ${error.message}`);
      return;
    }

    form.reset();
    document.getElementById("drive-link-input").hidden = true;
    document.getElementById("note-file-input").hidden = false;
    showMessage(document.getElementById("upload-message"), "Note uploaded successfully.");
    await fetchNotes();
  } catch (error) {
    console.error("Unable to upload note.", error);
    showMessage(document.getElementById("upload-message"), error.message || "Unable to upload note.", true);
  } finally {
    uploadButton.disabled = false;
  }
});

const uploadForm = document.getElementById("upload-notes-form");
const noteFileInput = document.getElementById("note-file-input");
const driveLinkInput = document.getElementById("drive-link-input");
document.querySelectorAll("input[name='uploadSource']").forEach((sourceOption) => {
  sourceOption.addEventListener("change", () => {
    const isDriveSource = sourceOption.value === "drive" && sourceOption.checked;
    driveLinkInput.hidden = !isDriveSource;
    driveLinkInput.required = isDriveSource;
    noteFileInput.hidden = isDriveSource;
    noteFileInput.required = !isDriveSource;
  });
});

document.querySelectorAll(".subject-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activeSubject = tab.dataset.subject;
    document.querySelectorAll(".subject-tab").forEach((item) => item.classList.toggle("is-active", item === tab));
    renderFilteredQuestions();
  });
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
  const savedSession = sessionStorage.getItem("classPortal.activeSession");
  if (savedSession) {
    try {
      const restoredSession = JSON.parse(savedSession);
      await showApp(restoredSession);
      updateUIState(true);
    } catch (error) {
      console.error("Unable to restore saved session.", error);
      sessionStorage.removeItem("classPortal.activeSession");
      updateUIState(false);
    }
  } else {
    updateUIState(false);
  }

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    await handleAuthSession(session);
  } catch (error) {
    console.error("Unable to restore Supabase session.", error);
  }

  if (!authStateSubscription) {
    authStateSubscription = supabaseClient.auth.onAuthStateChange((_event, session) => {
      void handleAuthSession(session);
    });
  }
  subscribeToQuestionChanges();
  subscribeToAnswerChanges();
  subscribeToNoteChanges();
  await syncAdminDriveFolder();
  await fetchQuestions();
  await fetchNotes();
  updateNotesCount();

  const notesList = document.getElementById("notes-list-container");
  if (notesList && !notesListObserver) {
    notesListObserver = new MutationObserver(updateNotesCount);
    notesListObserver.observe(notesList, { childList: true });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  void initApp();
}, { once: true });
