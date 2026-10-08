import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("./client/src/internal/appSettings.ts", import.meta.url);
let src = readFileSync(file, "utf8");
const EOL = "\r\n";

function replaceOnce(oldStr, newStr, label) {
  const idx = src.indexOf(oldStr);
  if (idx === -1) throw new Error(`not found: ${label}`);
  if (src.indexOf(oldStr, idx + oldStr.length) !== -1) throw new Error(`not unique: ${label}`);
  src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length);
}

replaceOnce(
  [
    `/** Wait (bounded) for the first auth verdict so mount does not race it. */`,
    `async function waitForAuthVerdict(): Promise<void> {`,
    `  if (readySettled) return;`,
    `  await Promise.race([`,
    `    remoteReady,`,
    `    new Promise((resolve) => setTimeout(resolve, 3000)),`,
    `  ]);`,
    `}`,
  ].join(EOL),
  [
    `/**`,
    ` * Wait (bounded) for the first auth verdict so mount does not race it,`,
    ` * then report the current availability.`,
    ` */`,
    `async function waitForAuthVerdict(): Promise<"unknown" | "enabled" | "disabled"> {`,
    `  if (!readySettled) {`,
    `    await Promise.race([`,
    `      remoteReady,`,
    `      new Promise((resolve) => setTimeout(resolve, 3000)),`,
    `    ]);`,
    `  }`,
    `  return remoteState;`,
    `}`,
  ].join(EOL),
  "waitForAuthVerdict",
);

replaceOnce(
  [
    `  if (remoteState === "disabled") return null;`,
    `  await waitForAuthVerdict();`,
    `  if (remoteState === "disabled") return null;`,
  ].join(EOL),
  [
    `  if (remoteState === "disabled") return null;`,
    `  if ((await waitForAuthVerdict()) === "disabled") return null;`,
  ].join(EOL),
  "postSettings wait",
);

replaceOnce(
  [
    `  if (remoteState === "disabled") return;`,
    `  await waitForAuthVerdict();`,
    `  if (remoteState === "disabled") return;`,
  ].join(EOL),
  [
    `  if (remoteState === "disabled") return;`,
    `  if ((await waitForAuthVerdict()) === "disabled") return;`,
  ].join(EOL),
  "clearAppSettings wait",
);

writeFileSync(file, src);
console.log("done");
