# GitBook 미사용 이미지 정리

GitBook 스페이스의 Library에서 **어디에서도 참조하지 않는 이미지**를 찾아 목록과 용량을 보여주고, 승인받은 파일만 Change Request 안에서 삭제한 뒤 검증하는 에이전트 스킬입니다. 병합은 사용자가 직접 합니다.

GitBook에는 미사용 파일을 자동으로 정리하는 기능이 확인되지 않고, 공식 API에는 파일 삭제 기능이 없습니다. 그래서 **조회는 공식 CLI**, **삭제는 로그인된 브라우저 화면**에서 합니다.

## 사용 방법

에이전트에게 다음처럼 요청합니다.

> GitBook 미사용 이미지 정리해줘. 스페이스는 `https://app.gitbook.com/o/…/s/…/`, 삭제는 Change Request #12에서 하고 병합은 하지 마.

## 누가 무엇을 하는가

| 단계 | 사용자 | 에이전트 | 코드 | GitBook 변경 |
|---|---|---|---|---|
| 0. 준비 (최초 1회) | 로그인 화면에서 승인 | 설치와 로그인 명령 실행 | `login`: CLI 로그인 | 없음 |
| 1. 요청 | 스페이스 주소와 Change Request 번호 전달 | 요청 해석 | – | 없음 |
| 2. 검사 (Dry run) | 기다림 | `scan` 실행 | 전체 원문을 읽고 파일별 사용 여부 판정, 목록·용량·승인 ID 출력 | 없음 |
| 3. 승인 | **삭제 목록을 확인하고 승인** | 개수·용량·목록 파일·한계 안내 | – | 없음 |
| 4. 삭제 직전 재검사 (첫 묶음) | – | `prepare` 실행 | 전체를 다시 검사, 새 참조가 생겼으면 중단, 이번 묶음의 삭제 스크립트 생성 | 없음 |
| 5. 삭제 | 해당 Change Request를 편집하지 않고 기다림 | 브라우저에서 Library > Images를 열고 스크립트 실행 (첫 묶음 `delete.js`, 이후 `next.js`) | `browser-delete.js`: 파일 ID가 일치하는 항목만 하나씩 삭제 | **Change Request만** |
| 6. 검증과 다음 준비 | – | `verify --next` 실행 | 삭제 반영, 대상 밖 삭제, 깨진 참조, 본문 변경 여부 확인. 통과하면 같은 검사 결과로 다음 묶음 생성 | 없음 |
| 7. 반복 | – | 남은 파일이 없을 때까지 5–6단계 반복 | – | Change Request만 |
| 8. 병합 | **Changes 화면에서 검토하고 직접 병합** | 결과 보고 | – | 병합하면 게시본에 반영 |

```
사용자 ──요청──▶ 에이전트
                  │ scan      ──▶ [GitBook CLI: 조회] ──▶ report.json, candidates.tsv
사용자 ──승인──▶ │
                  │ prepare   ──▶ [재검사] ──▶ delete.js, next.js, pending.json
                  │ 삭제 실행 ──▶ [로그인된 브라우저: Change Request의 Library]
                  │ verify    ──▶ [GitBook CLI: 조회] ──▶ 통과(다음 묶음 생성, 삭제 반복) / 실패(중단)
사용자 ──검토·병합
```

에이전트의 대화에는 요약만 들어갑니다. 페이지 본문과 전체 파일 목록은 코드가 처리해 사용량을 줄입니다.

## 필요한 것

- Node.js 22 이상
- 로컬 명령을 실행하고, 브라우저에서 JavaScript를 실행할 수 있는 에이전트
- GitBook에 로그인한 브라우저 (화면 언어 영어, Library는 목록 보기)
- 대상 스페이스의 편집 권한
- 삭제 작업을 담을 초안 또는 열린 Change Request

## 설치

`skill` 폴더가 배포 단위입니다. 에이전트의 스킬 폴더에 `gitbook-library-cleaner`라는 이름으로 복사합니다. `node_modules`와 `gblc-reports`는 복사하지 않습니다.

