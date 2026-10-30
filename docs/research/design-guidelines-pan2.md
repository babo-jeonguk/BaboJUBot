# 판 2 화면 설계 지침 조사: Apple HIG, Samsung One UI, Material 3, SEED, 토스

확인일: 2026-10-30. 질문은 하나다. **판 2([#91](https://github.com/babo-jeonguk/BaboJUBot/issues/91))에서 바뀌는 여덟 화면(A~H)을 다섯 디자인 가이드에 어긋나지 않게 만들면서 "화면에 설명문·경고문을 적지 않는다"는 사용자 원칙도 지키려면 어떤 패턴을 써야 하는가?**

- 대상 화면: A 전역 설정, B 새 연구 조직 창, C 에이전트 상세·설정, D 승인 상세(초기 연구 승인·`작업자 추가`), E 조직 설정, F Lead 대화 입력창의 전달 방식, G 실행 시도 상세의 사용량, H 조직 폴더에서 등록한 산출물 목록·단건. 화면 요구는 #91의 "대시보드" 절과 [기능 범위](../features.md)의 화면 지도를 따른다.
- 사용자 원칙(#91 "화면 원칙", 2026-10-30 결정): 화면에 설명문·경고문을 따로 적지 않는다. 상태는 상태 값과 컨트롤로 보이고, 쓸 수 없는 선택지는 내지 않는다.
- 근거 표기:
  - **[문서]** 가이드 원문을 직접 읽었다.
  - **[추론]** 원문들을 BaboJUBot 화면에 맞춰 해석·종합했다.
  - **[미확인]** 열지 못했거나 그림이라 읽지 못했다.
- 용어는 [공통 용어](../../GLOSSARY.md)를 따른다. 컴포넌트 이름은 각 가이드의 원래 이름(예: SEED `Badge`, Apple `Pop-up button`)을 그대로 쓴다.

## 출처

| 가이드 | 주소 | 확인일 | 읽은 범위 | 읽은 방식 |
|---|---|---|---|---|
| Apple Human Interface Guidelines | [developer.apple.com/design/human-interface-guidelines](https://developer.apple.com/design/human-interface-guidelines) | 2026-10-30 | Menus, Context menus, The menu bar, Pop-up buttons, Pickers, Toggles, Steppers, Segmented controls, Text fields, Entering data, Feedback, Alerts, Sheets, Settings, Writing, Labels, Lists and tables, Progress indicators, Accessibility, Color | 페이지마다 사이트가 쓰는 본문 데이터(`developer.apple.com/tutorials/data/design/human-interface-guidelines/<page>.json`)를 받아 글만 읽었다. 페이지별 마지막 변경 기록: Menus 2026-06-08, Sheets 2026-03-24, Writing 2025-12-16, Context menus 2023-12-05 등 |
| Samsung One UI | [developer.samsung.com/one-ui](https://developer.samsung.com/one-ui) | 2026-10-30 | Components(Buttons, Dialog, Lists, Toasts, Bottom bar), Writing 세 쪽(Focused and purposeful, Simple and human, Empowering and engaging), Accessibility(Color and contrast, Interaction and control, Content), Basic structure | 공개 HTML. 공개 가이드에는 Switch·Select·Badge·Text field 쪽이 없고, 컴포넌트 쪽은 "Find out more on … Material design"으로 Material에 넘긴다 |
| Google Material Design 3 | [m3.material.io](https://m3.material.io) | 2026-10-30 | Components: Menus, Switch, Text fields, Segmented buttons, Chips, Badges, Lists, Dialogs, Snackbar, Tooltips, Progress indicators. Foundations: Interaction states, Content design(Overview, Style guide), Writing | 사이트가 쓰는 콘텐츠 데이터(판 `2026-10-13_06-10-19`)를 받아 글만 읽었다 |
| 당근 SEED Design System | [seed-design.io](https://seed-design.io), 원문 [daangn/seed-design `docs/content`](https://github.com/daangn/seed-design/tree/99efaf5561de6e18557ffeb57fe95428ce066eb3/docs/content) | 2026-10-30 | Foundations: Writing, State, Voice and Tone. Components: Badge, Callout, Page Banner, Help Bubble, Switch, Select, Select Box, Segmented Control, Menu, Field, Text Input, Quantity Picker, Chip, Radio(비교표), List, Snackbar, Dialog, Alert Dialog, Side Panel, Tag Group, Progress Circle, Skeleton | 저장소 SHA `99efaf5561de6e18557ffeb57fe95428ce066eb3`(2026-10-29 commit)의 MDX를 읽고, 사이트의 Badge·Select·Alert Dialog 쪽이 같은 문구인지 대조했다 |
| 토스 | 아래 세 가지 | 2026-10-30 | 아래 참고 | 아래 참고 |

토스는 "토스 디자인 가이드"라는 이름의 단일 공개 문서가 없다. 공식으로 공개된 것 중 아래를 썼다.

| 토스 출처 | 주소 | 성격 | 읽은 범위 |
|---|---|---|---|
| 앱인토스 개발자센터 **UI/UX 가이드** (주 근거) | [developers-apps-in-toss.toss.im/design/consumer-ux-guide](https://developers-apps-in-toss.toss.im/design/consumer-ux-guide) | 토스 안 미니앱이 지켜야 하는 공식 기준. 출시 심사 기준 포함 | 다크패턴 방지 정책, UX 라이팅(해요체·능동·긍정·캐주얼 경어·명사 나열 금지와 예외 규칙). 페이지 끝 `.md` 판으로 읽었다 |
| 토스 디자인 시스템(TDS) 소개와 **TDS Mobile 문서** | [developers-apps-in-toss.toss.im/design/components](https://developers-apps-in-toss.toss.im/design/components), [tossmini-docs.toss.im/tds-mobile](https://tossmini-docs.toss.im/tds-mobile/) | 컴포넌트 사용법. 설계 규칙보다 속성·예제 위주 | Badge, Switch, ListRow, Segmented Control, Numeric Spinner, Dialog, Button·Checkbox 비활성화. `llms-full.txt`로 읽었다 |
| toss.tech 글 (보조) | [토스의 8가지 라이팅 원칙들](https://toss.tech/article/8-writing-principles-of-toss)(2022-11-15), [좋은 에러 메시지를 만드는 6가지 원칙](https://toss.tech/article/how-to-write-error-message)(2022-09-21) | 토스 UX Writer가 공개한 원칙. 가이드 문서는 아니다 | 전문 |

## 핵심 판단

1. **다섯 가이드 모두 "설명을 덜어내라"는 쪽이다.** 토스의 "의미 없는 문장 제거·핵심 메시지만", One UI의 "방어적 문구 제거·서브텍스트 생략", SEED의 "목적을 해치는 부가 설명 최소화", Apple의 "줄일 수 있으면 줄여라·정보만 주는 alert 피하기", M3의 "겁주는 경고 피하기"가 사용자 원칙을 뒷받침한다.
2. **쓸 수 없는 선택지는 가이드가 둘로 갈린다.** Apple 일반 메뉴와 M3 메뉴는 "숨기지 말고 흐리게(비활성)"를, Apple context menu·One UI·토스는 "처음부터 내지 않기"를 말한다. 둘 다 지키려면 **구조적으로 못 하는 것은 숨기고, 잠깐 못 하는 것은 비활성으로 두되 이유가 상태 값으로 옆에 보일 때만** 비활성을 쓴다. 그리고 가용성이 프로바이더에 따라 달라지는 동작은 **드롭다운 메뉴에 넣지 않는다**(메뉴에 넣으면 Apple·M3가 비활성 표시를 요구한다).
3. **글을 요구하는 경우가 있다.** 대부분 "오류가 났을 때 이유와 해결책을 알려라"와 "입력 오류·필수 표시를 설명하라"다. 오류가 생길 수 없게 만들면(값 범위 고정, 기본값 채우기, 쓸 수 없는 선택지 숨기기) 대부분 피할 수 있다. 끝까지 남는 것은 프로바이더가 준비되지 않았을 때의 "해결책" 요구이며, 이유는 **이유 코드 값**으로, 해결책은 **컨트롤**(예: 명령 복사 버튼)로 바꿔 지킨다. 자세한 표는 [2.3절](#23-글을-요구하는-지침과-피해-가는-방법)에 있다.
4. **상태는 SEED `Badge` 방식(짧은 라벨 + 톤 + 앞 아이콘)으로 통일한다.** 색만으로 상태를 전하지 말라는 규칙은 Apple·One UI·M3·SEED가 모두 말한다.
5. **결정이 필요한 충돌 네 가지**가 있다. 상태 값의 띄어쓰기("준비 안 됨" vs SEED의 붙여 쓰기), 부정형 상태 값(토스의 긍정형 원칙), 대화 상자 닫기 버튼 이름("닫기" vs "취소"), 준비되지 않은 프로바이더를 고르기 목록에 둘지. [2.4절](#24-가이드-사이-충돌과-권장-해소)에 선택지를 정리했다.

## 1. 가이드별 요지

### 1.1 Apple HIG

- **쓸 수 없는 항목**: 일반 메뉴는 "Show people when a menu item is unavailable. An unavailable menu item often appears dimmed"이고, 메뉴 전체가 쓸 수 없어도 메뉴는 열 수 있어야 한다. **[문서]** [Menus › Labels](https://developer.apple.com/design/human-interface-guidelines/menus#Labels). 메뉴 막대도 "disable the action instead of hiding it"이다. **[문서]** [The menu bar](https://developer.apple.com/design/human-interface-guidelines/the-menu-bar). 반대로 context menu는 "Hide unavailable menu items, don't dim them … displays only the actions that are relevant to the currently selected view or content"이다. **[문서]** [Context menus › Best practices](https://developer.apple.com/design/human-interface-guidelines/context-menus#Best-practices)
- **입력**: 고를 수 있으면 타이핑 대신 선택지를 주고, 합리적 기본값을 미리 채우고, 필요한 값이 들어오기 전에는 다음 버튼을 쓸 수 없게 둔다. 숫자는 number formatter로 숫자만 받는다. **[문서]** [Entering data › Best practices](https://developer.apple.com/design/human-interface-guidelines/entering-data#Best-practices). Pop-up button은 서로 배타적인 평평한 목록에 쓰고 "Provide a useful default selection". **[문서]** [Pop-up buttons › Best practices](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons#Best-practices). Stepper는 값이 보이는 칸 옆에 두고, 값 폭이 크면 텍스트 칸과 함께 쓴다. **[문서]** [Steppers](https://developer.apple.com/design/human-interface-guidelines/steppers)
- **토글**: iOS는 switch를 목록 행에서만 쓰고 "You don't need to supply a label in this situation because the content in the row provides the context". 상태 차이를 색에만 기대지 않는다. **[문서]** [Toggles › Best practices, iOS](https://developer.apple.com/design/human-interface-guidelines/toggles#Best-practices)
- **상태 표시**: 상태 정보는 "display status information in a passive way", 관련 항목 가까이에 통합한다. 데이터 손실이 예상된 결과라면 경고하지 않는다. **[문서]** [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback). 정보만 주는 alert는 피하고 맥락 안 표시로 대신한다. **[문서]** [Alerts › Best practices](https://developer.apple.com/design/human-interface-guidelines/alerts#Best-practices). 시스템 label 색 중 tertiary label은 "Text that describes an unavailable item or behavior"에 쓴다. **[문서]** [Labels › Best practices](https://developer.apple.com/design/human-interface-guidelines/labels#Best-practices). 색만으로 정보를 전하지 않는다. **[문서]** [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Color](https://developer.apple.com/design/human-interface-guidelines/color)
- **글**: "If you can use fewer words, do so." 버튼은 동사로. 설정 label이 부족하면 설명을 더한다(조건부). 오류는 문제 가까이에 고치는 방법과 함께. **[문서]** [Writing](https://developer.apple.com/design/human-interface-guidelines/writing). Segmented control은 텍스트 label이면 소개 문구가 필요 없다(iOS). **[문서]** [Segmented controls › Content](https://developer.apple.com/design/human-interface-guidelines/segmented-controls#Content). Spinner에는 label을 달지 않는다(macOS). **[문서]** [Progress indicators › macOS](https://developer.apple.com/design/human-interface-guidelines/progress-indicators#macOS)
- **Sheet**: 닫기 버튼은 "The Cancel (or Close) button dismisses a sheet without saving any changes", Done이 있으면 Cancel/Back과 짝을 짓는다. **[문서]** [Sheets › Anatomy, Best practices](https://developer.apple.com/design/human-interface-guidelines/sheets)

### 1.2 Samsung One UI

- **글을 남기는 기준**: "every bit of text helps users make a choice, take an action, or understand what's happening. If text isn't meeting one of these goals, we leave it out." 선택을 줄 때 "we only tell users the information they need to make the choice … not distract them with long explanations or additional options they can't complete from the current page." **[문서]** [Writing › Focused and purposeful](https://developer.samsung.com/one-ui/writing/focused-and-purposeful.html)
- **방어적 문구 제거**: 지금 당장의 문제가 아닌 경고는 빼고, 문제가 생기면 그때 알리며, 앱이 고칠 수 있으면 자동으로 고친다. 팝업은 입력·삭제 확인·개인 정보 동의·정말 중요한 정보에만 쓴다. **[문서]** [Writing › Simple and human](https://developer.samsung.com/one-ui/writing/simple-and-human.html)
- **해결책 제시**: "If there's a solution to a problem, we tell users what it is"(예: "Remove filter to take burst shots"). 메뉴·기능은 서브텍스트를 생략하고 사용자가 직접 해 보게 둔다. **[문서]** [Writing › Empowering and engaging](https://developer.samsung.com/one-ui/writing/empowering.html)
- **기술적 설정**: "Settings can often feel very technical … we try to explain the choices we offer … break it down to the benefits and tradeoffs"(Do: 이득과 손해를 함께 설명 / Don't: 이득만 설명). **[문서]** [Writing › Focused and purposeful › Understand what's happening](https://developer.samsung.com/one-ui/writing/focused-and-purposeful.html)
- **목록**: 설정 이름은 명사나 짧은 동사구, 31자 안. 이해하기 어려우면 subtext를 "줄 수 있다". 켜고 끄는 설정은 행 오른쪽에 switch. **[문서]** [Components › Lists](https://developer.samsung.com/one-ui/comp/list.html)
- **알림 강도**: toast는 1줄(최대 3줄), 사소한 정보에만. 선택이 필요하거나 심각한 경고는 popup. 아이콘 버튼은 길게 누르면 label이 뜬다. **[문서]** [Components › Toasts](https://developer.samsung.com/one-ui/comp/toast.html)
- **접근성**: 색만으로 구분하지 말고 추가 표시를 준다. 오류는 명확한 메시지와 다음 행동 경로를 준다. **[문서]** [Accessibility › Color and contrast](https://developer.samsung.com/one-ui/accessibility/color-contrast.html), [Interaction and control](https://developer.samsung.com/one-ui/accessibility/interaction-and-control.html)

### 1.3 Material Design 3

- **비활성**: 메뉴 항목은 "When a menu item can only be used under specific conditions, it should appear disabled rather than be removed." **[문서]** [Menus › Guidelines › Anatomy](https://m3.material.io/components/menus/guidelines). 비활성 상태는 버튼·칩·목록 항목·switch·텍스트 칸에 상속되고, 비활성 컴포넌트는 focus·press를 받지 않는다. **[문서]** [Interaction states › Applying states](https://m3.material.io/foundations/interaction/states/applying-states)
- **칩**: "Chips should dynamically offer various actions depending on the current task, whereas a button should be a persistent fixture of a layout." 한 배치에 버튼은 3개 이하. **[문서]** [Chips › Guidelines](https://m3.material.io/components/chips/guidelines)
- **Switch**: "The effects of a switch should start immediately, without needing to save." switch에는 무엇을 제어하는지 말하는 inline label을 붙인다. **[문서]** [Switch › Guidelines](https://m3.material.io/components/switch/guidelines)
- **텍스트 칸**: 상태(빈 칸·입력됨·오류)가 한눈에 보여야 한다. 필수 칸에 별표를 쓰면 supporting text나 양식 첫머리 한 줄로 별표의 뜻을 설명한다. 검증하는 칸은 supporting text 자리에 오류 문구를 대신 넣고, 오류 아이콘을 강하게 권한다. 단위는 suffix text로 붙인다. **[문서]** [Text fields › Guidelines](https://m3.material.io/components/text-fields/guidelines)
- **배지**: 내비게이션 아이콘 위의 알림·개수 표시용. 큰 배지 라벨은 최대 4자. **[문서]** [Badges › Guidelines](https://m3.material.io/components/badges/guidelines). 목록 항목의 trailing icon은 상태 표시에, trailing text는 가격·개수 같은 메타 정보에 쓴다. **[문서]** [Lists › Guidelines](https://m3.material.io/components/lists/guidelines)
- **메시지 강도**: dialog는 아껴 쓰고, 덜 방해되는 대안으로 dropdown menu를 권한다. headline에 "Warning!"·"Are you sure?"를 쓰지 않는다. **[문서]** [Dialogs › Guidelines](https://m3.material.io/components/dialogs/guidelines). 웹에서 저절로 사라지는 snackbar는 같은 정보를 인라인으로도 전해야 한다(예: `Save` 버튼을 `Saved`로 바꾸기). **[문서]** [Snackbar › Guidelines](https://m3.material.io/components/snackbar/guidelines)
- **Tooltip**: plain tooltip은 아이콘만 있는 버튼의 이름표, rich tooltip은 긴 설명용. **[문서]** [Tooltips › Guidelines](https://m3.material.io/components/tooltips/guidelines)
- **Segmented buttons**: M3 expressive 갱신 뒤 "no longer recommended", connected button group을 쓴다. **[문서]** [Segmented buttons › Guidelines](https://m3.material.io/components/segmented-buttons/guidelines)
- **글**: "Avoid cautions or warnings that might sound alarming … Focus instead on communicating the consequences of a function." label·tooltip·목록에는 마침표를 생략한다. 1,000 이상 숫자에 쉼표. **[문서]** [Content design › Style guide](https://m3.material.io/foundations/content-design/style-guide/ux-writing-best-practices). 잘린 글은 tooltip이나 링크로 전체를 볼 수 있어야 한다. **[문서]** [Writing › Text truncation](https://m3.material.io/foundations/writing/text-truncation)

### 1.4 SEED Design System

- **글**: "하나의 목적에 집중해요. 목적을 해치는 부가적인 설명은 최소화해요." 에러 메시지에는 직접 해결할 수 있는 방법을 알려준다. 같은 내용이면 긍정문. 띄어쓰기는 "기능명, 서비스명, 상태값 자체를 의미할 때는 붙여써요"(예: `예약중`). 버튼·메뉴·라벨에는 마침표를 쓰지 않는다. **[문서]** [Foundations › Writing](https://seed-design.io/foundations/writing)
- **상태**: Disabled는 "사용자의 상호작용을 받지 않고 있으나, 다른 조건에 따라 상호작용이 가능할 수 있음을 나타냅니다." **[문서]** [Foundations › State](https://seed-design.io/foundations/state)
- **Badge**: "객체의 속성이나 상태를 시각적으로 표현하는 작은 텍스트 라벨". 상태 표시 톤 표: Neutral(상태값이 명확하지 않은 초기 상태), Informative, Positive(완료·승인됨·저장 성공), Warning(만료 임박·필수 정보 부족 등 잠재적 문제), Critical(편집 불가·유효성 검증 실패). Prefix 아이콘으로 상태 인지를 돕는다. 한 객체에 1~2개, 2~3단어, 10자 넘으면 말줄임. 클릭 요소로 쓰지 않는다. 라벨 뒤 (i) 버튼(Action)으로 Help Bubble 설명을 붙이는 변형이 있다. **[문서]** [Components › Badge](https://seed-design.io/components/badge)
- **Select**: 항상 Field의 Label과 함께 쓰고 Placeholder로 Label을 대신하지 않는다. "고르지 않은 상태가 있을 수 없는 필드: 기본값을 미리 선택해 둡니다." "없음"이 답일 수 있으면 그 답을 뜻하는 옵션을 목록에 두고, 라벨은 질문의 핵심을 담는다(예: "선호하는 기내식 없음"). Item Label은 명사형이고 "Item Label에 동작이나 부연 설명을 함께 적지 않습니다." 다중 선택이면 고를 수 있는 개수를 Helper Text로 알린다. Select는 "고른 뒤 저장 또는 제출해야 반영됨", Menu는 "누르면 즉시 실행됨". **[문서]** [Components › Select](https://seed-design.io/components/select)
- **Switch**: 토글하면 결과가 즉시 나타나는 곳에만 쓰고, 저장 버튼을 눌러야 반영되면 Checkbox를 쓴다. 비활성일 때 텍스트 라벨도 비활성 색으로. **[문서]** [Components › Switch](https://seed-design.io/components/switch)
- **Quantity Picker**: Min·Max로 범위를 막고 "경계에 도달한 버튼은 자동으로 비활성화되어, 잘못된 값이 입력되는 것을 사전에 막습니다." **[문서]** [Components › Quantity Picker](https://seed-design.io/components/quantity-picker)
- **Field**: Footer에 Helper Text·Error Message·Character Count. 오류 메시지는 행동 지시형. 작성·수정 화면을 떠날 때 입력값이 지워질 수 있으면 Alert Dialog로 경고해야 하며, "값의 변화가 없거나 자동 저장 기능이 있는 경우에는 안내를 생략할 수 있습니다." 필수 표시는 필드 2/3 이상이 필수면 '선택'만, 아니면 '\*'만. **[문서]** [Components › Field](https://seed-design.io/components/field)
- **Segmented Control**: 4개 이하, 한 화면에 하나, 보기 전환·필터용. **[문서]** [Components › Segmented Control](https://seed-design.io/components/segmented-control)
- **Menu**: Label은 2~6자 동사형, Description은 필요한 항목에만. **[문서]** [Components › Menu](https://seed-design.io/components/menu)
- **메시지 컴포넌트**: Callout은 팁·기능 설명·위험 주의, Page Banner는 페이지 상태·제재 안내, Snackbar는 낮은 심각도 결과 안내(4초). 경고·오류에는 닫을 수 있는 Callout·Page Banner를 쓰지 않는다. **[문서]** [Callout](https://seed-design.io/components/callout), [Page Banner](https://seed-design.io/components/page-banner), [Snackbar](https://seed-design.io/components/snackbar)
- **Alert Dialog**: Menu Sheet와 비교해 "액션에 대한 부연설명이 반드시 필요". **[문서]** [Components › Alert Dialog](https://seed-design.io/components/alert-dialog)
- **Dialog**: md(768px) 미만에서 Bottom Sheet로 바뀌는 Responsive Dialog가 기본. 입력·수정 Dialog는 푸터의 취소 버튼으로 닫는다. **[문서]** [Components › Dialog](https://seed-design.io/components/dialog)

### 1.5 토스

- **다크패턴 방지(출시 불가 기준)**: "CTA 위에 과장되거나 중복된 보조 설명을 함께 노출하면 버튼의 역할이 흐려지고, 사용자에게 혼란을 줄 수 있어요." 진입·뒤로 가기 때 화면을 막는 바텀시트 금지. **[문서]** [UI/UX 가이드 › 다크패턴 방지 정책](https://developers-apps-in-toss.toss.im/design/consumer-ux-guide)
- **UX 라이팅**: 모든 문구 해요체, 능동형, 긍정형("안 돼요, 없어요 (X) → ~하면 할 수 있어요 (O)"). 다이얼로그 왼쪽 버튼은 **닫기**로 통일하고 "취소"는 쓰지 않는다(하던 작업이 취소된다고 오해할 수 있어서). 예외: 일부 기능만 쓸 수 없을 때는 부정형이 더 명확하고, 정책상 쓸 수 없을 때는 "쓸 수 없는 이유를 함께 안내해주세요." **[문서]** [UI/UX 가이드 › UX 라이팅](https://developers-apps-in-toss.toss.im/design/consumer-ux-guide)
- **라이팅 원칙**: Weed cutting(의미 없는 단어 제거), Remove empty sentences("공간이 비어보인다거나 … 의미 없는 문구를 쓰는 것도 피해야"), Focus on key message("사용자가 이미 알고 있는 정보는 과감하게 생략"), Predictable hint(버튼이 다음 화면을 예상하게). **[문서]** [토스의 8가지 라이팅 원칙들](https://toss.tech/article/8-writing-principles-of-toss)
- **에러**: "최고의 에러는 발생하지 않는 것". 내 연락처로는 송금할 수 없으니 메시지를 고치는 대신 "연락처 목록에서 내 연락처를 노출하지 않는 방향으로 작업했어요." 메시지가 필요하면 상황·이유·해결책을, 해결은 탭 한 번으로. **[문서]** [좋은 에러 메시지를 만드는 6가지 원칙](https://toss.tech/article/how-to-write-error-message)
- **TDS**: `Badge`는 "항목의 상태를 빠르게 인식할 수 있도록 강조", `fill`(강조)·`weak`(덜 눈에 띔). `ListRow`는 left·contents·right 세 영역이고 `disabled`와 두 가지 비활성 스타일이 있다. `Switch`·`Button`·`NumericSpinner`는 `disabled`로 비활성화한다. **[문서]** [TDS Mobile › Badge](https://tossmini-docs.toss.im/tds-mobile/components/badge/), [ListRow 이해하기](https://tossmini-docs.toss.im/tds-mobile/components/ListRow/list-row-overview/), [Switch](https://tossmini-docs.toss.im/tds-mobile/components/switch/), [Numeric Spinner](https://tossmini-docs.toss.im/tds-mobile/components/numeric-spinner/)

## 2. 가이드를 가로지르는 원칙

### 2.1 설명문 없는 화면: 무엇이 글이고 무엇이 값인가

**[추론]** 사용자 원칙을 다섯 가이드에 맞춰 적용하려면 화면의 글을 두 갈래로 나눠야 한다.

| 화면에 남기는 것(값·이름) | 화면에서 빼는 것(설명·경고) |
|---|---|
| 칸·행·열의 이름(Field Label, 목록 행 제목, 열 머리) | Helper Text·supporting text·Item Description·subtext |
| 값과 단위(`2`, `200,000 토큰`, `90%`, `1.2 MB`) | Callout·Page Banner·info 배너 |
| 상태 값과 이유 코드(`준비됨`, `제품 로그인 없음`, `보고 안 됨`) | Badge의 (i) 설명 버튼, rich tooltip |
| 버튼·메뉴 항목 이름(`저장`, `줄 세우기`) | 정보만 주는 toast·snackbar·alert |
| 아이콘 버튼의 이름표 tooltip(`실행 중 끼워 넣기`) | "다음 실행부터 적용돼요" 같은 동작 설명 문장 |

근거:

- 남기는 쪽: Select·Text field는 Label이 늘 있어야 한다(**[문서]** SEED [Select](https://seed-design.io/components/select), M3 [Text fields](https://m3.material.io/components/text-fields/guidelines)). 아이콘만 있는 버튼은 이름표가 필요하다(**[문서]** M3 [Tooltips](https://m3.material.io/components/tooltips/guidelines), One UI [Toasts › Label toast](https://developer.samsung.com/one-ui/comp/toast.html)). M3 suffix text는 단위용이다(**[문서]** [Text fields](https://m3.material.io/components/text-fields/guidelines)).
- 빼는 쪽: 토스 Remove empty sentences·다크패턴 5번, One UI "we leave it out"·"omit the subtext", SEED "부가적인 설명은 최소화"·Item Label에 부연 설명 금지, Apple "fewer words"·정보만 주는 alert 피하기, M3 "Avoid cautions or warnings that might sound alarming". 출처는 1장의 각 항목과 같다.

### 2.2 쓸 수 없는 선택지: 숨김과 비활성

| 가이드 | 숨김 쪽 | 비활성 쪽 |
|---|---|---|
| Apple | context menu는 관련 있는 동작만 보이고 쓸 수 없으면 숨긴다 | 일반 메뉴·메뉴 막대는 흐리게 남긴다. 입력 전 다음 버튼은 쓸 수 없게 둔다 |
| One UI | 지금 화면에서 끝낼 수 없는 선택지로 주의를 흩뜨리지 않는다 | (공개 문서에 규칙 없음) |
| M3 | 칩은 현재 작업에 따라 동적으로 동작을 낸다 | 조건부로만 쓸 수 있는 메뉴 항목은 지우지 말고 비활성 |
| SEED | (규칙 없음) | Disabled = 다른 조건에서 가능해질 수 있음. Quantity Picker는 경계에서 버튼 비활성 |
| 토스 | 오류만 낼 항목은 목록에서 빼기(에러 원칙 1) | TDS 컴포넌트의 `disabled` |

**[추론] 해소 규칙**

1. **구조적으로 못 하는 것은 숨긴다.** 지금 맥락에서 사용자가 아무리 해도 쓸 수 없는 선택지(예: Lead의 프로바이더가 끼워 넣기를 못 할 때의 `실행 중 끼워 넣기`, 다른 프로바이더의 모델). Apple context menu·One UI·토스·M3 칩이 뒷받침한다.
2. **잠깐 못 하는 것은 비활성으로 둔다. 단, 이유가 상태 값으로 옆에 보일 때만.** 예: 줄 세운 메시지 `20/20`일 때 보내는 버튼, 상한 경계의 stepper 버튼, 바뀐 값이 없을 때의 `저장`. Apple Feedback의 "help them understand why"를 글 없이 지키는 방법이다.
3. **가용성이 프로바이더에 따라 바뀌는 동작은 드롭다운 메뉴로 만들지 않는다.** 메뉴에 넣으면 Apple 일반 메뉴와 M3 메뉴가 "숨기지 말고 비활성"을 요구해 사용자 원칙과 부딪힌다. 맥락에 따라 바뀌는 버튼 묶음(현재 입력창 방식)으로 둔다.

### 2.3 글을 요구하는 지침과 피해 가는 방법

| 가이드 | 요구 | 언제 | 피해 가는 방법 **[추론]** |
|---|---|---|---|
| Apple [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback) | "Show people when a command can't be carried out and help them understand why" | 명령을 실행할 수 없을 때 | 실행할 수 없는 명령은 내지 않는다(2.2의 1). 비활성은 이유가 값으로 보일 때만 |
| Apple [Text fields](https://developer.apple.com/design/human-interface-guidelines/text-fields#Best-practices), [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data) | 숫자 칸에 숫자가 아닌 것을 넣으면 알린다. 값을 즉시 검증하고 문제를 알린다 | 입력 검증 실패 | 숫자만 받는 칸 + 최소·최대 범위가 있는 stepper. 범위 밖 입력이 생기지 않게 한다 |
| Apple [Writing](https://developer.apple.com/design/human-interface-guidelines/writing) | 설정 label만으로 부족하면 설명을 더한다. 빈 화면에는 다음 행동을 안내한다 | label이 모호할 때, 빈 화면 | label에 단위·대상을 담는다. 빈 목록은 이름과 0개 상태로 두고, 사용자가 할 행동이 있으면 버튼을 둔다 |
| One UI [Focused and purposeful](https://developer.samsung.com/one-ui/writing/focused-and-purposeful.html) | 기술적 설정은 이득과 손해를 설명하려 노력한다 | 미리 압축 기준, 격리 같은 기술 설정 | **남는 긴장.** One UI도 같은 쪽 안에서 "leave it out", 다른 쪽에서 "omit the subtext"를 말해 필수 규칙은 아니다. 기준값을 단위와 함께 보이고, 결과는 다른 화면의 상태 값(준비 상태, 동시 실행 수)으로 드러낸다 |
| One UI [Empowering](https://developer.samsung.com/one-ui/writing/empowering.html), 토스 [UX 라이팅 예외](https://developers-apps-in-toss.toss.im/design/consumer-ux-guide)·[에러 원칙](https://toss.tech/article/how-to-write-error-message), SEED [Writing](https://seed-design.io/foundations/writing) | 문제에 해결책이 있으면 알린다. 쓸 수 없으면 이유를 함께. 에러에는 상황·이유·해결책 | 프로바이더 준비 안 됨, 저장 실패 | 이유는 **이유 코드 값**(`설치 안 됨`, `제품 로그인 없음`)으로, 해결책은 **컨트롤**(`다시 확인`, 필요하면 `로그인 명령 복사`)로 준다. 토스 에러 원칙 5("탭 한 번으로")와 맞는다 |
| M3 [Text fields](https://m3.material.io/components/text-fields/guidelines) | 별표로 필수를 표시하면 별표의 뜻을 설명한다. 검증하는 칸은 오류 문구를 보인다 | 필수 칸, 검증 실패 | 판 2의 새 칸은 모두 기본값으로 채워 "비어 있는 필수 칸"이 없게 한다. 기존 조직 만들기 창의 선택 칸은 SEED처럼 `(선택)`만 붙인다 |
| SEED [Field](https://seed-design.io/components/field) | 입력값이 지워질 수 있는 화면을 떠나면 Alert Dialog로 경고한다 | 승인 화면에서 줄을 바꾸고 떠날 때, 설정을 고치고 떠날 때 | **자동 저장 예외를 쓴다.** 바꾼 값을 초안으로 보존해 떠나도 잃지 않게 한다 |
| SEED [Alert Dialog](https://seed-design.io/components/alert-dialog) | Alert Dialog에는 부연 설명이 반드시 필요 | 확인 대화 상자를 쓸 때 | 판 2 화면에 Alert Dialog를 쓰지 않는다. 되돌릴 수 없는 일이 사용자가 고른 그 동작의 예상 결과라면 Apple도 경고하지 말라고 한다 |
| SEED [Select](https://seed-design.io/components/select), [Select Box](https://seed-design.io/components/select-box) | 다중 선택의 최대 개수를 Helper Text로 알린다 | 개수 제한이 있는 다중 선택 | 판 2에는 다중 선택이 필요 없다. 단일 선택만 쓴다 |

### 2.4 가이드 사이 충돌과 권장 해소

| 충돌 | 한쪽 | 다른 쪽 | 권장 **[추론]** |
|---|---|---|---|
| 쓸 수 없는 메뉴 항목 | Apple 일반 메뉴·M3 메뉴: 비활성으로 남김 | Apple context menu·One UI·토스: 숨김 | 2.2의 해소 규칙. 가용성이 바뀌는 동작은 메뉴에 넣지 않는다 |
| 상태 값의 띄어쓰기 | SEED: 상태값 자체는 붙여 쓴다(`예약중`) | #91의 값 `준비 안 됨`·`보고 안 됨`, 한국어 맞춤법 | **사용자 결정 필요.** (가) SEED대로 `준비안됨`·`보고안됨`, (나) 띄어 쓰는 다른 낱말로 바꾸지 않고 지금 값 유지(SEED와 어긋남), (다) 붙여 써도 어색하지 않은 낱말로 바꾸기(예: `준비됨`·`준비필요`·`확인불가`). (가)나 (다)가 다섯 가이드에 어긋나지 않는다 |
| 부정형 상태 값 | 토스: 긍정형 우선 | `준비 안 됨`, `보고 안 됨` | 토스 예외 "일부 기능만 쓸 수 없을 때 부정형이 명확"에 해당한다. `보고 안 됨`은 0과 모름을 가르는 것이 목적(#91 사용자 이야기 35)이라 부정형이 맞다 |
| 대화 상자를 닫는 버튼 이름 | 토스: 왼쪽 버튼은 `닫기`, `취소` 금지 | SEED: 입력 Dialog는 푸터의 취소 버튼, Apple alert는 "Cancel" | `닫기`를 쓴다. Apple sheet는 "Cancel (or Close)"를 허용하고, SEED는 버튼의 역할(명시적 거절)을 정할 뿐 낱말을 고정하지 않는다. 초안을 보존하면 닫아도 작업이 취소되지 않아 `닫기`가 사실에 맞다. 판 2에 Apple alert는 쓰지 않는다 |
| Select 값의 반영 시점 | SEED: Select는 저장·제출해야 반영 | M3·SEED: switch는 즉시 반영 | 한 화면에서 switch는 즉시, Select·숫자 칸은 묶음별 `저장`으로 반영한다 |
| 배지의 쓰임 | M3: 배지는 내비게이션 아이콘의 알림·개수 | SEED·TDS: 배지로 항목 상태 표시 | 상태 표시는 SEED `Badge` 방식으로 한다. M3는 목록 trailing 요소로 상태를 보이는 것을 허용하므로 어긋나지 않는다 |
| 세 개 이상 선택지의 묶음 | M3: segmented buttons 비권장 | SEED: segmented control은 보기 전환·필터용, 한 화면 하나 | 전달 방식은 segmented control로 만들지 않는다. 지금처럼 맥락 버튼으로 둔다 |
| 기술적 설정의 설명 | One UI: 이득과 손해를 설명하려 함 | 사용자 원칙: 설명문 없음 | 2.3의 남는 긴장. 설명문 대신 값과 단위를 보인다. 사용자가 이 긴장을 받아들일지 확인이 필요하다 |

### 2.5 공통 패턴

- **상태 라벨** **[추론]**: SEED `Badge` 톤 + Prefix 아이콘 + 짧은 라벨. 클릭 요소로 쓰지 않는다. 판 2 톤 대응: `준비됨`=Positive, `준비 안 됨`=Critical(실행 시도가 실패하므로), `알 수 없음`=Neutral(상태값이 명확하지 않은 초기 상태), 이유 코드는 배지 옆 보조 글자(Apple secondary label "supplemental text"). 색만으로 구분하지 않는다(Apple·One UI·M3·SEED). 근거: **[문서]** SEED [Badge](https://seed-design.io/components/badge), Apple [Labels](https://developer.apple.com/design/human-interface-guidelines/labels), One UI [Color and contrast](https://developer.samsung.com/one-ui/accessibility/color-contrast.html)
- **확인 중 표시**: 배지 자리에 라벨 없는 작은 spinner(Apple macOS "Avoid labeling a spinning progress indicator", M3 200ms~5s는 loading indicator, SEED Progress Circle은 로딩 범위의 위치에). **[문서]** Apple [Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators), M3 [Progress indicators](https://m3.material.io/components/progress-indicators/guidelines), SEED [Progress Circle](https://seed-design.io/components/progress-circle)
- **기본값 채우기**: 모든 고르기 칸은 기본값이 선택된 채로 열린다(Apple Pop-up buttons·Entering data, SEED Select). "모델 비움"은 빈 칸이 아니라 `기본 모델` 옵션으로 보인다(SEED "없음" 옵션 규칙). **[문서]** 1.1, 1.4절
- **반영 방식**: switch는 즉시 반영(M3·SEED). Select·숫자 칸은 묶음별 `저장`(바뀐 값이 있을 때만 쓸 수 있음, Apple Entering data). 저장 전 값은 초안으로 보존(SEED Field 자동 저장 예외). 저장 결과는 버튼 자리의 상태로 보인다(M3 Snackbar의 웹 접근성 규칙: `Save`→`Saved`).
- **좁은 화면**: Dialog는 768px 미만에서 bottom sheet(SEED Responsive Dialog), 표는 행을 쌓아 다시 배치(M3 Writing의 reflow). **[문서]** SEED [Dialog](https://seed-design.io/components/dialog), M3 [Writing › Text resizing](https://m3.material.io/foundations/writing/text-resizing)
- **남는 글의 문체**: 이름·옵션은 명사형(SEED Select, Apple segment label, One UI 설정 이름), 버튼은 동사(Apple Writing, SEED Menu 2~6자 동사형, 토스 Predictable hint), 라벨·버튼에 마침표 없음(SEED·M3), 문장이 꼭 필요하면 해요체·능동(토스). 숫자는 아라비아 숫자·천 단위 쉼표(SEED Writing, M3 Style guide).

## 3. 화면별 패턴

각 절은 가이드별 적용 패턴, 일치·충돌, 권장 패턴 순서다.

### A. 전역 설정

| 가이드 | 적용 패턴 |
|---|---|
| Apple | 묶음 목록(grouped list)에 설정을 모으고 기본값을 잘 고른다. 설정 수를 줄인다(**[문서]** [Settings](https://developer.apple.com/design/human-interface-guidelines/settings)). switch는 목록 행에서, 행 내용이 label 역할(**[문서]** [Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles)). 상한은 stepper + 숫자 칸(**[문서]** [Steppers](https://developer.apple.com/design/human-interface-guidelines/steppers)). 확인을 자동으로 하고 사용자에게 매번 새로고침을 맡기지 않는다(**[문서]** [Progress indicators › Perform automatic content updates](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)) |
| One UI | 설정 목록에 subheader로 묶고, 켜고 끄는 설정은 행 오른쪽 switch(**[문서]** [Lists](https://developer.samsung.com/one-ui/comp/list.html)). 기술 설정의 손익 설명 권고(2.3 남는 긴장) |
| M3 | switch는 inline label과 즉시 반영. 숫자 칸은 suffix로 단위. 목록 trailing 요소로 상태(**[문서]** [Switch](https://m3.material.io/components/switch/guidelines), [Text fields](https://m3.material.io/components/text-fields/guidelines), [Lists](https://m3.material.io/components/lists/guidelines)) |
| SEED | List Header로 묶기(**[문서]** [List](https://seed-design.io/components/list)). 상태는 Badge 톤. Select는 Field Label과 기본값 선택. 상한은 Quantity Picker(Min·Max, 경계 비활성). 격리는 즉시 반영 Switch |
| 토스 | `ListHeader`·`ListRow`(left·contents·right), `Badge`, `Switch`, `NumericSpinner`(**[문서]** TDS). 이미 아는 정보는 생략(Focus on key message) |

- 일치: 묶음 목록, 행 오른쪽 switch 즉시 반영, 범위가 막힌 숫자 입력, 상태는 배지·아이콘.
- 충돌: One UI의 기술 설정 설명 권고. Select 반영 시점(2.4).

**권장 패턴 [추론]**

1. `프로바이더` 묶음: 프로바이더마다 목록 행 하나. 왼쪽 프로바이더 이름, 오른쪽 준비 상태 배지와 이유 코드, 그 옆 `동시 실행 상한` stepper(최소 1, 기본 2, 경계 버튼 비활성). 판 번호는 trailing 메타 글자로만. 설정 화면을 열면 자동으로 다시 확인하고 그동안 배지 자리에 라벨 없는 spinner.
2. `기본값` 묶음: `Lead 기본값`, `작업자 기본값` 두 줄. 줄마다 `프로바이더` Select와 `모델` Select(Field Label 있음). 모델 목록은 고른 프로바이더의 것만, 첫 옵션 `기본 모델`. 프로바이더 옵션 옆에 준비 상태 배지(라벨 글자에 섞지 않음).
3. `미리 압축` 묶음: `기준 토큰`(숫자 칸 + suffix `토큰`, 천 단위 쉼표, stepper)과 `비율`(숫자 칸 + suffix `%`, stepper, 최소·최대 고정). 범위 밖 값은 입력 단계에서 막는다.
4. `격리 실행` 행: 오른쪽 switch, 누르면 즉시 반영. 켜진 뒤 생기는 결과는 위 `프로바이더` 묶음의 배지(격리 확인 실패 시 `준비 안 됨`)로 보인다.
5. 2·3의 묶음은 `저장` 버튼(바뀐 값이 있을 때만 쓸 수 있음)으로 반영하고, 저장 전 값은 초안으로 보존한다. 저장 뒤 버튼 자리에 `저장됨` 상태를 잠시 보인다.
6. 설명 subtext, 프로바이더 행의 (i) 버튼, 로그인 방법 안내문은 두지 않는다. 해결 경로가 필요하면 `준비 안 됨` 행에 컨트롤(`다시 확인`, `로그인 명령 복사`)만 둔다. 이 두 컨트롤은 #91 범위 밖이므로 넣을지 사용자 확인이 필요하다.

### B. 새 연구 조직 창

| 가이드 | 적용 패턴 |
|---|---|
| Apple | sheet로 범위가 좁은 작업. 기본값을 채우고, 필요한 값이 들어오기 전엔 만들기 버튼을 쓸 수 없게(**[문서]** [Sheets](https://developer.apple.com/design/human-interface-guidelines/sheets), [Entering data](https://developer.apple.com/design/human-interface-guidelines/entering-data)) |
| One UI | 한 번에 하나의 선택·작업에 집중(**[문서]** [Focused and purposeful](https://developer.samsung.com/one-ui/writing/focused-and-purposeful.html)) |
| M3 | dialog는 아껴 쓰되 입력 작업용 dialog 허용. 버튼 두 개(확인·닫기)(**[문서]** [Dialogs](https://m3.material.io/components/dialogs/guidelines)) |
| SEED | Responsive Dialog(md 미만 bottom sheet). Select Field + Badge. 떠날 때 입력 보존이 없으면 경고 필요(Field) |
| 토스 | 다이얼로그 왼쪽 버튼 `닫기`. CTA는 다음 결과를 예상하게(`만들기`) |

- 일치: 기본값 채움, 버튼 두 개, 좁은 화면 bottom sheet.
- 충돌: 닫기 버튼 이름(2.4). 준비되지 않은 프로바이더를 목록에 둘지(아래 6).

**권장 패턴 [추론]**

1. 기존 칸(이름·연구 목표·선택 완료 기준) 아래 `Lead 프로바이더` Select와 `Lead 모델` Select. 전역 `Lead 기본값`으로 미리 채운다.
2. `Lead 프로바이더` 칸 바로 옆에 고른 프로바이더의 준비 상태 배지와 이유 코드. 칸 아래 Helper Text 자리는 쓰지 않는다.
3. 프로바이더를 바꾸면 모델이 그 프로바이더의 `기본 모델`로 돌아간다. 바뀐 값 자체가 결과 표시다.
4. 버튼은 `닫기`(왼쪽)와 `만들기`(오른쪽). `만들기`는 필수 칸이 찰 때만 쓸 수 있다. 선택 칸은 이름에 `(선택)`만 붙인다.
5. 닫아도 입력은 초안으로 보존해 다시 열면 그대로 보인다. 경고 대화 상자는 두지 않는다.
6. **사용자 결정 필요**: 준비되지 않은 프로바이더를 목록에 남길지. 권장은 남기고 배지로 상태를 보이는 쪽이다. 준비 상태는 마지막 확인 결과라 바뀔 수 있고(`알 수 없음` 포함), #91은 "다른 프로바이더로 몰래 바꾸지 않음"과 "고른 프로바이더의 준비 상태를 본다"를 요구한다. 숨기면 사용자가 일부러 고르려는 프로바이더가 이유 없이 사라진다. 다른 선택지는 `설치 안 됨`만 숨기는 것이다.

### C. 에이전트 상세·설정

| 가이드 | 적용 패턴 |
|---|---|
| Apple | 작업별 설정은 그 화면 안에서(**[문서]** [Settings › Task-specific options](https://developer.apple.com/design/human-interface-guidelines/settings)). 예상된 결과에는 경고하지 않는다(**[문서]** [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)) |
| One UI | 방어적 문구 제거, 앱이 처리할 수 있으면 자동 처리(**[문서]** [Simple and human](https://developer.samsung.com/one-ui/writing/simple-and-human.html)) |
| M3 | "Avoid cautions or warnings that might sound alarming … communicating the consequences"(**[문서]** [Style guide](https://m3.material.io/foundations/content-design/style-guide/ux-writing-best-practices)) |
| SEED | 생성·수정 Form은 같은 구성(**[문서]** [Field › 단일 화면에서 Form 구성하기](https://seed-design.io/components/field)). Select + `기본 모델` 옵션 |
| 토스 | 이미 아는 정보 생략, 강요·공포 문구 금지(Suggest over force) |

- 일치: 경고·확인 대화 상자 없이 바꾸기. 결과는 값으로.
- 충돌: M3의 "결과를 전하라"는 설명 쪽이다. 결과를 값으로 보여 지킨다.

**권장 패턴 [추론]**

1. 에이전트 설정 묶음에 `프로바이더`·`모델` Select 두 개와 `저장`. B와 같은 칸 구성(SEED 생성·수정 Form 일치).
2. 프로바이더를 바꾸면 모델 칸이 `기본 모델`로 바뀐다. 세션 비움에 대한 확인 대화 상자나 경고는 두지 않는다(사용자가 고른 동작의 예상 결과).
3. "다음 실행 시도부터 적용"은 문장 대신 값으로 보인다. 최근 실행 시도 목록의 각 행에 그 실행 시도가 쓴 `프로바이더 · 모델`을 보이고, 에이전트 머리의 값은 저장된 설정을 보인다. 실행 중 행과 설정 값이 다르면 그 차이가 곧 적용 시점을 보여 준다.
4. 프로바이더 칸 옆에 준비 상태 배지(A와 같은 모양).

### D. 승인 상세(초기 연구 승인·`작업자 추가`)

| 가이드 | 적용 패턴 |
|---|---|
| Apple | 여러 열 표는 명사 열 머리, 행 안 선택은 pop-up button("Within a popover or modal view, consider using a pop-up button … for a list item")(**[문서]** [Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables), [Pop-up buttons › iPadOS](https://developer.apple.com/design/human-interface-guidelines/pop-up-buttons)) |
| One UI | 한 번에 하나의 선택 집중 |
| M3 | 목록 항목은 같은 위치에 같은 요소, 항목 안 여러 동작 허용(**[문서]** [Lists](https://m3.material.io/components/lists/guidelines)) |
| SEED | List Item 하나에 상호작용 요소 4개 이상 지양(**[문서]** [List](https://seed-design.io/components/list)). Badge 한 객체 1~2개. 떠날 때 입력 보존(Field) |
| 토스 | `ListRow` 세 영역, 사용자 선택의 결과를 명확히 |

- 일치: 행마다 같은 배치, 행 안 pop-up 선택, 열 머리는 명사.
- 충돌: 없음. SEED 이탈 경고는 초안 보존으로 피한다.

**권장 패턴 [추론]**

1. 팀 구성 표: 열 머리 `역할`, `이름`, `프로바이더`, `모델`, `상태`. 줄마다 `프로바이더`·`모델` Select와 준비 상태 배지. Lead 제안으로 미리 채운다. Lead가 비운 칸은 `작업자 기본값` 옵션이 선택된 상태로 보인다.
2. 사용자가 바꾼 줄에는 `변경` 배지(Neutral)와 `되돌리기` 아이콘 버튼(이름표 tooltip). 한 줄의 상호작용 요소는 Select 두 개와 되돌리기, 셋으로 둔다.
3. 바꾼 값은 초안으로 보존한다. 결정 버튼은 기존 승인·거절 그대로.
4. 결정 뒤: 같은 표를 읽기 전용으로 바꾸고 열을 `Lead 제안`과 `결정`으로 나눈다. 다른 칸만 `변경` 배지를 단다. 문장 설명은 없다.
5. 좁은 화면: 줄마다 카드처럼 쌓고 열 머리는 칸 이름으로 바뀐다.

### E. 조직 설정(승인 정책)

| 가이드 | 적용 패턴 |
|---|---|
| Apple | 목록 행 switch, 행 내용이 label(**[문서]** [Toggles](https://developer.apple.com/design/human-interface-guidelines/toggles)) |
| One UI | 켜고 끄는 설정은 행 오른쪽 switch. subtext는 선택, 서브텍스트를 생략하고 탐색에 맡김(**[문서]** [Lists](https://developer.samsung.com/one-ui/comp/list.html), [Empowering](https://developer.samsung.com/one-ui/writing/empowering.html)) |
| M3 | switch 즉시 반영, inline label, 독립 항목은 radio 대신 switch(**[문서]** [Switch](https://m3.material.io/components/switch/guidelines)) |
| SEED | Switch는 즉시 결과·독립 기능에만. 비활성이면 라벨도 비활성 색(**[문서]** [Switch](https://seed-design.io/components/switch)) |
| 토스 | `Switch`, `ListRow` |

- 일치: 다섯 가이드 모두 같은 모양(목록 행 + 오른쪽 switch + 즉시 반영).
- 충돌: One UI의 기술 설정 설명 권고(약함).

**권장 패턴 [추론]**

1. `승인 정책` 묶음에 행 `작업자 추가`, `GitHub에 올리기`. 오른쪽 switch, 기본 꺼짐, 누르면 즉시 저장.
2. "지침으로 지키는 항목" 같은 구분 표시나 subtext는 두지 않는다(이 브랜치의 이전 커밋에서 이미 뺀 방향과 같다).
3. `GitHub에 올리기`는 격리 설정과 묶지 않는다. 격리가 켜져 있어도 정책 값은 저장 의미가 있으므로 비활성으로 만들지 않는다. 비활성으로 두면 이유가 화면에 없어 Apple Feedback과 부딪힌다.

### F. Lead 대화 입력창의 전달 방식

현재 입력창은 Lead 상태에 따라 아이콘 버튼이 바뀐다(쉬면 `보내기`, 실행 중이고 입력이 있으면 `중단하고 보내기`·`줄 세우기`). **[문서]** [기능 범위 › 조직 › Lead 대화](../features.md)

| 가이드 | 적용 패턴 |
|---|---|
| Apple | 현재 맥락에 관련 있는 동작만 보이고 쓸 수 없으면 숨김(context menu 원칙). 데이터 손실이 사용자가 고른 동작의 예상 결과면 경고 안 함(**[문서]** [Context menus](https://developer.apple.com/design/human-interface-guidelines/context-menus), [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)) |
| One UI | 지금 끝낼 수 없는 선택지를 내지 않음. 아이콘 버튼은 길게 누르면 label(**[문서]** [Focused and purposeful](https://developer.samsung.com/one-ui/writing/focused-and-purposeful.html), [Toasts](https://developer.samsung.com/one-ui/comp/toast.html)) |
| M3 | 맥락에 따라 동작을 동적으로 내는 칩 원칙, 한 배치에 버튼 3개 이하, 아이콘 버튼은 plain tooltip. 메뉴에 넣으면 비활성 유지 규칙(**[문서]** [Chips](https://m3.material.io/components/chips/guidelines), [Tooltips](https://m3.material.io/components/tooltips/guidelines), [Menus](https://m3.material.io/components/menus/guidelines)) |
| SEED | Segmented Control은 보기 전환·필터용이라 전달 방식에 맞지 않음(**[문서]** [Segmented Control](https://seed-design.io/components/segmented-control)) |
| 토스 | 오류만 낼 선택지는 목록에서 뺀다(에러 원칙 1) |

- 일치: 못 하는 전달 방식은 숨긴다는 쪽이 Apple context menu·One UI·M3 칩·토스로 넷.
- 충돌: Apple 일반 메뉴·M3 메뉴의 비활성 규칙. 드롭다운으로 만들지 않으면 해당하지 않는다.

**권장 패턴 [추론]**

1. 지금의 맥락 아이콘 버튼 묶음을 유지한다. Lead가 실행 중이고 입력이 있으면 `중단하고 보내기`·`실행 중 끼워 넣기`·`줄 세우기` 세 개(M3 3개 이하 충족). Enter는 `줄 세우기` 그대로.
2. Lead의 프로바이더가 끼워 넣기를 못 하면 `실행 중 끼워 넣기` 버튼을 그리지 않는다. 비활성 버튼이나 tooltip 설명으로 남기지 않는다.
3. 버튼마다 이름표 tooltip(마우스 올림·키보드 focus·길게 누름). 설명형 rich tooltip은 쓰지 않는다.
4. 실행 시점에 거절된 끼워 넣기는 입력창 위 줄 세운 메시지 목록에 나타나는 것으로 끝난다. 알림 문구는 띄우지 않는다.
5. `중단하고 보내기`는 사용자가 고른 동작이라 확인 대화 상자를 두지 않는다(지금과 같음).
6. 관찰: 기능 범위에 적힌 줄 세운 항목의 `재개하면 먼저 전달` 설명은 이 원칙과 맞지 않는다(2026-10-30 사용자 결정으로 화면·기능 문서에서 뺐다). 일시정지 상태가 이미 화면에 보이므로 빼는 것을 검토할 만하다. 판 2 범위 밖이다.

### G. 실행 시도 상세: 토큰 사용량과 비용

| 가이드 | 적용 패턴 |
|---|---|
| Apple | 상태는 관련 항목 가까이 수동적으로. 쓸 수 없는 항목을 말하는 글은 tertiary label 색(**[문서]** [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback), [Labels](https://developer.apple.com/design/human-interface-guidelines/labels)) |
| One UI | 색 + 추가 표시 |
| M3 | 1,000 이상 숫자에 쉼표, 목록 trailing text는 메타 정보(**[문서]** [Style guide](https://m3.material.io/foundations/content-design/style-guide/ux-writing-best-practices), [Lists](https://m3.material.io/components/lists/guidelines)) |
| SEED | 숫자는 아라비아 숫자. 묶음 정보는 Tag Group(6~10자)(**[문서]** [Writing](https://seed-design.io/foundations/writing), [Tag Group](https://seed-design.io/components/tag-group)) |
| 토스 | 비용을 숨기지 않는다(Respect). TDS `TableRow`(이름·값 표) **[미확인: TableRow 설명 문구는 읽지 않음]** |

- 일치: 이름-값 표, 숫자 서식, 값 없음은 흐린 글자.
- 충돌: 토스 긍정형 vs `보고 안 됨`(2.4, 예외로 해소).

**권장 패턴 [추론]**

1. 이름-값 표 하나: `입력`, `출력`, `캐시 읽기`, `캐시 쓰기`, `비용`. 값은 오른쪽 정렬, 천 단위 쉼표, 단위(`토큰`, 통화).
2. 프로바이더가 주지 않은 값은 `보고 안 됨`을 tertiary label 색으로. 0과 섞이지 않게 숫자 자리에 둔다.
3. 추정 비용은 값 옆 Neutral 배지 `추정`. 각주 문장은 두지 않는다.
4. 표 머리에 이 실행 시도의 `프로바이더 · 모델` 값(C의 3과 연결).

### H. 산출물 목록·단건(조직 폴더에서 등록한 파일)

| 가이드 | 적용 패턴 |
|---|---|
| Apple | 목록·표는 글 훑기에 맞음, 열 머리는 명사. 좁으면 가운데 말줄임으로 이름 구분 유지. 빈 화면은 다음 행동을 안내(**[문서]** [Lists and tables](https://developer.apple.com/design/human-interface-guidelines/lists-and-tables), [Writing](https://developer.apple.com/design/human-interface-guidelines/writing)) |
| One UI | 빈 화면이면 행동 버튼, 할 일이 없으면 돌아갈 길(**[문서]** [Focused and purposeful › Take an action](https://developer.samsung.com/one-ui/writing/focused-and-purposeful.html)) |
| M3 | leading icon은 항목을 빨리 알아보게, trailing text는 크기 같은 메타. 잘린 글은 tooltip으로 전체(**[문서]** [Lists](https://m3.material.io/components/lists/guidelines), [Writing › Text truncation](https://m3.material.io/foundations/writing/text-truncation)) |
| SEED | List Item, Skeleton(반복 목록 로딩)(**[문서]** [List](https://seed-design.io/components/list), [Skeleton](https://seed-design.io/components/skeleton)) |
| 토스 | `ListRow` left(아이콘)·contents·right(부가 정보) |

- 일치: 종류 아이콘 + 이름 + 크기·시각 메타의 목록 행.
- 충돌: Apple·One UI의 빈 화면 안내 권고. 산출물은 에이전트가 만들어 사용자가 할 행동이 없으므로 안내 문장 대신 빈 상태 값을 둔다.

**권장 패턴 [추론]**

1. 목록 행: 왼쪽 파일 종류 아이콘, 가운데 이름(넘치면 가운데 말줄임 + 전체 이름 tooltip), 오른쪽 `크기`·`등록 시각`·만든 에이전트. 넓은 화면은 같은 내용을 열 머리 있는 표로.
2. 단건: Markdown·텍스트는 본문 렌더링(판 1과 같음). 그 밖의 파일은 이름-값 표(`이름`, `종류`, `크기`, `등록 시각`, `원래 경로`)만 보인다. "미리 볼 수 없어요" 같은 문장은 두지 않는다. 본문 자리가 없는 것 자체가 상태다.
3. "등록 뒤 파일이 바뀌어도 내용은 그대로" 같은 설명은 두지 않는다. `등록 시각` 값이 기준 시점을 보인다.
4. 로딩은 Skeleton, 빈 목록은 화면 이름과 `0` 개수 표시만 둔다.

## 4. 판 2 티켓에 붙일 요약

| 화면 | 권장 패턴 |
|---|---|
| A 전역 설정 | 프로바이더마다 목록 행(이름 + 준비 상태 배지·이유 코드 + 동시 실행 상한 stepper 최소 1·기본 2). `Lead 기본값`·`작업자 기본값`은 프로바이더·모델 Select(모델 첫 옵션 `기본 모델`), 미리 압축은 단위 suffix 숫자 칸 + stepper. 격리는 즉시 반영 switch. Select·숫자 묶음은 `저장` + 초안 보존. 설명 subtext·안내문 없음 |
| B 새 연구 조직 창 | Lead 프로바이더·모델 Select를 전역 Lead 기본값으로 채우고, 프로바이더 칸 옆에 준비 상태 배지. 버튼 `닫기`·`만들기`, 좁은 화면은 bottom sheet, 닫아도 초안 보존 |
| C 에이전트 설정 | B와 같은 Select 두 개 + `저장`. 프로바이더를 바꾸면 모델이 `기본 모델`로 바뀌고 확인 대화 상자 없음. 적용 시점은 실행 시도 목록의 `프로바이더 · 모델` 값으로 보임 |
| D 승인 상세 | 팀 구성 표(역할·이름·프로바이더·모델·상태) 줄마다 Select 두 개를 Lead 제안으로 채움. 바꾼 줄은 `변경` 배지 + `되돌리기`, 초안 보존. 결정 뒤 `Lead 제안`·`결정` 두 열로 읽기 전용 |
| E 조직 설정 | `승인 정책` 묶음에 `작업자 추가`·`GitHub에 올리기` 행, 오른쪽 switch, 기본 꺼짐, 즉시 저장. subtext·구분 표시 없음 |
| F Lead 입력창 | 맥락 아이콘 버튼 묶음 유지(최대 3개). 끼워 넣기를 못 하는 프로바이더면 `실행 중 끼워 넣기` 버튼을 그리지 않음(비활성 아님). 드롭다운·segmented control로 만들지 않음. 이름표 tooltip만 |
| G 실행 시도 상세 | 이름-값 표(입력·출력·캐시 읽기·캐시 쓰기·비용), 천 단위 쉼표와 단위. 없는 값은 흐린 색 `보고 안 됨`, 추정 비용은 `추정` 배지 |
| H 산출물 | 목록 행(종류 아이콘·이름 가운데 말줄임·크기·등록 시각). 단건은 Markdown 렌더링, 그 밖은 이름-값 표만. 미리보기 불가·내용 고정 설명문 없음 |

공통: 상태는 SEED `Badge` 톤(Positive·Critical·Neutral) + 아이콘 + 짧은 라벨. 구조적으로 못 하는 선택지는 숨기고, 잠깐 못 하는 것만 이유가 값으로 보일 때 비활성.

## 검증 결과와 한계

- 다섯 가이드의 본문 글만 읽었다. Do/Don't 그림, Figma 이미지, 예시 화면은 보지 못했다. One UI Writing 쪽의 Do/Don't 예시, 토스 UX 라이팅의 예시 문구(그림), SEED의 DoImage·DontImage 설명 외 그림 내용은 **[미확인]**이다.
- Apple과 M3는 사이트가 쓰는 본문 데이터로 읽었다. 화면에 보이는 문구와 같다고 보지만 렌더링한 페이지와 대조하지는 않았다. Apple HIG에는 Badges 쪽이 없어 데이터를 받지 못했다 **[미확인]**.
- One UI 공개 가이드는 컴포넌트가 여덟 개뿐이다. Switch·Select·Badge·Text field 규칙은 없고 Material로 넘긴다. One UI 근거는 대부분 Writing·Lists·Accessibility에서 왔다.
- 토스는 단일 "디자인 가이드"가 공개되어 있지 않다. 앱인토스 UI/UX 가이드를 주 근거로, TDS Mobile 문서와 toss.tech 글 두 편을 보조로 썼다. TDS Mobile 문서는 컴포넌트 속성·예제 위주라 설계 규칙이 적다. TableRow·Tooltip·Toast·Menu·BottomSheet 쪽은 읽지 않았다.
- SEED의 Alert Dialog UX Writing은 별도 Notion 문서로 넘기며 공개되지 않았다 **[미확인]**. SEED Text Input·Checkbox·Radio 본문 중 비교표 외 부분은 읽지 않았다.
- 각 가이드는 자기 플랫폼(iOS·macOS, Android·One UI, 당근·토스 앱) 기준이다. 데스크톱 웹 대시보드에 옮긴 것은 **[추론]**이다. 특히 Apple의 iOS 전용 규칙(switch는 목록 행에서만)과 macOS 규칙을 웹에 함께 적용했다.
- 화면을 만들거나 실행해 보지 않았다. 권장 패턴은 설계 제안이며, 2.4절의 띄어쓰기·닫기 버튼 이름·준비되지 않은 프로바이더 목록과 A절 6의 해결 컨트롤은 사용자 결정이 필요하다.
