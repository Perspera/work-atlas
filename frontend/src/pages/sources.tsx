import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { api, download } from "../lib/api";
import { num } from "../lib/format";
import { hasPerm, useApp } from "../lib/store";
import { Badge, Empty, Kpi, KpiBand, Loading, PageHead, Panel } from "../components/ui";
import WmsPanel from "../features/wms-download";
import SourceArchives from "../features/source-archives";

interface SourceDir {
  path: string;
  ok: boolean;
}

interface SourceFile {
  id: number;
  name: string;
  kind: string | null;
  rows: number;
  status: string;
  error: string | null;
  imported_at: string | null;
  size: number;
  biz_dates: string;
  exists: boolean;
  logical_key: string;
  content_date_mismatch: boolean;
  versions?: number;
}

interface UnmappedDealer {
  full_name: string;
  lines: number;
  amount: number | null;
}

interface ArchivedDate {
  biz_date: string;
  rows: number;
}

interface SourcesData {
  dirs: SourceDir[];
  files: SourceFile[];
  file_total: number;
  file_pages: number;
  file_page: number;
  file_page_size: number;
  last_scan: string;
  last_scan_error: string;
  scan_sec: number;
  tms_unmatched: string[];
  unmapped: UnmappedDealer[];
  unmapped_count: number;
  data_range: { min: string | null; max: string | null; days: number };
  archived_dates: ArchivedDate[];
}

const STATUS_TEXT: Record<string, { kind: string; label: string }> = {
  ok: { kind: "ok", label: "正常" },
  unknown: { kind: "warn", label: "未识别" },
  partial: { kind: "danger", label: "部分成功" },
};

function statusOf(status: string) {
  return STATUS_TEXT[status] || { kind: "danger", label: "失败" };
}

