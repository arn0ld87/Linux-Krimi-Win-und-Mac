import RFB from "../../node_modules/@novnc/novnc/core/rfb.js";
import { mountRoom3D } from "./room3d.js";

const api = window.nachtdiff;

const FINALE_REPORT = `Rechenwerk Ostwind · Übergabe

Export · Timo erweiterte die Vorlage unter RW-3074 und stellte EXPORT-07 lokal bereit.
Protokoll · Nadia startete das Löschskript unter RW-1051.
Empfang · Ein externer Empfang ist unbelegt.
Testlauf · Der lokale Testausgang enthält ausschließlich die freigegebenen Messwerte.

Quellen · anhang-audit.txt, export-status.txt und zeitfolge.txt.
Prüfung · ~/belege/finale-pruefung.txt und ~/belege/finale-fallakte.txt.`;

const FINALE_SCENES = {
  "ep4-briefing": {
    id: "ep4-briefing",
    title: "Alex’ Briefing",
    parts: [
      {
        video: "ep4-briefing",
        audio: "ep4-briefing",
        caption:
          "Alex · Sichere die Freigabe und den tatsächlich erzeugten Export. Der Dateiname sagt nichts über den Inhalt.",
      },
    ],
  },
  "ep5-ausgang": {
    id: "ep5-ausgang",
    title: "Blick in den lokalen Ausgang",
    parts: [
      {
        video: "ep5-ausgang",
        audio: null,
        caption: "EXPORT-07 wurde lokal bereitgestellt. Der externe Empfang ist unbelegt.",
      },
    ],
  },
  "ep6-uhren": {
    id: "ep6-uhren",
    title: "Zwei Uhren ansehen",
    parts: [
      {
        video: "ep6-uhren",
        audio: null,
        caption:
          "Z bedeutet UTC. Ziehe bei +02:00 zwei Stunden ab. Der Linux-Texteditor öffnet die Uhrzeit-Legende.",
      },
    ],
  },
  "ep7-abspann": {
    id: "ep7-abspann",
    title: "Schlusssequenz ansehen",
    parts: [
      {
        video: "ep7-alex",
        audio: "ep7-abschluss",
        caption:
          "Alex · Wir haben geklärt, wer den Export bereitstellte und wer die Spur löschte. Einen externen Empfang können wir nicht belegen.",
      },
      {
        video: "ep7-micha",
        audio: "micha-ep7-abschluss",
        caption: "Micha · Und diesmal läuft nur, was freigegeben ist.",
      },
      {
        video: "ep7-abspann",
        audio: null,
        caption:
          "Margit übernimmt die dokumentierte Übergabe. Der lokale Testausgang enthält die freigegebenen Messwerte.",
      },
    ],
  },
};

const INTRO_CUES = [
  {
    id: "staffel-2-briefing",
    title: "Begrüßung",
    transcript:
      "Willkommen im Rechenwerk Ostwind. Ich bin Alex und begleite dich durch deinen ersten Einsatz. Im Archiv stimmt etwas nicht. Sieh dich zuerst im Terminal um und sammle Beweise, bevor du einen Vorwurf erhebst.",
  },
  {
    id: "staffel-2-archiv",
    title: "Archivhinweis",
    transcript:
      "Im Archiv steckt die Vorgeschichte. Prüfe die Metadaten und vergleiche die Originalzeilen. Erst wenn du die Abweichung belegen kannst, weißt du, welche Korrektur sinnvoll ist.",
  },
];

const HELP_COMMANDS = [
  ["pwd", "Aktuelles Verzeichnis anzeigen"],
  ["cd <pfad>", "Verzeichnis wechseln (~, ., .. und absolute Pfade)"],
  ["ls [pfad]", "Dateien auflisten"],
  ["ls -l <pfad>", "Dateien mit Besitzer, Rechten und Datum auflisten"],
  ["stat <datei>", "Besitzer, Rechte und Zeitstempel anzeigen"],
  ["cat <datei...>", "Dateiinhalt anzeigen"],
  ["grep [-i] <muster> <datei...>", "Zeilen mit Muster anzeigen"],
  ["cp <quelle> <ziel>", "Datei kopieren (überschreibt den Inhalt)"],
  ["mkdir [-p] <pfad>", "Verzeichnis anlegen, falls das Konto Schreibrechte hat"],
  ["uname -sm", "Linux und die Architektur des Gasts anzeigen"],
  ["clear", "Bildschirm leeren"],
];

const EXAMPLE_COMMANDS = [
  "ls -l /srv/rechenwerk/uebung/",
  "ls -l /srv/rechenwerk/uebung/ > ~/belege/kasse-meta.txt",
  "grep 2026-04-15 /srv/rechenwerk/uebung/kaffeekasse.csv > ~/belege/kasse-zeilen.txt",
  "grep 2026-04-15 /srv/rechenwerk/uebung/kaffeekasse.bak >> ~/belege/kasse-zeilen.txt",
  "cp /srv/rechenwerk/uebung/kaffeekasse.bak /srv/rechenwerk/uebung/kaffeekasse.csv",
];

let snapshot = null;
let assets = null;
let episodeVoices = {};
let michaVoices = {};
let showsMissionOutline = true;
let activeModal = null;
let lastMichaActivity = Date.now();
let currentCue = null;
let audioEl = null;
let audioLevel = 0;
let audioUnavailable = false;
let meterRaf = null;
let michaAnimating = false;
let michaTimer = null;
let answerInputs = {};
let answerFeedback = {};

// Terminal state (persisted across page switches)
let xterm = null;
let fitAddon = null;
let terminalElement = null;

