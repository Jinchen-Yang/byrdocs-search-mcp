// 检索工具的纯逻辑,移植自 superdocs-agent(去掉 Mastra 的 createTool 壳)。
// v0.3:search_documents 补全字段 + 分页 + 归一;新增 search_exam_questions / answer_guide。
import { getIndexes, buildInfo } from "./indexes";
import type { DocRec, KBChunk } from "./indexes";

const SITE = "https://byrdocs.cloudlay.cn"; // 资料详情页 ?q=<md5>

// ---------- 小工具 ----------

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 用于排序/筛选的年份:试卷取学年结束年 time.end,教材取 publish_year,资料无年份→0。 */
function sortYear(r: DocRec): number {
  const d = r.data || {};
  if (r.type === "test") return Number(d.time?.end || d.time?.start || 0) || 0;
  if (r.type === "book") return Number(d.publish_year || 0) || 0;
  return 0;
}

/** 记录是否落在 [from,to] 学年区间内。 */
function inYearRange(r: DocRec, from: number, to: number): boolean {
  const d = r.data || {};
  if (r.type === "test") {
    const s = Number(d.time?.start || 0) || 0;
    const e = Number(d.time?.end || 0) || 0;
    return e >= from && s <= to;
  }
  if (r.type === "book") {
    const p = Number(d.publish_year || 0) || 0;
    return p >= from && p <= to;
  }
  return false;
}

/** 统一取课程名。 */
function courseName(r: DocRec): string {
  const d = r.data || {};
  if (d.course?.name) return d.course.name;
  if (Array.isArray(d.course)) return d.course.map((c: any) => c?.name).filter(Boolean).join(" ");
  return "";
}

/** 课程名归一:全角→半角,trim,小 alias 表。只用在 course 参数上,绝不动 query。 */
const COURSE_ALIAS: Record<string, string> = {
  "高数": "高等数学",
  "线代": "线性代数",
  "概率": "概率论",
  "概率统计": "概率论与数理统计",
  "计组": "计算机组成",
  "数据结构与算法": "数据结构",
  "大物": "大学物理",
  "马原": "马克思主义基本原理",
  "毛概": "毛泽东思想和中国特色社会主义理论体系概论",
  "习概": "习近平新时代中国特色社会主义思想概论",
  "思修": "思想道德与法治",
  "近纲": "中国近现代史纲要",
};
function normalizeCourse(s: string): string {
  let n = s.replace(/（/g, "(").replace(/）/g, ")").replace(/\s+/g, "").trim();
  return COURSE_ALIAS[n] || n;
}

/** 从 query 中剥离纯意图词(仅独立短语,不碰内容词)。 */
const INTENT_RE = /\b(最新|最近|推荐我?|帮我找|帮我搜|latest|recent|newest)\b/gi;
function stripIntentWords(query: string): { cleaned: string; hasNewest: boolean } {
  const hasNewest = /最新|latest|recent|newest/i.test(query);
  const cleaned = query.replace(INTENT_RE, "").replace(/\s+/g, " ").trim();
  return { cleaned, hasNewest };
}

// ---------- 零结果建议 ----------
function buildSuggestions(args: Record<string, any>, type: "doc" | "exam" | "guide"): string[] {
  const s: string[] = [];
  if (type === "doc") {
    if (args.stage) s.push("可尝试去掉 stage 限制");
    if (args.year || args.year_from || args.year_to) s.push("可尝试放宽学年范围");
    if (args.course) s.push("可尝试使用课程别名,如:高等数学 / 高数");
    s.push("若要题目正文,可改用 search_exam_questions");
  } else if (type === "exam") {
    if (args.school_year || args.year) s.push("可尝试去掉学年限制");
    if (args.section) s.push("可尝试去掉题型限制");
    s.push("若要下载试卷 PDF,可改用 search_documents");
  } else {
    if (args.campus && args.campus !== "通用") s.push("可尝试去掉校区限制(设 campus 为通用)");
    s.push("可尝试使用更简短的关键词");
  }
  return s;
}

// ---------- search_documents ----------

export type SearchDocsArgs = {
  query?: string;
  type?: "book" | "test" | "doc";
  course?: string;
  year?: number;
  year_from?: number;
  year_to?: number;
  stage?: "期中" | "期末";
  semester?: string;
  content?: string;
  sort?: "relevance" | "newest" | "oldest";
  limit?: number;
  offset?: number;
};

