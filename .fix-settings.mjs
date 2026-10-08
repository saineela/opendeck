import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("./client/src/ui/pages/SettingsPage.tsx", import.meta.url);
let src = readFileSync(file, "utf8");
const EOL = "\r\n";

function lineStart(idx) {
  const nl = src.lastIndexOf("\n", idx);
  return nl === -1 ? 0 : nl + 1;
}

function insertBeforeLine(anchor, text, label) {
  const idx = src.indexOf(anchor);
  if (idx === -1) throw new Error(`anchor not found: ${label}`);
  if (src.indexOf(anchor, idx + 1) !== -1) throw new Error(`anchor not unique: ${label}`);
  const at = lineStart(idx);
  src = src.slice(0, at) + text + src.slice(at);
  console.log(`ok: ${label}`);
}

// 1. About > Quick start actionRow
insertBeforeLine(
  `<span>Replay the guided introduction.</span>`,
  `              <div className={styles.actionRow}>${EOL}` +
    `                <span className={styles.toggleDescription}>${EOL}` +
    `                  <strong>Quick start</strong>${EOL}`,
  "quick-start actionRow",
);

// 2. System > localPlaylistsBlock wrapper
insertBeforeLine(
  `<div className={styles.localPlaylistHeader}>`,
  `              <div className={styles.localPlaylistsBlock}>${EOL}`,
  "localPlaylistsBlock",
);

// 3. System > Potato PC mode label row
insertBeforeLine(
  `<span>Disables animations, blur effects, and the animated star background.</span>`,
  `              <label className={styles.settingRow}>${EOL}` +
    `                <span className={styles.toggleDescription}>${EOL}` +
    `                  <strong>Potato PC mode</strong>${EOL}`,
  "potato-pc label",
);

// 4. Plugins > Quality selectRow
insertBeforeLine(
  `<span>Downloads keep the best container YouTube exposes for the selected quality.</span>`,
  `                      <div className={styles.selectRow}>${EOL}` +
    `                        <span className={styles.toggleDescription}>${EOL}` +
    `                          <strong>Quality</strong>${EOL}`,
  "quality selectRow",
);

// 5. Style tab > Behavior section wrapper
{
  const anchor =
    `<div className={styles.compactHeader}>${EOL}` +
    `              <h2 id="behavior-settings-title">Behavior</h2>`;
  const idx = src.indexOf(anchor);
  if (idx === -1) throw new Error("anchor not found: behavior section");
  if (src.indexOf(anchor, idx + 1) !== -1) throw new Error("anchor not unique: behavior section");
  const at = lineStart(idx);
  src =
    src.slice(0, at) +
    `          <section className={styles.card} aria-labelledby="behavior-settings-title">${EOL}` +
    src.slice(at);
  console.log("ok: behavior section");
}

writeFileSync(file, src);
console.log("done");