// VNC state
let rfbClient = null;
let connectedWsPort = null;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "hidden") node.hidden = Boolean(v);
    else if (k === "disabled") node.disabled = Boolean(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined) {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function applyAppearance(pref) {
  const root = document.documentElement;
  root.classList.remove("theme-light", "theme-dark");
  if (pref === "light") root.classList.add("theme-light");
  if (pref === "dark") root.classList.add("theme-dark");
}

function isStepDone(step) {
  if (!snapshot) return false;
  const epID = snapshot.episode.id;
  const st = snapshot.state;
  if (epID !== 0) {
    return (st.linuxChecks || []).includes(step.id) || (st.acceptedAnswers || []).includes(step.id);
  }
  if (step.id === "meta-sichern") {
    return Boolean(st.evidences.find((e) => e.specID === "kasse-meta")?.validated);
  }
  if (step.id === "zeilen-original") {
    return Boolean(st.evidences.find((e) => e.specID === "kasse-zeilen")?.validated);
  }
  if (step.id === "reparatur") return Boolean(st.repaired);
  if (step.id === "vorwurf") return Boolean(st.solved);
  return false;
}

function renderProgressSummary(container, vertical = false) {
  const ep = snapshot.episode;
  const st = snapshot.state;
  const validated = st.evidences.filter((e) => e.validated).length;
  container.className = `progress-summary${vertical ? " vertical" : ""}`;
  container.replaceChildren(
    el("div", {}, `${snapshot.completedTracks} von ${ep.tracks.length} Spuren`),
    el("div", {}, `${validated} von ${st.evidences.length} Belegen anerkannt`),
    el(
      "div",
      {},
      ep.id === 0
        ? st.repaired
          ? "✓ Kasse wiederhergestellt"
          : "○ Kasse nicht wiederhergestellt"
        : st.repaired
        ? "✓ Eingriff abgeschlossen"
        : "○ Eingriff offen"
    ),
    st.solved
      ? el("div", { class: "solved-label" }, ep.id === 0 ? "⚑ Probelauf bestanden" : "⚑ Fall gelöst")
      : null
  );
}

function renderSidebar() {
  const ep = snapshot.episode;
  document.getElementById("sidebar-case-title").textContent = `Fall ${ep.id} · ${ep.title}`;

  const navItems = [
    ["briefing", "📄", "Einsatzrahmen"],
    ["terminal", "⌨", "Terminal"],
    ...(snapshot.supportsDesktop ? [["desktop", "🖥", "Bildschirm"]] : []),
    ["aktenwand", "🗂", "Aktenwand"],
    ["vorwurf", "⚑", ep.id === 7 ? "Übergabe" : "Vorwurf"],
    ["help", "❓", "Hilfe & Werkzeuge"],
  ];

  const nav = document.getElementById("sidebar-nav");
  nav.replaceChildren(
    ...navItems.map(([id, icon, label]) =>
      el(
        "button",
        {
          type: "button",
          class: `nav-item${snapshot.state.page === id ? " active" : ""}`,
          onClick: () => api.setPage(id),
        },
        el("span", {}, icon),
        el("span", {}, label)
      )
    )
  );

  const eps = document.getElementById("sidebar-episodes");
  eps.replaceChildren(
    ...snapshot.episodes.map((item) =>
      el(
        "button",
        {
          type: "button",
          class: `episode-btn${item.id === ep.id ? " active" : ""}`,
          disabled: snapshot.terminalBusy || !item.playable,
          onClick: () => {
            stopAudio();
            currentCue = null;
            answerInputs = {};
            answerFeedback = {};
            api.selectEpisode(item.id);
          },
        },
        el("span", { class: "episode-icon" }, !item.playable ? "🔒" : item.id === ep.id ? "▶" : "▷"),
        el(
          "span",
          { class: "episode-meta" },
          el("span", { class: "episode-title" }, `Episode ${item.id} · ${item.title}`),
          el("span", { class: "episode-sub" }, item.caseTitle)
        )
      )
    )
  );

  renderProgressSummary(document.getElementById("sidebar-progress"), true);
}

function renderTopbarAndInspector() {
  const page = snapshot.state.page;
  const topbar = document.getElementById("workspace-topbar");
  const inspector = document.getElementById("inspector");
  const toggleBtn = document.getElementById("btn-toggle-inspector");

  if (page === "briefing") {
    topbar.hidden = true;
    inspector.hidden = true;
    return;
  }

  topbar.hidden = false;
  document.getElementById("topbar-status").textContent = snapshot.statusMessage || "";
  toggleBtn.textContent = showsMissionOutline
    ? "Einsatzrahmen rechts ausblenden"
    : "Einsatzrahmen rechts einblenden";
  inspector.hidden = !showsMissionOutline;

  if (showsMissionOutline) {
    const ep = snapshot.episode;
    const body = document.getElementById("inspector-body");
    body.replaceChildren(
      el("h3", {}, ep.title),
      el("p", { class: "step-detail selectable" }, ep.briefing),
      ...ep.tracks.map((track) => renderTrackSection(track, true))
    );
  }
}

function stopAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl.currentTime = 0;
    audioEl = null;
  }
  if (meterRaf) {
    cancelAnimationFrame(meterRaf);
    meterRaf = null;
  }
  audioLevel = 0;
  updateFigureScale();
}

function updateFigureScale() {
  const fig = document.getElementById("alex-figure-img");
  if (!fig) return;
  const baseTransform = fig.dataset.parallax || "";
  fig.style.transform = `${baseTransform} scale(${1 + audioLevel * 0.014})`;
}

function playCue(cue) {
  stopAudio();
  currentCue = cue;
  audioUnavailable = false;
  const url = `${assets.einsatzBase}/${cue.id}.mp3`;
  const audio = new Audio();
  audio.preload = "auto";
  audio.volume = 1.0;
  audio.muted = false;
  audio.src = url;
  audioEl = audio;

  const startMeter = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const tick = (t) => {
      if (audioEl !== audio || audio.paused || audio.ended) return;
      audioLevel = 0.35 + 0.35 * Math.sin(t * 0.014) + 0.3 * Math.cos(t * 0.027);
      updateFigureScale();
      meterRaf = requestAnimationFrame(tick);
    };
    meterRaf = requestAnimationFrame(tick);
  };

  audio.addEventListener("play", startMeter);
  audio.addEventListener("ended", () => {
    if (audioEl === audio) {
      stopAudio();
      renderMain();
    }
  });
  audio.addEventListener("error", (ev) => {
    console.error("Audio playback error:", url, audio.error?.code, audio.error?.message, ev);
    if (audioEl === audio) {
      audioUnavailable = true;
      stopAudio();
      renderMain();
    }
  });
  audio.play().catch((err) => {
    console.error("Audio play() rejected:", url, err);
    if (audioEl === audio) {
      audioUnavailable = true;
      stopAudio();
      renderMain();
    }
  });
  renderMain();
}

function renderEvidenceCard(ev) {
  const selected = (snapshot.state.selectedEvidenceIDs || []).includes(ev.id);
  return el(
    "button",
    {
      type: "button",
      class: `evidence-card${selected ? " selected" : ""}`,
      onClick: () => api.toggleEvidence(ev.id),
    },
    el(
      "div",
      { class: "evidence-top" },
      el("span", {}, `${ev.validated ? "✓" : "⚠"} ${ev.title}`),
      el("span", {}, selected ? "✓ Ausgewählt" : "")
    ),
    el("div", { class: "evidence-file" }, ev.fileName),
    el(
      "div",
      { style: `font-size:12px;color:var(--${ev.validated ? "evidence-green" : "evidence-amber"})` },
      ev.validated ? "Anerkannt" : "Noch nicht anerkannt"
    ),
    !ev.validated && ev.validationHint
      ? el("div", { class: "step-detail" }, ev.validationHint)
      : null,
    ev.content ? el("pre", { class: "evidence-content" }, ev.content) : null
  );
}

