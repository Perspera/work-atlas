/** 统一请求封装：同源 Cookie、写操作带 X-Dashboard-Client、401/428 交给上层处理。 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

/** 会话失效（401）或需要改密（428）时广播，由根组件重新拉取 /api/me 决定界面。 */
export const AUTH_EVENT = "work-atlas:auth";

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** 原始请求体（文件上传 / CSV 文本）：直接发送，不做 JSON 序列化。 */
  rawBody?: BodyInit;
  query?: Record<string, QueryValue>;
}

function buildUrl(path: string, query?: Record<string, QueryValue>) {
  if (!query) return path;
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method || "GET";
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (method !== "GET") headers["X-Dashboard-Client"] = "1";

  const res = await fetch(buildUrl(path, options.query), {
    method,
    headers,
    body,
    credentials: "same-origin",
  });

  const type = res.headers.get("content-type") || "";
  const data: unknown = type.includes("json") ? await res.json() : await res.text();

  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `请求失败（${res.status}）`;
    if (res.status === 401 || res.status === 428) {
      window.dispatchEvent(new CustomEvent(AUTH_EVENT));
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

/** 下载导出文件：直接用浏览器打开，复用服务端的 Content-Disposition。 */
export function download(path: string, query?: Record<string, QueryValue>) {
  window.location.href = buildUrl(path, query);
}
