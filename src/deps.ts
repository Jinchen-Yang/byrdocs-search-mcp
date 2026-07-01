// 依赖注入:tools.ts 通过这里拿 getIndexes / buildInfo,由各平台入口(Worker index.ts / Node server.ts)
// 在启动时 configureDeps() 注入。这样 tools.ts 不直接 import 平台专用的 indexes.ts(避免把 wasm 导入
// 等 Worker-only 代码带进 Node)。
import type { Indexes, BuildInfo } from "./indexes-core";

let _getIndexes: (() => Promise<Indexes>) | null = null;
let _buildInfo: BuildInfo | null = null;

export function configureDeps(d: { getIndexes: () => Promise<Indexes>; buildInfo: BuildInfo }): void {
  _getIndexes = d.getIndexes;
  _buildInfo = d.buildInfo;
}

export function getIndexes(): Promise<Indexes> {
  if (!_getIndexes) throw new Error("deps 未配置:入口需先调用 configureDeps()");
  return _getIndexes();
}

const EMPTY_BUILD_INFO: BuildInfo = {
  built_at: "", metadata_url: "", metadata_count: 0, knowledge_count: 0, sources: [],
};
export function getBuildInfo(): BuildInfo {
  return _buildInfo ?? EMPTY_BUILD_INFO;
}