function renderAnswerBox(step, answer) {
  if (isStepDone(step)) {
    return el("div", { style: "color:var(--evidence-green);font-size:13px" }, "✓ Antwort angenommen");
  }
  const val = answerInputs[step.id] ?? "";
  const input = el("input", {
    type: "text",
    class: "text-input",
    placeholder: answer.format || "",
    value: val,
    onInput: (e) => {
      answerInputs[step.id] = e.target.value;
    },
    onKeydown: async (e) => {
      if (e.key === "Enter") {
        await submitAnswerAction(step.id);
      }
    },
  });
  const submitBtn = el(
    "button",
    {
      type: "button",
      class: "btn-secondary",
      disabled: snapshot.terminalBusy,
      onClick: () => submitAnswerAction(step.id),
    },
    "Antwort prüfen"
  );
  return el(
    "div",
    { class: "answer-box" },
    el("div", { style: "font-size:13px" }, answer.question),
    el("div", { class: "answer-controls" }, input, submitBtn),
    answerFeedback[step.id]
      ? el("div", { style: "font-size:12px;color:var(--copper)" }, answerFeedback[step.id])
      : null
  );
}

async function submitAnswerAction(stepID) {
  const val = (answerInputs[stepID] || "").trim();
  if (!val || snapshot.terminalBusy) return;
  const err = await api.submitAnswer(val, stepID);
  answerFeedback[stepID] = err;
  renderMain();
  renderTopbarAndInspector();
}

function renderTrackSection(track, compact = false) {
  const ep = snapshot.episode;
  const mission = snapshot.mission;
  const steps = ep.steps.filter((s) => s.trackID === track.id);
  const evForTrack = snapshot.state.evidences.filter((e) => e.trackID === track.id);

  return el(
    "div",
    { class: `track-card${compact ? " compact" : ""}` },
    el(
      "div",
      { class: "track-header" },
      el("div", { class: "track-title" }, track.title),
      track.summary ? el("div", { class: "track-summary" }, track.summary) : null
    ),
    ...steps.map((step) => {
      const done = isStepDone(step);
      const ans = mission?.responses?.[step.id];
      const hints = mission?.stepsByID?.[step.id]?.hints || [];
      return el(
        "div",
        { class: "step-row" },
        el("span", { class: `step-check${done ? " done" : ""}` }, done ? "✓" : "○"),
        el(
          "div",
          { class: "step-body" },
          el("div", { class: "step-title" }, step.title),
          el("div", { class: "step-detail" }, step.detail),
          step.command ? el("code", { class: "code-chip" }, step.command) : null,
          mission && (ep.id !== 7 || compact === false) && ans && (ep.id !== 7)
            ? renderAnswerBox(step, ans)
            : null,
          hints.length > 0
            ? el(
                "details",
                { class: "hints" },
                el("summary", {}, "Hinweise"),
                el(
                  "ul",
                  {},
                  ...hints.map((h) => el("li", {}, h))
                )
              )
            : null
        )
      );
    }),
    !compact && evForTrack.length > 0
      ? el("div", { class: "evidence-grid" }, ...evForTrack.map(renderEvidenceCard))
      : null
  );
}

function getMichaAsleep() {
  if (!snapshot) return false;
  const ep = snapshot.episode;
  const st = snapshot.state;
  const michaSpeaking = currentCue?.id?.startsWith("micha-") && audioEl && !audioEl.paused;
  return !michaSpeaking && !(ep.id === 7 && st.solved) && Date.now() - lastMichaActivity >= 32000;
}

function buildMichaBar() {
  const ep = snapshot.episode;
  const asleep = getMichaAsleep();
  const michaSpeaking = currentCue?.id?.startsWith("micha-") && audioEl && !audioEl.paused;

  const thumbNode = michaAnimating
    ? el("video", {
        class: "micha-video",
        src: `${assets.finaleBase}/${michaAnimating}.${assets.videoExt || "mp4"}`,
        autoplay: true,
        muted: true,
        playsinline: true,
      })
    : el("img", {
        class: "micha-thumb",
        src: `${assets.einsatzBase}/${asleep ? "micha-sleep.jpg" : "micha-awake.jpg"}`,
        alt: "Micha",
      });

  return el(
    "div",
    { class: "micha-bar", id: "micha-bar", "data-asleep": String(asleep) },
    thumbNode,
    el(
      "div",
      { style: "flex:1" },
      el("div", { style: "font-weight:700" }, "Micha"),
      el(
        "div",
        { style: "font-size:12px;color:var(--text-secondary)" },
        asleep ? "🌙 Döst kurz" : michaSpeaking ? "🔊 Spricht" : "Assistenz"
      )
    ),
    el(
      "button",
      {
        type: "button",
        class: "btn-secondary",
        disabled: michaAnimating,
        onClick: async () => {
          if (michaSpeaking) {
            stopAudio();
            renderMain();
            return;
          }
          lastMichaActivity = Date.now();
          if (asleep) {
            if (ep.id >= 4 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
              michaAnimating = "micha-wacht";
              refreshMichaBarOnly();
              await new Promise((r) => setTimeout(r, 2600));
              michaAnimating = false;
            }
            const wake = michaVoices["wake"];
            if (wake) playCue(wake);
          } else {
            const clip = michaVoices[String(ep.id)];
            if (clip) playCue(clip);
          }
        },
      },
      michaSpeaking ? "⏹ Micha stoppen" : asleep ? "🔔 Micha wecken" : "💬 Micha fragen"
    )
  );
}

function refreshMichaBarOnly() {
  const existing = document.getElementById("micha-bar");
  if (!existing) return;
  existing.replaceWith(buildMichaBar());
}

