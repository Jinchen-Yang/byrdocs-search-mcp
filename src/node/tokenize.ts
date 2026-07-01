// Node 端中文分词:用原生 nodejs-jieba(搜索模式),与 Worker 的 jieba-wasm cut_for_search 行为一致。
// 服务器环境能跑原生实现,不需要 wasm。require 时即加载,无需异步 init。
import { cutForSearch } from "nodejs-jieba";

/** 供 minisearch 的 tokenize(同步)。带兜底:失败退化为空白切分。 */
export function tokenizeSync(s: string): string[] {
  try {
    const out = cutForSearch(s, true) as unknown as string[];
    return (Array.isArray(out) ? out : [out]).filter((w) => w && w.trim());
  } catch {
    return s.split(/\s+/).filter(Boolean);
  }
}
