// Morte Idle (morte.idle): an OpenPets plugin that keeps Morte busy while nobody is talking to him.
// Spec: docs/idle-plugin-spec.md. The AMBIENT data below is injected by pipeline/build_plugin.py.
/// <reference types="@open-pets/plugin-sdk" />

export const AMBIENT = "__AMBIENT__";

export const PACE_MS = { lively: [15000, 40000], relaxed: [30000, 90000], sleepy: [60000, 180000] };
export const RESUME_AFTER_AGENT_MS = 45000; // quiet time after the last agent pulse before idling again
export const SELF_ECHO_MS = 800;            // our own say/react calls come back as agent:activity
export const BUBBLE_MS = 3500;              // OpenPets re-renders ~4 s after a react/idle, replaying a longer bubble's pop-in
export const FOLLOW_LAG = 0.9;              // followCursor moves (1 - lag) of the gap per host tick; higher = slower

export const BEHAVIOURS = ["roam", "follow", "quip", "bark", "spin", "trick", "playdead", "shift", "contemplate"];
export const MOODS = ["bored", "engaged", "contemplative"];
export const MOOD_TITLES = { bored: "Bored", engaged: "Engaged", contemplative: "Contemplative" };
// Must match the configSchema defaults in openpets.plugin.json (a test checks it).
export const DEFAULT_BEHAVIOURS = {
  bored: ["roam", "spin", "trick", "quip", "bark"],
  engaged: ["follow", "quip", "bark", "trick", "spin"],
  contemplative: ["shift", "playdead", "contemplate"],
};
const TRICKS = ["tumble", "flourish", "pratfall"];
const STATE_MOOD_CHOICES = [...MOODS, "off"];

// ── pure helpers (unit-tested) ────────────────────────────────────────────────

const cap = (m) => m[0].toUpperCase() + m.slice(1);

export function cleanConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
  const behaviours = {};
  for (const m of MOODS) {
    const v = c["behaviours" + cap(m)];
    behaviours[m] = Array.isArray(v) ? BEHAVIOURS.filter((b) => v.includes(b)) : [...DEFAULT_BEHAVIOURS[m]];
  }
  const away = Number(c.awayAfterMin);
  return {
    pace: Object.prototype.hasOwnProperty.call(PACE_MS, c.pace) ? c.pace : "lively",
    sound: c.sound !== false,
    pauseWhenBusy: c.pauseWhenBusy !== false,
    idleMood: oneOf(c.idleMood, STATE_MOOD_CHOICES, "bored"),
    workingMood: oneOf(c.workingMood, STATE_MOOD_CHOICES, "engaged"),
    mood: oneOf(c.mood, ["auto", ...STATE_MOOD_CHOICES], "auto"),
    awayAfterMin: Number.isFinite(away) && c.awayAfterMin !== null && c.awayAfterMin !== "" ? Math.min(Math.max(away, 1), 240) : 10,
    behaviours,
  };
}

/** The mood that applies right now or null when he should stay quiet. Away is always quiet. */
export function resolveMood(cfg, state) {
  if (state === "away") return null;
  const pick = cfg.mood !== "auto" ? cfg.mood : state === "idle" ? cfg.idleMood : cfg.workingMood;
  return MOODS.includes(pick) ? pick : null;
}

export function menuItems(cfg, state) {
  const now = resolveMood(cfg, state);
  const auto = `Mood: automatic (${state === "away" ? "away: quiet" : `${state}: ${now ? MOOD_TITLES[now] : "quiet"}`})`;
  return [
    { id: "mood:auto", title: auto, checked: cfg.mood === "auto" },
    ...MOODS.map((m) => ({ id: `mood:${m}`, title: `Mood: ${MOOD_TITLES[m]}`, checked: cfg.mood === m })),
    { id: "mood:off", title: "Mood: quiet (off)", checked: cfg.mood === "off" },
    { id: "sound", title: "Barks and sound", checked: cfg.sound },
    { id: "busy", title: "Pause while Claude is working", checked: cfg.pauseWhenBusy },
  ];
}

/** Menu selection -> the config key it overrides and its new value (null for unknown ids). */
export function applyMenuChoice(id, cfg) {
  if (id.startsWith("mood:")) {
    const v = id.slice(5);
    return ["auto", ...STATE_MOOD_CHOICES].includes(v) ? { key: "mood", value: v } : null;
  }
  if (id === "sound") return { key: "sound", value: !cfg.sound };
  if (id === "busy") return { key: "pauseWhenBusy", value: !cfg.pauseWhenBusy };
  return null;
}

