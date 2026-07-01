// 两个检索工具的纯逻辑,移植自 superdocs-agent(去掉 Mastra 的 createTool 壳)。
import { getIndexes } from "./indexes";

const SITE = "https://byrdocs.cloudlay.cn"; // 资料详情页 ?q=<md5>
const PER_CHUNK = 1200;

export type SearchDocsArgs = {
  query: string;
  type?: "book" | "test" | "doc";
  course?: string;
  limit?: number;
};

/** 检索 byrdocs 资料元信息。试卷 year 用学年区间、带 stage;每条给详情页 link。 */
export async function searchDocuments(args: SearchDocsArgs) {
  const { docIndex, docById } = await getIndexes();
  let hits = docIndex.search(args.query) as any[];
  if (args.type) hits = hits.filter((h) => h.type === args.type);
  if (args.course) hits = hits.filter((h) => (h.course || "").includes(args.course!));
  const lim = args.limit ?? 8;
  return {
    count: Math.min(hits.length, lim),
    results: hits.slice(0, lim).map((h) => {
      const t = docById.get(h.id)?.data?.time || {};
      const year = t.start && t.end ? `${t.start}-${t.end}` : h.year || undefined;
      return {
        id: h.id,
        type: h.type,
        title: h.title,
        course: h.course || undefined,
        year,
        stage: t.stage || h.stage || undefined,
        filetype: h.filetype,
        link: `${SITE}/?q=${h.id}`,
      };
    }),
  };
}

export type AnswerKnowledgeArgs = {
  query: string;
  source?: "survival-guide" | "neowiki";
  course?: string;
  kind?: "guide" | "exam";
  topK?: number;
};

/** 一步检索新生答疑知识库(生存指南 + 真题wiki),返回可直接据此作答的正文(含出处 url)。 */
export async function answerKnowledge(args: AnswerKnowledgeArgs) {
  const { kbIndex, kbById } = await getIndexes();
  let hits = kbIndex.search(args.query) as any[];
  if (args.source) hits = hits.filter((h) => h.source === args.source);
  if (args.kind) hits = hits.filter((h) => h.kind === args.kind);
  if (args.course) hits = hits.filter((h) => (h.course || "").includes(args.course!));
  const k = args.topK ?? 3;
  const results = hits.slice(0, k).map((h) => {
    const chunk = kbById.get(h.id);
    const text = chunk?.text || "";
    const truncated = text.length > PER_CHUNK;
    return {
      title: h.title,
      source: h.source,
      kind: h.kind,
      course: h.course || undefined,
      url: h.url,
      meta: chunk?.meta,
      text: truncated ? text.slice(0, PER_CHUNK) + "…(正文较长已截断,换更具体关键词再查)" : text,
      truncated,
    };
  });
  return { count: results.length, results };
}
