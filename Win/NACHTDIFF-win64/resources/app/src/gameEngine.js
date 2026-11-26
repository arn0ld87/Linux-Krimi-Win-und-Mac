const fs = require("node:fs");
const path = require("node:path");

const ORIGINAL_CSV = [
  "datum,name,betrag",
  "2026-04-13,Timo,5.00",
  "2026-04-14,Nadia,5.00",
  "2026-04-15,Timo,2.50",
  "2026-04-16,Nadia,7.00",
  "2026-04-17,Timo,3.50",
].join("\n");

const CHANGED_CSV = [
  "datum,name,betrag",
  "2026-04-13,Timo,5.00",
  "2026-04-14,Nadia,5.00",
  "2026-04-15,Timo,0.50",
  "2026-04-16,Nadia,7.00",
  "2026-04-17,Timo,3.50",
].join("\n");

const CSV_PATH = "/srv/rechenwerk/uebung/kaffeekasse.csv";
const BELEGE_PATH = "/home/azubi/belege";
const TRANSCRIPT_LIMIT = 200;

const EPISODE_0 = {
  id: 0,
  key: "probelauf",
  title: "Nachtschicht",
  caseTitle: "Der Bon von 03:12 Uhr",
  organization: "Rechenwerk Ostwind GmbH",
  account: "azubi",
  briefing:
    "Juri legt dir einen zerknitterten Bon auf die Tastatur. Für Timos Kaffee vom 15. April stehen da fünfzig Cent. Rike zieht den unterschriebenen Abendabschluss aus ihrer Jacke. Gleicher Tag, gleiche Buchung, zwei Euro fünfzig. In der Blechkasse stimmt der Betrag bis auf den letzten Cent.\n\n" +
    "Um 03:12 Uhr hat jemand die Liste neu geschrieben. Rike will die Sicherung sofort zurückspielen. Du bittest sie, die Hände von der Tastatur zu nehmen. Noch liegen beide Fassungen in /srv/rechenwerk/uebung/.\n\n" +
    "Sichere als azubi die Dateidaten und beide Buchungszeilen. Erst dann kannst du die Liste wiederherstellen und sagen, welches Konto für die Änderung verantwortlich ist.",
  tracks: [
    { id: "akte", title: "Akte", summary: "Metadaten sichern: Besitzer, Rechte und Datum beider Dateien." },
    { id: "inhalt", title: "Inhalt", summary: "Inhalt sichern: geänderte Zeile und ihr Original festhalten." },
  ],
  evidenceSpecs: [
    {
      id: "kasse-meta",
      trackID: "akte",
      fileName: "kasse-meta.txt",
      title: "Metadaten der Kaffeekasse",
      requiredFragments: ["kaffeekasse.csv", "kaffeekasse.bak", "kaffee", "2026-04-17", "03:12"],
      forbiddenFragments: [],
      hint: "Mit `ls -l /srv/rechenwerk/uebung/` siehst du Besitzer, Rechte und Datum beider Dateien.",
    },
    {
      id: "kasse-zeilen",
      trackID: "inhalt",
      fileName: "kasse-zeilen.txt",
      title: "Zeilen um den 15. April",
      requiredFragments: ["2026-04-15,Timo,2.50", "2026-04-15,Timo,0.50"],
      forbiddenFragments: [],
      hint: "Sichere die geänderte Zeile aus der CSV und ihr Original aus der BAK.",
    },
  ],
  suspects: [
    {
      id: "timo",
      name: "Rike Falck",
      role: "Leiterin der Spätschicht",
      detail: "Hat den Abendabschluss um 22:05 Uhr abgezeichnet.",
      portraitName: "rike",
    },
    {
      id: "nadia",
      name: "Juri Kern",
      role: "Techniker im Frühdienst",
      detail: "Hat den ersten Bon gezogen und den Nachdruck abgebrochen.",
      portraitName: "juri",
    },
    {
      id: "kaffee",
      name: "Kaffeeautomat",
      role: "Dienstkonto kaffee",
      detail: "Sein Dienstkonto darf Buchungen für den Tagesabschluss schreiben.",
      portraitName: null,
    },
  ],
  culpritID: "kaffee",
  steps: [
    {
      id: "meta-lesen",
      trackID: "akte",
      title: "Besitzer, Rechte und Datum ablesen",
      detail: "In /srv/rechenwerk/uebung/ liegen die Kaffeekasse-Liste kaffeekasse.csv und ihre Sicherung kaffeekasse.bak vom Abend davor.",
      command: "ls -l /srv/rechenwerk/uebung/",
    },
    {
      id: "meta-sichern",
      trackID: "akte",
      title: "Metadaten in einem Beleg sichern",
      detail: "Ein Beleg ist die echte Ausgabe eines Befehls, in eine Textdatei in ~/belege/ umgeleitet. Abgetippter Text zählt nicht.",
      command: "ls -l /srv/rechenwerk/uebung/ > ~/belege/kasse-meta.txt",
    },
    {
      id: "zeilen-sichern",
      trackID: "inhalt",
      title: "Geänderte Zeile und ihr Original sichern",
      detail: "In der Liste wurde nachts ein Betrag verändert. Sichere beide Fassungen der Zeile vom 15. April.",
      command: "grep 2026-04-15 /srv/rechenwerk/uebung/kaffeekasse.csv > ~/belege/kasse-zeilen.txt",
    },
    {
      id: "zeilen-original",
      trackID: "inhalt",
      title: "Original aus der Sicherung anhängen",
      detail: "Das Original der Zeile steht in der BAK. Hänge es an denselben Beleg an.",
      command: "grep 2026-04-15 /srv/rechenwerk/uebung/kaffeekasse.bak >> ~/belege/kasse-zeilen.txt",
    },
    {
      id: "reparatur",
      trackID: "inhalt",
      title: "Liste aus der Sicherung wiederherstellen",
      detail: "Erst sichern, dann reparieren. Wer vorher repariert, löscht den Beweis.",
      command: "cp /srv/rechenwerk/uebung/kaffeekasse.bak /srv/rechenwerk/uebung/kaffeekasse.csv",
    },
    {
      id: "vorwurf",
      trackID: "akte",
      title: "Vorwurf erheben",
      detail: "Wähle den Verdächtigen und belege ihn mit zwei anerkannten Belegen aus beiden Spuren.",
      command: null,
    },
  ],
  playable: true,
};

