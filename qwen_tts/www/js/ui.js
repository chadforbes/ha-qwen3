export function $(selector, root = document) {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export function setOnline(statusDotEl, statusTextEl, isOnline) {
  statusDotEl.classList.toggle("status--ok", Boolean(isOnline));
  statusTextEl.textContent = isOnline ? "Online" : "Offline";
}

export function setLatency(latencyEl, ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    latencyEl.textContent = "—";
    return;
  }
  latencyEl.textContent = `${Math.round(ms)} ms`;
}

export function setVoiceCount(voiceCountEl, n) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    voiceCountEl.textContent = "—";
    return;
  }
  voiceCountEl.textContent = String(n);
}

export function setPercent(metricValueEl, barEl, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    metricValueEl.textContent = "—";
    barEl.style.width = "0%";
    return;
  }
  const clamped = Math.max(0, Math.min(100, value));
  metricValueEl.textContent = `${Math.round(clamped)}%`;
  barEl.style.width = `${clamped}%`;
}

export function setQueue(queueEl, value) {
  if (value === null || value === undefined) {
    queueEl.textContent = "—";
    return;
  }
  queueEl.textContent = String(value);
}

function normalizeVoices(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.voices)) return raw.voices;
    if (Array.isArray(raw.items)) return raw.items;
  }
  return [];
}

function voiceToModel(v) {
  if (typeof v === "string") return { name: v, description: "" };
  if (!v || typeof v !== "object") return { name: "(unknown)", description: "" };

  const name = String(v.name ?? v.id ?? v.voice ?? "(unnamed)");
  const description = String(v.description ?? v.desc ?? "");
  return { name, description };
}

export function renderVoices(selectEl, listEl, rawVoices) {
  const voices = normalizeVoices(rawVoices).map(voiceToModel);

  selectEl.innerHTML = "";
  if (voices.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No voices";
    selectEl.appendChild(opt);
    selectEl.disabled = true;
  } else {
    selectEl.disabled = false;
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = v.name;
      selectEl.appendChild(opt);
    }
  }

  listEl.innerHTML = "";
  if (voices.length === 0) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No voices available.";
    listEl.appendChild(empty);
    return voices;
  }

  for (const v of voices) {
    const row = document.createElement("div");
    row.className = "voice";
    row.setAttribute("role", "listitem");

    const left = document.createElement("div");

    const name = document.createElement("div");
    name.className = "voice__name";
    name.textContent = v.name;

    left.appendChild(name);

    if (v.description) {
      const desc = document.createElement("div");
      desc.className = "voice__desc";
      desc.textContent = v.description;
      left.appendChild(desc);
    }

    const btn = document.createElement("button");
    btn.className = "btn";
    btn.type = "button";
    btn.textContent = "Add Voice";
    btn.disabled = true;
    btn.title = "Placeholder for future functionality";

    row.appendChild(left);
    row.appendChild(btn);
    listEl.appendChild(row);
  }

  return voices;
}

export function toast(toastsEl, message, { variant = "ok", timeoutMs = 3200 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${variant === "error" ? "toast--error" : "toast--ok"}`;
  el.textContent = message;
  toastsEl.appendChild(el);

  const id = setTimeout(() => el.remove(), timeoutMs);
  el.addEventListener("click", () => {
    clearTimeout(id);
    el.remove();
  });
}
