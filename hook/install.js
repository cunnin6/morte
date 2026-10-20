#!/usr/bin/env node
/**
 * Swap the OpenPets-managed Claude Code hooks for Morte's voice hook.
 *
 * node install.js                      install into ~/.claude/settings.json (backs it up first).
 * node install.js --settings <path>    use another settings file (e.g., a project's .claude/settings.json)
 * node install.js --uninstall          remove Morte's hooks (then re-run `openpets configure --agent claude`
 *                                      or reinstall hooks from the OpenPets app to get the stock ones back)
 * node install.js --dry-run            print the result without writing
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EVENTS = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "Notification", "Stop", "StopFailure"];
const MANAGED = "--openpets-managed";
const MARK = "morte-hook.js";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const settingsPath = path.resolve(opt("--settings") || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json"));
const hookScript = path.join(__dirname, "morte-hook.js").replace(/\\/g, "/");
const command = `node "${hookScript}"`;

if (!fs.existsSync(hookScript)) { console.error(`Can't find ${hookScript}`); process.exit(1); }

let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
  catch (e) { console.error(`${settingsPath} is not valid JSON (${e.message}). Fix it first; nothing changed.`); process.exit(1); }
}
if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
  console.error("settings.hooks is not an object; refusing to touch it."); process.exit(1);
}

const isOurs = (h) => h && typeof h.command === "string" && (h.command.includes(MANAGED) || h.command.includes(MARK));
const hooks = { ...(settings.hooks || {}) };
let removedManaged = 0, removedMorte = 0;

// strip OpenPets-managed and previous Morte entries from every event (not just ours, in case of stragglers)
for (const [event, matchers] of Object.entries(hooks)) {
  if (!Array.isArray(matchers)) continue;
  const kept = [];
  for (const m of matchers) {
    if (!m || !Array.isArray(m.hooks)) { kept.push(m); continue; }
    const inner = m.hooks.filter((h) => {
      if (!isOurs(h)) return true;
      if (h.command.includes(MANAGED)) removedManaged++; else removedMorte++;
      return false;
    });
    if (inner.length) kept.push({ ...m, hooks: inner });
  }
  if (kept.length) hooks[event] = kept; else delete hooks[event];
}

if (!flag("--uninstall")) {
  for (const event of EVENTS) {
    hooks[event] = [...(hooks[event] || []), { hooks: [{ type: "command", command, timeout: 5, async: true }] }];
  }
}

const next = { ...settings };
if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
const out = JSON.stringify(next, null, 2) + "\n";

if (flag("--dry-run")) { console.log(out); process.exit(0); }

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
if (fs.existsSync(settingsPath)) {
  const backup = `${settingsPath}.morte-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(settingsPath, backup);
  console.log(`backup: ${backup}`);
}
fs.writeFileSync(settingsPath, out);
console.log(`${flag("--uninstall") ? "uninstalled from" : "installed into"} ${settingsPath}`);
console.log(`removed ${removedManaged} OpenPets-managed hook(s), ${removedMorte} previous Morte hook(s)`);
if (flag("--uninstall")) console.log("To restore the OpenPets stock hooks: openpets configure --agent claude (or reinstall hooks from the OpenPets app).");
else console.log("Restart Claude Code sessions to pick up the change. Try: node morte-hook.js --test success");
