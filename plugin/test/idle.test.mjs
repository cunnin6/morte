// Behaviour tests for plugin/index.js with a fake OpenPets ctx and a fake clock. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// plugin/index.js is an ES module but the repo is CommonJS: load a copy as .mjs
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "morte-idle-"));
const copy = path.join(tmp, "index.mjs");
fs.copyFileSync(new URL("../index.js", import.meta.url), copy);
const plugin = await import(pathToFileURL(copy).href);
const {
  cleanConfig, resolveMood, menuItems, applyMenuChoice, enabledWeights, pickAction, pickFresh, isAgentPulse,
  createIdle, RESUME_AFTER_AGENT_MS, FOLLOW_LAG, BUBBLE_MS, BEHAVIOURS, MOODS, DEFAULT_BEHAVIOURS,
} = plugin;
const MANIFEST = JSON.parse(fs.readFileSync(new URL("../openpets.plugin.json", import.meta.url), "utf8"));

const ALL = Object.fromEntries(BEHAVIOURS.map((b) => [b, 1]));
const mood = (sounds) => ({ paceMul: 1, weights: ALL, sounds, lines: ["Line one.", "Line two."], quips: ["Quip one.", "Quip two."] });
const DATA = {
  animations: {
    spin: { fps: 16, durationMs: 1000, hop: false },
    tumble: { fps: 12, durationMs: 1000, hop: true },
    flourish: { fps: 10, durationMs: 1100, hop: false },
    pratfall: { fps: 8, durationMs: 2000, hop: false },
    fall: { fps: 8, durationMs: 1000, hop: false },
    dead: { fps: 8, durationMs: 125, hop: false },
    getup: { fps: 8, durationMs: 1000, hop: false },
  },
  moods: { bored: mood(["mrt042", "mrt028"]), engaged: mood(["mrt011", "mrt123"]), contemplative: { ...mood([]), lines: ["Echo.", "Did I say that aloud?"] } },
};