function renderBriefingPage() {
  const ep = snapshot.episode;
  const st = snapshot.state;
  const cues = (ep.id === 0 ? INTRO_CUES : episodeVoices[String(ep.id)] || []).filter(
    (c) => st.solved || !c.id.endsWith("-abschluss")
  );
  const episodeClipMap = {
    4: "ep4-briefing",
    5: st.solved ? "ep5-ausgang" : null,
    6: "ep6-uhren",
    7: st.solved ? "ep7-abspann" : null,
  };
  const episodeClip = episodeClipMap[ep.id] || null;

  const stageRoom = el("img", {
    class: "stage-room",
    src: `${assets.einsatzBase}/serverraum.webp`,
    alt: "",
  });
  const alexFig = el("img", {
    id: "alex-figure-img",
    class: "stage-figure",
    style: `left:${ep.id >= 0 ? "64%" : "74%"}`,
    src: `${assets.einsatzBase}/alex-figur.png`,
    alt: "Alex",
  });
  const michaChair = el("img", {
    class: "stage-micha-chair",
    style: "left:76%",
    src: `${assets.einsatzBase}/micha-buerostuhl.png`,
    alt: "Micha",
  });

  const stage = el(
    "div",
    {
      class: "stage-card",
      onMousemove: (e) => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
        stageRoom.style.transform = `scale(1.06) translate(${-nx * 8}px, ${-ny * 4}px)`;
        const alexT = `translate(${nx * 16}px, ${ny * 4}px)`;
        alexFig.dataset.parallax = alexT;
        alexFig.style.transform = `${alexT} scale(${1 + audioLevel * 0.014})`;
        michaChair.style.transform = `translate(${nx * 10}px, ${ny * 3}px)`;
      },
      onMouseleave: () => {
        stageRoom.style.transform = "";
        alexFig.dataset.parallax = "";
        alexFig.style.transform = `scale(${1 + audioLevel * 0.014})`;
        michaChair.style.transform = "";
      },
    },
    stageRoom,
    el("div", { class: "stage-gradient" }),
    alexFig,
    michaChair,
    el(
      "div",
      { class: "stage-overlay" },
      el("div", { class: "stage-title" }, "Rechenwerk Ostwind"),
      el("div", { class: "stage-sub" }, "Alex · Einsatzbegleitung"),
      currentCue && !currentCue.id.startsWith("micha-") && audioEl && !audioEl.paused
        ? el("div", { class: "stage-speaking" }, `🔊 ${currentCue.title}`)
        : null
    )
  );

  const michaBar = buildMichaBar();

  const dropdownMenu = el(
    "div",
    { class: "dropdown-menu", hidden: true },
    el("button", { type: "button", onClick: () => openSceneModal("ep4-briefing") }, "Episode 4 · Alex’ Briefing"),
    el("button", { type: "button", onClick: () => openSceneModal("ep6-uhren") }, "Episode 6 · Zwei Uhren"),
    el("div", { class: "dropdown-section" }, "Mit Handlungsspoilern"),
    el("button", { type: "button", onClick: () => openSceneModal("ep5-ausgang") }, "Episode 5 · Blick in den lokalen Ausgang"),
    el("button", { type: "button", onClick: () => openSceneModal("ep7-abspann") }, "Episode 7 · Schlusssequenz (Spoiler)")
  );

  const videoMenuBtn = el(
    "div",
    { class: "dropdown-wrap" },
    el(
      "button",
      {
        type: "button",
        class: "btn-secondary",
        onClick: (e) => {
          e.stopPropagation();
          dropdownMenu.hidden = !dropdownMenu.hidden;
        },
      },
      "🎬 Videos ansehen ▾"
    ),
    dropdownMenu
  );

  const nextEp = snapshot.episodes.find((e) => e.id === ep.id + 1 && e.playable);

  return el(
    "div",
    { class: "page-content" },
    el(
      "div",
      {},
      el("h1", { class: "page-title" }, `Episode ${ep.id} · ${ep.title}`),
      el("div", { class: "page-subtitle" }, ep.caseTitle),
      el(
        "div",
        { class: "meta-row" },
        el("span", {}, `🏢 ${ep.organization}`),
        el("span", {}, `👤 Konto ${ep.account}`)
      )
    ),
    stage,
    el(
      "div",
      { class: "btn-row", style: "justify-content:space-between" },
      el(
        "div",
        { class: "btn-row" },
        ...cues.map((c) => {
          const playing = currentCue?.id === c.id && audioEl && !audioEl.paused;
          return el(
            "button",
            {
              type: "button",
              class: "btn-secondary",
              onClick: () => (playing ? (stopAudio(), renderMain()) : playCue(c)),
            },
            playing ? `⏹ ${c.title} stoppen` : `🔊 ${c.title}`
          );
        })
      ),
      el(
        "div",
        { class: "btn-row" },
        el("button", { type: "button", class: "btn-secondary", onClick: openArtworkModal }, "🖼 Originalgrafiken"),
        el(
          "button",
          { type: "button", class: "btn-primary", onClick: () => api.setPage("terminal") },
          "⌨ Zum Terminal"
        )
      )
    ),
    ep.id > 0
      ? el(
          "div",
          { class: "btn-row" },
          el("button", { type: "button", class: "btn-secondary", onClick: () => openRoomModal(ep.id, st.solved) }, "🧊 3D-Serverraum"),
          snapshot.supportsDesktop
            ? el("button", { type: "button", class: "btn-secondary", onClick: () => api.setPage("desktop") }, "🖥 Linux-Bildschirm")
            : null,
          ep.id === 2
            ? el("button", { type: "button", class: "btn-secondary", onClick: openPhotoModal }, "📷 Wartungsfoto")
            : null,
          episodeClip
            ? el(
                "button",
                { type: "button", class: "btn-secondary", onClick: () => openSceneModal(episodeClip) },
                `▶ ${FINALE_SCENES[episodeClip].title}`
              )
            : null
        )
      : null,
    michaBar,
    currentCue
      ? el(
          "div",
          { class: "transcript-card" },
          el("img", {
            class: "portrait-box",
            src: `${assets.einsatzBase}/${
              currentCue.id.startsWith("micha-")
                ? "micha-awake.jpg"
                : audioEl && !audioEl.paused && !currentCue.id.endsWith("-briefing")
                ? "alex-portraet-konzentriert.png"
                : "alex-portraet.png"
            }`,
            alt: "",
          }),
          el(
            "div",
            { style: "flex:1" },
            el(
              "div",
              { style: "font-weight:700;margin-bottom:4px" },
              `${currentCue.id.startsWith("micha-") ? "Micha" : "Alex"} · ${currentCue.title}`
            ),
            el("div", { class: "step-detail selectable" }, currentCue.transcript),
            audioUnavailable
              ? el("div", { style: "font-size:12px;color:var(--text-secondary);margin-top:4px" }, "🔇 Sprachclip nicht verfügbar")
              : null
          )
        )
      : null,
    el(
      "div",
      { class: "btn-row" },
      el("button", { type: "button", class: "btn-secondary", onClick: openTrailerModal }, "▶ NACHTDIFF-Trailer ansehen"),
      videoMenuBtn
    ),
    st.solved
      ? el(
          "div",
          { class: "success-banner" },
          el(
            "div",
            { style: "font-weight:700;font-size:16px;color:var(--evidence-green)" },
            ep.id === 7
              ? "⚑ Staffel abgeschlossen"
              : ep.id === 0
              ? "⚑ Probelauf bestanden. Jetzt wird es ernst."
              : "⚑ Fall gelöst"
          ),
          el(
            "div",
            { style: "font-size:13.5px" },
            snapshot.mission?.resolution ||
              "Auf Juris Bon stehen 0,50 Euro. Die Sicherung bestätigt Rikes 2,50 Euro. Der nächtliche Abgleich des Kaffeeautomaten hat die Buchung verändert. Rike heftet beide Fassungen zusammen. In Episode 1 wartet die nächste Akte: „Zu viele Rechte“."
          ),
          ep.id === 0
            ? el("div", { style: "font-size:12.5px;color:var(--text-secondary)" }, "📦 Beweisstück „Der Bon von 03:12 Uhr“ · Code S2-E0-KASSE")
            : null,
          ep.id === 7
            ? el(
                "details",
                {},
                el("summary", { style: "cursor:pointer;font-weight:600" }, "Übergabebericht"),
                el("pre", { class: "evidence-content" }, FINALE_REPORT),
                el(
                  "button",
                  {
                    type: "button",
                    class: "btn-secondary",
                    style: "margin-top:6px",
                    onClick: () => api.copyText(FINALE_REPORT),
                  },
                  "📋 Bericht kopieren"
                )
              )
            : null,
          nextEp
            ? el(
                "div",
                {},
                el(
                  "button",
                  { type: "button", class: "btn-primary", onClick: () => api.selectEpisode(nextEp.id) },
                  `Weiter zu Episode ${nextEp.id}`
                )
              )
            : null
        )
      : null,
    el("p", { class: "briefing-text" }, ep.briefing),
    el(
      "div",
      { class: "notice-banner" },
      el("span", {}, "ℹ"),
      el(
        "span",
        {},
        "Die Befehle laufen als azubi in einer lokalen Alpine-Linux-VM ohne Netzwerk und ohne Zugriff auf deine Windows-Ordner."
      )
    ),
    ...ep.tracks.map((track) => renderTrackSection(track, false)),
    snapshot.loadWarning ? el("div", { class: "warning-banner" }, `⚠ ${snapshot.loadWarning}`) : null
  );
}

