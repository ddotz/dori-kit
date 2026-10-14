# dori-kit

Dori 모드([omo-dori-mode-experimental](https://github.com/sisyphuslabs/omo-dori-mode-experimental)) 위에 얹는 "상시 디스코드 비서" 확장팩. 디스코드 리스너, herdr 탭 감시, Gmail/캘린더 감시(zele), 세션 자동 복구(session-doctor), 야간 정리, 사용량 가드, 백업 스크립트와 그 운용 규칙(skill)을 묶었다. macOS + launchd 기준.

## 설치

```sh
git clone <this repo> ~/Code/dori-kit
~/Code/dori-kit/install.sh                          # 대화형
~/Code/dori-kit/install.sh --answers answers.json   # 비대화형 (형식: skills/dori-kit/scripts/SETUP.md)
```

`install.sh`가 하는 일:
1. bun, git 확인
2. `~/.dori/src`가 없으면 Dori 베이스를 커밋 `40034ad`로 clone (`DORI_KIT_SKIP_DORI=1`이면 건너뜀)
3. `skills/dori-kit`을 `${SKILLS_DIR:-~/.agents/skills}/dori-kit`으로 링크
4. `setup.ts` 실행: 공유 스크립트를 `~/.<layer>`로 복사, `config.json` / `identity/IDENTITY.md` 생성, `~/Library/LaunchAgents/dev.<layer>.*.plist` 생성 (`--load`를 줄 때만 launchctl로 로드)

설치 후 출력되는 다음 단계(봇 토큰 등록, 서비스 로드)를 따르고, 에이전트 작업 폴더에서 `Dori mode`라고 말하면 된다. 개인 규칙(프로젝트 채널, 사람 등)은 `~/.<layer>/ext/SKILL.md`에 따로 둔다.

## 구성

```
install.sh
VERSION
skills/dori-kit/
  SKILL.md            Dori SKILL.md 다음에 읽는 확장 규칙 (값은 config.json / identity에서)
  scripts/            ~/.<layer>로 복사되는 공유 스크립트 + setup.ts, config.example.json, identity 템플릿
    MANIFEST.md       포함 파일 목록 (setup.ts가 읽음)
```

## 버전

`VERSION` 참고. 변경은 관리자의 라이브 레이어에서 먼저 시험한 뒤 이 저장소로 옮겨진다.
