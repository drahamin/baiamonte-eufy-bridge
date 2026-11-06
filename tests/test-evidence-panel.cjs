const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
let Panel;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../custom_components/eufy_security/www/evidence-panel.js"), "utf8"), {
  HTMLElement: class { attachShadow() {} },
  customElements: { define(_name, type) { Panel = type; } }, Date, Map, Set,
});

test("roster view is admin-only and escapes records, names and warnings", () => {
  const panel = new Panel();
  panel._hass = { user: { is_admin: false } };
  assert.equal(panel.homebaseTablesMarkup(), "");
  panel._hass.user.is_admin = true;
  panel._tables = { updated_at: new Date().toISOString(), warnings: ["<script>bad</script>"],
    stations: [{ name: "Pro", model: "T9000", roster_status: "loaded", roster_updated_at: new Date().toISOString(),
      people: [{ name: "<img onerror=bad>", recognized: true }] }], recordings: [] };
  const html = panel.homebaseTablesMarkup();
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
  assert.doesNotMatch(html, /<script>|<img onerror/);
  assert.match(html, /No unique HA person match/);
  assert.match(html, /empty response does not prove/);
});

test("inventory presence and unknown/invalid dates are never called current", () => {
  const panel = new Panel();
  const camera = { state: "idle", attributes: { connected: true, snapshot_available: true } };
  assert.equal(panel.snapshotStatus(camera).state, "stale");
  camera.attributes.snapshot_updated_at = "invalid";
  assert.equal(panel.snapshotStatus(camera).state, "stale");
  camera.attributes.snapshot_updated_at = new Date().toISOString();
  assert.equal(panel.snapshotStatus(camera).state, "current");
  assert.match(panel.snapshotStatus(camera).label, /reachability unverified/);
  camera.attributes.bridge_available = false;
  assert.equal(panel.snapshotStatus(camera).state, "down");
});

test("non-admin cannot initiate a roster service call", async () => {
  const panel = new Panel();
  panel._hass = { user: { is_admin: false }, callWS() { throw new Error("must not call"); } };
  await panel.loadHomebaseTables();
});