/** `only` restricts every mood to one behaviour; `cfg` is merged into the plugin config. */
function fake({ rng = () => 0.3, only, cfg = {}, state = { visible: true, dragging: false } } = {}) {
  const calls = [];
  const rec = (name) => async (...a) => { calls.push([name, ...a]); };
  const ctx = {
    log: { warn() {} },
    pet: {
      speak: async (spec) => { calls.push(["speak", spec.text, spec]); }, react: rec("react"), setAnimation: rec("setAnimation"), wander: rec("wander"),
      moveBy: rec("moveBy"), followCursor: rec("followCursor"), getState: async () => state,
    },
    audio: { play: rec("play") },
    assets: { sound: (n) => ({ kind: "sound", name: n }), sprite: (n) => ({ kind: "sprite", name: n }) },
  };
  let t = 1_000_000;
  const timers = [];
  let changes = 0;
  const data = only
    ? { ...DATA, moods: Object.fromEntries(MOODS.map((m) => [m, { ...DATA.moods[m], weights: { [only]: 1 } }])) }
    : DATA;
  const deps = {
    data, rng,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    setTimeout: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    onChange: () => { changes++; },
  };
  const idle = createIdle(ctx, deps);
  const only3 = only ? { behavioursBored: [only], behavioursEngaged: [only], behavioursContemplative: [only] } : {};
  idle.start({ ...only3, ...cfg });
  return {
    idle, calls, timers, data, changes: () => changes,
    run: () => { timers.length = 0; return idle.tick(); },
    names: () => calls.map((c) => c[0]),
    advance: (ms) => { t += ms; },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// ── config and pure helpers ───────────────────────────────────────────────────

test("cleanConfig defaults and rejects junk", () => {
  const c = cleanConfig(undefined);
  assert.equal(c.pace, "lively");
  assert.equal(c.sound, true);
  assert.equal(c.pauseWhenBusy, true);
  assert.equal(c.idleMood, "bored");
  assert.equal(c.workingMood, "engaged");
  assert.equal(c.mood, "auto");
  assert.equal(c.awayAfterMin, 10);
  assert.deepEqual(c.behaviours, DEFAULT_BEHAVIOURS);
  const bad = cleanConfig({ pace: "nope", idleMood: "grumpy", workingMood: 3, mood: "x", awayAfterMin: "abc", behavioursBored: ["roam", "fly", "roam"] });
  assert.equal(bad.pace, "lively");
  assert.equal(bad.idleMood, "bored");
  assert.equal(bad.workingMood, "engaged");
  assert.equal(bad.mood, "auto");
  assert.equal(bad.awayAfterMin, 10);
  assert.deepEqual(bad.behaviours.bored, ["roam"]);
  assert.equal(cleanConfig({ awayAfterMin: 0 }).awayAfterMin, 1);
  assert.equal(cleanConfig({ awayAfterMin: 9999 }).awayAfterMin, 240);
  assert.deepEqual(cleanConfig({ behavioursEngaged: [] }).behaviours.engaged, []);
});

test("manifest defaults match the code's defaults", () => {
  const cs = MANIFEST.configSchema;
  const c = cleanConfig({});
  assert.equal(cs.idleMood.default, c.idleMood);
  assert.equal(cs.workingMood.default, c.workingMood);
  assert.equal(cs.mood.default, c.mood);
  assert.equal(cs.awayAfterMin.default, c.awayAfterMin);
  assert.equal(cs.pace.default, c.pace);
  assert.equal(cs.sound.default, c.sound);
  assert.equal(cs.pauseWhenBusy.default, c.pauseWhenBusy);
  for (const m of MOODS) {
    const f = cs["behaviours" + m[0].toUpperCase() + m.slice(1)];
    assert.deepEqual(f.default, DEFAULT_BEHAVIOURS[m]);
    assert.deepEqual(f.options.map((o) => o.value), BEHAVIOURS);
  }
  for (const p of ["commands", "storage", "events"]) assert.ok(MANIFEST.permissions.includes(p), p);
});

test("resolveMood: state maps to a mood, off/away stay quiet", () => {
  const c = cleanConfig({});
  assert.equal(resolveMood(c, "idle"), "bored");
  assert.equal(resolveMood(c, "working"), "engaged");
  assert.equal(resolveMood(c, "away"), null);
  assert.equal(resolveMood(cleanConfig({ idleMood: "contemplative" }), "idle"), "contemplative");
  assert.equal(resolveMood(cleanConfig({ workingMood: "off" }), "working"), null);
  assert.equal(resolveMood(cleanConfig({ mood: "contemplative" }), "working"), "contemplative");
  assert.equal(resolveMood(cleanConfig({ mood: "off" }), "idle"), null);
  assert.equal(resolveMood(cleanConfig({ mood: "bored" }), "away"), null); // Away overrides a manual mood
});

test("menu: one mood checked, items valid, choices map to config keys", () => {
  const c = cleanConfig({ mood: "engaged" });
  const items = menuItems(c, "idle");
  assert.deepEqual(items.filter((i) => i.checked && i.id.startsWith("mood:")).map((i) => i.id), ["mood:engaged"]);
  assert.ok(items.length <= 16 && items.every((i) => i.title.length > 0 && i.title.length <= 80 && /^[A-Za-z0-9._:-]{1,64}$/.test(i.id)));
  assert.match(menuItems(cleanConfig({}), "idle")[0].title, /idle: Bored/);
  assert.match(menuItems(cleanConfig({}), "away")[0].title, /away/);
  assert.deepEqual(applyMenuChoice("mood:contemplative", c), { key: "mood", value: "contemplative" });
  assert.deepEqual(applyMenuChoice("mood:auto", c), { key: "mood", value: "auto" });
  assert.deepEqual(applyMenuChoice("mood:off", c), { key: "mood", value: "off" });
  assert.deepEqual(applyMenuChoice("sound", c), { key: "sound", value: false });
  assert.deepEqual(applyMenuChoice("busy", c), { key: "pauseWhenBusy", value: false });
  assert.equal(applyMenuChoice("mood:grumpy", c), null);
  assert.equal(applyMenuChoice("nope", c), null);
});

test("enabledWeights keeps only allowed behaviours; bark also needs sound", () => {
  assert.deepEqual(enabledWeights(ALL, ["roam", "bark"], true), { roam: 1, bark: 1 });
  assert.deepEqual(enabledWeights(ALL, ["roam", "bark"], false), { roam: 1 });
  assert.deepEqual(enabledWeights(ALL, [], true), {});
});

test("pickAction avoids the previous action and is weighted", () => {
  const w = { a: 1, b: 1, c: 1 };
  for (const r of [0, 0.34, 0.99]) assert.notEqual(pickAction(w, () => r, "a"), "a");
  assert.equal(pickAction({ only: 1 }, () => 0.5, "only"), "only");
  assert.equal(pickAction({ a: 0, b: 5 }, () => 0, null), "b");
  assert.equal(pickAction({}, () => 0, null), null);
});

test("pickFresh skips recent picks", () => {
  const recent = [];
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(pickFresh(["a", "b", "c", "d"], recent, () => 0));
  for (let i = 3; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
});

test("isAgentPulse: only active default-surface pulses outside our own echo", () => {
  assert.equal(isAgentPulse({ active: true, surface: "default", petId: "morte" }, 10, 0), true);
  assert.equal(isAgentPulse({ active: true }, 10, 0), true);
  assert.equal(isAgentPulse({ active: false }, 10, 0), false);
  assert.equal(isAgentPulse({ active: true, surface: "agent" }, 10, 0), false);
  assert.equal(isAgentPulse({ active: true }, 10, 20), false);
  assert.equal(isAgentPulse(undefined, 10, 0), false);
});

// ── scheduling ────────────────────────────────────────────────────────────────

test("start schedules the first action a few seconds out", () => {
  const f = fake();
  assert.equal(f.timers.length, 1);
  assert.ok(f.timers[0].ms >= 3000 && f.timers[0].ms <= 8000);
});

test("a tick reschedules at the mood's pace", async () => {
  const f = fake({ only: "roam" });
  await f.run();
  assert.equal(f.timers.length, 1);
  assert.ok(f.timers[0].ms >= 15000 && f.timers[0].ms <= 40000);
  const g = fake({ only: "shift", cfg: { mood: "contemplative" } });
  g.data.moods.contemplative.paceMul = 2;
  await g.run();
  assert.ok(g.timers[0].ms >= 30000 && g.timers[0].ms <= 80000);
});

test("dragged or hidden pet: skip the action but keep the schedule", async () => {
  const f = fake({ state: { visible: true, dragging: true } });
  await f.run();
  assert.deepEqual(f.calls.filter((c) => c[0] !== "getState"), []);
  assert.equal(f.timers.length, 1);
});

test("a failing SDK call never escapes tick", async () => {
  const ctx = { log: { warn() {} }, pet: { getState: async () => ({}), wander: async () => { throw new Error("boom"); } } };
  const data = { ...DATA, moods: { ...DATA.moods, engaged: { ...DATA.moods.engaged, weights: { roam: 1 } } } };
  let t = 0;
  const idle = createIdle(ctx, { data, rng: () => 0.1, sleep: async (ms) => { t += ms; }, setTimeout: () => ({}), clearTimeout() {}, now: () => t });
  idle.start({ behavioursEngaged: ["roam"] });
  await assert.doesNotReject(idle.tick());
});

// ── behaviours ────────────────────────────────────────────────────────────────

test("roam wanders 2-4 times", async () => {
  const f = fake({ only: "roam" });
  await f.run();
  assert.ok(f.calls.filter((c) => c[0] === "wander").length >= 2);
});

test("follow: slow lag, on then always off again", async () => {
  const f = fake({ only: "follow" });
  await f.run();
  const follows = f.calls.filter((c) => c[0] === "followCursor");
  assert.deepEqual(follows.map((c) => c[1].enabled), [true, false]);
  assert.equal(follows[0][1].lag, FOLLOW_LAG);
  assert.ok(FOLLOW_LAG > 0.8 && FOLLOW_LAG < 1);
});

test("every bubble expires before the host's ~4 s transient re-render replays its pop-in", async () => {
  const f = fake({ only: "quip" });
  await f.run();
  const speak = f.calls.find((c) => c[0] === "speak");
  assert.equal(speak[2].durationMs, BUBBLE_MS);
  assert.ok(BUBBLE_MS < 4000);
});

test("quip: gesture without a generic bubble, then a line of the current mood", async () => {
  const f = fake({ only: "quip" });          // working -> engaged
  await f.run();
  assert.deepEqual(f.calls[0], ["react", "waving", { showMessage: false }]);
  assert.ok(DATA.moods.engaged.lines.includes(f.calls.find((c) => c[0] === "speak")[1]));
});

test("bark plays a clip of the mood; no sound, or bark not allowed, plays nothing", async () => {
  let f = fake({ only: "bark" });
  await f.run();
  assert.ok(DATA.moods.engaged.sounds.includes(f.calls.find((c) => c[0] === "play")[1].name));
  f = fake({ only: "bark", cfg: { sound: false } });
  await f.run();
  assert.ok(!f.names().includes("play"));
  // quip with bark removed from the mood never barks, however the dice fall
  f = fake({ only: "quip", rng: () => 0.01, cfg: { behavioursEngaged: ["quip"] } });
  await f.run();
  assert.ok(f.names().includes("speak") && !f.names().includes("play"));
});

test("spin: sets the strip, clears it, covers the generic bubble with a quip", async () => {
  const f = fake({ only: "spin" });
  await f.run();
  const set = f.calls.find((c) => c[0] === "setAnimation" && typeof c[1] === "object");
  assert.equal(set[1].sprite.name, "spin");
  const clear = f.calls.findIndex((c) => c[0] === "setAnimation" && c[1] === "idle");
  assert.ok(clear > 0);
  assert.ok(DATA.moods.engaged.quips.includes(f.calls.slice(clear).find((c) => c[0] === "speak")[1]));
});

test("trick plays tumble, flourish or pratfall; tumble hops up and back down", async () => {
  const f = fake({ only: "trick", rng: () => 0.01 });
  await f.run();
  const sprite = f.calls.find((c) => c[0] === "setAnimation" && typeof c[1] === "object")[1].sprite.name;
  assert.ok(["tumble", "flourish", "pratfall"].includes(sprite));
  assert.deepEqual(f.calls.filter((c) => c[0] === "moveBy").map((c) => c[1].y), sprite === "tumble" ? [-80, 80] : []);
});

test("playdead: fall, held pose, get up, then a quip; sprite cleared at the end", async () => {
  const f = fake({ only: "playdead" });
  await f.run();
  const sprites = f.calls.filter((c) => c[0] === "setAnimation" && typeof c[1] === "object").map((c) => c[1].sprite.name);
  assert.deepEqual(sprites, ["fall", "dead", "getup"]);
  assert.equal(f.calls.filter((c) => c[0] === "setAnimation").at(-1)[1], "idle");
  assert.ok(f.names().includes("speak"));
  assert.ok(!f.names().includes("play"));
});

test("shift: slow side-to-side moves that net out to zero, silent", async () => {
  const f = fake({ only: "shift", cfg: { mood: "contemplative" } });
  await f.run();
  const moves = f.calls.filter((c) => c[0] === "moveBy").map((c) => c[1]);
  assert.ok(moves.length >= 4);
  assert.equal(moves.reduce((s, m) => s + m.x, 0), 0);
  assert.ok(moves.every((m) => m.y === 0 && m.durationMs >= 1000));
  assert.ok(!f.names().includes("play") && !f.names().includes("speak"));
});

test("contemplate: a quiet thought from the contemplative lines, no gesture or sound", async () => {
  const f = fake({ only: "contemplate" });
  await f.run();
  assert.deepEqual(f.names().filter((n) => n !== "getState"), ["speak"]);
  assert.ok(DATA.moods.contemplative.lines.includes(f.calls.find((c) => c[0] === "speak")[1]));
});

test("a mood with nothing allowed does nothing but keeps its schedule", async () => {
  const f = fake({ cfg: { behavioursEngaged: [] } });
  await f.run();
  assert.deepEqual(f.calls, []);
  assert.equal(f.timers.length, 1);
});

// ── states and moods ──────────────────────────────────────────────────────────

test("idle:enter switches to the idle mood and acts soon; idle:exit switches back", async () => {
  const f = fake({ only: "quip" });
  assert.equal(f.idle.mood, "engaged");
  f.idle.onSystemEvent("idle:enter");
  assert.equal(f.idle.state, "idle");
  assert.equal(f.idle.mood, "bored");
  const next = f.timers.find((t) => t.fn.name === "tick");
  assert.ok(next && next.ms >= 2500 && next.ms <= 6000);
  await f.run();
  assert.ok(DATA.moods.bored.lines.includes(f.calls.find((c) => c[0] === "speak")[1]));
  f.idle.onSystemEvent("idle:exit");
  assert.equal(f.idle.mood, "engaged");
  assert.ok(f.changes() >= 2);
});

test("Away after the configured idle time: no timer, no actions", async () => {
  const f = fake({ only: "quip", cfg: { awayAfterMin: 3 } });
  f.idle.onSystemEvent("idle:enter");
  const away = f.timers.find((t) => t.ms === 3 * 60000);
  assert.ok(away);
  f.timers.splice(f.timers.indexOf(away), 1);  // a fired timer is gone
  await away.fn();
  assert.equal(f.idle.state, "away");
  assert.equal(f.idle.mood, null);
  assert.equal(f.timers.length, 0);
  await f.idle.tick();
  assert.deepEqual(f.calls, []);
  f.idle.onSystemEvent("idle:exit");        // back: wakes up in the working mood
  assert.equal(f.idle.mood, "engaged");
  assert.equal(f.timers.length, 1);
});

test("idle:exit cancels the Away timer", () => {
  const f = fake();
  f.idle.onSystemEvent("idle:enter");
  assert.ok(f.timers.some((t) => t.ms === 10 * 60000));
  f.idle.onSystemEvent("idle:exit");
  assert.ok(!f.timers.some((t) => t.ms === 10 * 60000));
});

test("screen lock is Away at once; unlock is back to working", () => {
  const f = fake();
  f.idle.onSystemEvent("screen:locked");
  assert.equal(f.idle.state, "away");
  assert.equal(f.timers.length, 0);
  f.idle.onSystemEvent("screen:unlocked");
  assert.equal(f.idle.state, "working");
  assert.equal(f.timers.length, 1);
});

test("Away cuts a long action short and nothing is said afterwards", async () => {
  const f = fake({ only: "playdead" });
  const running = f.run();
  await flush();
  f.idle.onSystemEvent("screen:locked");
  await running;
  assert.ok(!f.names().includes("speak"));
  assert.equal(f.calls.filter((c) => c[0] === "setAnimation").at(-1)[1], "idle");
  assert.equal(f.timers.length, 0);
});

test("manual mood override and 'off'", () => {
  const f = fake();
  f.idle.reconfigure({ mood: "contemplative" });
  assert.equal(f.idle.mood, "contemplative");
  f.idle.reconfigure({ mood: "off" });
  assert.equal(f.idle.mood, null);
  assert.equal(f.timers.length, 0);
  f.idle.reconfigure({ mood: "auto" });
  assert.equal(f.idle.mood, "engaged");
  assert.equal(f.timers.length, 1);
});

test("turning follow off mid-action stops following", async () => {
  const f = fake({ only: "follow" });
  const running = f.run();
  await flush();
  f.idle.reconfigure({ behavioursEngaged: [] });
  await running;
  assert.deepEqual(f.calls.filter((c) => c[0] === "followCursor").map((c) => c[1].enabled), [true, false]);
});

// ── agent pauses (unchanged behaviour) ────────────────────────────────────────

test("an agent pulse stops following and defers idling by the resume delay", async () => {
  const f = fake({ only: "follow" });
  const running = f.run();
  await f.idle.onAgentActivity({ active: true, surface: "default", petId: "morte" });
  await running;
  const follows = f.calls.filter((c) => c[0] === "followCursor").map((c) => c[1].enabled);
  assert.equal(follows.at(-1), false);
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].ms, RESUME_AFTER_AGENT_MS);
});

test("agent pulse during a sprite drops it without a quip", async () => {
  const f = fake({ only: "spin" });
  const running = f.run();
  await flush();
  await f.idle.onAgentActivity({ active: true, surface: "default" });
  await running;
  assert.ok(f.calls.some((c) => c[0] === "setAnimation" && c[1] === "idle"));
  assert.ok(!f.calls.some((c) => c[0] === "speak"));
});

test("pauseWhenBusy off ignores agent pulses", async () => {
  const f = fake();
  f.idle.reconfigure({ pauseWhenBusy: false });
  const before = f.timers[0];
  await f.idle.onAgentActivity({ active: true, surface: "default" });
  assert.equal(f.timers[0], before);
});

test("our own speech echoing back as agent:activity does not pause us", async () => {
  const f = fake({ only: "quip" });
  await f.run();               // marks selfUntil with each speak/react
  const timer = f.timers[0];
  await f.idle.onAgentActivity({ active: true, surface: "default", petId: "morte" });
  assert.equal(f.timers[0], timer);  // still on the normal schedule
  f.advance(2000);                   // echo window over: now it is a real pulse
  await f.idle.onAgentActivity({ active: true, surface: "default", petId: "morte" });
  assert.equal(f.timers[0].ms, RESUME_AFTER_AGENT_MS);
});

test("an agent pulse while Away does not wake him", async () => {
  const f = fake();
  f.idle.onSystemEvent("screen:locked");
  await f.idle.onAgentActivity({ active: true, surface: "default" });
  assert.equal(f.timers.length, 0);
});