export async function searchDocuments(args: SearchDocsArgs) {
  const { docIndex, docById } = await getIndexes();

  // 意图词剥离
  let q = (args.query || "").trim();
  let hasNewest = false;
  if (q) {
    const stripped = stripIntentWords(q);
    q = stripped.cleaned;
    hasNewest = stripped.hasNewest;
  }

  let records: DocRec[];
  let hasScore = false;
  if (q) {
    const hits = docIndex.search(q) as any[];
    records = hits.map((h) => docById.get(h.id)).filter(Boolean) as DocRec[];
    hasScore = true;
  } else {
    records = [...docById.values()];
  }

  // 课程名归一
  const courseNorm = args.course ? normalizeCourse(args.course) : undefined;

  // 过滤
  if (args.type) records = records.filter((r) => r.type === args.type);
  if (courseNorm) records = records.filter((r) => courseName(r).includes(courseNorm));
  if (args.stage) records = records.filter((r) => (r.data?.time?.stage || "") === args.stage);
  if (args.semester) records = records.filter((r) => (r.data?.time?.semester || "") === args.semester);
  if (args.content)
    records = records.filter((r) => Array.isArray(r.data?.content) && r.data.content.includes(args.content!));

  const from = args.year_from ?? args.year;
  const to = args.year_to ?? args.year;
  if (from != null || to != null) {
    const lo = from ?? -Infinity;
    const hi = to ?? Infinity;
    records = records.filter((r) => inYearRange(r, lo, hi));
  }

  // 排序:意图词含"最新"且未显式传 sort → 默认 newest
  const sort = args.sort ?? (hasNewest ? "newest" : hasScore ? "relevance" : "newest");
  if (sort === "newest") records = [...records].sort((a, b) => sortYear(b) - sortYear(a));
  else if (sort === "oldest") records = [...records].sort((a, b) => sortYear(a) - sortYear(b));

  const total = records.length;
  const offset = args.offset ?? 0;
  const lim = args.limit ?? 8;
  const top = records.slice(offset, offset + lim);

  const snapshot_at = buildInfo.built_at || undefined;

  const results = top.map((r) => {
    const d = r.data || {};
    const t = d.time || {};
    const school_year =
      r.type === "test"
        ? t.start && t.end ? `${t.start}-${t.end}` : String(t.end || t.start || "") || undefined
        : undefined;
    const year =
      r.type === "test"
        ? t.start && t.end ? `${t.start}-${t.end}` : String(t.end || t.start || "") || undefined
        : d.publish_year || undefined;
    const filesize = typeof d.filesize === "number" ? d.filesize : undefined;
    return {
      id: r.id,
      type: r.type,
      title: d.title || courseName(r) || undefined,
      course: courseName(r) || undefined,
      school_year: school_year || undefined,
      year,
      semester: t.semester || undefined,
      stage: t.stage || undefined,
      content: Array.isArray(d.content) ? d.content : undefined,
      filetype: d.filetype || "pdf",
      filesize,
      filesize_h: filesize != null ? humanSize(filesize) : undefined,
      detail_url: `${SITE}/?q=${r.id}`,
      download_url: r.url || undefined,
      source_url: `https://byrdocs.org/?q=${r.id}`,
      snapshot_at,
    };
  });

  const ret: Record<string, any> = { total, count: results.length, offset, sort, results };
  if (buildInfo.built_at) ret.note = `byrdocs 数据没有上传/提交时间;year 是学年(试卷)或出版年(教材),snapshot_at 是数据快照时间。`;
  if (results.length === 0 && total === 0) ret.suggestions = buildSuggestions(args, "doc");
  return ret;
}

// ---------- search_exam_questions ----------

export type SearchExamArgs = {
  query?: string;
  course?: string;
  school_year?: string;
  year?: number;
  semester?: string;
  stage?: string;
  section?: string;
  question_no?: string;
  qtype?: "choice" | "blank" | "freeform";
  has_figure?: boolean;
  answer_mode?: "question_only" | "with_answer" | "with_solution";
  limit?: number;
};

