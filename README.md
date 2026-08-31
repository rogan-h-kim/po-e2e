# 🍰 Po-Cake

배포된 사이트를 **코드 수정 없이** 테스트하는 노코드 E2E 레코더 크롬 익스텐션.
토스 발표의 *Cake* 컨셉을 참고해, **접근성(role/name) 기반 셀렉터 + CDP 신뢰 이벤트 재생**으로 정확도를 우선한 구현입니다.

## 설계 요약


| 레이어                    | 역할                                              | 정확도 포인트                            |
| ---------------------- | ----------------------------------------------- | ---------------------------------- |
| **Side Panel (React)** | 녹화/재생/스텝 관리 UI                                  | —                                  |
| **Content Script**     | 요소 선택·하이라이트, 접근성 셀렉터 생성, 녹화(엿듣기), 위치 탐색         | ① 요소 선택 정확도 (role/name 우선, 유일성 검증) |
| **Background + CDP**   | `chrome.debugger`로 **신뢰(trusted) 마우스/키 이벤트** 재생 | ② 동작 재현 정확도                        |


셀렉터 우선순위: `testid` → `role+name` → `text` → `css`(경고).
동일 요소가 여러 개면 `nth`로 특정하고 경고를 표시합니다. (Cake의 "홈페이지 바로가기 2개" 케이스 대응)

## 개발 / 빌드

```bash
npm install
npm run build      # tsc 타입체크 + eslint + vite 빌드 → dist/
npm run dev        # HMR 개발 모드 (crxjs)
npm run lint       # eslint 만 실행
```



## 크롬에 설치 (Load unpacked)

1. `npm run build` 실행 → `dist/` 생성
2. 크롬에서 `chrome://extensions` 열기
3. 우측 상단 **개발자 모드** 켜기
4. **압축해제된 확장 프로그램을 로드합니다** → `dist/` 폴더 선택
5. 툴바의 Po-Cake 아이콘 클릭 → **사이드 패널** 열림



## 사용법

- **＋ 요소 선택**: 페이지 요소에 마우스를 올리면 하이라이트, 클릭하면 선택 →
`클릭 / 입력 / 옵션 선택 / 보임 검증 / 텍스트 검증` 중 골라 단계 추가
- **● 녹화 시작**: 실제로 클릭·입력·드롭다운 선택·Enter/Esc/Tab 키를 누르면 단계가 자동으로 쌓임.
  빈 시나리오에서 시작하면 현재 페이지 URL이 첫 단계(**페이지 이동**)로 자동 추가되어, 누가 어디서 재생하든 같은 페이지에서 시작합니다
- **＋ 페이지 이동 / ＋ 키 입력 / ＋ 대기 / ＋ URL 검증**: URL 이동, 단일 키 입력(Enter·Escape·Tab·Backspace·화살표), 대기(ms), 현재 URL 검증 단계를 직접 추가
- **검증 종류**: 보임 · 텍스트 나타남(아무 글자) · 텍스트 포함/일치 · 입력값 일치 · URL 포함/일치. 모든 검증은 최대 8초 동안 조건이 맞을 때까지 기다린 뒤 판정합니다
- 각 단계의 `✎`(편집)로 입력값·URL·키·대기시간·설명을 고치고 `↑ ↓`로 순서를 바꿀 수 있음
- **▶ 전체 재생**: 저장된 단계를 현재 탭에서 신뢰 이벤트로 재생. 실행 중인 단계가 파란색으로 표시되고, 단계별 소요 시간이 함께 기록됨
  - 실패한 단계에는 **실패 시점 스크린샷**이 붙고, **실패 시 계속** 체크박스를 켜면 첫 실패에서 멈추지 않고 끝까지 실행해 모든 실패를 한 번에 확인
  - 단계 목록 아래 **실행 기록**에서 최근 10회 결과를 다시 볼 수 있음 (이 브라우저에만 저장, 팀 공유되지 않음)
- 각 단계의 `🔎`(화면에서 강조) / `▶`(단건 실행) / `✎`(편집·순서) / `✕`(삭제)
- **내보내기 / 불러오기**: 시나리오를 JSON으로 저장·복원 (자동으로도 `storage.local`에 저장됨)

> 재생 시 크롬 상단에 *"Po-Cake이 이 브라우저를 디버깅하고 있습니다"* 배너가 뜹니다.
> 이는 `chrome.debugger`(CDP)로 **진짜 유저와 구분되지 않는 신뢰 이벤트**를 쏘기 때문이며, 정확도를 위한 의도된 동작입니다.



## 여러 시나리오 관리

- 상단 **시나리오 선택 바**에서 드롭다운으로 시나리오 전환
- `＋`(새로), `✎`(이름변경), `⧉`(복제), `🗑`(삭제)
- 모든 시나리오는 자동으로 `chrome.storage.local`에 저장 (오프라인 유지)
- 기존 단일 시나리오 데이터는 처음 실행 시 "기본 시나리오"로 자동 이전됨



## 팀 공유 (Supabase)

여러 사람이 같은 시나리오를 주고받으려면 Supabase를 연결합니다.

