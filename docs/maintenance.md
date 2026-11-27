# 개발과 유지보수

## 파일 구성

```
skill/                     배포 단위
  SKILL.md                 에이전트용 절차
  scripts/gblc.mjs         명령: login, scan, prepare, verify
  scripts/scan.mjs         검사 범위 수집
  scripts/lib.mjs          사용 여부 판정 (네트워크 없음)
  scripts/gitbook.mjs      GitBook API 조회 (재시도, 호출 제한)
  scripts/capture-auth.mjs CLI 프로세스에서 로그인 인증 값을 넘겨받음
  scripts/login.mjs        브라우저 로그인
  scripts/browser-delete.js  브라우저에서 실행하는 삭제 스크립트
  test/lib.test.mjs        판정 로직과 삭제 스크립트 테스트
  test/gitbook.test.mjs    조회, 로그인 재사용, 검사 중단 조건 테스트
  package.json             GitBook CLI 버전 고정
  .npmrc                   설치 스크립트 실행 차단
```

## 조회 방식

- 로그인: 실행마다 CLI의 `whoami`를 한 번 실행합니다. CLI가 필요하면 로그인을 갱신하고, `capture-auth.mjs`가 CLI의 API 요청에서 인증 값을 IPC로 넘깁니다. 인증 값은 메모리에만 둡니다. `whoami`에서 인증 값을 받지 못하면 3번까지 시도합니다. 조회 응답이 401이면 `whoami`를 한 번 더 실행합니다. 저장된 로그인이 없거나 다시 받은 인증도 401이면 종료 코드 3으로 끝납니다. Windows의 패키지 앱에서 실행한 로그인은 `%LOCALAPPDATA%\Packages\<앱>\LocalCache\Roaming`에 저장되어 다른 앱에서 보이지 않을 수 있습니다.
- 조회: 한 프로세스에서 API를 직접 호출하며 동시에 10개까지 보냅니다. 연결 실패, 429, 5xx는 3번까지 시도하고, 호출 제한이 60초보다 늦게 풀리면 바로 실패합니다. 하나라도 최종 실패하면 검사를 중단합니다.
- 호출 한도: 삭제 묶음을 만들기 전에 응답 헤더의 남은 호출이 다음 검증의 어림값(`verifyQuota`)보다 적으면 묶음을 만들지 않습니다.
- 문서는 한 번의 검사 안에서만 중복을 없애고, 실행 사이에는 저장해 두지 않습니다. 공식 명세에서 문서 ID의 내용이 바뀌지 않는다는 보장을 확인하지 못했습니다.

## 검사 결과 파일

검사 결과는 명령을 실행한 위치의 `gblc-reports/<시각>/`에 저장됩니다.

| 파일 | 내용 |
|---|---|
| `candidates.tsv` | 삭제 후보의 ID, 이름, 용량 |
| `report.json` | 모든 파일의 판정과 참조 위치, 검사 범위, 승인 ID |
| `delete.js` | 삭제 함수를 페이지에 올리고 이번 묶음을 실행하는 스크립트 |
| `next.js` | 같은 페이지에서 이번 묶음만 실행하는 짧은 스크립트 |
| `pending.json` | 이번 묶음의 검증 기준 |

## 고장 났을 때

| 증상 | 확인할 곳 |
|---|---|
| `refused: open Library > Images first` | Images 목록이 열려 있는지, 검색창 선택자 |
| `timeout: row for …` | 목록 보기인지, 행 구조와 파일 ID 위치 |
| `timeout: Delete menu item`, `timeout: confirm dialog` | 메뉴와 확인 창의 문구·구조 (`browser-delete.js`) |
| `읽을 수 없는 페이지 형식`, `자동 생성 페이지` | `lib.mjs`의 `collectDocuments` |
| `로그인 필요` (종료 코드 3) | 같은 환경에서 `login` 실행 |
| `GitBook 로그인 확인 실패` | 표시된 CLI 오류, 샌드박스 권한. CLI 버전을 올렸다면 `capture-auth.mjs`와 `whoami` 동작 |
| `GitBook 조회 실패` | 표시된 상태 코드와 경로, `gitbook.mjs` |
| `삭제 묶음을 만들지 않았습니다` | 안내된 시각 뒤에 `prepare` |

## 코드를 고친 뒤

1. `skill` 폴더에서 `npm test`를 실행합니다.
2. 판정 로직이나 삭제 스크립트를 고쳤다면 `--batch 2`로 삭제와 검증을 다시 확인합니다.

실제 스페이스에서 확인하지 않은 동작: 50개 묶음 삭제, Codex에서 `next.js`로 이어서 삭제, 병합 후 게시본, 호출 제한 응답 처리, 읽기 전용 토큰 검사, macOS·Linux. 확인하면 이 목록에서 지우고 README의 관련 문구를 고칩니다.

CLI 버전을 올리면 `npm test`가 저장된 로그인의 갱신과 재사용을 임시 설정 폴더와 로컬 서버로 확인합니다.

## 의존 패키지의 취약점

직접 의존성은 `@gitbook/cli` 하나이며, 취약점 알림은 CLI가 끌어오는 패키지에서 나옵니다. CLI 버전을 올릴 때 `npm audit`과 아래 표를 함께 확인합니다. `package.json`의 `overrides`는 CLI(의 `miniflare`)가 수정된 버전을 스스로 요구하게 되면 지웁니다.

| 패키지 | 처리 |
|---|---|
| `undici`, `sharp` | `overrides`로 같은 호환 범위의 수정 버전을 씁니다. CLI는 시작할 때 `undici`를 읽으며, CLI의 API 요청도 이 패키지를 거칠 수 있습니다 |
| `esbuild` | 그대로 둡니다. 수정 버전이 CLI의 허용 범위 밖이고, 알림 대상인 개발 서버(CLI의 `dev`)는 이 도구가 실행하지 않습니다 |
| `zod` | 그대로 둡니다. 수정 버전이 다음 메이저이고, CLI는 설치된 패키지가 아니라 번들에 포함한 사본을 써서 올려도 실행 코드가 바뀌지 않습니다. 번들 사본이 알림의 영향을 받는지는 확인하지 않았습니다 |
