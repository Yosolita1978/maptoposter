// Map to Poster — frontend logic.
// Talks to the FastAPI backend: fetch themes, submit a job, poll for status,
// then show/download the finished poster.

// The deployed backend. To test against a locally-running API instead,
// change this to "http://127.0.0.1:8000".
const API_BASE = "https://maptoposter-api-3z7d.onrender.com";

// How often to poll the status endpoint (milliseconds).
const POLL_INTERVAL = 3000;

// --- Element references -----------------------------------------------------

const form = document.getElementById("poster-form");
const themeSelect = document.getElementById("theme");
const distanceInput = document.getElementById("distance");
const distanceValue = document.getElementById("distance-value");
const generateBtn = document.getElementById("generate-btn");

const statusSection = document.getElementById("status");
const workingBox = document.getElementById("working");
const workingTitle = document.getElementById("working-title");
const workingPhase = document.getElementById("working-phase");
const workingTip = document.getElementById("working-tip");
const workingLong = document.getElementById("working-long");
const elapsedEl = document.getElementById("elapsed");
const errorBox = document.getElementById("error");

// Facts to rotate through while the user waits, so the screen feels alive.
const TIPS = [
  "Tip: a wider map radius means more streets to download — and a longer wait.",
  "Tip: generating the same city again is cached, so it returns in seconds.",
  "Tip: SVG and PDF formats are vector — great for large, crisp prints.",
  "Tip: the poster shows the exact coordinates of the city center.",
  "Tip: try different themes — each one recolors roads, water, and parks.",
];

// Show the long-wait reassurance once elapsed passes this many seconds.
const LONG_WAIT_SECONDS = 90;
const resultBox = document.getElementById("result");
const previewImg = document.getElementById("preview");
const downloadLink = document.getElementById("download");
const againBtn = document.getElementById("again");

// --- Small display helpers --------------------------------------------------

// Show the map radius slider value in kilometres.
function updateDistanceLabel() {
  const km = Math.round(Number(distanceInput.value) / 1000);
  distanceValue.textContent = `${km} km`;
}