| 에이전트 | 일반적인 스킬 폴더 |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.agents/skills/` |

그다음 에이전트에게 [SKILL.md](skill/SKILL.md)의 "준비" 단계를 실행해 달라고 합니다.

### 로그인 권한

| 방식 | 방법 | 저장되는 권한 |
|---|---|---|
| 브라우저 승인 | `node scripts/gblc.mjs login` | 콘텐츠 쓰기, 병합, 게시, 구성원·권한 변경까지 포함 |
| 읽기 전용 토큰 | [개발자 설정](https://app.gitbook.com/account/developer)에서 `Read only` 토큰을 만든 뒤 `node node_modules/@gitbook/cli/cli.js auth` | 조회만 가능. 다른 사람에게 배포할 때 권장 |

이 도구의 코드는 두 방식 모두에서 조회 명령만 실행합니다. 로그인 정보는 GitBook CLI가 사용자 컴퓨터에 보관하며, `node node_modules/@gitbook/cli/cli.js logout`으로 지웁니다. 토큰은 대화에 붙여 넣지 않습니다.

Windows에서 브라우저 승인을 하면 `client_id` 오류 탭이 함께 열릴 수 있습니다. 그 탭은 닫고 다른 탭에서 승인합니다.

## 판정 기준

검사하는 곳:

- 대상 스페이스의 본문(숨김 페이지, 운영 문서 포함), 페이지 설정과 표지, 재사용 콘텐츠
- 병합되지 않은 모든 Change Request(초안, 열림, 보관)
- 같은 조직의 다른 스페이스와 그 Change Request
- 조직의 사이트 설정(로고, 파비콘 등)

| 판정 | 조건 | 삭제 |
|---|---|---|
| 사용 중 | 파일 ID 또는 업로드 주소가 원문 어디에든 있음 | 안 함 |
| 불확실 | 업로드 주소를 알 수 없음 | 안 함 |
| 이미지 아님 | 이미지 형식이 아님 | 안 함 |
| 삭제 후보 | 위에 해당하지 않는 이미지 | 승인 후 |

파일은 이름이 아니라 고유 ID로 식별합니다. 이름이 같은 파일이 여러 개여도 각각 판정합니다.

본문이 아직 쓰는 이미지는, Change Request에서 다른 이미지로 교체했더라도 "사용 중"입니다. 병합한 뒤 다시 검사하면 후보가 됩니다.

## 안전장치

- `scan`은 항상 Dry run이며, 코드의 GitBook 조회는 읽기 전용입니다.
- 하나라도 읽지 못했거나, 읽을 수 없는 형식(자동 생성 페이지 등)이 있거나, 검사 중 내용이 바뀌면 삭제 준비를 거부합니다.
- 승인 ID는 스페이스, Change Request, 삭제 목록이 같을 때만 일치합니다.
- 모든 묶음은 삭제 직전의 전체 검사를 기준으로 만듭니다(첫 묶음은 `prepare`, 이후는 `verify --next`). 승인한 파일 중 하나라도 새 참조가 생기면 중단합니다.
- 브라우저 스크립트는 지정한 Change Request 화면에서만 시작하고, 파일 ID·행·확인 창이 예상과 다르면 즉시 멈춥니다.
- 병합 기능은 코드에 없습니다.

## 한계

- GitBook 밖(외부 웹페이지, 메일 등)에서 이미지 주소를 직접 쓰는 경우는 알 수 없습니다.
- 로그인 계정이 볼 수 없는 스페이스와 다른 조직의 참조는 검사하지 못합니다.
- 병합이 끝난 과거 버전에서만 쓰던 이미지는 후보가 됩니다.
- 방금 올려 아직 페이지에 넣지 않은 이미지도 후보가 됩니다. 편집이 끝난 뒤 검사합니다.
- 재검사와 삭제 사이에 누가 참조를 추가하면 삭제 전에 알 수 없고, `verify`에서 발견합니다.
- 삭제는 GitBook 화면 구조에 의존합니다. 화면이 바뀌면 스크립트가 멈추며 수정이 필요합니다.
- 삭제 확인 창은 파일 내용이 버전 기록에 남는다고 안내합니다. 복구 절차는 시험하지 않았습니다.

## 검증 상태

| 항목 | 상태 |
|---|---|
| Windows + Claude Code + Chrome: 로그인, 검사, 재검사, 삭제, 검증 | 실제 스페이스에서 확인 |
| 20개 묶음 연속 삭제와 묶음별 검증 (파일 130여 개) | 확인. 브라우저 삭제는 파일당 약 4초 |
| 전체 검사 1회 (대상 스페이스 문서 약 120개, 다른 스페이스 4개) | 약 25초 |
| `verify --next`로 다음 묶음 생성 | 삭제 없이 확인. `--next`로 이어가는 연속 삭제는 미확인 |
| `next.js`로 실제 파일 삭제 | 미확인 |
| 판정 로직 단위 테스트 | `npm test` |
| 병합 후 게시본 | 미확인 |
| Codex, ChatGPT Work, macOS, Linux | 미확인 |
| 읽기 전용 토큰으로 검사 | 미확인 |

## 파일 구성

```
skill/
  SKILL.md                 에이전트용 절차
  scripts/gblc.mjs         명령: login, scan, prepare, verify
  scripts/scan.mjs         검사 범위 수집
  scripts/lib.mjs          사용 여부 판정 (네트워크 없음)
  scripts/gitbook.mjs      GitBook CLI 조회
  scripts/login.mjs        브라우저 로그인
  scripts/browser-delete.js  브라우저에서 실행하는 삭제 스크립트
  test/lib.test.mjs        판정 로직 테스트
  package.json             GitBook CLI 버전 고정
  .npmrc                   설치 스크립트 실행 차단
```

검사 결과는 명령을 실행한 위치의 `gblc-reports/<시각>/`에 저장됩니다.

| 파일 | 내용 |
|---|---|
| `candidates.tsv` | 삭제 후보의 ID, 이름, 용량 |
| `report.json` | 모든 파일의 판정과 참조 위치, 검사 범위, 승인 ID |
| `delete.js` | 삭제 함수를 페이지에 올리고 이번 묶음을 실행하는 스크립트 |
| `next.js` | 같은 페이지에서 이번 묶음만 실행하는 짧은 스크립트 |
| `pending.json` | 이번 묶음의 검증 기준 |

## 유지보수

| 증상 | 확인할 곳 |
|---|---|
| `refused: open Library > Images first` | Images 목록이 열려 있는지, 검색창 선택자 |
| `timeout: row for …` | 목록 보기인지, 행 구조와 파일 ID 위치 |
| `timeout: Delete menu item`, `confirm dialog` | 메뉴와 확인 창의 문구·구조 (`browser-delete.js`) |
| `unsupported page type`, `computed page` | `lib.mjs`의 `collectDocuments` |
| CLI 명령 실패 | `gitbook.mjs`, CLI 버전 |

코드를 고친 뒤 `skill` 폴더에서 `npm test`를 실행하고, `--batch 2`로 삭제와 검증을 다시 확인합니다. `npm audit`은 GitBook CLI의 의존 패키지에 대한 취약점을 보고합니다. CLI 버전을 올릴 때 함께 확인합니다.

## 라이선스

[MIT](LICENSE)
