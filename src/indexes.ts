// 两套本地检索索引(minisearch),从打包进来的 JSON 快照现建。
// 移植自 superdocs-agent 的 search-index.ts / knowledge-index.ts,分词换成 jieba-wasm。
import MiniSearch from "minisearch";
import metadataRaw from "../data/metadata.json";
import knowledgeRaw from "../data/knowledge.json";
import { initJieba, tokenizeSync } from "./tokenize";

// ---------- 文档(byrdocs 资料元信息)----------
type DocRec = { id: string; url: string; type: "book" | "test" | "doc"; data: any };

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
  };
}

// ---------- 知识(真题wiki / 生存指南正文)----------
export type KBChunk = {
  id: string;
  source: string;
  kind: string;
  title: string;
  course?: string;
  url: string;
  text: string;
  meta?: Record<string, string>;
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
    storeFields: ["id", "type", "title", "course", "year", "filetype", "stage"],
    processTerm: (t) => t.toLowerCase(),
    tokenize: (s) => tokenizeSync(s),
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 3, course: 2 } },
  });
  docIndex.addAll(docsRaw.map(flattenDoc));

  const kbRaw = (knowledgeRaw as unknown as KBChunk[]).filter((r) => r && typeof r === "object" && r.id);
  const kbById = new Map(kbRaw.map((r) => [r.id, r]));
  const kbIndex = new MiniSearch({
    fields: ["title", "course", "text"],
    storeFields: ["id", "source", "kind", "title", "course", "url"],
    processTerm: (t) => t.toLowerCase(),
    tokenize: (s) => tokenizeSync(s),
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 4, course: 3, text: 1 } },
  });
  kbIndex.addAll(
    kbRaw.map((r) => ({
      id: r.id, source: r.source, kind: r.kind, title: r.title,
      course: r.course || "", url: r.url, text: r.text,
    })),
  );

  return { docIndex, docById, kbIndex, kbById };
}
