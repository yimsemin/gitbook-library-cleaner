# 개발과 유지보수

## 파일 구성

```
skill/                     배포 단위
  SKILL.md                 에이전트용 절차
  scripts/gblc.mjs         명령: login, scan, prepare, verify
  scripts/scan.mjs         검사 범위 수집
  scripts/lib.mjs          사용 여부 판정 (네트워크 없음)
  scripts/gitbook.mjs      GitBook CLI 조회
  scripts/login.mjs        브라우저 로그인
  scripts/browser-delete.js  브라우저에서 실행하는 삭제 스크립트
  test/lib.test.mjs        판정 로직과 삭제 스크립트 테스트
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

## 고장 났을 때

| 증상 | 확인할 곳 |
|---|---|
| `refused: open Library > Images first` | Images 목록이 열려 있는지, 검색창 선택자 |
| `timeout: row for …` | 목록 보기인지, 행 구조와 파일 ID 위치 |
| `timeout: Delete menu item`, `timeout: confirm dialog` | 메뉴와 확인 창의 문구·구조 (`browser-delete.js`) |
| `읽을 수 없는 페이지 형식`, `자동 생성 페이지` | `lib.mjs`의 `collectDocuments` |
| CLI 명령 실패 | `gitbook.mjs`, CLI 버전 |

## 코드를 고친 뒤

1. `skill` 폴더에서 `npm test`를 실행합니다.
2. 판정 로직이나 삭제 스크립트를 고쳤다면 `--batch 2`로 삭제와 검증을 다시 확인합니다.

`npm audit`은 GitBook CLI의 의존 패키지에 대한 취약점을 보고합니다. CLI 버전을 올릴 때 함께 확인합니다.
