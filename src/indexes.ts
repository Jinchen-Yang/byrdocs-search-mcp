// 两套本地检索索引(minisearch),从打包进来的 JSON 快照现建。
// 移植自 superdocs-agent 的 search-index.ts / knowledge-index.ts,分词换成 jieba-wasm。
import MiniSearch from "minisearch";
import metadataRaw from "../data/metadata.json";
import knowledgeRaw from "../data/knowledge.json";
import buildInfoRaw from "../data/build-info.json";
import { initJieba, tokenizeSync } from "./tokenize";

// ---------- build-info ----------
export type BuildInfo = {
  built_at: string;
  metadata_url: string;
  metadata_count: number;
  knowledge_count: number;
  sources: { repo: string; commit: string }[];
};
export const buildInfo: BuildInfo = buildInfoRaw as BuildInfo;

// ---------- 文档(byrdocs 资料元信息)----------
export type DocRec = { id: string; url: string; type: "book" | "test" | "doc"; data: any };

// 中文搜索的稳健性配置:jieba 会把 query 切出很多单字/短词,
// 若对单字也开 prefix+fuzzy,会在词表里命中海量候选 → minisearch 打分爆炸 → Worker CPU 超时。
// 故:只对 ≥2 字的词开前缀匹配,只对 ≥4 字的词开模糊匹配,并给 fuzzy 上限。
const SAFE_SEARCH = {
  prefix: (term: string) => term.length >= 2,
  fuzzy: (term: string) => (term.length >= 4 ? 0.2 : false),
  maxFuzzy: 4,
} as const;

function flattenDoc(r: DocRec) {
  const d = r.data || {};
  const courseName =
    d.course?.name || (Array.isArray(d.course) ? d.course.map((c: any) => c.name).join(" ") : "");
  return {
    id: r.id,
    type: r.type,
    title: d.title || courseName || "",
    course: courseName || "",
    college: Array.isArray(d.college) ? d.college.join(" ") : "",
    authors: Array.isArray(d.authors) ? d.authors.join(" ") : "",
    year: String(d.publish_year || d.time?.end || d.time?.start || ""),
    content: Array.isArray(d.content) ? d.content.join(" ") : "",
    filetype: d.filetype || "pdf",
    stage: d.time?.stage || "",
    semester: d.time?.semester || "",
  };
}

// ---------- 知识(真题wiki / 生存指南正文)----------
export type ExamOption = { label: string; text: string };
export type ExamFigure = { src: string; caption: string; url: string };

export type KBChunk = {
  id: string;
  source: string;  // "survival-guide" | "neowiki"
  kind: string;     // "guide" | "exam"
  chunk: string;    // "guide" | "question" | "section" | "whole"
  title: string;
  course?: string;
  url: string;
  // 指南字段
  campus?: string;  // "沙河" | "海淀" | "通用"
  topic?: string;
  text?: string;
  // 真题结构化字段
  section?: string;
  qno?: number;
  qtype?: string;   // "choice" | "blank" | "freeform"
  has_figure?: boolean;
  stem?: string;
  options?: ExamOption[];
  answer?: string | string[];
  solution?: string;
  figures?: ExamFigure[];
  meta?: Record<string, string | number | string[] | undefined>;
};

export type Indexes = {
  docIndex: MiniSearch;
  docById: Map<string, DocRec>;
  kbIndex: MiniSearch;
  kbById: Map<string, KBChunk>;
};

let built: Promise<Indexes> | null = null;

/** 懒建索引(先 initJieba)。isolate 内只建一次,后续请求复用。 */
export function getIndexes(): Promise<Indexes> {
  if (!built) built = build();
  return built;
}

async function build(): Promise<Indexes> {
  await initJieba(); // minisearch 的 tokenize 是同步的,必须先把 jieba 准备好

  const docsRaw = (metadataRaw as DocRec[]).filter((r) => r && typeof r === "object" && r.id);
  const docById = new Map(docsRaw.map((r) => [r.id, r]));
  const docIndex = new MiniSearch({
    fields: ["title", "course", "college", "authors", "content", "year"],
    storeFields: ["id", "type", "title", "course", "year", "filetype", "stage", "semester"],
    processTerm: (t) => t.toLowerCase(),
    tokenize: (s) => tokenizeSync(s),
    searchOptions: { ...SAFE_SEARCH, boost: { title: 3, course: 2 } },
  });
  docIndex.addAll(docsRaw.map(flattenDoc));

  const kbRaw = (knowledgeRaw as unknown as KBChunk[]).filter((r) => r && typeof r === "object" && r.id);
  const kbById = new Map(kbRaw.map((r) => [r.id, r]));
  const kbIndex = new MiniSearch({
    fields: ["title", "course", "stem", "text", "section"],
    storeFields: [
      "id", "source", "kind", "chunk", "title", "course", "url",
      "section", "qno", "qtype", "has_figure", "campus", "topic",
    ],
    processTerm: (t) => t.toLowerCase(),
    tokenize: (s) => tokenizeSync(s),
    searchOptions: { ...SAFE_SEARCH, boost: { title: 4, course: 3, stem: 2, text: 1 } },
  });
  kbIndex.addAll(
    kbRaw.map((r) => ({
      id: r.id,
      source: r.source,
      kind: r.kind,
      chunk: r.chunk,
      title: r.title,
      course: r.course || "",
      url: r.url,
      stem: r.stem || "",
      text: r.text || "",
      section: r.section || "",
      qno: r.qno,
      qtype: r.qtype || "",
      has_figure: r.has_figure ? 1 : 0,
      campus: r.campus || "",
      topic: r.topic || "",
    })),
  );

  return { docIndex, docById, kbIndex, kbById };
}