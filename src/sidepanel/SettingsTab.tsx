import { useRef, useState } from "react";
import type { Team } from "./useTeam";
import { SETUP_SQL } from "./supabase";

interface Props {
  team: Team;
  continueOnFailure: boolean;
  onContinueChange: (on: boolean) => void;
  canExport: boolean;
  onExport: () => void;
  onImport: (file: File) => void;
}

/** Account, replay options, import/export, setup SQL. */
export function SettingsTab({
  team,
  continueOnFailure,
  onContinueChange,
  canExport,
  onExport,
  onImport,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="settings-tab">
      {team.enabled && (
        <section className="block">
          <h3>계정</h3>
          <Account team={team} />
        </section>
      )}

      <section className="block">
        <h3>실행 설정</h3>
        <label className="switch">
          <input
            type="checkbox"
            checked={continueOnFailure}
            onChange={(e) => onContinueChange(e.target.checked)}
          />
          실패해도 계속 실행
        </label>
        <p className="hint">
          켜면 실패한 단계가 있어도 끝까지 실행해 모든 실패를 한 번에 확인할 수
          있어요.
        </p>
      </section>

      <section className="block">
        <h3>내보내기 / 불러오기</h3>
        <div className="block-actions">
          <button className="btn sm" onClick={onExport} disabled={!canExport}>
            현재 시나리오 내보내기
          </button>
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            JSON 불러오기
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = "";
            }}
          />
        </div>
        <p className="hint">
          팀원이 만든 시나리오를 공유 권한이 있는 사람에게 보내는 통로예요. 불러온 시나리오는
          내 시나리오로 들어갑니다.
        </p>
      </section>

      {team.enabled && (
        <section className="block">
          <details className="sql-help">
            <summary>Supabase 설정 SQL (관리자가 최초 1회)</summary>
            <pre>{SETUP_SQL}</pre>
          </details>
        </section>
      )}
    </div>
  );
}

function Account({ team }: { team: Team }) {
  const [mail, setMail] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState("");

  const login = async () => {
    if (!mail.trim() || !password) {
      setMsg("이메일과 비밀번호를 입력하세요.");
      return;
    }
    setWorking(true);
    setMsg("로그인 중…");
    try {
      await team.signIn(mail.trim(), password);
      setMsg("로그인 성공. 편집·공유 탭이 켜졌어요.");
      setPassword("");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (team.email) {
    return (
      <div>
        <p className="modal-text">
          <b>{team.email}</b>
          <br />
          {team.isPublisher
            ? "공유 권한 있음 - 팀 시나리오와 버전을 편집하고 공유할 수 있어요."
            : "공유 권한 없음 - Supabase의 publishers 테이블에 이 이메일을 추가하세요."}
        </p>
        <button className="btn sm ghost danger" onClick={() => team.signOut()}>
          로그아웃
        </button>
      </div>
    );
  }
  return (
    <div className="login-form">
      <p className="modal-text">
        실행만 한다면 로그인이 필요 없어요. 팀 시나리오를 만들고 공유하는 사람만
        로그인합니다.
      </p>
      <label>이메일</label>
      <input
        type="email"
        autoComplete="username"
        value={mail}
        onChange={(e) => setMail(e.target.value)}
        placeholder="you@company.com"
      />
      <label>비밀번호</label>
      <input
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && login()}
      />
      {msg && <pre className="modal-msg">{msg}</pre>}
      <div className="block-actions">
        <button className="btn primary sm" disabled={working} onClick={login}>
          {working ? "확인 중…" : "공유 권한 로그인"}
        </button>
      </div>
    </div>
  );
}