export default function SourcesPage() {
  const me = useApp((state) => state.me);
  const toast = useApp((state) => state.toast);
  const canScan = hasPerm(me, "action.scan");
  const canExportDealers = hasPerm(me, "action.dealers.manage");
  const [filePage, setFilePage] = useState(1);
  const [fileGroup, setFileGroup] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["sources", filePage, fileGroup],
    queryFn: () =>
      api<SourcesData>("/api/sources", {
        query: { file_page: filePage, file_page_size: 10, file_group: fileGroup ? "1" : "0" },
      }),
  });

  const scan = useMutation({
    mutationFn: () => api("/api/scan", { method: "POST" }),
    onSuccess: () => {
      toast("扫描完成", "ok");
      void refetch();
    },
    onError: (err) => toast((err as Error).message, "err"),
  });

  const dealerFile = useRef<HTMLInputElement>(null);

  // 与旧版一致：xlsx 以原始文件体上传；CSV 读成文本上传，后端按文件头自动分流。
  const importDealers = async (file: File) => {
    try {
      const isCsv = /\.csv$/i.test(file.name);
      const result = await api<{ count?: number; created?: number; updated?: number; skipped?: number }>(
        "/api/dealers/import",
        { method: "POST", rawBody: isCsv ? await file.text() : file },
      );
      toast(
        `导入完成：新增 ${result.created ?? result.count ?? 0} / 更新 ${result.updated ?? 0} / 跳过 ${result.skipped ?? 0}`,
        "ok",
      );
      void refetch();
    } catch (error) {
      toast((error as Error).message, "err");
    }
  };

  const range = data?.data_range;

  return (
    <>
      <PageHead
        title="数据源"
        sub="把 WMS「发运表」与 TMS「运输单状态」的下载文件丢进下面目录即可，系统自动识别"
      >
        {canScan && (
          <button className="btn btn-primary" disabled={scan.isPending} onClick={() => scan.mutate()}>
            {scan.isPending ? "扫描中…" : "立即扫描"}
          </button>
        )}
        {canExportDealers && (
          <>
            <input
              ref={dealerFile}
              type="file"
              accept=".xlsx,.xlsm"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importDealers(file);
              }}
            />
            <button className="btn" onClick={() => dealerFile.current?.click()}>
              导入经销商 XLSX
            </button>
          </>
        )}
      </PageHead>

      {isLoading && <Loading />}
      {error && <Empty text={(error as Error).message} />}

      {data && (
        <>
          <KpiBand cols={4}>
            <Kpi label="已导入文件" value={num(data.file_total)} unit="个"
              sub={`本页 ${num(data.files.length)} 个 · 每 ${num(data.scan_sec)} 秒自动扫描`} />
            <Kpi label="未映射经销商" value={num(data.unmapped_count)} unit="行"
              warn={data.unmapped_count > 0}
              sub={data.unmapped_count > 0 ? "需要人工补映射" : "全部已映射"} />
            <Kpi label="扫描间隔" value={num(Math.round(data.scan_sec / 60))} unit="分钟"
              sub={data.last_scan ? `上次扫描 ${data.last_scan}` : "尚未扫描"} />
            <Kpi label="最近扫描"
              value={data.last_scan_error ? "失败" : "正常"}
              warn={Boolean(data.last_scan_error)}
              sub={data.last_scan_error || (range ? `数据覆盖 ${range.min} ~ ${range.max}（${range.days} 天）` : "—")} />
          </KpiBand>

          <div className="grid cols-2" style={{ marginBottom: 14 }}>
            <Panel title="数据源目录">
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {data.dirs.map((dir) => (
                  <div key={dir.path}>
                    <Badge kind={dir.ok ? "ok" : "danger"}>{dir.ok ? "可达" : "不可达"}</Badge>{" "}
                    <span className="small mono">{dir.path}</span>
                  </div>
                ))}
              </div>
              <div className="small" style={{ marginTop: 10 }}>
                发运数据覆盖：<b>{range?.min || "-"} ~ {range?.max || "-"}</b>（{range?.days || 0} 天）
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>
                每 {data.scan_sec} 秒自动扫描一次 · 上次扫描：{data.last_scan || "-"}
              </div>
              {data.last_scan_error && (
                <div className="small" style={{ marginTop: 6, color: "#c92a2a" }}>
                  上次扫描告警：{data.last_scan_error}
                </div>
              )}
              {data.archived_dates.length > 0 && (
                <div className="small muted" style={{ marginTop: 6 }}>
                  已存档日期：
                  {data.archived_dates.map((item) => `${item.biz_date}(${item.rows})`).join("、")}
                </div>
              )}
            </Panel>

            <Panel title="运输单未匹配波次">
              {data.tms_unmatched.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {data.tms_unmatched.map((wave) => (
                    <Badge key={wave} kind="warn">
                      {wave}
                    </Badge>
                  ))}
                </div>
              ) : (
                <Empty text="全部波次都能在 TMS 里找到" />
              )}
            </Panel>
          </div>

          <Panel
            title="文件台账"
            actions={
              <label className="check small">
                <input
                  type="checkbox"
                  checked={fileGroup}
                  onChange={(event) => {
                    setFileGroup(event.target.checked);
                    setFilePage(1);
                  }}
                />
                合并同名版本
              </label>
            }
            flush
          >
            <div className="table-wrap" style={{ maxHeight: 430 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>类型</th>
                    <th className="num">行数</th>
                    <th className="num">版本</th>
                    <th>内容日期</th>
                    <th>状态</th>
                    <th>导入时间</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {data.files.length === 0 && (
                    <tr>
                      <td colSpan={8} className="empty-cell">
                        <Empty text="还没有导入任何文件" />
                      </td>
                    </tr>
                  )}
                  {data.files.map((file) => {
                    const state = statusOf(file.status);
                    return (
                      <tr key={file.id}>
                        <td>
                          {file.name}
                          {file.exists === false && (
                            <>
                              {" "}
                              <span title="Z 盘已不存在该文件，保留历史台账">
                                <Badge kind="warn">源文件已移除</Badge>
                              </span>
                            </>
                          )}
                        </td>
                        <td>{file.kind || "-"}</td>
                        <td className="num">{num(file.rows)}</td>
                        <td className="num">{num(file.versions || 1)}</td>
                        <td className="small">
                          {file.biz_dates || "-"}
                          {file.content_date_mismatch && (
                            <>
                              {" "}
                              <span title="文件名日期不在实际订单日期中">
                                <Badge kind="warn">日期不一致</Badge>
                              </span>
                            </>
                          )}
                        </td>
                        <td>
                          <Badge kind={state.kind}>{state.label}</Badge>
                        </td>
                        <td>{file.imported_at || ""}</td>
                        <td className="small muted">{file.error || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span>
                共 {num(data.file_total)} 个文件 · 第 {num(data.file_page)}/{num(data.file_pages)} 页
              </span>
              <button
                className="btn btn-sm"
                disabled={Number(data.file_page) <= 1}
                onClick={() => setFilePage(Math.max(1, data.file_page - 1))}
              >
                上一页
              </button>
              <button
                className="btn btn-sm"
                disabled={Number(data.file_page) >= Number(data.file_pages)}
                onClick={() => setFilePage(data.file_page + 1)}
              >
                下一页
              </button>
            </div>
          </Panel>

          <div style={{ height: 14 }} />

          <WmsPanel />

          <div style={{ height: 14 }} />

          <SourceArchives />

          <div style={{ height: 14 }} />

          <Panel
            title="未映射经销商"
            sub={`共 ${data.unmapped_count} 个，建议补全映射后单量分类才完整`}
            actions={
              canExportDealers && (
                <>
                  <button className="btn btn-sm" onClick={() => download("/api/export/unmapped-dealers.csv")}>
                    导出未映射 CSV
                  </button>
                  <label className="btn btn-sm" style={{ cursor: "pointer" }}>
                    批量导入更新
                    <input
                      type="file"
                      accept=".csv"
                      style={{ display: "none" }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file) void importDealers(file);
                      }}
                    />
                  </label>
                </>
              )
            }
            flush
          >
            {data.unmapped.length ? (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>经销商全称</th>
                      <th className="num">行数</th>
                      <th className="num">金额(万)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.unmapped.slice(0, 100).map((item) => (
                      <tr key={item.full_name}>
                        <td>{item.full_name}</td>
                        <td className="num">{item.lines}</td>
                        <td className="num">{item.amount === null ? "-" : num(item.amount, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty text="所有经销商都已映射" />
            )}
          </Panel>
        </>
      )}
    </>
  );
}