**1) Supabase 프로젝트 준비 (최초 1회)**

1. [https://supabase.com](https://supabase.com) 에서 프로젝트 생성
2. **SQL Editor**에서 아래 SQL 실행 (사이드 패널 ⚙ 설정 모달 하단에도 동일 SQL이 있음)

```sql
create table if not exists scenarios (
  id text primary key,
  name text not null,
  steps jsonb not null default '[]',
  created_at bigint not null,
  updated_at bigint not null
);
alter table scenarios enable row level security;
create policy "po_cake_anon_all" on scenarios for all using (true) with check (true);
```

1. **Project Settings → API**에서 `Project URL`과 `anon public` 키 복사

**2) 익스텐션에 연결 — 두 가지 방법**

**(A) 빌드에 기본 설정 심기 (배포용 · 추천)**
동료들이 아무 입력 없이 설치만 하면 쓰게 하려면, 빌드 전에 `.env`를 채웁니다.

```bash
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
# .env 를 열어 값 입력
#   VITE_SUPABASE_URL=https://xxxx.supabase.co
#   VITE_SUPABASE_ANON_KEY=eyJhbGci...
#   VITE_SUPABASE_TABLE=scenarios
npm run build
```

→ `dist/`에 설정이 포함된 채로 빌드됩니다. 이걸 배포하면 동료는 설치 즉시 "팀 공유 연결됨 (기본 설정)" 상태가 됩니다.

**(B) 각자 ⚙에서 입력 (개인 override)**

- 사이드 패널의 **⚙** 클릭 → URL / anon key / 테이블명 입력 → **연결 & 저장**
- 이 값은 그 브라우저의 `storage.local`에만 저장되며, **(A)의 기본값을 덮어씁니다.**
- **연결 해제**를 누르면 다시 (A)의 기본값으로 돌아갑니다.

> anon key는 공개 키라 배포본에 포함돼도 안전한 설계지만, 접근 통제는 RLS가 합니다.
> `.env`는 `.gitignore`에 있어 git에 올라가지 않습니다.

**3) 동기화**

- **⇅ 동기화**: 원격과 로컬을 `updatedAt` 기준으로 병합(최신 우선) 후 양방향 반영
- **↓ 불러오기**: 원격 → 로컬 병합만
- **↑ 올리기**: 로컬 → 원격 업로드만

> ⚠️ 보안: 위 정책은 anon 키에 전체 접근을 허용하는 **내부 팀용** 설정입니다.
> 외부 노출 환경이라면 Supabase Auth + 사용자별 RLS 정책으로 강화하세요.



## 배포 — 크롬 웹스토어 미등록(Unlisted)

검색에는 안 뜨고 **링크 아는 사람만** 설치하는 방식. 자동 업데이트됨.

1. **설정 심어 빌드**: 위 (A)대로 `.env` 채우고 `npm run build`
2. **dist 압축** (PowerShell):
  ```powershell
   Compress-Archive -Path dist\* -DestinationPath po-cake.zip -Force
  ```
3. **개발자 등록**: [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)에서
  개발자 계정 등록(최초 1회 $5) → **새 항목** → `po-cake.zip` 업로드
4. 스토어 등록정보(아이콘·설명·스크린샷) 작성
5. **공개 범위(Visibility)** → **미등록(Unlisted)** 선택 → 제출 → 검토 후 게시
6. 게시되면 나오는 **설치 링크를 팀에 공유** → 동료는 링크 → "Chrome에 추가"로 설치

> 링크만 있으면 누구나 설치 가능합니다(검색에는 안 뜸). 계정 제한이 필요하면
> 공개 범위를 **비공개(Private)** 로 두고 테스터 이메일을 등록하세요.



## 폴더 구조

```
src/
  shared/      types.ts (Step/Selector/Scenario 모델), messages.ts (메시지 프로토콜)
               scenarios.ts (로컬 다중 시나리오 저장 + 병합)
  content/     selector.ts (접근성 role/name·셀렉터 생성·탐색), index.ts (선택/녹화/위치)
  background/  index.ts (CDP 재생 엔진 + 명령 라우팅 + content 자동 주입)
  sidepanel/   App.tsx (메인), ScenarioBar.tsx (시나리오 관리),
               SyncBar.tsx (Supabase 동기화 + 설정 모달), supabase.ts (원격 CRUD),
               StepRow.tsx, styles.css, main.tsx
manifest.config.ts, vite.config.ts, index.html
```



## 완료된 것

- ✅ 접근성 기반 셀렉터 + CDP 신뢰 이벤트 재생
- ✅ 요소 선택 / 녹화 / 재생
- ✅ 여러 시나리오 이름 붙여 관리
- ✅ Supabase 팀 공유(동기화)



## 아직 안 만든 것 (다음 단계 후보)

- 모델 기반 분기(시나리오 조합 → 상태 머신)
- 헤드리스(Puppeteer) 실행 + 리포트
- Supabase Auth 기반 사용자별 권한(RLS 강화)
- 줌 배율 보정, 다중 프레임(iframe) 지원
- ARIA accessible-name 알고리즘 완전판