function ensureXterm() {
  if (xterm) return;
  xterm = new window.Terminal({
    fontFamily: '"Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace',
    fontSize: 14,
    cursorBlink: true,
    theme: {
      background: "#121714",
      foreground: "#d9e6d6",
      cursor: "#9ed199",
    },
  });
  fitAddon = new window.FitAddon.FitAddon();
  xterm.loadAddon(fitAddon);

  xterm.onData((str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    api.sendTerminalInput(btoa(bin));
  });
  xterm.onResize(({ cols, rows }) => {
    api.resizeTerminal({ cols, rows });
  });

  terminalElement = document.createElement("div");
  terminalElement.className = "terminal-container";
  xterm.open(terminalElement);

  window.addEventListener("resize", () => {
    if (snapshot?.state?.page === "terminal" && fitAddon) {
      fitAddon.fit();
    }
  });
}

function renderTerminalBar() {
  return el(
    "div",
    { class: "terminal-bar" },
    el("span", { class: "terminal-dot" }),
    el("span", { class: "terminal-host" }, snapshot.maintenanceShell ? "root@rw-srv01" : "azubi@rw-srv01"),
    el("span", { class: "terminal-msg" }, snapshot.linuxMessage),
    el("span", { class: "terminal-cwd" }, snapshot.maintenanceShell ? "Wartungsmodus" : snapshot.state.cwd),
    !snapshot.maintenanceShell && snapshot.interactiveShellOpen
      ? el(
          "button",
          {
            type: "button",
            class: "btn-subtle",
            style: "padding:3px 8px;font-size:11.5px;color:#d9e6d6;border-color:rgba(255,255,255,0.2)",
            onClick: openMaintenanceModal,
          },
          "Wartungs-Shell"
        )
      : null
  );
}

function renderTerminalPage() {
  ensureXterm();
  const bar = renderTerminalBar();
  const page = el("div", { class: "terminal-page" }, bar, terminalElement);
  queueMicrotask(() => {
    if (fitAddon) fitAddon.fit();
    xterm.focus();
    if (!snapshot.interactiveShellOpen && !snapshot.terminalBusy) {
      api.openInteractiveTerminal(false);
    }
  });
  return page;
}

function disconnectVnc() {
  if (rfbClient) {
    try {
      rfbClient.disconnect();
    } catch {}
    rfbClient = null;
    connectedWsPort = null;
  }
}

function renderDesktopPage() {
  const mission = snapshot.mission;
  const hasPhoto = Boolean(mission?.desktop?.photo);

  const canvasWrap = el("div", { class: "desktop-canvas-wrap", id: "vnc-target" });
  if (snapshot.desktopReady && snapshot.vncWsPort) {
    queueMicrotask(() => {
      const target = document.getElementById("vnc-target");
      if (!target) return;
      if (rfbClient && connectedWsPort === snapshot.vncWsPort) return;
      disconnectVnc();
      try {
        const rfb = new RFB(target, `ws://127.0.0.1:${snapshot.vncWsPort}`);
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfbClient = rfb;
        connectedWsPort = snapshot.vncWsPort;
      } catch (err) {
        target.textContent = `VNC-Fehler: ${err.message}`;
      }
    });
  } else if (snapshot.desktopMessage) {
    canvasWrap.replaceChildren(
      el(
        "div",
        { style: "padding:20px;color:#eee;display:flex;flex-direction:column;gap:12px" },
        el("pre", { class: "selectable", style: "white-space:pre-wrap" }, snapshot.desktopMessage),
        el(
          "button",
          { type: "button", class: "btn-primary", onClick: () => api.useDesktop("start") },
          "Bildschirm erneut starten"
        )
      )
    );
  } else {
    canvasWrap.replaceChildren(el("div", { class: "desktop-loading" }, "Linux-Bildschirm startet …"));
    if (!snapshot.terminalBusy) {
      queueMicrotask(() => api.useDesktop("start"));
    }
  }

  return el(
    "div",
    { class: "desktop-page" },
    el(
      "div",
      { class: "desktop-toolbar" },
      el("strong", {}, "🖥 Linux-Bildschirm"),
      el("div", { style: "flex:1" }),
      el(
        "button",
        {
          type: "button",
          class: "btn-secondary",
          disabled: !snapshot.desktopReady || snapshot.terminalBusy,
          onClick: () => api.useDesktop("files"),
        },
        "📁 Dateimanager"
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn-secondary",
          disabled: !snapshot.desktopReady || snapshot.terminalBusy,
          onClick: () => api.useDesktop("terminal"),
        },
        "⌨ Grafisches Terminal"
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn-secondary",
          disabled: !snapshot.desktopReady || snapshot.terminalBusy,
          onClick: () => api.useDesktop("editor"),
        },
        "📝 Texteditor"
      ),
      hasPhoto
        ? el(
            "button",
            {
              type: "button",
              class: "btn-secondary",
              disabled: !snapshot.desktopReady || snapshot.terminalBusy,
              onClick: () => api.useDesktop("photo"),
            },
            "🖼 Bildbetrachter"
          )
        : null,
      el(
        "button",
        {
          type: "button",
          class: "btn-primary",
          disabled: !snapshot.desktopReady || snapshot.terminalBusy,
          onClick: () => api.refreshGuest(),
        },
        "Stand prüfen"
      )
    ),
    canvasWrap
  );
}

