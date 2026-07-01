#!/usr/bin/env node
// 重建打包用的数据快照 data/metadata.json + data/knowledge.json + data/build-info.json。
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
const res = await fetch(METADATA_URL, { signal: AbortSignal.timeout(30000) });
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

// 源仓更新:clone 或 fetch+reset(分支无关,survival-guide=main,neowiki=master)
const sourceCommits = [];
for (const s of SOURCES) {
  const p = join(WORK, s.dir);
  if (!existsSync(p)) {
    console.log("clone", s.repo, "...");
    execSync(`git clone --depth 1 https://github.com/${s.repo}.git "${p}"`, { stdio: "inherit" });
  } else {
    console.log("update", s.repo, "...");
    try {
      execSync(`git -C "${p}" fetch --depth 1 origin HEAD`, { stdio: "inherit" });
      execSync(`git -C "${p}" reset --hard FETCH_HEAD`, { stdio: "inherit" });
    } catch (e) {
      console.warn("  更新失败,使用已有版本:", e.message);
    }
  }
  try {
    const commit = execSync(`git -C "${p}" rev-parse HEAD`, { encoding: "utf8" }).trim();
    sourceCommits.push({ repo: s.repo, commit });
  } catch { sourceCommits.push({ repo: s.repo, commit: "unknown" }); }
}

const readFm = (text) => {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  let fm = {};
  try { fm = yaml.load(m[1]) || {}; } catch { /* ignore */ }
  return { fm, body: m[2] };
};

// 只清真正的 HTML/JSX 标签(<tag ...> / </tag> / <tag/>),要求 < 后紧跟字母、且标签内不含 $。
// 这样不会误伤数学里的 < >(如 0<a<4、V'(a)>0、$\varepsilon_1 < \varepsilon_2$)——它们是真题正文。
const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9.-]*(?:\s+[^<>$]*?)?\/?>/g;

const cleanMd = (s) => s
  .replace(/:::(note|tip|caution|danger|info)\b\[?[^\]\n]*\]?/g, "提示：").replace(/:::/g, "")
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图]").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(TAG_RE, " ").replace(/`{1,3}/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// cleanMdx 保留结构化标签的内容,但不替换为中文标记(按题切块时需要原始数据)
const stripMdxPreserve = (s) => s
  .replace(/<Blank\s*\/>/g, "【填空】")
  .replace(/<Slot[^>]*\/>/g, "【】")
  .replace(/<Figure[^>]*?src="([^"]+)"[^>]*>([\s\S]*?)<\/Figure>/g, "[图]")
  .replace(/<Figure[^>]*?src="([^"]+)"[^>]*\/>/g, "[图]")
  .replace(/<Figure[^>]*\/?>/g, "[图]")
  .replace(/^#{1,6}\s+/gm, "") // 去 markdown 标题符(### 1. → 1.)
  .replace(TAG_RE, " ").replace(/\n{3,}/g, "\n\n").trim();

// cleanMdx 用于整卷兜底和指南(不需要结构化字段)
const cleanMdx = (s) => s
  .replace(/<Blank\s*\/>/g, "【填空】").replace(/<Blank>([\s\S]*?)<\/Blank>/g, "【$1】")
  .replace(/<Solution>([\s\S]*?)<\/Solution>/g, "\n【解析】$1").replace(/<Answer>([\s\S]*?)<\/Answer>/g, "\n【答案】$1")
  .replace(/<Choices[^>]*>([\s\S]*?)<\/Choices>/g, (_, c) => c).replace(/<Slot[^>]*\/>/g, "【】")
  .replace(/<Figure[^>]*\/?>/g, "[图]").replace(TAG_RE, " ").replace(/\n{3,}/g, "\n\n").trim();

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name);
  return e.isDirectory() ? walk(p) : (/\.mdx?$/.test(e.name) ? [p] : []);
});

// ---------- 时间解析工具 ----------
function parseTime(timeStr) {
  const s = String(timeStr || "");
  const ym = s.match(/(\d{4})\s*[-–~至]\s*(\d{4})/);
  const school_year = ym ? `${ym[1]}-${ym[2]}` : "";
  const year_start = ym ? parseInt(ym[1], 10) : undefined;
  const year_end = ym ? parseInt(ym[2], 10) : undefined;
  const semester = /第一学期|第1学期|上学期|秋/.test(s) ? "First"
    : /第二学期|第2学期|下学期|春/.test(s) ? "Second" : "";
  return { school_year, year_start, year_end, semester, raw: s };
}

