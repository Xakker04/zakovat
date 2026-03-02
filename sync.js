(function (global) {
  const STATE_KEY = "zakovat_timer_state_v1";
  const COMMAND_KEY = "zakovat_timer_command_v1";
  const CHANNEL_NAME = "zakovat_timer_channel_v1";

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
    listeners.forEach((listener) => listener(message));
  }

  if (channel) {
    channel.addEventListener("message", (event) => {
      if (!event.data || !event.data.kind) return;
      emit(event.data);
    });
  }

  window.addEventListener("storage", (event) => {
    if (event.key === STATE_KEY && event.newValue) {
      const state = safeParse(event.newValue);
      if (state) emit({ kind: "state", state });
      return;
    }

    if (event.key === COMMAND_KEY && event.newValue) {
      const command = safeParse(event.newValue);
      if (command) emit({ kind: "command", command });
    }
  });

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function publishState(nextState) {
    const state = {
      ...nextState,
      version: 1,
      updatedAt: now()
    };

    localStorage.setItem(STATE_KEY, JSON.stringify(state));

    if (channel) {
      channel.postMessage({ kind: "state", state });
    }

    emit({ kind: "state", state });
    return state;
  }

  function sendCommand(type, payload) {
    const command = {
      id: makeId(),
      type,
      payload: payload || {},
      sentAt: now()
    };

    localStorage.setItem(COMMAND_KEY, JSON.stringify(command));

    if (channel) {
      channel.postMessage({ kind: "command", command });
    }

    emit({ kind: "command", command });
    return command;
  }

  global.ZakovatSync = {
    STATE_KEY,
    COMMAND_KEY,
    defaultState,
    readState,
    publishState,
    sendCommand,
    subscribe
  };
})(window);