export async function searchExamQuestions(args: SearchExamArgs) {
  const { kbIndex, kbById } = await getIndexes();

  const q = (args.query || "").trim();
  let hits: any[];
  if (q) {
    hits = kbIndex.search(q) as any[];
  } else {
    hits = [...kbById.values()].map((c) => ({ id: c.id }));
  }

  // 只搜真题
  hits = hits.filter((h) => {
    const chunk = kbById.get(h.id);
    return chunk && chunk.source === "neowiki";
  });

  const courseNorm = args.course ? normalizeCourse(args.course) : undefined;

  // 结构化字段过滤
  hits = hits.filter((h) => {
    const c = kbById.get(h.id) as KBChunk | undefined;
    if (!c) return false;
    if (courseNorm && !(c.course || "").includes(courseNorm)) return false;
    if (args.school_year && c.meta?.school_year !== args.school_year) return false;
    if (args.year != null) {
      const ys = Number(c.meta?.year_start || 0);
      const ye = Number(c.meta?.year_end || 0);
      if (!(ys <= args.year && args.year <= ye)) return false;
    }
    if (args.semester && c.meta?.semester !== args.semester) return false;
    if (args.stage && c.meta?.stage !== args.stage) return false;
    if (args.section && !(c.section || "").includes(args.section)) return false;
    if (args.question_no && String(c.qno) !== String(args.question_no)) return false;
    if (args.qtype && c.qtype !== args.qtype) return false;
    if (args.has_figure != null && !!c.has_figure !== args.has_figure) return false;
    return true;
  });

  const k = args.limit ?? 5;
  const answerMode = args.answer_mode ?? "with_answer";
  const snapshot_at = buildInfo.built_at || undefined;

  const results = hits.slice(0, k).map((h) => {
    const c = kbById.get(h.id) as KBChunk;
    const ret: Record<string, any> = {
      exam_title: c.title?.replace(/\s·\s.*$/, "") || c.title,
      course: c.course || undefined,
      school_year: c.meta?.school_year || undefined,
      semester: c.meta?.semester || undefined,
      stage: c.meta?.stage || undefined,
      section: c.section || undefined,
      question_no: c.qno != null ? String(c.qno) : undefined,
      qtype: c.qtype || undefined,
      has_figure: !!c.has_figure,
      stem: c.stem || c.text || "",
      url: c.url,
      snapshot_at,
    };

    // options:question_only 时不标正解
    if (c.options && c.options.length > 0) {
      if (answerMode === "question_only") {
        ret.options = c.options.map((o) => ({ label: o.label, text: o.text }));
      } else {
        ret.options = c.options.map((o) => ({ label: o.label, text: o.text }));
      }
    }

    if (answerMode !== "question_only") {
      if (c.answer != null) ret.answer = c.answer;
    }
    if (answerMode === "with_solution") {
      if (c.solution) ret.solution = c.solution;
    }

    // figures
    if (c.figures && c.figures.length > 0) {
      ret.figures = c.figures;
    }

    // 含图题提示
    if (c.has_figure && (!c.figures || c.figures.length === 0 || /【?图】?/.test(c.stem || ""))) {
      ret.note = "此题依赖图片,请打开 url 查看";
    }

    return ret;
  });

  const ret: Record<string, any> = { count: results.length, results };
  if (results.length === 0) ret.suggestions = buildSuggestions(args, "exam");
  return ret;
}

// ---------- answer_guide ----------

export type AnswerGuideArgs = {
  query: string;
  campus?: "沙河" | "海淀" | "通用";
  topic?: string;
  limit?: number;
};

export async function answerGuide(args: AnswerGuideArgs) {
  const { kbIndex, kbById } = await getIndexes();

  const q = args.query.trim();
  let hits = kbIndex.search(q) as any[];

  // 只搜指南
  hits = hits.filter((h) => {
    const c = kbById.get(h.id);
    return c && c.source === "survival-guide";
  });

  // campus 过滤
  if (args.campus && args.campus !== "通用") {
    hits = hits.filter((h) => {
      const c = kbById.get(h.id) as KBChunk | undefined;
      return c && (c.campus === args.campus || c.campus === "通用");
    });
  }

  // topic 过滤
  if (args.topic) {
    hits = hits.filter((h) => {
      const c = kbById.get(h.id) as KBChunk | undefined;
      return c && (c.topic || "").includes(args.topic!);
    });
  }

  const k = args.limit ?? 3;
  const snapshot_at = buildInfo.built_at || undefined;

  const results = hits.slice(0, k).map((h) => {
    const c = kbById.get(h.id) as KBChunk;
    return {
      title: c.title,
      campus: c.campus || undefined,
      topic: c.topic || undefined,
      url: c.url,
      text: (c.text || "").slice(0, 2000),
      snapshot_at,
    };
  });

  const ret: Record<string, any> = { count: results.length, results };
  if (results.length === 0) ret.suggestions = buildSuggestions(args, "guide");
  return ret;
}

// ---------- answer_knowledge (deprecated 兼容层) ----------

export type AnswerKnowledgeArgs = {
  query: string;
  source?: "survival-guide" | "neowiki";
  course?: string;
  kind?: "guide" | "exam";
  year?: number;
  topK?: number;
};

/** @deprecated 请使用 search_exam_questions(真题) 或 answer_guide(指南) */
export async function answerKnowledge(args: AnswerKnowledgeArgs) {
  const { kbIndex, kbById } = await getIndexes();
  const q = args.query.trim();
  let hits = kbIndex.search(q) as any[];

  if (args.source) hits = hits.filter((h) => h.source === args.source);
  if (args.kind) hits = hits.filter((h) => h.kind === args.kind);

  const courseNorm = args.course ? normalizeCourse(args.course) : undefined;
  if (courseNorm) hits = hits.filter((h) => (h.course || "").includes(courseNorm));

  // 修复:用结构化字段做年份过滤(不再是 Number(meta.year) === args.year)
  if (args.year != null) {
    hits = hits.filter((h) => {
      const chunk = kbById.get(h.id);
      const ys = Number(chunk?.meta?.year_start || 0);
      const ye = Number(chunk?.meta?.year_end || 0);
      return ys <= args.year! && args.year! <= ye;
    });
  }

  const k = args.topK ?? 3;
  const PER_CHUNK = 1200;
  const results = hits.slice(0, k).map((h) => {
    const chunk = kbById.get(h.id) as KBChunk | undefined;
    const text = chunk?.text || chunk?.stem || "";
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
      _deprecated: "建议使用 search_exam_questions(查真题)或 answer_guide(查指南),本工具将在未来版本移除。",
    };
  });
  return { count: results.length, results };
}