#!/usr/bin/env node
// 重建打包用的数据快照 data/metadata.json + data/knowledge.json。
// 在能访问 GitHub 的机器(带代理)上跑;产物随 wrangler deploy 打进 Worker。
//   用法: node scripts/build-data.mjs
// metadata:默认从镜像公开接口拉;knowledge:从 neowiki + 生存指南现建(链接指向线上 wiki)。
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
mkdirSync(DATA, { recursive: true });

// ---------- 1) metadata.json ----------
const METADATA_URL = process.env.METADATA_URL || "https://byrdocs.cloudlay.cn/data/metadata.json";
console.log("拉 metadata:", METADATA_URL);
const res = await fetch(METADATA_URL);
if (!res.ok) throw new Error("metadata 拉取失败 " + res.status);
const metadata = await res.json();
writeFileSync(join(DATA, "metadata.json"), JSON.stringify(metadata));
console.log("  metadata.json:", Array.isArray(metadata) ? metadata.length : "?", "条");

// ---------- 2) knowledge.json(从 GitHub 源现建,url 指向线上 wiki)----------
const WORK = process.env.KB_SRC_DIR || join(ROOT, ".kb-src");
const SOURCES = [
  { repo: "byrdocs/bupt-survival-guide", dir: "bupt-survival-guide" },
  { repo: "byrdocs/byrdocs-neowiki", dir: "byrdocs-neowiki" },
];
mkdirSync(WORK, { recursive: true });
for (const s of SOURCES) {
  const p = join(WORK, s.dir);
  if (!existsSync(p)) {
    console.log("clone", s.repo, "...");
    execSync(`git clone --depth 1 https://github.com/${s.repo}.git "${p}"`, { stdio: "inherit" });
  }
}

const readFm = (text) => {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  let fm = {};
  try { fm = yaml.load(m[1]) || {}; } catch { /* ignore */ }
  return { fm, body: m[2] };
};
const cleanMd = (s) => s
  .replace(/:::(note|tip|caution|danger|info)\b\[?[^\]\n]*\]?/g, "提示：").replace(/:::/g, "")
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图]").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/<[^>]+>/g, " ").replace(/`{1,3}/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const cleanMdx = (s) => s
  .replace(/<Blank\s*\/>/g, "【填空】").replace(/<Blank>([\s\S]*?)<\/Blank>/g, "【$1】")
  .replace(/<Solution>([\s\S]*?)<\/Solution>/g, "\n【解析】$1").replace(/<Answer>([\s\S]*?)<\/Answer>/g, "\n【答案】$1")
  .replace(/<Choices[^>]*>([\s\S]*?)<\/Choices>/g, (_, c) => c).replace(/<Slot[^>]*\/>/g, "【】")
  .replace(/<Figure[^>]*\/?>/g, "[图]").replace(/<[^>]+>/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name);
  return e.isDirectory() ? walk(p) : (/\.mdx?$/.test(e.name) ? [p] : []);
});

const chunks = [];

// 生存指南:按 ## 切块 → guide.byrdocs.org/<路径>/
const GROOT = join(WORK, "bupt-survival-guide/src/content/docs");
for (const file of walk(GROOT)) {
  const rel = relative(GROOT, file);
  const { fm, body } = readFm(readFileSync(file, "utf8"));
  const docTitle = fm.title || rel.replace(/\.mdx?$/, "");
  const parts = rel.replace(/\.mdx?$/, "").split(sep);
  if (parts[parts.length - 1] === "index") parts.pop();
  const url = `https://guide.byrdocs.org/${parts.map(encodeURIComponent).join("/")}/`;
  let i = 0;
  for (const part of body.split(/\r?\n(?=##\s)/)) {
    const hm = part.match(/^##\s+(.+)/);
    const clean = cleanMd(part.replace(/^##\s+.+\r?\n?/, ""));
    if (clean.length < 30) continue;
    chunks.push({ id: `survival-guide:${rel}#${i++}`, source: "survival-guide", kind: "guide",
      title: hm ? `${docTitle} — ${hm[1].trim()}` : docTitle, url, text: clean.slice(0, 4000), meta: { doc: docTitle } });
  }
}

// 真题wiki:一卷一块 → wiki.byrdocs.org/exam/<卷>/
const EX = join(WORK, "byrdocs-neowiki/exams");
for (const dir of readdirSync(EX)) {
  const mdx = join(EX, dir, "index.mdx");
  if (!existsSync(mdx)) continue;
  const { fm, body } = readFm(readFileSync(mdx, "utf8"));
  const course = fm["科目"] || "", year = fm["时间"] || "", stage = fm["阶段"] || "", type = fm["类型"] || "";
  const college = Array.isArray(fm["学院"]) ? fm["学院"].join(" ") : (fm["学院"] || "");
  const clean = cleanMdx(body);
  if (clean.length < 20) continue;
  chunks.push({ id: `neowiki:${dir}`, source: "neowiki", kind: "exam",
    title: `${course} ${year} ${stage}`.replace(/\s+/g, " ").trim(), course,
    url: `https://wiki.byrdocs.org/exam/${encodeURIComponent(dir)}/`,
    text: clean.slice(0, 8000), meta: { year: String(year), stage: String(stage), type: String(type), college } });
}

writeFileSync(join(DATA, "knowledge.json"), JSON.stringify(chunks));
const bySrc = {};
for (const c of chunks) bySrc[c.source] = (bySrc[c.source] || 0) + 1;
console.log("  knowledge.json:", chunks.length, "块", JSON.stringify(bySrc));
console.log("完成。接着 `npm run deploy` 把新数据打进 Worker。");