function loadMissions(missionsJsonPath) {
  try {
    const raw = fs.readFileSync(missionsJsonPath, "utf8");
    const list = JSON.parse(raw);
    return list.map((m) => {
      const stepsByID = {};
      for (const s of m.steps || []) {
        if (!(s.id in stepsByID)) stepsByID[s.id] = s;
      }
      return { ...m, stepsByID };
    });
  } catch {
    return [];
  }
}

class MissionCatalog {
  constructor(missionsJsonPath) {
    this.browserMissions = loadMissions(missionsJsonPath);
    this.episodes = [EPISODE_0, ...this.browserMissions.map((m) => m.episode)];
  }

  episode(id) {
    return this.episodes.find((e) => e.id === id) || EPISODE_0;
  }

  forEpisode(id) {
    return this.browserMissions.find((m) => m.episode.id === id) || null;
  }

  supportsDesktop(id) {
    return id === 2 || Boolean(this.forEpisode(id)?.desktop);
  }
}

function validateSpec(spec, content) {
  const lowered = (content || "").toLowerCase();
  for (const f of spec.requiredFragments || []) {
    if (!lowered.includes(f.toLowerCase())) return false;
  }
  for (const f of spec.forbiddenFragments || []) {
    if (lowered.includes(f.toLowerCase())) return false;
  }
  return true;
}

