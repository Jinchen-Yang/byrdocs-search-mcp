// 平台无关的索引构建核心 —— Worker 与 Node 共用。
// 数据加载和分词由各平台注入(Worker: JSON import + jieba-wasm;Node: fs + nodejs-jieba)。
import MiniSearch from "minisearch";

// ---------- 类型 ----------
export type BuildInfo = {
  built_at: string;
  metadata_url: string;
  metadata_count: number;
  knowledge_count: number;
  sources: { repo: string; commit: string }[];
};

export type DocRec = { id: string; url: string; type: "book" | "test" | "doc"; data: any };

export type ExamOption = { label: string; text: string };
export type ExamFigure = { src: string; caption: string; url: string };

export type KBChunk = {
  id: string;
  source: string; // "survival-guide" | "neowiki"
  kind: string; // "guide" | "exam"
  chunk: string; // "guide" | "question" | "section" | "whole"
  title: string;
  course?: string;
  url: string;
  // 指南字段
  campus?: string;
  topic?: string;
  text?: string;
  // 真题结构化字段
  section?: string;
  qno?: number;
  qtype?: string;
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

// 中文搜索稳健性:jieba 会切出很多单字,若对单字也开 prefix+fuzzy 会候选爆炸拖垮 CPU。
// 故只对 ≥2 字开前缀、≥4 字开模糊,并给 fuzzy 上限。
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

/** 从原始 JSON 快照建两套 MiniSearch 索引。tokenizeSync 由平台注入(须已就绪/同步)。 */
export function buildIndexes(
  metadataRaw: unknown,
  knowledgeRaw: unknown,
  tokenizeSync: (s: string) => string[],
): Indexes {
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
      id: r.id, source: r.source, kind: r.kind, chunk: r.chunk, title: r.title,
      course: r.course || "", url: r.url, stem: r.stem || "", text: r.text || "",
      section: r.section || "", qno: r.qno, qtype: r.qtype || "",
      has_figure: r.has_figure ? 1 : 0, campus: r.campus || "", topic: r.topic || "",
    })),
  );

  return { docIndex, docById, kbIndex, kbById };
}