/** Weights for the behaviors the mood allows. `bark` also needs sound on. */
export function enabledWeights(weights, allowed, sound) {
  const out = {};
  for (const [name, w] of Object.entries(weights ?? {})) {
    if (allowed.includes(name) && (name !== "bark" || sound)) out[name] = w;
  }
  return out;
}

export const between = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** Weighted pick that avoids repeating the previous action when there is a choice. */
export function pickAction(weights, rng, last) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  const pool = entries.length > 1 ? entries.filter(([name]) => name !== last) : entries;
  const total = pool.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [name, w] of pool) { if ((r -= w) < 0) return name; }
  return pool.length ? pool[pool.length - 1][0] : null;
}

/** Random pick that skips the last few picks from the same pool. */
export function pickFresh(pool, recent, rng) {
  if (!pool || pool.length === 0) return null;
  const avoid = new Set(recent.slice(-Math.min(3, pool.length - 1)));
  const options = pool.filter((x) => !avoid.has(x));
  const from = options.length ? options : pool;
  const choice = from[Math.floor(rng() * from.length)];
  recent.push(choice);
  if (recent.length > 6) recent.shift();
  return choice;
}

/**
 * Pause logic for agent:activity events. Returns true when the event means
 * "an agent is driving the pet". Our own calls echo back, so they are ignored
 * during `selfUntil`.
 */
export function isAgentPulse(event, now, selfUntil) {
  if (!event || event.active !== true) return false;
  if ((event.surface ?? "default") !== "default") return false; // other sessions' pets
  return now >= selfUntil;
}

// ── the idle engine ───────────────────────────────────────────────────────────