function renderAktenwandPage() {
  const ep = snapshot.episode;
  const evs = snapshot.state.evidences;
  const prog = el("div");
  renderProgressSummary(prog, false);

  return el(
    "div",
    { class: "page-content" },
    el(
      "div",
      {},
      el("h1", { class: "page-title" }, "Aktenwand"),
      el(
        "p",
        { class: "step-detail" },
        "Gesicherte Ausgaben aus dem Übungsterminal. Nur was du per Umleitung in ~/belege/ geschrieben hast, liegt hier."
      )
    ),
    evs.length === 0
      ? el(
          "div",
          { class: "track-card" },
          el("div", { class: "track-title" }, "📥 Noch keine Belege"),
          el(
            "p",
            { class: "step-detail" },
            "Ein Beleg entsteht, wenn du die echte Ausgabe eines Befehls in eine Datei unter ~/belege/ umleitest – zum Beispiel mit `ls -l /srv/rechenwerk/uebung/ > ~/belege/kasse-meta.txt`. Abgetippter Text zählt nicht."
          )
        )
      : el(
          "div",
          { class: "evidence-grid" },
          ...ep.tracks
            .map((track) => {
              const items = evs.filter((e) => e.trackID === track.id);
              if (!items.length) return null;
              return el(
                "div",
                { class: "track-card" },
                el("div", { class: "track-title" }, track.title),
                track.summary ? el("div", { class: "step-detail" }, track.summary) : null,
                ...items.map(renderEvidenceCard)
              );
            })
            .filter(Boolean)
        ),
    prog
  );
}

function renderVorwurfPage() {
  const ep = snapshot.episode;
  const st = snapshot.state;

  if (ep.id === 7) {
    const mission = snapshot.mission;
    return el(
      "div",
      { class: "page-content" },
      el("h1", { class: "page-title" }, "Die Übergabe"),
      el("p", { class: "step-detail" }, "Ordne die Erkenntnisse zu und wähle beide anerkannten Belege aus."),
      ...(mission
        ? ep.steps
            .filter((s) => mission.responses?.[s.id])
            .map((s) =>
              el(
                "div",
                { class: "track-card" },
                el("div", { class: "step-title" }, s.title),
                renderAnswerBox(s, mission.responses[s.id])
              )
            )
        : []),
      el("div", { class: "evidence-grid" }, ...st.evidences.map(renderEvidenceCard)),
      st.lastAccusationFeedback
        ? el("div", { class: "warning-banner" }, st.lastAccusationFeedback)
        : null,
      el(
        "div",
        { class: "btn-row" },
        el(
          "button",
          {
            type: "button",
            class: "btn-primary",
            disabled: snapshot.terminalBusy,
            onClick: () => api.submitFinale(),
          },
          "Übergabe abgeben"
        )
      )
    );
  }

  return el(
    "div",
    { class: "page-content" },
    el(
      "div",
      {},
      el("h1", { class: "page-title" }, "Vorwurf erheben"),
      el(
        "p",
        { class: "step-detail" },
        "Mindestens zwei anerkannte Belege, mindestens ein Beleg aus jeder Spur. Die Prüfung erfolgt frisch, vor der Bewertung."
      )
    ),
    el("h3", {}, "Verdächtige"),
    el(
      "div",
      { class: "evidence-grid" },
      ...ep.suspects.map((s) => {
        const selected = st.selectedSuspectID === s.id;
        const portrait = s.portraitName || (s.id !== "kaffee" ? s.id : null);
        return el(
          "button",
          {
            type: "button",
            class: `suspect-row${selected ? " selected" : ""}`,
            onClick: () => api.setSelectedSuspect(s.id),
          },
          el("span", { style: `color:${selected ? "var(--copper)" : "var(--text-secondary)"}` }, selected ? "◉" : "○"),
          portrait
            ? el("img", {
                class: "suspect-portrait",
                src: `${assets.einsatzBase}/${portrait}.webp`,
                alt: s.name,
              })
            : el("span", { style: "font-size:26px;width:64px;text-align:center" }, "☕"),
          el(
            "div",
            {},
            el("div", { style: "font-weight:700" }, s.name),
            el("div", { class: "step-detail" }, s.detail ? `${s.role} – ${s.detail}` : s.role)
          )
        );
      })
    ),
    el("h3", {}, "Belege"),
    st.evidences.length === 0
      ? el("p", { class: "step-detail" }, "Noch keine erkannten Belege.")
      : el("div", { class: "evidence-grid" }, ...st.evidences.map(renderEvidenceCard)),
    st.lastAccusationFeedback
      ? el(
          "div",
          { class: st.solved ? "success-banner" : "warning-banner" },
          st.lastAccusationFeedback
        )
      : null,
    el(
      "div",
      { class: "btn-row" },
      el(
        "button",
        {
          type: "button",
          class: "btn-primary",
          disabled: snapshot.terminalBusy,
          onClick: () => api.submitAccusation(),
        },
        "✓ Prüfen"
      ),
      st.solved
        ? el(
            "span",
            { style: "color:var(--evidence-green);font-weight:600" },
            ep.id === 0 ? "⚑ Probelauf bestanden" : "⚑ Fall gelöst"
          )
        : null
    )
  );
}

