// nodejs-jieba 无自带类型声明,补一个最小声明。
declare module "nodejs-jieba" {
  export function cut(text: string, hmm?: boolean): string[];
  export function cutAll(text: string): string[];
  export function cutForSearch(text: string, hmm?: boolean): string[];
  export function tag(text: string): { word: string; tag: string }[];
  export function extract(text: string, topn: number): { keyword: string; weight: number }[];
  export function load(): void;
}
