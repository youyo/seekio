import pkg from "../package.json";

/** サーバー名とバージョンの唯一の定義。McpServer・/health・feedback が同じ値を読む。 */
export const SERVER_NAME = "seekio";
export const SERVER_VERSION: string = pkg.version;
export const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION } as const;
