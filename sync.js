(function (global) {
  const STATE_KEY = "zakovat_timer_state_v1";
  const COMMAND_KEY = "zakovat_timer_command_v1";
  const CHANNEL_NAME = "zakovat_timer_channel_v1";

  const appConfig = global.ZakovatAppConfig || {};

  function normalizeText(value) {
    return String(value || "").trim();
  }

  function normalizeBaseUrl(url) {
    return normalizeText(url).replace(/\/+$/, "");
  }

  function readRoomFromUrl() {
    try {
      const params = new URLSearchParams(global.location.search);
      const room = normalizeText(params.get("room"));
      if (room) return room;
    } catch (_error) {
      return "";
    }

    return "";
  }

  const roomId = normalizeText(readRoomFromUrl() || appConfig.roomId || "main");
  const cloudBaseUrl = normalizeBaseUrl(appConfig.firebaseDatabaseUrl || appConfig.realtimeDatabaseUrl);
  const cloudAuthToken = normalizeText(appConfig.firebaseAuthToken || "");
  const requestedMode = normalizeText(appConfig.syncMode || "cloud").toLowerCase();
  const cloudEnabled = requestedMode !== "local" && Boolean(cloudBaseUrl);
  const pollMs = Number(appConfig.pollMs) >= 250 ? Number(appConfig.pollMs) : 500;

  function safeParse(raw) {
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function now() {
    return Date.now();
  }

  function makeId() {
    return `${now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function defaultState() {
    return {
      version: 1,
      roundSeconds: 20,
      phase: "idle",
      remaining: 20,
      timerLabel: "Asosiy vaqt",
      status: "Tayyor holat",
      subStatus: "Admin Enter tugmasi bilan raundni boshlaydi.",
      firstTeamKey: null,
      secondTeamKey: null,
      updatedAt: now()
    };
  }

  function readState() {
    const parsed = safeParse(localStorage.getItem(STATE_KEY));

    if (!parsed || parsed.version !== 1) {
      return defaultState();
    }

    return parsed;
  }

  const listeners = new Set();
  const channel = typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

  function emit(message) {
    listeners.forEach(function (listener) {
      listener(message);
    });
  }

  if (channel) {
    channel.addEventListener("message", function (event) {
      if (!event.data || !event.data.kind) return;
      emit(event.data);
    });
  }

  global.addEventListener("storage", function (event) {
    if (event.key === STATE_KEY && event.newValue) {
      const state = safeParse(event.newValue);
      if (state) emit({ kind: "state", state: state });
      return;
    }

    if (event.key === COMMAND_KEY && event.newValue) {
      const command = safeParse(event.newValue);
      if (command) emit({ kind: "command", command: command });
    }
  });

  function subscribe(listener) {
    listeners.add(listener);
    return function () {
      listeners.delete(listener);
    };
  }

  function createCloudBridge() {
    if (!cloudEnabled) {
      return {
        enabled: false,
        mode: "local",
        roomId: roomId,
        start: function () {},
        publishState: function () {},
        sendCommand: function () {}
      };
    }

    const encodedRoom = encodeURIComponent(roomId);
    let lastStateUpdatedAt = 0;
    let lastCommandSentAt = 0;
    let polling = false;
    let pollTimer = null;

    function buildUrl(path, query) {
      const baseUrl = `${cloudBaseUrl}/rooms/${encodedRoom}/${path}.json`;
      const params = new URLSearchParams();

      if (query) {
        Object.keys(query).forEach(function (key) {
          const value = query[key];
          if (value === undefined || value === null || value === "") return;
          params.set(key, String(value));
        });
      }

      if (cloudAuthToken) {
        params.set("auth", cloudAuthToken);
      }

      const queryString = params.toString();
      return queryString ? `${baseUrl}?${queryString}` : baseUrl;
    }

    async function requestJson(url, options) {
      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(`Cloud sync HTTP ${response.status}`);
      }

      const text = await response.text();
      if (!text) return null;
      return safeParse(text);
    }

    function publishState(state) {
      const updatedAt = Number(state && state.updatedAt) || 0;
      if (updatedAt > lastStateUpdatedAt) {
        lastStateUpdatedAt = updatedAt;
      }

      fetch(buildUrl("state"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
        keepalive: true
      }).catch(function () {});
    }

    function sendCommand(command) {
      const sentAt = Number(command && command.sentAt) || 0;
      if (sentAt > lastCommandSentAt) {
        lastCommandSentAt = sentAt;
      }

      fetch(buildUrl(`commands/${encodeURIComponent(command.id)}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
        keepalive: true
      }).catch(function () {});
    }

    async function pollState() {
      const state = await requestJson(buildUrl("state"));
      if (!state || typeof state !== "object") return;

      const updatedAt = Number(state.updatedAt) || 0;
      if (updatedAt <= lastStateUpdatedAt) return;

      lastStateUpdatedAt = updatedAt;
      emit({ kind: "state", state: state });
    }

    async function pollCommands() {
      const commandsMap = await requestJson(buildUrl("commands", {
        orderBy: '"sentAt"',
        startAt: String(lastCommandSentAt + 1),
        limitToFirst: 50
      }));

      if (!commandsMap || typeof commandsMap !== "object") return;

      const commands = Object.keys(commandsMap)
        .map(function (key) {
          return commandsMap[key];
        })
        .filter(function (command) {
          return command && typeof command === "object";
        })
        .sort(function (a, b) {
          const sentA = Number(a.sentAt) || 0;
          const sentB = Number(b.sentAt) || 0;
          if (sentA !== sentB) return sentA - sentB;
          return String(a.id || "").localeCompare(String(b.id || ""));
        });

      commands.forEach(function (command) {
        const sentAt = Number(command.sentAt) || 0;
        if (sentAt <= lastCommandSentAt) return;

        lastCommandSentAt = sentAt;
        emit({ kind: "command", command: command });
      });
    }

    async function pollOnce() {
      if (polling) return;
      polling = true;

      try {
        await Promise.all([pollState(), pollCommands()]);
      } catch (_error) {
      } finally {
        polling = false;
      }
    }

    function start() {
      if (pollTimer) return;
      pollOnce();
      pollTimer = setInterval(pollOnce, pollMs);
    }

    return {
      enabled: true,
      mode: "cloud",
      roomId: roomId,
      start: start,
      publishState: publishState,
      sendCommand: sendCommand
    };
  }

  const cloudBridge = createCloudBridge();
  cloudBridge.start();

  function publishState(nextState) {
    const state = {
      ...nextState,
      version: 1,
      updatedAt: now()
    };

    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    if (channel) {
      channel.postMessage({ kind: "state", state: state });
    }

    emit({ kind: "state", state: state });
    cloudBridge.publishState(state);

    return state;
  }

  function sendCommand(type, payload) {
    const command = {
      id: makeId(),
      type: type,
      payload: payload || {},
      sentAt: now()
    };

    localStorage.setItem(COMMAND_KEY, JSON.stringify(command));

    if (channel) {
      channel.postMessage({ kind: "command", command: command });
    }

    emit({ kind: "command", command: command });
    cloudBridge.sendCommand(command);

    return command;
  }

  function createAudioController() {
    const AudioContextClass = global.AudioContext || global.webkitAudioContext;
    const mutedApi = {
      play: function () {},
      unlock: function () {},
      setEnabled: function () {}
    };

    if (!AudioContextClass) {
      return mutedApi;
    }

    let context = null;
    let enabled = true;

    function getContext() {
      if (!context) {
        context = new AudioContextClass();
      }

      return context;
    }

    function unlock() {
      const ctx = getContext();
      if (ctx.state === "suspended") {
        ctx.resume().catch(function () {});
      }
    }

    function tone(frequency, duration, options) {
      if (!enabled) return;
      const ctx = getContext();

      if (ctx.state === "suspended") {
        ctx.resume().catch(function () {});
      }

      const settings = options || {};
      const startAt = ctx.currentTime + (settings.delay || 0);
      const volume = settings.volume || 0.16;
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = settings.type || "sine";
      oscillator.frequency.value = frequency;

      gainNode.gain.setValueAtTime(0.0001, startAt);
      gainNode.gain.exponentialRampToValueAtTime(volume, startAt + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + duration + 0.03);
    }

    function playPattern(notes) {
      let delay = 0;

      notes.forEach(function (note) {
        tone(note.freq, note.duration, {
          delay: delay,
          volume: note.volume,
          type: note.type
        });

        delay += note.gap || note.duration + 0.04;
      });
    }

    function play(soundName) {
      if (!enabled) return;
      unlock();

      if (soundName === "start") {
        playPattern([
          { freq: 740, duration: 0.09, type: "square", volume: 0.14 },
          { freq: 980, duration: 0.11, type: "square", volume: 0.16, gap: 0.12 }
        ]);
        return;
      }

      if (soundName === "press_red") {
        playPattern([{ freq: 370, duration: 0.2, type: "sawtooth", volume: 0.18 }]);
        return;
      }

      if (soundName === "press_green") {
        playPattern([{ freq: 540, duration: 0.2, type: "triangle", volume: 0.18 }]);
        return;
      }

      if (soundName === "timeout") {
        playPattern([
          { freq: 260, duration: 0.12, type: "square", volume: 0.17 },
          { freq: 220, duration: 0.12, type: "square", volume: 0.17, gap: 0.18 },
          { freq: 180, duration: 0.2, type: "square", volume: 0.18, gap: 0.2 }
        ]);
        return;
      }

      if (soundName === "correct") {
        playPattern([
          { freq: 640, duration: 0.1, type: "triangle", volume: 0.14 },
          { freq: 860, duration: 0.12, type: "triangle", volume: 0.16, gap: 0.11 },
          { freq: 1080, duration: 0.16, type: "triangle", volume: 0.18, gap: 0.14 }
        ]);
        return;
      }

      if (soundName === "wrong") {
        playPattern([
          { freq: 500, duration: 0.13, type: "sawtooth", volume: 0.16 },
          { freq: 320, duration: 0.22, type: "sawtooth", volume: 0.19, gap: 0.14 }
        ]);
        return;
      }

      if (soundName === "reset") {
        playPattern([{ freq: 700, duration: 0.09, type: "triangle", volume: 0.12 }]);
      }
    }

    global.addEventListener("pointerdown", unlock, { once: true, passive: true });
    global.addEventListener("keydown", unlock, { once: true });
    global.addEventListener("touchstart", unlock, { once: true, passive: true });

    return {
      play: play,
      unlock: unlock,
      setEnabled: function (value) {
        enabled = Boolean(value);
      }
    };
  }

  global.ZakovatSync = {
    STATE_KEY: STATE_KEY,
    COMMAND_KEY: COMMAND_KEY,
    syncMode: cloudBridge.mode,
    cloudEnabled: cloudBridge.enabled,
    roomId: roomId,
    defaultState: defaultState,
    readState: readState,
    publishState: publishState,
    sendCommand: sendCommand,
    subscribe: subscribe
  };

  global.ZakovatAudio = createAudioController();
})(window);