class GameEngine {
  constructor(catalog, initialState) {
    this.catalog = catalog;
    this.state = initialState || GameEngine.freshState(catalog, 0);
    if (!this.state.files) this.state.files = {};
    if (!this.state.selectedEvidenceIDs) this.state.selectedEvidenceIDs = [];
    if (!this.state.evidences) this.state.evidences = [];
    if (!this.state.linuxChecks) this.state.linuxChecks = [];
    if (!this.state.acceptedAnswers) this.state.acceptedAnswers = [];
    if (!this.state.transcript) this.state.transcript = [];
  }

  static freshState(catalog, episodeID) {
    const ep = catalog.episode(episodeID);
    return {
      episodeID: ep.id,
      cwd: "/home/azubi",
      files: episodeID === 0 ? { [CSV_PATH]: CHANGED_CSV } : {},
      transcript: [{ kind: "system", text: "Die Befehle laufen in einer lokalen Alpine-Linux-VM." }],
      evidences: [],
      selectedSuspectID: null,
      selectedEvidenceIDs: [],
      repaired: false,
      solved: false,
      page: "briefing",
      lastAccusationFeedback: null,
      linuxChecks: [],
      acceptedAnswers: [],
    };
  }

  get episode() {
    return this.catalog.episode(this.state.episodeID);
  }

  get mission() {
    return this.catalog.forEpisode(this.state.episodeID);
  }

  isStepComplete(id) {
    return (
      (this.state.linuxChecks || []).includes(id) ||
      (this.state.acceptedAnswers || []).includes(id)
    );
  }

  get linuxMissionPaths() {
    if (this.state.episodeID === 0) {
      return {
        csv: CSV_PATH,
        meta: `${BELEGE_PATH}/kasse-meta.txt`,
        lines: `${BELEGE_PATH}/kasse-zeilen.txt`,
      };
    }
    const map = {};
    for (const spec of this.episode.evidenceSpecs) {
      map[spec.id] = `${BELEGE_PATH}/${spec.fileName}`;
    }
    return map;
  }

  get linuxSeed() {
    if (this.state.episodeID !== 0) return {};
    const seed = {
      backup: ORIGINAL_CSV,
      csv: this.state.files?.[CSV_PATH] ?? CHANGED_CSV,
    };
    const paths = this.linuxMissionPaths;
    for (const [key, p] of Object.entries(paths)) {
      if (key === "csv") continue;
      const content = this.state.files?.[p];
      if (typeof content === "string" && Buffer.byteLength(content, "utf8") <= 64 * 1024) {
        seed[key] = content;
      }
    }
    return seed;
  }

  syncLinux(cwd, files, checks = []) {
    this.state.cwd = cwd || "/home/azubi";
    this.state.linuxChecks = Array.from(new Set(checks || []));
    const paths = this.linuxMissionPaths;
    if (!this.state.files) this.state.files = {};
    for (const [key, p] of Object.entries(paths)) {
      if (files && Object.prototype.hasOwnProperty.call(files, key)) {
        this.state.files[p] = files[key];
      } else {
        delete this.state.files[p];
      }
    }
    this.refreshProgress();
  }

  refreshProgress() {
    const ep = this.episode;
    const updated = [];
    for (const spec of ep.evidenceSpecs) {
      const p = `${BELEGE_PATH}/${spec.fileName}`;
      const content = this.state.files?.[p];
      if (typeof content !== "string") continue;
      const valid =
        ep.id === 0
          ? validateSpec(spec, content)
          : (this.state.linuxChecks || []).includes(spec.id);
      updated.push({
        id: spec.id,
        specID: spec.id,
        trackID: spec.trackID,
        title: spec.title,
        fileName: spec.fileName,
        content,
        validated: valid,
        validationHint: valid ? null : spec.hint,
      });
    }
    this.state.evidences = updated;
    const present = new Set(updated.map((e) => e.id));
    this.state.selectedEvidenceIDs = (this.state.selectedEvidenceIDs || []).filter((id) =>
      present.has(id)
    );

    const mission = this.mission;
    if (mission) {
      this.state.repaired = (mission.repairs || []).every((id) => this.isStepComplete(id));
    } else {
      const csv = this.state.files?.[CSV_PATH];
      this.state.repaired = csv === ORIGINAL_CSV;
    }
  }