// Turn a theme filename ("neon_cyberpunk") into a nicer label ("Neon Cyberpunk").
function prettyTheme(name) {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Reveal exactly one of the three status boxes (working / error / result).
function showStatus(which) {
  statusSection.hidden = false;
  workingBox.hidden = which !== "working";
  errorBox.hidden = which !== "error";
  resultBox.hidden = which !== "result";
}

function showError(message) {
  errorBox.textContent = message;
  showStatus("error");
  generateBtn.disabled = false;
}

// --- Load the theme list on page load --------------------------------------

async function loadThemes() {
  try {
    const res = await fetch(`${API_BASE}/themes`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    themeSelect.innerHTML = "";
    for (const name of data.themes) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = prettyTheme(name);
      if (name === "terracotta") option.selected = true;
      themeSelect.appendChild(option);
    }
  } catch {
    // If the list can't load, keep a single safe default so the form still works.
    themeSelect.innerHTML = '<option value="terracotta">Terracotta</option>';
  }
}

// --- Polling ----------------------------------------------------------------

let elapsedTimer = null;
let tipTimer = null;

// Format seconds as "m:ss" (e.g. 125 -> "2:05").
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = String(seconds % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

// Rough average time one poster takes, used only for a ballpark queue estimate.
const EST_MIN_PER_JOB = 4;

// Update the phase line from the backend's status and queue position.
function updatePhase(status, position) {
  if (status === "running") {
    workingPhase.textContent = "Downloading map data & rendering…";
  } else if (status === "queued") {
    if (typeof position === "number" && position > 0) {
      const estMin = position * EST_MIN_PER_JOB;
      workingPhase.textContent =
        `You're #${position} in line — roughly ${estMin} min estimated wait.`;
    } else {
      workingPhase.textContent = "Next in line — starting shortly…";
    }
  } else {
    workingPhase.textContent = "Submitting…";
  }
}

function startWorking(cityName) {
  workingTitle.textContent = `Generating your ${cityName} poster…`;
  updatePhase("submitting");
  workingLong.hidden = true;

  // Elapsed clock, plus the long-wait note once we cross the threshold.
  let seconds = 0;
  elapsedEl.textContent = "0:00";
  elapsedTimer = setInterval(() => {
    seconds += 1;
    elapsedEl.textContent = formatTime(seconds);
    if (seconds >= LONG_WAIT_SECONDS) workingLong.hidden = false;
  }, 1000);

  // Rotate through tips every few seconds.
  let tipIndex = 0;
  workingTip.textContent = TIPS[0];
  tipTimer = setInterval(() => {
    tipIndex = (tipIndex + 1) % TIPS.length;
    workingTip.textContent = TIPS[tipIndex];
  }, 6000);
}

function stopWorking() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (tipTimer) {
    clearInterval(tipTimer);
    tipTimer = null;
  }
}

// Repeatedly ask the backend how the job is doing until it finishes.
async function pollJob(jobId, outputFormat) {
  let res;
  try {
    res = await fetch(`${API_BASE}/status/${jobId}`);
  } catch {
    showError("Lost connection to the server. Please try again.");
    stopWorking();
    return;
  }

  if (!res.ok) {
    showError("The server could not find this job. Please try again.");
    stopWorking();
    return;
  }

  const data = await res.json();

  if (data.status === "done") {
    stopWorking();
    await showResult(jobId, outputFormat);
    return;
  }

  if (data.status === "error") {
    stopWorking();
    const detail = (data.error || "").toLowerCase();
    if (detail.includes("429") || detail.includes("geocoding failed")) {
      // The OpenStreetMap geocoder rate-limited us or was unreachable.
      showError("The map service (OpenStreetMap) is busy right now. Please wait a minute and try again.");
    } else if (detail.includes("could not find") || detail.includes("coordinates")) {
      // The city/country wasn't recognised.
      showError("We couldn't find that city. Check the spelling of the city and country, then try again.");
    } else {
      showError("Something went wrong while generating the poster. Please try again.");
    }
    return;
  }

  // Still queued or running — reflect the phase, then check again shortly.
  updatePhase(data.status, data.queue_position);
  setTimeout(() => pollJob(jobId, outputFormat), POLL_INTERVAL);
}

// --- Show the finished poster ----------------------------------------------

async function showResult(jobId, outputFormat) {
  const resultUrl = `${API_BASE}/result/${jobId}`;

  // Fetch the file as a blob so we can preview and download the same bytes.
  let blob;
  try {
    const res = await fetch(resultUrl);
    if (!res.ok) throw new Error();
    blob = await res.blob();
  } catch {
    showError("The poster was generated but could not be downloaded. Please try again.");
    return;
  }

  const objectUrl = URL.createObjectURL(blob);
  downloadLink.href = objectUrl;
  downloadLink.download = `map-poster.${outputFormat}`;

  // PDFs don't display in an <img>; show a download-only view for them.
  if (outputFormat === "pdf") {
    previewImg.hidden = true;
    downloadLink.textContent = "Download PDF poster";
  } else {
    previewImg.hidden = false;
    previewImg.src = objectUrl;
    downloadLink.textContent = "Download poster";
  }

  showStatus("result");
  generateBtn.disabled = false;
}

// --- Form submit ------------------------------------------------------------

async function handleSubmit(event) {
  event.preventDefault();
  generateBtn.disabled = true;

  const payload = {
    city: document.getElementById("city").value.trim(),
    country: document.getElementById("country").value.trim(),
    theme: themeSelect.value,
    output_format: document.getElementById("format").value,
    distance: Number(distanceInput.value),
  };

  showStatus("working");
  startWorking(payload.city || "map");

  let res;
  try {
    res = await fetch(`${API_BASE}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    stopWorking();
    showError("Could not reach the server. It may be waking up — please try again in a moment.");
    return;
  }

  if (res.status === 429) {
    stopWorking();
    showError("The server is busy right now. Please try again in a minute.");
    return;
  }

  if (!res.ok) {
    stopWorking();
    showError("The server rejected the request. Please check your inputs and try again.");
    return;
  }

  const data = await res.json();
  pollJob(data.job_id, payload.output_format);
}

// --- Wire everything up -----------------------------------------------------

distanceInput.addEventListener("input", updateDistanceLabel);
form.addEventListener("submit", handleSubmit);
againBtn.addEventListener("click", () => {
  statusSection.hidden = true;
});

updateDistanceLabel();
loadThemes();
