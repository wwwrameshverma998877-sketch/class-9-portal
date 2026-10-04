const SUPABASE_URL = "https://jscgedmfzdxpbtmokazf.supabase.co/rest/v1/";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzY2dlZG1memR4cGJ0bW9rYXpmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyMTYwNjAsImV4cCI6MjEwNDc5MjA2MH0.bGFzIlqtQYfByOC9dGNEihIhX-jfX72g7tZ8-wZeTeg";
const SUPABASE_PROJECT_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, "");
const supabaseClient = supabase.createClient(SUPABASE_PROJECT_URL, SUPABASE_ANON_KEY);
const DRIVE_FOLDER_ID = "1kvzcnMaijD6g06GT5loXUtJ1xom7N2t0";
const DRIVE_API_KEY = "AIzaSyDL9mJG7q0JFRXSKNjLKIdYR4nyS8I5ZE0";
const MAX_PDF_SIZE = 10 * 1024 * 1024;
const SUBJECTS = ["English", "Algebra", "Geometry", "Science I", "Science II", "Hindi", "Marathi"];
const DEVICE_TOKEN = localStorage.getItem("device_token") || (() => {
  const token = globalThis.crypto?.randomUUID?.() || `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem("device_token", token);
  return token;
})();

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

const loginModal = document.getElementById("login-modal");
const welcomePage = document.getElementById("welcome-page");
const appView = document.getElementById("app-view");
const loginForm = document.getElementById("login-form");
const changeNameModal = document.getElementById("change-name-modal");
const changeNameForm = document.getElementById("change-name-form");
const loginMessage = document.getElementById("login-message");
const adminPanel = document.querySelector(".admin-panel");
const questionSection = document.querySelector(".ask-section");

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
    const driveSource = document.getElementById("drive-source-option");
    const driveLink = document.getElementById("drive-link-input");
    if (driveSource) driveSource.disabled = !loggedIn || !isAdmin;
    if (driveLink) driveLink.disabled = !loggedIn || !isAdmin;
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
  return record.rollNo || record.std || record.studentClass || "-";
}

async function releaseActiveSession(session = activeSession) {
  if (!session?.deviceToken || !session.rollNo || session.rollNo === "-") return;
  try {
    const response = await fetch(`${SUPABASE_URL}Credentials?roll_no=eq.${encodeURIComponent(session.rollNo)}&active_session_id=eq.${encodeURIComponent(session.deviceToken)}`, {
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
  if (questionSection) questionSection.hidden = session.role === "admin";
}

async function showApp(session) {
  activeSession = session;
  isAdmin = session.role?.toLowerCase() === "admin";
  renderUser(session);
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

async function restoreSavedSession() {
  const savedSession = localStorage.getItem("classPortal.activeSession");
  let storedSession;
  try {
    storedSession = savedSession ? JSON.parse(savedSession) : null;
  } catch (error) {
    console.error("Unable to parse saved session.", error);
    localStorage.removeItem("classPortal.activeSession");
    return null;
  }
  const rollNo = storedSession?.rollNo;
  if (!rollNo) return null;

  const { data: credential, error } = await supabaseClient
    .from("Credentials")
    .select("code, role, student_name, roll_no, active_session_id")
    .eq("roll_no", rollNo)
    .maybeSingle();

  if (error) {
    console.error("Unable to restore the Credentials session.", error);
    return null;
  }
  if (!credential) return null;
  if (credential.active_session_id && credential.active_session_id !== DEVICE_TOKEN) return { securityConflict: true };

  const { data: claimedRows, error: claimError } = await supabaseClient
    .from("Credentials")
    .update({ active_session_id: DEVICE_TOKEN })
    .eq("roll_no", rollNo)
    .or(`active_session_id.is.null,active_session_id.eq.${DEVICE_TOKEN}`)
    .select("roll_no");
  if (claimError) throw claimError;
  if (!claimedRows?.length) return { securityConflict: true };

  const session = {
    name: titleCaseName(credential.student_name?.trim() || `Student ${credential.roll_no}`),
    role: credential.role || "student",
    rollNo: credential.roll_no,
    deviceToken: DEVICE_TOKEN
  };
  localStorage.setItem("classPortal.activeSession", JSON.stringify(session));
  return session;
}

async function login(rollNo, accessCode) {
  const normalizedCode = accessCode.trim().toUpperCase();
  const { data: accessCodeRecord, error } = await supabaseClient
    .from("Credentials")
    .select("code, role, student_name, roll_no, active_session_id")
    .eq("code", normalizedCode)
    .eq("roll_no", rollNo)
    .maybeSingle();

  if (error) throw error;
  if (!accessCodeRecord) return null;
  if (accessCodeRecord.active_session_id && accessCodeRecord.active_session_id !== DEVICE_TOKEN) return { occupied: true };

  const { data: claimedRows, error: claimError } = await supabaseClient
    .from("Credentials")
    .update({ active_session_id: DEVICE_TOKEN })
    .eq("code", accessCodeRecord.code)
    .eq("roll_no", rollNo)
    .or(`active_session_id.is.null,active_session_id.eq.${DEVICE_TOKEN}`)
    .select("code");

  if (claimError) throw claimError;
  if (!claimedRows?.length) return { occupied: true };

  return {
    name: titleCaseName(accessCodeRecord.student_name?.trim() || `Student ${accessCodeRecord.roll_no || rollNo}`),
    role: accessCodeRecord.role || "student",
    rollNo: accessCodeRecord.roll_no || rollNo || "-",
    deviceToken: DEVICE_TOKEN
  };
}

async function isStudentNameTaken(customName, currentRollNo) {
  const { data: matches, error } = await supabaseClient
    .from("Credentials")
    .select("roll_no")
    .ilike("student_name", customName)
    .limit(20);
  if (error) throw error;
  return matches.some((record) => String(record.roll_no) !== String(currentRollNo));
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
  const uploaderName = note.uploaded_by || note.uploader_name || "Portal member";
  uploader.textContent = `Uploaded by: ${uploaderName}`;
  roleBadge.className = "note-role-badge";
  roleBadge.textContent = note.uploader_role === "admin" ? "Admin" : "Student";
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
  deleteButton.disabled = !isAdmin;
  deleteButton.title = isAdmin ? "Delete this note" : "Admin access required";
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
  if (!isAdmin) {
    window.alert("Only Admin users can delete notes.");
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

  allNotes = notes;
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
      const { data: poll, error: pollError } = await supabaseClient
        .from("polls")
        .insert({ question })
        .select("poll_id")
        .single();
      if (pollError) throw pollError;

      const { error: optionsError } = await supabaseClient
        .from("poll_options")
        .insert(options.map((optionText) => ({ poll_id: poll.poll_id, option_text: optionText, vote_count: 0 })));
      if (optionsError) {
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
      row.className = `poll-result-row${String(userVote.option_id) === String(option.option_id) ? " is-voted" : ""}`;
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
    input.value = option.option_id;
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
      .eq("roll_no", rollNo)
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
  const rollNo = activeSession?.rollNo;
  if (!isLoggedIn || !rollNo || rollNo === "-") {
    window.alert("Please log in with your Roll Number to vote.");
    return;
  }
  voteButton.disabled = true;
  let voteRecorded = false;
  try {
    const { error: voteError } = await supabaseClient
      .from("poll_votes")
      .insert({ poll_id: poll.poll_id, roll_no: rollNo, option_id: optionId });
    if (voteError) throw voteError;
    voteRecorded = true;

    const { data: option, error: optionError } = await supabaseClient
      .from("poll_options")
      .select("vote_count")
      .eq("option_id", optionId)
      .single();
    if (optionError) throw optionError;

    const { error: updateError } = await supabaseClient
      .from("poll_options")
      .update({ vote_count: Number(option.vote_count || 0) + 1 })
      .eq("option_id", optionId);
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
      window.alert("This Roll Number is already logged in on another device.");
      showMessage(loginMessage, "This Roll Number is already logged in on another device.", true);
      return;
    }
    if (!session) {
      showMessage(loginMessage, "That access code was not found.", true);
      return;
    }
    localStorage.setItem("classPortal.activeSession", JSON.stringify(session));
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

document.getElementById("open-login-button").addEventListener("click", openLoginModal);
document.getElementById("welcome-login-button").addEventListener("click", openLoginModal);
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
      .eq("roll_no", activeSession.rollNo);
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

document.getElementById("logout-button").addEventListener("click", () => {
  void releaseActiveSession();
  activeSession = null;
  isAdmin = false;
  updateUIState(false);
  localStorage.removeItem("classPortal.activeSession");
  loginForm.reset();
  showMessage(loginMessage, "");
  showWelcomePage();
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
    window.alert("Please log in to participate.");
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

    try {
      const { error: insertError } = await supabaseClient
        .from("notes")
        .insert({ title, subject, file_url: fileUrl, uploaded_by: uploaderName, uploader_role: uploaderRole });
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
    const isDriveSource = sourceOption.value === "drive" && sourceOption.checked;
    noteFileInput.hidden = isDriveSource;
    noteFileInput.required = !isDriveSource;
    driveLinkInput.hidden = !isDriveSource;
    driveLinkInput.required = isDriveSource;
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
