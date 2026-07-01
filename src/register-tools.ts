// 4 个工具的注册(名称/描述/zod schema/handler),Worker 与 Node 入口共用,保证两端一致。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchDocuments, searchExamQuestions, answerGuide, answerKnowledge } from "./tools";

export const SERVER_INSTRUCTIONS = `byrdocs-search:检索北邮 byrdocs 资料库(https://byrdocs.org 的国内镜像)。

【库里有什么】三类文件,元信息结构如下:
- book(教材):title / authors / publisher / publish_year(出版年)/ isbn。
- test(历年试卷):course.name / time{start,end,semester,stage} / content[原题|答案]。
  time.start-end 是「学年区间」(如 2018-2019),stage 是 期中|期末。semester 是 First/Second。
- doc(课程资料):title / course[].name / content[思维导图|题库|答案|知识点|课件]。

【最重要的一条规则:没有「上传/提交时间」这个字段】
要「最新的试卷」→ 用 search_documents(type="test", sort="newest"),别把「最新」写进 query。

【四个工具怎么选】
- search_documents:找「可下载的资料文件(PDF/ZIP)元信息 + 下载链接」。
- search_exam_questions:找「真题 wiki 的题目正文」,支持按题/节/卷返回,可控制是否含答案/解析。
- answer_guide:找「生存指南经验」——校园生活/选课/宿舍/网络等。
- answer_knowledge(已弃用):请改用上面两个工具。

【query 只放内容关键词】课程名/书名/主题(如「数据结构」「高等数学」),
不要放「最新/最近/推荐/帮我找」这类意图词——意图用 sort/year/type 等参数表达。

【文件类型】资料文件包含 PDF(约1067个)和 ZIP(约48个),ZIP 需下载解压,非在线预览。`;

export function registerTools(server: McpServer): void {
  server.tool(
    "search_documents",
    "检索 byrdocs 资料库(教材/试卷/资料),返回标题、课程、学年、阶段、文件类型(PDF/ZIP)、文件大小、下载链接。要「可下载的资料文件」时用它。⚠️ 没有上传时间,sort=newest 按学年从新到旧。",
    {
      query: z.string().optional().describe("内容关键词:课程名/书名/主题。别放'最新/最近'等意图词。"),
      type: z.enum(["book", "test", "doc"]).optional().describe("book=教材, test=历年试卷, doc=课程资料"),
      course: z.string().optional().describe("课程名包含匹配,支持别名如'高数'→'高等数学'"),
      year: z.number().int().optional().describe("单一学年,如 2024"),
      year_from: z.number().int().optional().describe("学年下限(含)"),
      year_to: z.number().int().optional().describe("学年上限(含)"),
      stage: z.enum(["期中", "期末"]).optional().describe("仅试卷:考试阶段"),
      semester: z.enum(["First", "Second"]).optional().describe("学期:First=秋, Second=春"),
      content: z.string().optional().describe("文件内容类型:原题/答案/题库/知识点/课件/思维导图"),
      sort: z.enum(["relevance", "newest", "oldest"]).optional().describe("排序"),
      limit: z.number().int().min(1).max(50).optional().describe("返回条数,默认 8"),
      offset: z.number().int().min(0).optional().describe("分页偏移,默认 0"),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchDocuments(args)) }] }),
  );

  server.tool(
    "search_exam_questions",
    "检索北邮真题 wiki,按题/节/卷返回题目正文。支持按课程/学年/题型/题号筛选。answer_mode 控制是否暴露答案与解析:question_only(只要题干)/with_answer(含答案)/with_solution(含解析)。含图题会提示打开 url 查看。",
    {
      query: z.string().optional().describe("内容关键词,如题干中的关键词"),
      course: z.string().optional().describe("课程名包含匹配"),
      school_year: z.string().optional().describe("学年区间,如 '2024-2025'"),
      year: z.number().int().optional().describe("学年,如 2024(匹配 2024-2025)"),
      semester: z.enum(["First", "Second"]).optional().describe("学期"),
      stage: z.enum(["期中", "期末"]).optional().describe("考试阶段"),
      section: z.string().optional().describe("节标题包含匹配,如 '选择题'/'填空'/'简答'"),
      question_no: z.string().optional().describe("题号,如 '6'"),
      qtype: z.enum(["choice", "blank", "freeform"]).optional().describe("题型:choice=选择,blank=填空,freeform=简答/计算等"),
      has_figure: z.boolean().optional().describe("是否含图"),
      answer_mode: z.enum(["question_only", "with_answer", "with_solution"]).optional().describe("答案模式,默认 with_answer"),
      limit: z.number().int().min(1).max(10).optional().describe("返回条数,默认 5"),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchExamQuestions(args)) }] }),
  );

  server.tool(
    "answer_guide",
    "检索北邮生存指南,返回可直接据此作答的校园生活经验——宿舍/选课/网络/食堂/交通等。要「答疑/找经验」时用它。不要用来搜真题或可下载资料。",
    {
      query: z.string().describe("用户问题或关键词,如 '沙河宿舍用电' / '怎么选课'"),
      campus: z.enum(["沙河", "海淀", "通用"]).optional().describe("校区筛选"),
      topic: z.string().optional().describe("主题(取指南文件名,如 '校园网'/'成绩构成'/'转专业'/'入学准备');细主题也可直接放进 query"),
      limit: z.number().int().min(1).max(5).optional().describe("返回条数,默认 3"),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await answerGuide(args)) }] }),
  );

  server.tool(
    "answer_knowledge",
    "⚠️ 已弃用。请改用 search_exam_questions(查真题)或 answer_guide(查指南)。本工具将在未来版本移除。保留为兼容层。",
    {
      query: z.string().describe("用户问题或关键词"),
      source: z.enum(["survival-guide", "neowiki"]).optional(),
      course: z.string().optional(),
      kind: z.enum(["guide", "exam"]).optional(),
      year: z.number().int().optional(),
      topK: z.number().int().min(1).max(5).optional(),
    },
    async (args) => ({ content: [{ type: "text", text: JSON.stringify(await answerKnowledge(args)) }] }),
  );
}
