// Renders site/icon.svg into the PNG app icons the manifest and iOS need.
// Run it after changing icon.svg; the PNGs are committed, the site build does not redraw them.
// Uses headless Google Chrome (macOS path by default, or set CHROME=/path/to/chrome).
//
// Usage:
//   node build_scripts/icons.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) throw new Error(`Не найден Chrome: ${chrome}. Укажите путь: CHROME=/путь/к/chrome node build_scripts/icons.mjs`);

const icons = { "icon-512.png": 512, "icon-192.png": 192, "apple-touch-icon.png": 180 };

// Headless Chrome writes the screenshot but does not always exit, so wait for the file and stop it
async function screenshot(page, file, size, profile) {
  rmSync(file, { force: true });
  const child = spawn(chrome, [
    "--headless", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--hide-scrollbars", "--force-device-scale-factor=1", `--user-data-dir=${profile}`,
    `--window-size=${size},${size}`, `--screenshot=${file}`, pathToFileURL(page).href,
  ], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  for (let i = 0; i < 600 && child.exitCode === null; i++) {
    if (existsSync(file) && statSync(file).size > 0) break;
    await sleep(100);
  }
  await sleep(500); // let Chrome finish writing the file
  child.kill();
  await exited;
  if (!existsSync(file)) throw new Error(`Chrome не сохранил ${file}`);
}

const svg = readFileSync(join(site, "icon.svg"), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "icons-"));
try {
  for (const [name, size] of Object.entries(icons)) {
    const page = join(tmp, `${size}.html`);
    writeFileSync(page, `<!doctype html><style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await screenshot(page, join(site, name), size, join(tmp, "profile"));
    console.log(`${name}: ${size}×${size}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