function renderHelpPage() {
  return el(
    "div",
    { class: "page-content" },
    el(
      "div",
      {},
      el("h1", { class: "page-title" }, "Hilfe & Werkzeuge"),
      el(
        "p",
        { class: "step-detail" },
        "Das Terminal führt Befehlszeilen in der Alpine-Shell aus. Für die Ermittlungen stehen unter anderem die folgenden Werkzeuge zur Verfügung."
      )
    ),
    el(
      "div",
      { class: "track-card" },
      el("div", { class: "track-title" }, "Befehle"),
      ...HELP_COMMANDS.map(([cmd, desc]) =>
        el("div", { class: "cmd-row" }, el("code", { class: "cmd-name" }, cmd), el("span", { class: "step-detail" }, desc))
      )
    ),
    el(
      "div",
      { class: "track-card" },
      el("div", { class: "track-title" }, "Beispielbefehle"),
      el("p", { class: "step-detail" }, "Zum Kopieren gedacht – sie werden nicht automatisch ausgeführt."),
      ...EXAMPLE_COMMANDS.map((ex) =>
        el(
          "div",
          { class: "example-row" },
          el("span", { class: "selectable" }, ex),
          el(
            "button",
            { type: "button", class: "btn-subtle", onClick: () => api.copyText(ex) },
            "📋 Kopieren"
          )
        )
      )
    ),
    el(
      "div",
      { class: "track-card" },
      el("div", { class: "track-title" }, "Tastatur"),
      el("div", { class: "step-detail" }, "⌨ Strg+1 … Strg+6 – Seiten wechseln"),
      el("div", { class: "step-detail" }, "⌨ Strg+Eingabe – Vorwurf prüfen / Übergabe abgeben"),
      el("div", { class: "step-detail" }, "⌨ Strg+, – Einstellungen öffnen"),
      el("div", { class: "step-detail" }, "⌨ Strg+Alt+Umschalt+R – Wartungs-Shell (Root) im Terminal")
    ),
    el(
      "div",
      { class: "notice-banner" },
      el("span", {}, "ℹ"),
      el(
        "span",
        {},
        "Die lokale Linux-VM besitzt eine eigene Festplatte und arbeitet offline. Änderungen in deinem Linux-Home und in der Übung bleiben im Spielstand erhalten."
      )
    )
  );
}

function closeModal() {
  if (activeModal?.cleanup) activeModal.cleanup();
  activeModal = null;
  document.getElementById("modal-root").replaceChildren();
}

function showModal(title, contentNode, cleanup = null) {
  closeModal();
  const backdrop = el(
    "div",
    {
      class: "modal-backdrop",
      onClick: (e) => {
        if (e.target === backdrop) closeModal();
      },
    },
    el(
      "div",
      { class: "modal-dialog" },
      el(
        "div",
        { class: "modal-header" },
        el("h2", {}, title),
        el("button", { type: "button", class: "btn-secondary", onClick: closeModal }, "Schließen")
      ),
      contentNode
    )
  );
  activeModal = { cleanup };
  document.getElementById("modal-root").replaceChildren(backdrop);
}

function openTrailerModal() {
  stopAudio();
  const video = el(
    "video",
    {
      class: "video-frame",
      src: assets.trailer,
      controls: true,
      autoplay: true,
    },
    assets.trailerVtt
      ? el("track", {
          kind: "subtitles",
          srclang: "de",
          label: "Deutsch",
          src: assets.trailerVtt,
          default: true,
        })
      : null
  );
  video.muted = false;
  video.volume = 1.0;
  showModal("NACHTDIFF · Ein Linux-Krimi", video, () => video.pause());
}

function openSceneModal(sceneKey) {
  stopAudio();
  const scene = FINALE_SCENES[sceneKey];
  if (!scene) return;
  let idx = 0;
  let partAudio = null;
  const video = el("video", { class: "video-frame", controls: true, autoplay: true });
  const caption = el("div", { class: "step-detail selectable", style: "max-width:768px" });
  const nextBtn = el("button", { type: "button", class: "btn-secondary", onClick: () => playPart(idx + 1) }, "Weiter");

  function stopPart() {
    video.pause();
    if (partAudio) {
      partAudio.pause();
      partAudio = null;
    }
  }

  function playPart(i) {
    stopPart();
    idx = i;
    const part = scene.parts[i];
    caption.textContent = part.caption;
    nextBtn.hidden = i + 1 >= scene.parts.length;
    const ext = assets.videoExt || "mp4";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced && part.audio) {
      video.hidden = true;
      partAudio = new Audio(`${assets.einsatzBase}/${part.audio}.mp3`);
      partAudio.play().catch(() => {});
      return;
    }
    video.hidden = false;
    video.src = `${assets.finaleBase}/${part.video}.${ext}`;
    video.muted = false;
    video.volume = 1.0;
    video.play().catch(() => {});
  }

  video.addEventListener("ended", () => {
    if (idx + 1 < scene.parts.length) playPart(idx + 1);
  });

  const body = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:12px" },
    video,
    caption,
    el(
      "div",
      { class: "btn-row" },
      el("button", { type: "button", class: "btn-secondary", onClick: () => playPart(0) }, "Erneut ansehen"),
      nextBtn
    )
  );
  showModal(scene.title, body, stopPart);
  playPart(0);
}

function openArtworkModal() {
  const box = el(
    "div",
    { class: "btn-row", style: "gap:18px;align-items:flex-start" },
    el(
      "div",
      {},
      el("img", { src: `${assets.einsatzBase}/terminal_missions_hero.png`, style: "width:240px;height:190px;object-fit:contain" }),
      el("div", { style: "font-weight:700;margin-top:6px" }, "Terminal-Missionen")
    ),
    el(
      "div",
      {},
      el("img", { src: `${assets.einsatzBase}/linux_commands_preview.svg`, style: "width:240px;height:190px;object-fit:contain" }),
      el("div", { style: "font-weight:700;margin-top:6px" }, "Linux-Befehle")
    )
  );
  showModal("Originalgrafiken", box);
}

function openPhotoModal() {
  const img = el("img", {
    src: `${assets.einsatzBase}/wiederganger-zettel.png`,
    style: "width:680px;max-width:100%;border-radius:8px",
    alt: "Wartungszettel für den Wächter des Lagerabgleichs: RW-2122",
  });
  showModal("Wartungsfoto", img);
}

function openRoomModal(episodeID, solved) {
  const titles = {
    1: "Rack · Fernwartung",
    2: "Rack · Lagerabgleich",
    4: "Rack · Freigabe und Vorlage",
    5: "Rack · Lokaler Ausgang",
    6: "Rack · Zeitquellen",
    7: "Rack · Übergabe",
  };
  const title = titles[episodeID] || "Anmeldelog und Spiegel";
  const canvas = el("canvas", { class: "room3d-canvas" });
  const slider = el("input", {
    type: "range",
    min: "-55",
    max: "55",
    value: "12",
    style: "flex:1",
  });
  const centerBtn = el("button", { type: "button", class: "btn-secondary" }, "Zentrieren");
  const container = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:12px" },
    canvas,
    el("div", { class: "btn-row" }, el("span", {}, "Blickwinkel"), slider, centerBtn)
  );

  const room = mountRoom3D(canvas, episodeID, solved);
  slider.addEventListener("input", () => room.setRotation(Number(slider.value)));
  centerBtn.addEventListener("click", () => {
    slider.value = "12";
    room.setRotation(12);
  });
  showModal(title, container, () => room.dispose());
}

