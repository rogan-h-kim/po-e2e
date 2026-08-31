import { useState } from 'react';
import {
  type SupabaseConfig,
  DEFAULT_TABLE,
  saveConfig,
  clearConfig,
  testConnection,
  getEnvConfig,
  SETUP_SQL,
} from './supabase';

export interface SyncCounts {
  localOnly: number;
  dirty: number;
  synced: number;
  remoteNewer: number;
}

interface Props {
  config: SupabaseConfig | null;
  usingDefault: boolean;
  syncing: boolean;
  status: string;
  counts: SyncCounts;
  lastSyncedAt: number | null;
  viewer: boolean;
  onConfigChange: (cfg: SupabaseConfig | null, fromEnv: boolean) => void;
  onViewerChange: (on: boolean) => void;
  onPush: () => void;
  onPull: () => void;
  onSync: () => void;
}

export function SyncBar({
  config,
  usingDefault,
  syncing,
  status,
  counts,
  lastSyncedAt,
  viewer,
  onConfigChange,
  onViewerChange,
  onPush,
  onPull,
  onSync,
}: Props) {
  const [open, setOpen] = useState(false);
  const pending = counts.localOnly + counts.dirty + counts.remoteNewer;

  return (
    <div className="sync-bar">
      <div className="sync-row">
        <span className={`sync-dot ${config ? 'on' : 'off'}`} />
        <span className="sync-label">
          {config ? `팀 공유 연결됨${usingDefault ? ' (기본 설정)' : ''}` : '팀 공유 미설정'}
        </span>
        <button className="mini" title="Supabase 설정" onClick={() => setOpen(true)}>
          ⚙
        </button>
      </div>
      {config && !viewer && (
        <>
          <div className="sync-counts">
            {counts.synced > 0 && <span title="동기화됨">🟢 {counts.synced}</span>}
            {counts.dirty > 0 && <span title="변경됨 · 올리기 필요">🟡 {counts.dirty}</span>}
            {counts.localOnly > 0 && <span title="로컬 전용 · 미업로드">🔵 {counts.localOnly}</span>}
            {counts.remoteNewer > 0 && <span title="원격 최신 · 불러오기 필요">🟣 {counts.remoteNewer}</span>}
            {pending === 0 && counts.synced > 0 && <span className="all-synced">모두 동기화됨</span>}
          </div>
          <div className="sync-actions">
            <button className="small" disabled={syncing} onClick={onSync}>
              ⇅ 동기화{pending > 0 ? ` (${pending})` : ''}
            </button>
            <button className="small ghost" disabled={syncing} onClick={onPull}>
              ↓ 불러오기
            </button>
            <button className="small ghost" disabled={syncing} onClick={onPush}>
              ↑ 올리기
            </button>
          </div>
          {lastSyncedAt && (
            <div className="sync-time">마지막 동기화: {new Date(lastSyncedAt).toLocaleString('ko-KR')}</div>
          )}
        </>
      )}
      {status && <div className="sync-status">{status}</div>}

      {open && (
        <SettingsModal
          config={config}
          viewer={viewer}
          onClose={() => setOpen(false)}
          onSaved={onConfigChange}
          onViewerChange={onViewerChange}
        />
      )}
    </div>
  );
}

function SettingsModal({
  config,
  viewer,
  onClose,
  onSaved,
  onViewerChange,
}: {
  config: SupabaseConfig | null;
  viewer: boolean;
  onClose: () => void;
  onSaved: (cfg: SupabaseConfig | null, fromEnv: boolean) => void;
  onViewerChange: (on: boolean) => void;
}) {
  const [url, setUrl] = useState(config?.url ?? '');
  const [anonKey, setAnonKey] = useState(config?.anonKey ?? '');
  const [table, setTable] = useState(config?.table ?? DEFAULT_TABLE);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState('');

  const save = async () => {
    const cfg: SupabaseConfig = { url: url.trim(), anonKey: anonKey.trim(), table: table.trim() || DEFAULT_TABLE };
    if (!cfg.url || !cfg.anonKey) {
      setMsg('URL과 anon key를 모두 입력하세요.');
      return;
    }
    setTesting(true);
    setMsg('연결 확인 중…');
    try {
      await testConnection(cfg);
      await saveConfig(cfg);
      onSaved(cfg, false);
      setMsg('연결 성공! 저장했어요.');
      setTimeout(onClose, 700);
    } catch (e) {
      setMsg(`연결 실패: ${(e as Error).message}\n아래 SQL로 테이블을 먼저 만들었는지 확인하세요.`);
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    // Remove this browser's override → fall back to the build-time default.
    await clearConfig();
    const env = getEnvConfig();
    onSaved(env, !!env);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>표시 설정</h2>
        <label className="viewer-toggle">
          <input
            type="checkbox"
            checked={viewer}
            onChange={(e) => onViewerChange(e.target.checked)}
          />
          <span>
            실행 전용 모드
            <small>
              녹화·편집·삭제·추가 버튼을 숨기고 재생만 가능하게 합니다. 배포용 브라우저에서 켜세요.
            </small>
          </span>
        </label>

        <h2>Supabase 팀 공유 설정</h2>
        <label>Project URL</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.supabase.co" />
        <label>anon public key</label>
        <input value={anonKey} onChange={(e) => setAnonKey(e.target.value)} placeholder="eyJhbGciOi..." />
        <label>테이블 이름</label>
        <input value={table} onChange={(e) => setTable(e.target.value)} placeholder={DEFAULT_TABLE} />

        {msg && <pre className="modal-msg">{msg}</pre>}

        <div className="modal-actions">
          <button className="primary" disabled={testing} onClick={save}>
            {testing ? '확인 중…' : '연결 & 저장'}
          </button>
          {config && (
            <button className="ghost danger" onClick={disconnect}>
              연결 해제
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            닫기
          </button>
        </div>

        <details className="sql-help">
          <summary>처음이면 이 SQL을 Supabase에서 한 번 실행하세요</summary>
          <pre>{SETUP_SQL}</pre>
        </details>
      </div>
    </div>
  );
}