// ---------- 指南 campus/topic 推断 ----------
function inferCampusTopic(relPath) {
  const parts = relPath.split(sep);
  const topDir = parts[0] || "";
  let campus = "通用";
  if (topDir === "沙河校区") campus = "沙河";
  else if (topDir === "海淀校区") campus = "海淀";
  // topic 取文件名(去扩展名)——比顶层目录细,能对上"校园网/成绩构成/转专业"等真实主题;
  // index/根散文回退到目录名。
  const fname = (parts[parts.length - 1] || "").replace(/\.mdx?$/, "");
  const topic = (!fname || fname === "index") ? (parts.length > 1 ? parts[parts.length - 2] : "") : fname;
  return { campus, topic };
}

// ---------- 真题按题切块(三层 fallback) ----------
function inferQtype(heading) {
  const h = heading.toLowerCase();
  if (/选择|单选|单项选择|多选|choice|multiple\s*choice/.test(h)) return "choice";
  if (/填空|fill|blank/.test(h)) return "blank";
  return "freeform"; // 简答/计算/证明/分析/综合/解答/问答/大题/question/part 等
}

function extractFigures(text, figUrlFn) {
  const figs = [];
  const re = /<Figure[^>]*?src="([^"]+)"[^>]*>([\s\S]*?)<\/Figure>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    figs.push({ src: m[1], caption: m[2].trim(), url: figUrlFn(m[1]) });
  }
  // also match self-closing <Figure src="..." />
  const re2 = /<Figure[^>]*?src="([^"]+)"[^>]*\/>/g;
  while ((m = re2.exec(text)) !== null) {
    figs.push({ src: m[1], caption: "", url: figUrlFn(m[1]) });
  }
  return figs;
}

function extractQuestion(qbody, qtype, figUrlFn) {
  const figures = extractFigures(qbody, figUrlFn);
  const has_figure = figures.length > 0;

  let stem = "", options, answer, solution;

  // 提取 <Solution>
  const solMatch = qbody.match(/<Solution>([\s\S]*?)<\/Solution>/);
  if (solMatch) solution = stripMdxPreserve(solMatch[1]).slice(0, 1500);

  // 提取 <Answer>
  const ansMatch = qbody.match(/<Answer>([\s\S]*?)<\/Answer>/);
  if (ansMatch && !answer) answer = stripMdxPreserve(ansMatch[1]).slice(0, 500);

  if (qtype === "choice" && /<Choices/.test(qbody)) {
    // 选择题:提取选项
    const choicesMatch = qbody.match(/<Choices[^>]*>([\s\S]*?)<\/Choices>/);
    if (choicesMatch) {
      const lines = choicesMatch[1].split(/\r?\n/).filter(l => l.trim());
      const labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      let li = 0;
      options = [];
      let correctAnswer = "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^[+\-]\s/.test(trimmed)) {
          const isCorrect = trimmed.startsWith("+");
          const text = stripMdxPreserve(trimmed.slice(1).trim()).slice(0, 300);
          const label = labels[li] || `${li + 1}`;
          options.push({ label, text });
          if (isCorrect) correctAnswer = `${label}. ${text}`;
          li++;
        }
      }
      if (correctAnswer) answer = correctAnswer;
    }
    // stem = <Choices> 之前的正文
    stem = qbody.replace(/<Choices[^>]*>[\s\S]*?<\/Choices>/g, "")
      .replace(/<Solution>[\s\S]*?<\/Solution>/g, "")
      .replace(/<Answer>[\s\S]*?<\/Answer>/g, "");
    stem = stripMdxPreserve(stem).slice(0, 1500);
  } else if (/<Blank>/.test(qbody) || /<Blank\s*\/>/.test(qbody)) {
    // 填空题:提取答案
    const blanks = [];
    const blankRe = /<Blank>([\s\S]*?)<\/Blank>/g;
    let bm;
    while ((bm = blankRe.exec(qbody)) !== null) {
      blanks.push(bm[1].trim());
    }
    if (blanks.length > 0) answer = blanks.length === 1 ? blanks[0] : blanks;
    // stem:替换 <Blank>X</Blank> 为【填空】,去掉 Figure
    stem = qbody.replace(/<Blank>([\s\S]*?)<\/Blank>/g, "【填空】")
      .replace(/<Blank\s*\/>/g, "【填空】")
      .replace(/<Solution>[\s\S]*?<\/Solution>/g, "")
      .replace(/<Answer>[\s\S]*?<\/Answer>/g, "");
    stem = stripMdxPreserve(stem).slice(0, 1500);
  } else {
    // 自由题
    stem = qbody.replace(/<Solution>[\s\S]*?<\/Solution>/g, "")
      .replace(/<Answer>[\s\S]*?<\/Answer>/g, "");
    stem = stripMdxPreserve(stem).slice(0, 1500);
  }

  // 去掉题干开头重复的题号("1. xxx" → "xxx",题号已在 qno 字段)
  stem = stem.replace(/^\s*\d+[.、]\s*/, "").trim();

  return { stem, options, answer, solution, has_figure, figures };
}

