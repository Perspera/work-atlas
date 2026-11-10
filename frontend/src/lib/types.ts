/** 接口返回结构：与后端 api/core_mixin.py 的字段保持一致。 */

export interface Me {
  setup: boolean;
  authenticated: boolean;
  site_title?: string;
  user?: {
    id: number;
    username: string;
    display_name: string;
    must_change_pwd: boolean;
  };
  permissions?: string[];
  scopes?: Record<string, unknown>;
  is_admin?: boolean;
  unread_alerts?: number;
}

export interface BizDate {
  biz_date: string;
  is_today?: boolean;
  waves?: number;
  archived?: boolean;
  data_lines?: number;
}

export interface Meta {
  site_title: string;
  version: number;
  biz_dates: BizDate[];
  default_biz_date: string;
  today: string;
  cutoff: string;
  last_scan: string;
  source_dirs: string[];
  files: number;
  scan_sec: number;
  data_range: { min: string | null; max: string | null; days: number };
  archived_dates: string[];
  permissions: string[];
}

export interface Series {
  name: string;
  values: number[];
}

export interface VolumeBreakdown {
  label: string;
  lines: number;
  groups: number;
  amount: number;
  prev_lines: number;
  prev_amount: number;
  yoy_lines: number;
  yoy_amount: number;
}

export interface VolumePeriodData {
  range: {
    period: string;
    start: string;
    end: string;
    prev_start: string;
    prev_end: string;
    yoy_start: string;
    yoy_end: string;
  };
  totals: { lines: number; groups: number; amount: number | null };
  prev: { lines: number; groups: number; amount: number | null };
  yoy: { lines: number; groups: number; amount: number | null };
  breakdowns: Record<string, VolumeBreakdown[]>;
  detail: {
    group_no: string;
    wave_no: string | null;
    dealer: string | null;
    route: string | null;
    zone: string | null;
    region: string | null;
    doc_type: string | null;
    lines: number;
    amount: number | null;
  }[];
  with_amount: boolean;
}