export function createIdle(ctx, deps = {}) {
  const rng = deps.rng ?? Math.random;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const setT = deps.setTimeout ?? setTimeout;
  const clearT = deps.clearTimeout ?? clearTimeout;
  const data = deps.data ?? AMBIENT;
  const onChange = deps.onChange ?? (() => {});

  let cfg = cleanConfig({});
  let state = "working";  // working | idle | away: what the computer is doing (see setState)
  let running = false;
  let timer = null;
  let awayTimer = null;
  let epoch = 0;          // bumped on every pause/stop so a running action knows to bail out
  let selfUntil = 0;
  let last = null;
  let spriteOn = false;
  let following = false;
  let busy = false;
  const recents = {};

  const mood = () => (running ? resolveMood(cfg, state) : null);
  const live = (e) => running && e === epoch;
  const mark = () => { selfUntil = now() + SELF_ECHO_MS; };
  const guard = async (fn) => { try { return await fn(); } catch (err) { ctx.log?.warn?.("idle action failed", err?.message); return undefined; } };
  const recent = (m) => (recents[m] ??= { lines: [], quips: [], sounds: [], anims: [], thoughts: [] });
  const content = (m) => data.moods[m];
  /** Sleep in short slices so a pause, mood change, or Away cuts a long wait short. */
  const nap = async (ms, e) => { const end = now() + ms; while (live(e) && now() < end) await sleep(Math.min(500, end - now())); };

  const say = (text) => text && guard(() => { mark(); return ctx.pet.speak({ text, durationMs: BUBBLE_MS }); });
  const gesture = () => guard(() => { mark(); return ctx.pet.react("waving", { showMessage: false }); });
  const setSprite = (name, loop = true) => guard(() => {
    mark();
    spriteOn = true;
    return ctx.pet.setAnimation({ sprite: ctx.assets.sprite(name), loop, fps: data.animations[name].fps });
  });

  async function clearSprite(quip) {
    if (!spriteOn) return;
    spriteOn = false;
    // Dropping a sprite override means setAnimation("idle"), which makes OpenPets show a generic
    // "Ready"-style bubble. Follow it at once with a Morte line so the generic one never reads.
    await guard(() => { mark(); return ctx.pet.setAnimation("idle"); });
    if (quip) await say(quip);
  }

  async function stopFollow() {
    if (!following) return;
    following = false;
    await guard(() => ctx.pet.followCursor({ enabled: false }));
  }

  /** A bark needs the global sound switch and `bark` among the mood's behaviors. */
  async function bark(m) {
    const sounds = content(m)?.sounds ?? [];
    if (!cfg.sound || !cfg.behaviours[m].includes("bark") || !sounds.length) return;
    const name = pickFresh(sounds, recent(m).sounds, rng);
    await guard(() => ctx.audio.play(ctx.assets.sound(name)));
  }

  async function playAnim(name, e, m) {
    const a = data.animations[name];
    if (!a) return;
    if (a.hop) await guard(() => ctx.pet.moveBy({ x: 0, y: -80, durationMs: 260 }));
    await setSprite(name);
    if (rng() < 0.4) await bark(m);
    await nap(a.durationMs * 2 + (a.hop ? 0 : 200), e); // two loops
    if (a.hop) await guard(() => ctx.pet.moveBy({ x: 0, y: 80, durationMs: 260 }));
    await clearSprite(live(e) ? pickFresh(content(m).quips, recent(m).quips, rng) : null);
  }

  // ── behaviors; each checks `live(e)` between steps ─────────────────────────

  const behaviours = {
    async roam(e) {
      const hops = between(rng, 2, 4);
      for (let i = 0; i < hops && live(e); i++) {
        const durationMs = between(rng, 1200, 2200);
        await guard(() => ctx.pet.wander({ distance: between(rng, 140, 320), durationMs }));
        await nap(durationMs + 250, e);
      }
    },
    async follow(e) { // "lemme see that": trail the cursor slowly for a while, then lose interest
      following = true;
      await guard(() => ctx.pet.followCursor({ enabled: true, lag: FOLLOW_LAG }));
      await nap(between(rng, 6000, 12000), e);
      await stopFollow();
    },
    async quip(e, m) {
      await gesture();
      if (!live(e)) return;
      await say(pickFresh(content(m).lines, recent(m).lines, rng));
      if (rng() < 0.5) await bark(m);
    },
    async bark(e, m) {
      await gesture();
      if (live(e)) await bark(m);
    },
    async spin(e, m) { await playAnim("spin", e, m); },
    async trick(e, m) {
      const name = pickFresh(TRICKS.filter((n) => data.animations[n]), recent(m).anims, rng);
      if (name) await playAnim(name, e, m);
    },
    async playdead(e, m) { // fall, hold the last frame on the ground, get back up
      const { fall, dead, getup } = data.animations;
      if (!fall || !dead || !getup) return;
      await setSprite("fall");
      await nap(fall.durationMs * 0.95, e);        // swap to the held pose just before the strip loops
      if (live(e)) await setSprite("dead");
      await nap(between(rng, 4000, 9000), e);
      if (live(e)) { await setSprite("getup"); await nap(getup.durationMs * 0.95, e); }
      await clearSprite(live(e) ? pickFresh(content(m).quips, recent(m).quips, rng) : null);
    },
    async shift(e) { // sway side to side where he is, ending back at the start
      const sways = between(rng, 2, 3) * 2, step = between(rng, 40, 70), sign = rng() < 0.5 ? 1 : -1;
      let x = 0;
      for (let i = 0; i < sways && live(e); i++) {
        const to = (i % 2 === 0 ? 1 : -1) * sign * step;
        await guard(() => ctx.pet.moveBy({ x: to - x, y: 0, durationMs: 1400 }));
        x = to;
        await nap(1600, e);
      }
      if (x !== 0) await guard(() => ctx.pet.moveBy({ x: -x, y: 0, durationMs: 1000 }));
    },
    async contemplate(e) { // a quiet thought: no gesture, no sound
      if (live(e)) await say(pickFresh(content("contemplative").lines, recent("contemplative").thoughts, rng));
    },
  };

  async function canAct() {
    const st = await guard(() => ctx.pet.getState());
    return !st || (st.visible !== false && st.dragging !== true);
  }

  function schedule(delayMs) {
    clearT(timer);
    timer = null;
    const m = mood();
    if (!m) return;                                  // nothing to do in this state: no timer
    const [lo, hi] = PACE_MS[cfg.pace];
    const mul = content(m)?.paceMul ?? 1;
    timer = setT(tick, delayMs ?? between(rng, Math.round(lo * mul), Math.round(hi * mul)));
  }

  async function tick() {
    timer = null;
    const m = mood();
    if (!m) return;
    if (busy) return schedule(2000); // a paused action is still winding down
    busy = true;
    const e = epoch;
    try {
      if (await canAct()) {
        const name = pickAction(enabledWeights(content(m).weights, cfg.behaviours[m], cfg.sound), rng, last);
        last = name;
        if (name && behaviours[name]) await behaviours[name](e, m);
      }
    } catch (err) {
      ctx.log?.warn?.("idle tick failed", err?.message);
    } finally {
      await stopFollow();
      await clearSprite(null);
      busy = false;
      if (live(e)) schedule();
    }
  }

  /** The mood changed (or he must go quiet): drop what he is doing and start fresh. */
  function settle(entering) {
    epoch++;
    schedule(entering ? between(rng, 2500, 6000) : undefined);
  }

  /** An agent is driving Morte: drop whatever we are doing and stay quiet for a while. */
  async function pause() {
    epoch++;
    clearT(timer);
    timer = null;
    await stopFollow();
    await clearSprite(null);
    if (running) schedule(RESUME_AFTER_AGENT_MS);
  }

  /** working <-> idle <-> away from the host's system-idle and lock events. */
  function setState(next) {
    if (next === state) return;
    const before = mood();
    state = next;
    clearT(awayTimer);
    awayTimer = null;
    if (running && state === "idle") awayTimer = setT(() => { awayTimer = null; setState("away"); }, cfg.awayAfterMin * 60000);
    const after = mood();
    if (after !== before) settle(after !== null);
    onChange();
  }

  return {
    start(rawCfg) {
      cfg = cleanConfig(rawCfg);
      running = true;
      state = "working";
      schedule(between(rng, 3000, 8000));
    },
    stop() {
      running = false;
      epoch++;
      clearT(timer);
      clearT(awayTimer);
      timer = awayTimer = null;
      return Promise.all([stopFollow(), clearSprite(null)]);
    },
    reconfigure(rawCfg) {
      const before = mood();
      cfg = cleanConfig(rawCfg);
      if (running) settle(mood() !== before && mood() !== null);
      onChange();
    },
    /** Host events: idle:enter, idle:exit, screen:locked, screen:unlocked. */
    onSystemEvent(name) {
      if (name === "idle:enter") setState("idle");
      else if (name === "idle:exit" || name === "screen:unlocked") setState("working");
      else if (name === "screen:locked") setState("away");
    },
    onAgentActivity(event) {
      if (!cfg.pauseWhenBusy || !isAgentPulse(event, now(), selfUntil)) return Promise.resolve();
      return pause();
    },
    // exposed for tests and the menu
    tick,
    get config() { return cfg; },
    get state() { return state; },
    get mood() { return mood(); },
  };
}