function parseExam(dir, fm, body) {
  const course = fm["科目"] || "";
  const stage = String(fm["阶段"] || "");
  const type = String(fm["类型"] || "");
  const college = Array.isArray(fm["学院"]) ? fm["学院"].join(" ") : (fm["学院"] || "");
  const time = parseTime(fm["时间"]);
  const variant = (dir.match(/[（(][^）)]*[）)]/g) || []).join(" ");
  const wikiUrl = `https://wiki.byrdocs.org/exam/${encodeURIComponent(dir)}/`;
  const figUrlFn = (src) => `https://wiki.byrdocs.org/exam/${encodeURIComponent(dir)}/${encodeURIComponent(src)}`;

  const examTitle = `${course} ${time.raw} ${stage} ${variant}`.replace(/\s+/g, " ").trim();
  const examMeta = {
    school_year: time.school_year,
    year_start: time.year_start,
    year_end: time.year_end,
    semester: time.semester,
    stage,
    type,
    college,
    answer_completeness: String(fm["答案完成度"] || ""),
  };

  const clean = cleanMdx(body);
  if (clean.length < 20) {
    // 图片卷/空卷:整卷兜底
    return [makeChunk(`neowiki:${dir}`, "neowiki", "exam", "whole",
      examTitle, course, wikiUrl, clean.slice(0, 4000), examMeta, {}) ];
  }

  // 按 ## 切节
  const sectionParts = body.split(/\r?\n(?=##\s)/);
  const chunks = [];

  for (const part of sectionParts) {
    const headingMatch = part.match(/^##\s+(.+)/);
    const heading = headingMatch ? headingMatch[1].trim() : "";
    const sectionContent = part.replace(/^##\s+.+\r?\n?/, "");
    if (sectionContent.trim().length < 15) continue;
    const qtype = heading ? inferQtype(heading) : "freeform";
    const sectionTitle = heading || "(无标题)";
    const sectionSlug = sectionTitle.replace(/\s+/g, "-");

    // freeform(简答/计算/证明…):整节成一块。答案在 <Solution>/<Answer> 里,单独归入 solution,
    // stem 只留题目——避免把答案块里的 1./2./3. 当成独立题(那正是重复 id + 答案泄漏的根)。
    if (qtype === "freeform") {
      const figures = extractFigures(sectionContent, figUrlFn);
      const sols = [];
      const solRe = /<(Solution|Answer)>([\s\S]*?)<\/\1>/g;
      let sm;
      while ((sm = solRe.exec(sectionContent)) !== null) {
        const t = stripMdxPreserve(sm[2]);
        if (t) sols.push(t);
      }
      const stem = stripMdxPreserve(
        sectionContent.replace(/<(Solution|Answer)>[\s\S]*?<\/(Solution|Answer)>/g, ""),
      ).slice(0, 3000);
      if (stem.length < 5) continue;
      chunks.push({
        id: `neowiki:${dir}#${sectionSlug}`, source: "neowiki", kind: "exam", chunk: "section",
        title: `${examTitle} · ${sectionTitle}`, course, url: wikiUrl,
        section: sectionTitle, qtype: "freeform", has_figure: figures.length > 0, stem,
        ...(sols.length ? { solution: sols.join("\n\n").slice(0, 4000) } : {}),
        ...(figures.length ? { figures } : {}),
        meta: examMeta,
      });
      continue;
    }

    // choice / blank:按题切。切分点只认「列首(第0列)」的 \d+.,躲开 <Solution> 里缩进的编号。
    const questionParts = sectionContent.split(/(?=^\d+\.\s)/m);
    const validQuestions = questionParts.filter((p) => p.trim().length > 10);

    if (validQuestions.length >= 1 && validQuestions.length <= 100) {
      for (const qbody of validQuestions) {
        const qnumMatch = qbody.match(/^(\d+)\.\s/);
        const qno = qnumMatch ? parseInt(qnumMatch[1], 10) : undefined;
        const extracted = extractQuestion(qbody, qtype, figUrlFn);
        if (extracted.stem.length < 5) continue;
        const suffix = qno != null ? String(qno) : `p${chunks.length}`;
        chunks.push({
          id: `neowiki:${dir}#${sectionSlug}-${suffix}`, source: "neowiki", kind: "exam", chunk: "question",
          title: `${examTitle} · ${sectionTitle}第${qno ?? ""}题`.replace(/第题/, "题"),
          course, url: wikiUrl,
          section: sectionTitle, qno, qtype,
          has_figure: extracted.has_figure, stem: extracted.stem,
          ...(extracted.options ? { options: extracted.options } : {}),
          ...(extracted.answer != null ? { answer: extracted.answer } : {}),
          ...(extracted.solution ? { solution: extracted.solution } : {}),
          ...(extracted.figures.length > 0 ? { figures: extracted.figures } : {}),
          meta: examMeta,
        });
      }
    } else if (sectionContent.trim().length > 30) {
      // 切不动:按节返回
      const cleanSection = stripMdxPreserve(sectionContent).slice(0, 4000);
      chunks.push(makeChunk(`neowiki:${dir}#${sectionSlug}`, "neowiki", "exam", "section",
        `${examTitle} · ${sectionTitle}`, course, wikiUrl, cleanSection, examMeta,
        { section: sectionTitle, qtype }));
    }
  }

  if (chunks.length === 0) {
    // 全部切不动:整卷兜底
    return [makeChunk(`neowiki:${dir}`, "neowiki", "exam", "whole",
      examTitle, course, wikiUrl, clean.slice(0, 4000), examMeta, {}) ];
  }

  return chunks;
}

function makeChunk(id, source, kind, chunkType, title, course, url, text, meta, extra) {
  return { id, source, kind, chunk: chunkType, title, course, url, text, meta, ...extra };
}

// ========== 主构建流程 ==========
const chunks = [];

// --- 生存指南:按 ## 切块 + campus/topic ---
const GROOT = join(WORK, "bupt-survival-guide/src/content/docs");
for (const file of walk(GROOT)) {
  const rel = relative(GROOT, file);
  const { fm, body } = readFm(readFileSync(file, "utf8"));
  const docTitle = fm.title || rel.replace(/\.mdx?$/, "");
  const parts = rel.replace(/\.mdx?$/, "").split(sep);
  if (parts[parts.length - 1] === "index") parts.pop();
  const url = `https://guide.byrdocs.org/${parts.map(encodeURIComponent).join("/")}/`;
  const { campus, topic } = inferCampusTopic(rel);
  let i = 0;
  for (const part of body.split(/\r?\n(?=##\s)/)) {
    const hm = part.match(/^##\s+(.+)/);
    const clean = cleanMd(part.replace(/^##\s+.+\r?\n?/, ""));
    if (clean.length < 30) continue;
    chunks.push({
      id: `survival-guide:${rel}#${i++}`, source: "survival-guide", kind: "guide", chunk: "guide",
      title: hm ? `${docTitle} — ${hm[1].trim()}` : docTitle,
      campus, topic, url, text: clean.slice(0, 4000),
      meta: { doc: docTitle, campus, topic },
    });
  }
}

// --- 真题 wiki:按题切块 ---
const EX = join(WORK, "byrdocs-neowiki/exams");
let examChunkCount = 0;
let examSectionCount = 0;
let examWholeCount = 0;
for (const dir of readdirSync(EX)) {
  const mdx = join(EX, dir, "index.mdx");
  if (!existsSync(mdx)) continue;
  const { fm, body } = readFm(readFileSync(mdx, "utf8"));
  const examChunks = parseExam(dir, fm, body);
  for (const c of examChunks) {
    if (c.chunk === "question") examChunkCount++;
    else if (c.chunk === "section") examSectionCount++;
    else examWholeCount++;
  }
  chunks.push(...examChunks);
}

// --- id 唯一性兜底(minisearch addAll 遇重复 id 会抛,整个索引建不起来)---
const idSeen = new Set();
let idFixed = 0;
for (const c of chunks) {
  if (!idSeen.has(c.id)) { idSeen.add(c.id); continue; }
  let i = 2, nid;
  do { nid = `${c.id}~${i++}`; } while (idSeen.has(nid));
  c.id = nid; idSeen.add(nid); idFixed++;
}
if (idFixed) console.warn(`  ⚠️ 修正了 ${idFixed} 个重复 chunk id(已加 ~N 后缀)`);

// --- 输出 ---
writeFileSync(join(DATA, "knowledge.json"), JSON.stringify(chunks));
const bySrc = {};
for (const c of chunks) bySrc[c.source] = (bySrc[c.source] || 0) + 1;
console.log("  knowledge.json:", chunks.length, "块", JSON.stringify(bySrc));
console.log("  真题:按题", examChunkCount, "/ 按节", examSectionCount, "/ 整卷", examWholeCount);

// --- build-info.json ---
const buildInfo = {
  built_at: new Date().toISOString(),
  metadata_url: METADATA_URL,
  metadata_count: Array.isArray(metadata) ? metadata.length : 0,
  knowledge_count: chunks.length,
  sources: sourceCommits,
};
writeFileSync(join(DATA, "build-info.json"), JSON.stringify(buildInfo, null, 2));
console.log("  build-info.json: written,", sourceCommits.length, "sources");

console.log("完成。接着 `npm run deploy` 把新数据打进 Worker。");