function openSettingsModal() {
  const select = el(
    "select",
    {
      class: "text-input",
      onChange: (e) => api.setAppearance(e.target.value),
    },
    el("option", { value: "system", ...(snapshot.appearance === "system" ? { selected: true } : {}) }, "System"),
    el("option", { value: "light", ...(snapshot.appearance === "light" ? { selected: true } : {}) }, "Hell"),
    el("option", { value: "dark", ...(snapshot.appearance === "dark" ? { selected: true } : {}) }, "Dunkel")
  );

  const confirmBox = el("div", { hidden: true, class: "warning-banner", style: "display:flex;flex-direction:column;gap:8px" });
  const resetBtn = el(
    "button",
    {
      type: "button",
      class: "btn-secondary",
      disabled: snapshot.terminalBusy,
      onClick: () => {
        confirmBox.hidden = false;
      },
    },
    "Fortschritt zurücksetzen…"
  );

  confirmBox.replaceChildren(
    el("div", { style: "font-weight:700" }, "Fortschritt wirklich zurücksetzen?"),
    el(
      "div",
      {},
      "Der Spielstand und die Linux-Festplatte werden im selben Ordner gesichert. Die Übung beginnt von vorn."
    ),
    el(
      "div",
      { class: "btn-row" },
      el(
        "button",
        {
          type: "button",
          class: "btn-danger",
          onClick: async () => {
            closeModal();
            await api.resetProgress();
          },
        },
        "Zurücksetzen"
      ),
      el("button", { type: "button", class: "btn-secondary", onClick: () => (confirmBox.hidden = true) }, "Abbrechen")
    )
  );

  const content = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:14px;width:460px;max-width:100%" },
    el("div", {}, el("div", { style: "font-weight:700;margin-bottom:4px" }, "Erscheinungsbild"), select),
    el(
      "div",
      {},
      el("div", { style: "font-weight:700;margin-bottom:4px" }, "Übungsterminal"),
      el("div", { class: "step-detail" }, "Befehle laufen als azubi in einer lokalen Alpine-Linux-VM (x86_64, offline).")
    ),
    el(
      "div",
      {},
      el("div", { style: "font-weight:700;margin-bottom:4px" }, "Spielstand"),
      el("div", { class: "code-chip", style: "margin-bottom:8px" }, snapshot.storePath),
      el("div", {}, resetBtn),
      confirmBox
    )
  );
  showModal("Einstellungen", content);
}

function openMaintenanceModal() {
  const content = el(
    "div",
    { style: "display:flex;flex-direction:column;gap:12px;width:440px" },
    el(
      "p",
      { class: "step-detail" },
      "Beim Wechsel endet die aktuelle Shell-Sitzung. Root kann Systemdateien und Missionsdaten in dieser Offline-VM ändern. Mit exit öffnet sich wieder eine azubi-Shell."
    ),
    el(
      "div",
      { class: "btn-row", style: "justify-content:flex-end" },
      el("button", { type: "button", class: "btn-secondary", onClick: closeModal }, "Abbrechen"),
      el(
        "button",
        {
          type: "button",
          class: "btn-danger",
          onClick: () => {
            closeModal();
            api.openInteractiveTerminal(true);
          },
        },
        "Root-Shell öffnen"
      )
    )
  );
  showModal("Wartung in der Spiel-VM", content);
}

function renderMain() {
  const main = document.getElementById("main-pane");
  const page = snapshot.state.page;
  const prevScroll = main.scrollTop;
  if (page !== "desktop") disconnectVnc();

  if (page === "terminal") {
    const existingTerm = main.querySelector(".terminal-page");
    if (existingTerm) {
      const bar = renderTerminalBar();
      existingTerm.firstElementChild.replaceWith(bar);
      return;
    }
    main.replaceChildren(renderTerminalPage());
    return;
  }

  if (page === "desktop") {
    const existingDesk = main.querySelector(".desktop-page");
    if (existingDesk && connectedWsPort && connectedWsPort === snapshot.vncWsPort && snapshot.desktopReady) {
      const next = renderDesktopPage();
      existingDesk.firstElementChild.replaceWith(next.firstElementChild);
      return;
    }
    main.replaceChildren(renderDesktopPage());
    return;
  }

  if (page === "briefing") main.replaceChildren(renderBriefingPage());
  else if (page === "aktenwand") main.replaceChildren(renderAktenwandPage());
  else if (page === "vorwurf") main.replaceChildren(renderVorwurfPage());
  else if (page === "help") main.replaceChildren(renderHelpPage());
  main.scrollTop = prevScroll;
}

function renderAll() {
  if (!snapshot || !assets) return;
  applyAppearance(snapshot.appearance);
  renderSidebar();
  renderTopbarAndInspector();
  renderMain();
}

async function init() {
  assets = await api.getAssetUrls();
  try {
    episodeVoices = await (await fetch(`${assets.einsatzBase}/episodenstimmen.json`)).json();
  } catch {}
  try {
    michaVoices = await (await fetch(`${assets.einsatzBase}/micha-stimmen.json`)).json();
  } catch {}

  snapshot = await api.getInitialState();
  renderAll();

  document.getElementById("btn-toggle-inspector").addEventListener("click", () => {
    showsMissionOutline = !showsMissionOutline;
    renderTopbarAndInspector();
  });
  document.getElementById("btn-open-settings").addEventListener("click", openSettingsModal);
  document.addEventListener("click", () => {
    document.querySelectorAll(".dropdown-menu").forEach((m) => (m.hidden = true));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  api.onStateChanged((next) => {
    snapshot = next;
    renderAll();
  });
  api.onTerminalOutput((b64) => {
    if (!xterm) return;
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    xterm.write(bytes);
  });
  api.onTerminalReset(() => {
    if (xterm) xterm.reset();
  });
  api.onOpenSettings(openSettingsModal);
  api.onRequestMaintenance(openMaintenanceModal);

  michaTimer = setInterval(async () => {
    if (snapshot?.state?.page !== "briefing") return;
    const bar = document.getElementById("micha-bar");
    if (!bar) return;
    const wasAsleep = bar.dataset.asleep === "true";
    const nowAsleep = getMichaAsleep();
    if (nowAsleep !== wasAsleep) {
      if (
        nowAsleep &&
        snapshot.episode.id >= 4 &&
        !activeModal &&
        !(audioEl && !audioEl.paused) &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        michaAnimating = "micha-doest";
        refreshMichaBarOnly();
        setTimeout(() => {
          michaAnimating = false;
          refreshMichaBarOnly();
        }, 3200);
      } else {
        refreshMichaBarOnly();
      }
    }
  }, 1000);
}

init();