  completedTracksCount() {
    const ep = this.episode;
    if (ep.id !== 0) {
      return ep.tracks.filter((track) =>
        ep.steps.filter((s) => s.trackID === track.id).every((s) => this.isStepComplete(s.id))
      ).length;
    }
    return ep.tracks.filter((track) =>
      ep.evidenceSpecs
        .filter((spec) => spec.trackID === track.id)
        .every((spec) => this.state.evidences.some((e) => e.specID === spec.id && e.validated))
    ).length;
  }

  markAnswer(id) {
    const set = new Set(this.state.acceptedAnswers || []);
    set.add(id);
    this.state.acceptedAnswers = Array.from(set);
  }

  recordLinuxCommand(input, output, failed) {
    this.state.transcript.push({ kind: "input", text: input });
    if (failed) {
      this.state.transcript.push({ kind: "error", text: output });
    } else if (output) {
      this.state.transcript.push({ kind: "output", text: output });
    }
    if (this.state.transcript.length > TRANSCRIPT_LIMIT) {
      this.state.transcript.splice(0, this.state.transcript.length - TRANSCRIPT_LIMIT);
    }
  }

  clearTerminal() {
    this.state.transcript = [];
  }

  evaluateAccusation(suspectID, evidenceIDs) {
    if (!suspectID) {
      return {
        outcome: "missingEvidence",
        message: "Wähle zuerst einen Verdächtigen.",
      };
    }
    const idSet = new Set(evidenceIDs || []);
    const selected = this.state.evidences.filter((e) => idSet.has(e.id));
    const validated = selected.filter((e) => e.validated);
    const mission = this.mission;
    const minEvidence = mission ? mission.minimumEvidence : 2;

    if (validated.length < minEvidence) {
      return {
        outcome: "missingEvidence",
        message:
          mission?.insufficientEvidence ||
          "Es fehlen anerkannte Belege. Du brauchst mindestens zwei gültige Belege – und zwar aus beiden Spuren.",
      };
    }

    const trackIDs = new Set(validated.map((e) => e.trackID));
    const missingTracks = this.episode.tracks.filter((t) => !trackIDs.has(t.id));
    if (missingTracks.length > 0) {
      const names = missingTracks.map((t) => t.title).join(" und ");
      return {
        outcome: "missingEvidence",
        message: `Deine Belege stammen nur aus einer Spur. Es fehlt ein Beleg aus ${names}.`,
      };
    }

    if (mission) {
      const pending = mission.episode.steps.filter((s) => !this.isStepComplete(s.id));
      if (pending.length > 0) {
        return {
          outcome: "notRepaired",
          message: "Noch offen: " + pending.map((s) => s.title).join(", "),
        };
      }
    } else if (this.state.files?.[CSV_PATH] !== ORIGINAL_CSV) {
      return {
        outcome: "notRepaired",
        message:
          "Die Kaffeekasse ist noch nicht wiederhergestellt. Repariere zuerst die Liste aus der Sicherung.",
      };
    }

    const suspect = this.episode.suspects.find((s) => s.id === suspectID);
    if (!suspect) {
      return {
        outcome: "missingEvidence",
        message: "Dieser Verdächtige ist nicht Teil des Falls.",
      };
    }

    if (suspectID === this.episode.culpritID) {
      return {
        outcome: "accepted",
        message: mission?.resolution || "Probelauf bestanden. Jetzt wird es ernst.",
      };
    }

    return {
      outcome: "wrongSuspect",
      message:
        mission?.wrongSuspect ||
        `${suspect.name} war es nicht. Die Spuren sprechen für ein anderes Konto – prüfe Besitzer und Dienstkonto.`,
    };
  }
}

module.exports = { GameEngine, MissionCatalog, ORIGINAL_CSV, CHANGED_CSV };