// ── plugin entry ──────────────────────────────────────────────────────────────

export function register(OpenPetsPlugin) {
  let cleanup = () => {};
  OpenPetsPlugin.register({
    async start(ctx) {
      cleanup();
      // Control-panel config is the base; right-click choices are saved as overrides on top of it.
      // Changing a setting in the panel drops the override for that key, so the newest change wins.
      let base = (await ctx.config.get()) ?? {};
      let prefs = await guardedStorage(ctx, "get");
      prefs = prefs && typeof prefs === "object" ? prefs : {};
      const effective = () => cleanConfig({ ...base, ...prefs });
      let idle = null;
      const refreshMenu = () => {
        if (!idle) return;
        try { Promise.resolve(ctx.ui?.menu?.setItems(menuItems(idle.config, idle.state))).catch(() => {}); } catch { /* menu is best-effort */ }
      };
      idle = createIdle(ctx, { onChange: refreshMenu });
      idle.start(effective());
      refreshMenu();

      const unsubConfig = ctx.config.onChange((raw) => {
        const next = raw ?? {};
        for (const k of Object.keys(prefs)) if (next[k] !== base[k]) delete prefs[k];
        base = next;
        guardedStorage(ctx, "set", prefs);
        idle.reconfigure(effective());
      });
      const unsubMenu = ctx.ui?.menu?.onSelect((id) => {
        const choice = applyMenuChoice(id, effective());
        if (!choice) return;
        prefs[choice.key] = choice.value;
        guardedStorage(ctx, "set", prefs);
        idle.reconfigure(effective());
      });
      const unsubActivity = ctx.events.on("agent:activity", (event) => idle.onAgentActivity(event));
      const unsubSystem = ["idle:enter", "idle:exit", "screen:locked", "screen:unlocked"].map((name) =>
        ctx.events.on(name, () => idle.onSystemEvent(name)));
      cleanup = () => { unsubConfig(); unsubMenu?.(); unsubActivity(); unsubSystem.forEach((u) => u()); idle.stop(); };
    },
    stop() { cleanup(); cleanup = () => {}; },
  });
}

async function guardedStorage(ctx, op, value) {
  try { return op === "get" ? await ctx.storage.get("prefs") : await ctx.storage.set("prefs", value); } catch { return undefined; }
}
