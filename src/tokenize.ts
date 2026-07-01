// jieba 中文分词(搜索模式),用 WASM 版 —— Cloudflare Workers 跑不了原生 nodejs-jieba,
// 但 WASM 能跑(byrdocs 前端本来就用 jieba-wasm)。与 agent 侧 cutForSearch 行为一致。
import init, { cut_for_search } from "jieba-wasm";
// CF Workers:把 .wasm 作为模块导入,得到 WebAssembly.Module 交给 wasm-bindgen 的 init。
// jieba-wasm 的 exports 挡了直接 subpath 导入,故由 scripts/copy-wasm.mjs 把 web 版 wasm 拷进 src/ 再本地导入。
import wasmModule from "./jieba_rs_wasm_bg.wasm";

let ready: Promise<void> | null = null;

/** 初始化 jieba WASM(每个 isolate 一次)。建索引/搜索前必须先 await 它。 */
export function initJieba(): Promise<void> {
  if (!ready) ready = init(wasmModule as unknown as WebAssembly.Module).then(() => undefined);
  return ready;
}

/** 供 minisearch 的 tokenize(同步)。调用前必须已 initJieba()。带兜底:失败退化为空白切分。 */
export function tokenizeSync(s: string): string[] {
  try {
    const out = cut_for_search(s, true) as unknown as string[];
    return (Array.isArray(out) ? out : [out]).filter((w) => w && w.trim());
  } catch {
    return s.split(/\s+/).filter(Boolean);
  }
}
