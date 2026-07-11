# patch.md — правки aito1-tracker поверх upstream multica

Чек-лист всех модификаций, которые отличают наш форк от upstream'а `multica-ai/multica`. Использовать при синхронизации с upstream'ом, чтобы не потерять.

---

## Workflow обновления с upstream

### Безопасный merge (по умолчанию)

```bash
cd ~/Documents/Projects/aito1-tracker
git remote add upstream https://github.com/multica-ai/multica.git 2>/dev/null  # один раз
git fetch upstream
git checkout main
git merge upstream/main
# при конфликтах — разрешить, опираясь на этот документ
go test ./server/pkg/agent/... -count=1   # проверить, что наши тесты прошли
git push origin main
```

### Альтернатива — rebase (если хочешь линейную историю)

```bash
git fetch upstream
git rebase upstream/main
# наши коммиты применятся поверх upstream/main
go test ./server/pkg/agent/... -count=1
git push --force-with-lease origin main
```

⚠️ `--force-with-lease` нужен после rebase, и он **переписывает чужую историю на GitHub** — после этого все, у кого есть локальный клон, должны сделать `git fetch && git reset --hard origin/main`.

### Чего нельзя делать

- `git reset --hard upstream/main` — это снесёт наши коммиты вообще.
- `git pull` без `--rebase` или явного merge на конфликтном файле может молча перезаписать наш код.
- Запускать установщик AITO1 без проверки, что клон содержит **оба** наших коммита (см. ниже).

---

## Проверка целостности

После любого pull/merge/rebase:

```bash
git log --oneline | grep -E "fix\(agent\): switch managed|fix\(agent\): support managed|feat\(ui\): like-only|build\(web\): outputFileTracingRoot"
```

Должно показать **пять** строк:
- `27ece86c fix(agent): switch managed permission mode from dontAsk to acceptEdits`
- `4008d298 fix(agent): support managed permission policies in claude backend`
- `c05c6391 feat(ui): like-only reactions, scoped to comments`
- `build(web): outputFileTracingRoot for monorepo standalone` *(см. патч 6)*
- `feat: drop reply mechanic — flat comments only` *(см. патч 7)*

(хеши после rebase будут другие, но названия коммитов сохранятся.)

И подтверждение по содержимому:
```bash
grep -c "acceptEdits" server/pkg/agent/claude.go    # ожидаем ≥ 2
grep -c "control_request" server/pkg/agent/claude.go # ожидаем ≥ 1 (case в loop)
grep -c "Keep stdin open" server/pkg/agent/claude.go # ожидаем 1 (наш комментарий)
test -f packages/ui/components/common/like-button.tsx && echo ok  # патч 5
test ! -f packages/ui/components/common/quick-emoji-picker.tsx && echo ok  # патч 5
grep -c "outputFileTracingRoot" apps/web/next.config.mjs  # патч 6, ожидаем 1
test -f apps/web/next.config.mjs && test ! -f apps/web/next.config.ts && echo ok  # патч 18
grep -c "issue.identifier" packages/views/issues/components/board-card.tsx  # патч 17, ожидаем 1
grep -c "issue.identifier" packages/views/issues/components/list-row.tsx  # патч 17, ожидаем 1
test -x scripts/aito1-deploy.sh && echo ok  # патч 6
test ! -f packages/views/issues/components/reply-input.tsx && echo ok  # патч 7
grep -c "isReplyToMemberThread" server/internal/handler/comment.go  # патч 7, ожидаем 0
grep -c "shouldInheritParentMentions" server/internal/handler/comment.go  # патч 7, ожидаем 0
grep -c "HasAgentRepliedInThread" server/pkg/db/queries/comment.sql  # патч 7, ожидаем 0
```

---

## Список патчей

### Патч 1 — `handleControlRequest` подключён + stdin pipe держится открытым

**Файл:** `server/pkg/agent/claude.go`
**Коммит:** `4008d298` (исходный fix)
**Зачем:** под Jamf-managed Claude Code в режиме `bypassPermissions` / `auto` происходит **silent downgrade** до `default`, и Claude шлёт каждое использование инструмента через stream-json `control_request`. В upstream `handleControlRequest` уже написан и протестирован (`TestClaudeHandleControlRequestAutoApproves`), но **не подключён** к event-loop, плюс `stdin` закрывался сразу после prompt'а — отвечать было физически некуда.

**Что изменено:**

1. Убран ранний `closeStdin()` сразу после `writeClaudeInput`. Замена — explanatory комментарий «Keep stdin open». Найти место по контексту:
   ```go
   if err := writeClaudeInput(stdin, prompt); err != nil { ... }
   closeStdin()                                  // ← было это
   b.cfg.Logger.Info("claude started", ...)
   ```
   Заменить `closeStdin()` на:
   ```go
   // Keep stdin open: under managed permission policies (Jamf, etc.) the CLI
   // downgrades bypassPermissions/auto to default and emits stream-json
   // control_request messages for every tool use. handleControlRequest writes
   // the auto-allow control_response back through stdin, so the pipe must stay
   // open until "result" is observed (or the run is cancelled).
   ```

2. Cancel-goroutine закрывает stdin рядом с stdout:
   ```go
   // было:
   go func() { <-runCtx.Done(); _ = stdout.Close() }()

   // стало:
   go func() {
       <-runCtx.Done()
       _ = stdout.Close()
       closeStdin()
   }()
   ```

3. В switch на `msg.Type` добавить case (после `case "log"`):
   ```go
   case "control_request":
       b.handleControlRequest(msg, stdin)
   ```

**Тест:** `claude_test.go::TestClaudeHandleControlRequestAutoApproves` уже есть в upstream — после патча он по-прежнему проходит, и плюс рабочий E2E под managed policy.

---

### Патч 2 — `--permission-mode` = `acceptEdits`

**Файл:** `server/pkg/agent/claude.go`
**Коммит:** `27ece86c`
**Зачем:** под managed policy `bypassPermissions` и `auto` молча даунгрейдятся до `default`. Из доступных только `acceptEdits` и `dontAsk` сохраняют себя; `dontAsk` — **auto-deny** (всё что не в allowlist'е → отказ), не подходит. `acceptEdits` оставляет Edit/Write автоматическими, остальное гонит через `control_request`, который мы авто-апрувим патчем 1.

**Что изменено:**

В `buildClaudeArgs`:
```go
// было:
"--permission-mode", "bypassPermissions",

// стало:
"--permission-mode", "acceptEdits",
```

В `claudeBlockedArgs` обновить комментарий рядом с `--permission-mode`:
```go
"--permission-mode": blockedWithValue,  // acceptEdits + handleControlRequest auto-allow under managed policies
```

---

### Патч 3 — тест `TestBuildClaudeArgsIncludesStrictMCPConfig` ожидает `acceptEdits`

**Файл:** `server/pkg/agent/claude_test.go`
**Коммит:** `27ece86c`

```go
// было:
"--permission-mode", "bypassPermissions",

// стало:
"--permission-mode", "acceptEdits",
```

**2026-05-31:** в `expected` дописана пара `"--setting-sources", "user,project,local"` — `buildClaudeArgs` отдаёт её (см. блок про `--setting-sources` ниже), а тест отстал и падал `expected 9 args, got 11`. Список `expected` обязан совпадать с фактическим выводом `buildClaudeArgs` 1:1.

---

### Патч 4 — тест `TestClaudeExecuteSurfacesStderrWhenChildExitsEarly` (fake claude читает 1 строку)

**Файл:** `server/pkg/agent/claude_test.go`
**Коммит:** `4008d298`
**Зачем:** в патче 1 stdin не закрывается сразу. Старый fake script `cat >/dev/null` дренировал stdin до EOF — без EOF теперь висит до timeout. Заменили на `head -n 1` — читает ровно одну строку (наш prompt) и выходит, симулируя реалистично.

**Что изменено:**
```go
// было:
script := "#!/bin/sh\n" +
    "cat >/dev/null\n" +
    "echo \"FATAL ERROR: V8 abort: assertion failed\" >&2\n" +
    "exit 3\n"

// стало:
script := "#!/bin/sh\n" +
    "head -n 1 >/dev/null\n" +
    "echo \"FATAL ERROR: V8 abort: assertion failed\" >&2\n" +
    "exit 3\n"
```

И обновлён комментарий выше про обоснование (см. коммит).

---

### Патч 5 — like-only reactions, scoped to comments (UI)

**Файлы:**
- `packages/ui/components/common/like-button.tsx` *(новый)*
- `packages/ui/components/common/quick-emoji-picker.tsx` *(удалён)*
- `packages/ui/components/common/reaction-bar.tsx`
- `packages/views/issues/components/comment-card.tsx`
- `packages/views/issues/components/issue-detail.tsx`

**Коммит:** `c05c6391`

**Зачем:** Brain как approve-сигнал слушает только 👍 на комментарии Planner / Executor / Reflector (см. `_on_reaction_added` в `brain/listener/state_machine.py` репозитория AITO1). Остальные эмодзи и `issue_reaction` система игнорирует — но UI это позволял ставить, и пользователь не понимал, почему ничего не произошло. Сводим UI к единственному действию: «👍» на коммент.

**Что изменено:**

1. **Новый `LikeButton`** — одна кнопка-тоггл `onClick={() => onToggle("👍")}`. Add/remove по уже существующей реакции текущего юзера разруливает сам хук (`useToggleCommentReaction` / `useToggleIssueReaction`), кнопка про это не знает.
2. **`reaction-bar.tsx`** — `QuickEmojiPicker` заменён на `LikeButton`. Кнопка скрывается, если юзер уже лайкнул (`userAlreadyLiked = grouped.some(g => g.emoji === "👍" && g.reacted)`) — тоггл-снять остаётся доступен кликом по самому бейджу в группе.
3. **`comment-card.tsx`** — picker из шапки коммента (рядом с copy / edit / delete, обе точки: top-level и threaded reply) **удалён целиком**. Лайк живёт в `<ReactionBar>` под телом коммента — это единственное место.
4. **`issue-detail.tsx`** — `<ReactionBar reactions={issueReactions} …>` под description-editor'ом убран. Импорт `ReactionBar` / `useIssueReactions` и деструктуринг хука вычищены как dead code.
5. **`quick-emoji-picker.tsx`** удалён — use-site'ов больше нет. **`emoji-picker.tsx` оставлен** — используется для иконок проектов в `project-detail.tsx` / `create-project.tsx`.

**Что НЕ трогаем (намеренно):**

- **Хук `use-issue-reactions.ts`** — экспортируется из `packages/views/issues/hooks/index.ts` как часть upstream API; `issue-detail.test.tsx` mock'ает его через `listIssueReactions`. Удаление породило бы лишние merge-конфликты.
- **Бекенд** (`server/internal/handler/reaction.go`, `issue_reaction` / `comment_reaction` таблицы, WS-events `issue_reaction:added` / `comment_reaction:added`) — single-user, прямого API-доступа извне нет, defense-in-depth избыточен. Если когда-нибудь подключим внешних клиентов, добавить whitelist `emoji != "👍" → 400` отдельным патчем 5b.
- **`EmojiPicker`** в `packages/ui/components/common/emoji-picker.tsx` — нужен для иконок проектов.

**Проверки после правки:** `pnpm --filter @multica/views test` (327/327 ✅), `pnpm --filter @multica/ui --filter @multica/views typecheck` (чисто), `lint` без новых warning'ов.

**Если конфликт при merge/rebase:**

| Конфликт | Что делать |
|---|---|
| Upstream вернул `QuickEmojiPicker` (новые quick-emojis, ребрендинг) | Удалить upstream-файл, наш `like-button.tsx` оставить. В `reaction-bar.tsx` оставить `LikeButton` + логику `userAlreadyLiked`. |
| Upstream отрефакторил `ReactionBar` (новые props, другая структура grouped) | Перенести `userAlreadyLiked` (любой derived-флаг по 👍 текущего юзера) и `<LikeButton onToggle={onToggle} />` на новые props; пикер не возвращать. |
| Upstream добавил новую точку использования picker'а в коммент-UI (шапка / hover-row / inline) | Удалить целиком. Единственное разрешённое место для add-like — `<ReactionBar>` под телом коммента. |
| Upstream вернул `<ReactionBar>` в `issue-detail.tsx` (под description) | Удалить блок и зачистить ставшие unused импорты `ReactionBar` / `useIssueReactions` + деструктуринг хука. Сам файл `use-issue-reactions.ts` оставить. |

---

### Патч 6 — AITO1 deploy: source → artifact → run

**Файлы:**
- `apps/web/next.config.ts` (правка над upstream — `outputFileTracingRoot`)
- `scripts/aito1-deploy.sh` *(новый, AITO1-специфичный — не для upstream PR)*
- `.gitignore` (`next-env.d.ts` добавлен — flaps между `next dev` и `next build`)
- `apps/web/next-env.d.ts` *(удалён из tracking; файл остаётся на диске, генерится Next.js)*

**Зачем:** до этого патча установщик AITO1 клонировал второй экземпляр форка в `~/.aito1/multica-src` и launchd-сервисы стартовали оттуда. Это создавало два HEAD'а одного репо (dev-клон в `~/Documents/...` + production-клон в `~/.aito1/multica-src`), которые надо было руками синхронизировать `cp`'ями. Кроме того, симлинк `~/.aito1/multica-src → ~/Documents/...` не работает из-за macOS TCC: launchd-сервисы не могут читать `.env` через симлинк, ведущий в `~/Documents/`.

Переходим на стандартный flow «source → build → artifact → run»: dev-клон — единственный source of truth, `pnpm build` / `go build` создают артефакты, скрипт `aito1-deploy.sh` копирует их в `~/.aito1/`, плисты launchd стартуют ровно артефакты. `~/.aito1/multica-src` уходит совсем.

**Что изменено:**

1. **`apps/web/next.config.ts`** — внутри `STANDALONE === "true"` ветки добавлен `outputFileTracingRoot: resolve(__dirname, "../..")`. Без этого Next.js в pnpm-монорепо детектит workspace root по lockfile'у наугад (видит `~/package-lock.json` от других проектов) и упаковывает standalone-bundle с уродливым префиксом пути. Поведение **только при `STANDALONE=true`** — обычный dev-старт (`pnpm --filter web dev`) не затронут.

2. **`scripts/aito1-deploy.sh`** — единая точка входа для деплоя. `./scripts/aito1-deploy.sh frontend|backend|all`:
   - **frontend:** `STANDALONE=true pnpm --filter web build` → копирует `apps/web/.next/standalone/.` + `static` + `public` в `~/.aito1/web/` (~100 MB вместо 1.5 GB workspace `node_modules`). Рестарт `ai.aito1.multica.frontend`.
   - **backend:** `go build` для `cmd/server` (multica-server), `cmd/multica` (daemon CLI), `cmd/migrate` → в `~/.aito1/multica/bin/`. Рестарт `ai.aito1.multica.backend` + `ai.aito1.multica.daemon`.

**Связанные правки вне репо** (плисты + установщик):
- `~/Library/LaunchAgents/ai.aito1.multica.frontend.plist`: `cd .../multica-src; pnpm --filter web start` → `node /Users/wwax/.aito1/web/apps/web/server.js`. WorkingDirectory → `~/.aito1/web`.
- `~/Library/LaunchAgents/ai.aito1.multica.backend.plist`: `.env` source с `~/.aito1/multica-src/.env` → `~/.aito1/multica.env` (физическая копия, не через симлинк). WorkingDirectory → `~/.aito1`.
- Установщик AITO1 (фаза `40_multica.sh`): должен прекратить клонировать второй экземпляр форка и принимать путь к существующему dev-клону через env / install.json. **Отдельная задача**, в этом PR не делается — пока deploy руками через скрипт после первоначальной установки.

**Если конфликт при merge/rebase:**

| Конфликт | Что делать |
|---|---|
| Upstream выпилил флаг `STANDALONE` или поменял условие | Перенести `outputFileTracingRoot: resolve(__dirname, "../..")` в новую конфигурацию standalone. Без него pack ломается. |
| Upstream добавил свой `outputFileTracingRoot` | Принять upstream-значение, проверить что bundle собирается с правильной структурой (`.next/standalone/apps/web/server.js` без префикса `Documents/...`). |
| Upstream поменял layout `apps/`, `server/cmd/` | Поправить пути в `scripts/aito1-deploy.sh` (один `cp -R` для frontend и три `go build` для backend — точечно). |

---

### Патч 7 — `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` для всех агентов

**Файл:** `server/pkg/agent/claude.go`
**Зачем:** Claude Code CLI (v2.1.59+) имеет встроенную auto-memory, которая пишет в `~/.claude/projects/<workspace>/memory/MEMORY.md` и подгружает первые 200 строк в каждую сессию. Это **конфликтует** с архитектурой AITO1: Brain — единственный владелец памяти (`aito1_facts` / `aito1_procedural` / `aito1_knowledges`), а параллельный нерегулируемый storage в `~/.claude` обходит весь governance (provenance, bi-temporal, event log, Pydantic-schema).

**Что изменено:**

В `buildEnv` после `mergeEnv` явно дописываем переменную, потому что `mergeEnv → isFilteredChildEnvKey` срезает все `CLAUDE_CODE_*` из parent env'а:

```go
func buildEnv(extra map[string]string) []string {
    env := mergeEnv(os.Environ(), extra)
    // AITO1-patch: disable Claude Code built-in auto-memory for all pipeline
    // agents (Planner / Executor / Reflector / Auditor). Conflicts with
    // aito1_facts / aito1_procedural / aito1_knowledges — Brain is the single
    // owner of memory. Interactive `claude` sessions run by Human directly are
    // unaffected — env var applies only to subprocesses spawned by this daemon.
    // `mergeEnv` strips CLAUDE_CODE_* from parent env via isFilteredChildEnvKey,
    // so we inject the flag after the filter to guarantee it's set.
    env = append(env, "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1")
    return env
}
```

**Проверка после правки:**

```bash
# Перезапусти daemon
launchctl kickstart -k gui/$(id -u)/ai.aito1.multica.daemon
# Запусти любую задачу через AITO1
# Проверь, что новых memory-папок для pipeline-агентов не создаётся:
find ~/.claude/projects -type d -name memory -newer /tmp/aito1_memory_stamp
```

**Если конфликт при merge/rebase:** если upstream рефакторит `buildEnv` (новая сигнатура, добавляется dependency injection) — главное сохранить, что переменная **гарантированно** доходит до child-процесса. Проще всего: добавить `extra["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"` непосредственно перед `mergeEnv`, либо хардкодом в массив после filter'а — конкретное место не важно, важна семантика «всегда установлено в subprocess».

**Связано в AITO1 репо:**
- `plans/memory-system-design.md` §6.13 — обоснование решения.
- `docs/memory-system.md` — раздел «Auto-memory Claude Code — отключена».

---

### Патч 8 — поднять лимиты на вывод инструментов

**Файл:** `server/pkg/agent/claude.go`
**Зачем:** Дефолты Claude Code (25k токенов на `Read`/MCP-вывод, ~25k на `Bash` до сброса в файл) рассчитаны на десктоп-сценарий, когда юзер сам решает, как читать большой файл. У AITO1 скиллы вроде `aito1_recall`, `wiki-cli.sh show`, `tracker-cli.sh show` штатно возвращают 30–90 КБ — агент упирается в лимит, 3-4 раза подряд снижает `limit=N` (Claude Code SDK считает токены **до** применения limit, отказ повторяется), теряет ~30 секунд на ровном месте.

**Что изменено:**

В `buildEnv`, рядом с патчем 7, дописываем четыре переменные:

```go
env = append(env, "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=40000")
env = append(env, "CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000")
env = append(env, "MAX_MCP_OUTPUT_TOKENS=40000")
env = append(env, "BASH_MAX_OUTPUT_LENGTH=40000")
env = append(env, "MCP_TIMEOUT=120000")
```

`mergeEnv → isFilteredChildEnvKey` срезает все `CLAUDE_CODE_*` из parent env'а, поэтому переменные пишутся **после** фильтра — иначе значение из родительской shell-сессии пользователя протекло бы и затёрло наш дефолт.

**`MCP_TIMEOUT=120000` (добавлен 2026-05-31):** дефолтный лимит старта MCP-сервера в Claude Code — 30 с. `gmail-mcp` (`@gongrzhe/server-gmail-autoauth-mcp`) холодно стартует 20–30 с (загрузка node-модулей + OAuth token refresh), упираясь в этот потолок; когда несколько stdio-серверов (gmail/perplexity/playwright) поднимаются одновременно, конкуренция добивает gmail за 30 с. Упавший сервер Claude Code в рамках сессии **не переподнимает** → агент видит gmail-tools недоступными и уходит в `[BLOCKED]`. Диагностировано на issue `44d85146`, Executor-сессия `79936ea0`: `Connection timeout triggered after 30458ms (limit: 30000ms)`; соседние прогоны той же задачи стартовали за 1.5 с (тёплый) и 24 с (впритык). 120 с даёт медленным cold-start'ам запас. `MCP_TIMEOUT` `isFilteredChildEnvKey` не режет — место в массиве не критично.

**Почему 40k, а не 100k:** Anthropic ставит дефолт 25k не от жадности — большой single-shot вывод раздувает контекст агента и ухудшает рассуждение. 40k закрывает текущие AITO1-кейсы и оставляет защиту от «всю вики в одну Read'у».

**Параллельная задача:** разобраться, почему `aito1_recall` штатно отдаёт 31k токенов одному агенту — это симптом, а не норма. Лимит — только пластырь.

**Проверка после правки:**

```bash
# Пересборка + деплой multica (см. memory: reference_multica_build_and_deploy.md).
launchctl kickstart -k gui/$(id -u)/ai.aito1.multica.daemon
# Прогнать любую задачу с большим recall'ом и убедиться, что в trace нет
# "File content (N tokens) exceeds maximum allowed tokens (25000)":
psql -h localhost -p 5433 aito1 -tAc \
  "SELECT output FROM task_message WHERE output LIKE '%exceeds maximum allowed tokens%' AND created_at > now() - interval '1 hour';"
```

**Если конфликт при merge/rebase:** см. патч 7 — то же правило, главное чтобы `env = append(env, "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=…")` оказался **после** `mergeEnv`. Если апстрим унифицирует env-конфиг в отдельный helper — перенести три CLAUDE_CODE_*-переменные туда (MAX_MCP_OUTPUT_TOKENS и BASH_MAX_OUTPUT_LENGTH `isFilteredChildEnvKey` не режет — их можно ставить где угодно или вообще отдать на откуп оператору).

**Связано в AITO1 репо:**
- `memory/reference_blocking_skills_for_e2e.md` — про работу с большими выдачами скиллов.

---

### Патч 9 — sub-second precision в timeline ordering

**Файлы:** `server/internal/util/pgx.go`, `server/internal/handler/activity.go`
**Зачем:** Коммент Teamlead'а (Brain auto-approve hint, `member`-автор) в UI отображался **выше** Planner-коммента (`agent`-автор), хотя Brain постит его на ~900 мс позже Planner-плана. Хронологически правильный порядок — Planner сверху (создан раньше), Brain ниже.

**Корневая причина:**
1. `util.TimestampToString` форматировал через `time.RFC3339` без долей секунды → два события с разницей < 1 сек получали идентичную строку `2026-05-15T09:23:45+03:00`.
2. `mergeTimelineDesc` / `mergeTimelineAscThenReverse` в `handler/activity.go` сравнивали `TimelineEntry.CreatedAt` как строку. При равенстве срабатывал tie-breaker по `out[i].ID > out[j].ID` (UUID лексикографически DESC). UUID Planner'а случайно оказался лексикографически больше UUID Teamlead'а, поэтому Planner попадал первым в DESC-массив, Teamlead — вторым.
3. UI делает `flat.reverse()` в `use-issue-timeline.ts` → ASC массив `[Teamlead, Planner]` → Teamlead визуально выше / раньше.

**Что изменено:**

```go
// util/pgx.go
func TimestampToString(t pgtype.Timestamptz) string {
    if !t.Valid { return "" }
    return t.Time.Format(time.RFC3339Nano)  // было: time.RFC3339
}
// TimestampToPtr — аналогично
```

```go
// handler/activity.go — TimelineEntry: добавлено приватное поле для сортировки
type TimelineEntry struct {
    // ... existing exported fields ...
    createdAtTime time.Time  // не сериализуется (lowercase), хранит точный pgtype.Timestamptz.Time
}

// commentsToEntries / activityToEntry — заполняют createdAtTime: c.CreatedAt.Time / a.CreatedAt.Time

// mergeTimelineDesc / mergeTimelineAscThenReverse — теперь сравнивают по time.Time:
sort.Slice(out, func(i, j int) bool {
    if !out[i].createdAtTime.Equal(out[j].createdAtTime) {
        return out[i].createdAtTime.After(out[j].createdAtTime)  // или .Before для ASC
    }
    return out[i].ID > out[j].ID  // или < для ASC
})
```

**Почему «гибридный» вариант (C):**
- Только `RFC3339Nano` в `TimestampToString` — лечит сериализацию, но оставляет string-сравнение в Go (хрупкий антипаттерн, легко регрессирует если кто-то добавит ещё одно поле сортировки).
- Только сортировка по `time.Time` — лечит порядок, но клиент всё равно получает truncated timestamps в JSON, что вредит другим клиентам (mobile / автотесты).
- Гибрид: точные байты на проводе + сортировка по типу-данных. Серверная сортировка не зависит от строки.

**Совместимость:**
- `RFC3339Nano` — strict superset RFC3339. JavaScript `new Date(...)`, Python `dateutil.parser.parse`, Go `time.Parse(time.RFC3339Nano, ...)` все понимают и `2026-05-15T09:23:45+03:00`, и `2026-05-15T09:23:45.040154+03:00`. Парсер курсора (`entryTimestamp` в `activity.go:559`) уже использовал `RFC3339Nano` — совместимость подтверждена.
- `Format(time.RFC3339Nano)` отбрасывает trailing zeros: время с миллисекундами `.040` форматируется как `.04`, а ровное по секунде — как RFC3339 без точки. Парсеры это понимают.

**Проверка после правки:**

```bash
# Микросекунды должны быть видны на /timeline:
TOKEN=$(jq -r .token ~/.multica/profiles/aito1/config.json)
WS=$(jq -r .workspace_id ~/.multica/profiles/aito1/config.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8090/api/issues/<issue_id>/timeline?limit=20&workspace_id=$WS" \
  | jq '.entries | reverse | [.[] | {type, actor_type, created_at}]'
# Должно показывать формат "2026-05-15T09:23:45.040154+03:00", и Planner-коммент идёт раньше Teamlead-коммента.

# Тесты прошли:
cd ~/Documents/Projects/aito1-tracker/server
go test ./internal/handler/... -run 'Timeline|Comment' -count=1
go test ./internal/util/... -count=1
```

**Если конфликт при merge/rebase:**
- Если upstream переходит на `pgtype.Timestamptz`-serializer или меняет `RFC3339` → `RFC3339Nano` сам — наш патч становится no-op в `pgx.go`, оставить только изменения в `activity.go`.
- Если upstream меняет структуру `TimelineEntry` (добавляет поля, переименовывает) — главное сохранить, что сортировка идёт **не по string**, а по `time.Time` (или по `pgtype.Timestamptz.Time`).
- Если upstream переименовывает `mergeTimelineDesc` → искать любые `sort.Slice` по `CreatedAt`-строкам, лечить аналогично.

**Связано в AITO1 репо:**
- Симптом обнаружен на задаче `a5ceb280-35a0-4089-a182-42a6cde98989` (AIT-222).

---

## Если конфликт при merge/rebase

`server/pkg/agent/claude.go` — самый горячий файл (upstream активно его дорабатывает). Шаблон resolution:

| Конфликт | Что делать |
|---|---|
| Upstream поменял `buildClaudeArgs` (новый флаг, новый порядок) | Принять upstream-структуру, переставить `"--permission-mode", "acceptEdits"` обратно туда, где было `bypassPermissions`. |
| Upstream поменял event-loop (новые `case`'ы) | Принять upstream-кейсы, добавить наш `case "control_request"` рядом с `case "log"`. |
| Upstream начал слать `closeStdin()` где-то внутри loop'а сам | Удалить наш `closeStdin()` из cancel-горутины (чтобы не было двойного close), оставить случай где он закрывается единожды. |
| Upstream добавил sandbox-bypass через stream-json (новый `subtype` в `control_request`) | Расширить `handleControlRequest` (см. permission-management.md, сценарий C про логирование `control_request_raw`). |

После любого resolve:
```bash
go build ./server/... && go test ./server/pkg/agent/... -count=1
```

---

### Патч 7 — drop reply mechanic (flat comments only)

**Файлы:**
- `server/internal/handler/comment.go` — выпил parent-id обработки + двух guard-функций
- `server/internal/service/task.go` — `createAgentComment` без `parentID`
- `server/pkg/db/queries/comment.sql` — удалён query `HasAgentRepliedInThread`
- `server/pkg/db/generated/*.go` — регенерация sqlc
- `server/cmd/server/comment_trigger_integration_test.go` — выпил reply-сценариев
- `packages/views/issues/components/issue-detail.tsx` — flat-render
- `packages/views/issues/components/comment-card.tsx` — без nested replies + ReplyInput
- `packages/views/issues/components/reply-input.tsx` — **удалён**

**Зачем:** AITO1-pipeline (Planner / Executor / Reflector) общается через flat-комменты с маркерами в первой строке (`[PLAN vN]`, `[EXECUTOR REPORT]`, `[REFLECTION]`, `[BLOCKED]`, `[PLAN BLOCKED]`). Reply-механика upstream'а нам не нужна и активно мешает: усложняет UX, требует guard'а `isReplyToMemberThread`, провоцирует sleep'ы агентов в reply-цепочках. Заодно убираем «агент обязательно отвечает reply'ем на trigger comment» (`createAgentComment` поднимался к thread root и постил reply туда) — теперь агент пишет flat.

**База данных НЕ трогается.** Колонка `comment.parent_id` остаётся в схеме (миграции 017/018 upstream'а живут). Просто перестаём её писать и читать. Старые комменты с `parent_id != NULL` (если есть) остаются, рендерятся flat, никем не обрабатываются. Это сужает дифф, упрощает merge и оставляет дверь открытой к восстановлению механики, если когда-нибудь понадобится.

**Что изменено:**

1. **`comment.go`**:
   - `CommentResponse.ParentID *string` остаётся (контракт API не сужается); `commentToResponse` его выставляет из БД (для legacy-комментов будет non-nil, для новых — nil).
   - `CreateCommentRequest.ParentID *string` остаётся, **игнорируется** в обработке.
   - Удалён блок валидации `parent_id` (старые строки 198-213).
   - Удалён agent-anti-drift defense block (старые 223-247).
   - В `CreateCommentParams` всегда `ParentID: pgtype.UUID{}`.
   - В условии enqueue (старая строка 296) убран вызов `!h.isReplyToMemberThread(...)`.
   - Удалена функция `isReplyToMemberThread` целиком.
   - Удалена функция `shouldInheritParentMentions` целиком.
   - `enqueueMentionedAgentTasks` упрощена: убран параметр `parentComment`, нет наследования mentions от parent.

2. **`task.go::createAgentComment`**:
   - Удалён блок «подняться к thread root»:
     ```go
     // удалено:
     if parentID.Valid {
         if parent, err := s.Queries.GetComment(ctx, parentID); err == nil && parent.ParentID.Valid {
             parentID = parent.ParentID
         }
     }
     ```
   - Сигнатура без параметра `parentID`. В `CreateComment` всегда `ParentID: pgtype.UUID{}`.
   - Все вызовы (старые строки 695, 834) передают на один аргумент меньше.

3. **`comment.sql`**: query `HasAgentRepliedInThread` удалён, `sqlc generate` регенерирует.

4. **Frontend**:
   - `issue-detail.tsx`: убрана группировка `repliesByParent` и `topLevel`-фильтр; `submitReply` хук и prop в CommentCard выпилены.
   - `comment-card.tsx`: убраны `collectReplies`, рендер `allNestedReplies`, встроенный `<ReplyInput>`, collapsible-header с `reply_count`. Импорт `ReplyInput` снят.
   - `reply-input.tsx` удалён.
   - `TimelineEntry` тип: поле `parent_id` оставлено опциональным для совместимости с API.

**Тесты:** `comment_trigger_integration_test.go` — выпиливаем reply-сценарии (старые строки 241-520):
- `TestReplyRecordsNewCommentIDAsTriggerCommentID` — удалён.
- `TestReplyToMemberThreadWithoutMentionsSuppressesTrigger` — удалён.
- `TestReplyToMemberThreadAfterAgentRepliedTriggersAgent` — удалён.
- `TestReplyInThreadInheritsParentMention` — удалён.
- Helper `postComment(t, issueID, content, parentID)` упрощён без `parentID`.

Прогон: `cd server && go test ./... -count=1`.

**Frontend smoke**: `pnpm --filter @multica/views typecheck && pnpm --filter web typecheck && STANDALONE=true pnpm --filter web build` — все три прохода зелёные.

**Если конфликт при merge/rebase с upstream:**

| Конфликт | Что делать |
|---|---|
| Upstream добавил новое использование `parent_id` в API/UI | Принять upstream, **удалить** новые reply-блоки, оставив только flat path |
| Upstream вернул `<ReplyInput>` где-то ещё | Удалить, оставить плоский `<CommentCard>` |
| Upstream добавил новый guard на основе `parent_id` (типа нашего бывшего `isReplyToMemberThread`) | Удалить целиком — у нас reply нет |
| Upstream поменял sqlc-queries на comment'ах | Принять, проверить что ни один наш query не тянет `parent_id` (только legacy SELECT с *, оставлять) |
| Upstream сделал миграцию, удаляющую `parent_id` | Принять — это совместимо с нашим направлением |

**Что НЕ откатываем при rebase:**
- Любое возвращение reply UI (collectReplies, ReplyInput, replyCount-collapsible) удаляем заново.
- Любое возвращение `parentID` в `createAgentComment` подписи — снимаем; агенту flat-коммент.

---

### Патч 8 — Board: компактные колонки + 5-строчный заголовок + порядок blocked/done

**Файлы:**
- `packages/views/issues/components/board-column.tsx` — `w-[280px]` → `w-[196px]`
- `packages/views/issues/components/board-view.tsx` — DragOverlay `w-[280px]` → `w-[196px]` (синхронно с шириной колонки)
- `packages/views/issues/components/board-card.tsx` — `line-clamp-2` → `line-clamp-5` на заголовке
- `packages/core/issues/config/status.ts` — `blocked` поставлен перед `done` в `STATUS_ORDER`, `ALL_STATUSES`, `BOARD_STATUSES`

**Зачем:** при работе с AITO1 на маке хочется видеть больше колонок одновременно (todo / in_progress / in_review / blocked / done) без горизонтального скролла. Заголовки задач длинные («Изучить, что такое Стефания (корпоративный инструмент)») — двух строк мало, обрезается полезное. Логически `blocked` — это активный статус, требующий внимания (агент упёрся в `[BLOCKED]` / `[PLAN BLOCKED]`), и должен соседствовать с `in_review`, а не уходить за финальный `done`.

**Что изменено:** ширина board-колонки уменьшена на 30% (280 → 196), DragOverlay подгоняется к колонке, в карточке заголовок занимает до 5 строк (2026-05-13: 3→5, потому что после сужения колонок строки стали короче и трёх рядов всё равно мало под полные русские заголовки), `blocked` идёт перед `done`.

`HiddenColumnsPanel` (240px) **не трогали** — это сайдбар скрытых колонок, не карточка. Если визуально просядет — поменяем отдельно.

**Если конфликт при merge/rebase с upstream:**

| Конфликт | Что делать |
|---|---|
| Upstream поменял `w-[280px]` в `board-column.tsx` / `board-view.tsx` | Принять upstream-значение, умножить на 0.7 (или подобрать близкое). Главное — два места синхронны. |
| Upstream рефакторнул разметку карточки и `line-clamp-2` мигрировал | Найти clamp заголовка (после блока `identifier`), поставить `line-clamp-5`. |
| Upstream добавил настраиваемую ширину колонки в view-store | Использовать новый механизм, дефолт уменьшить на 30%. |
| Upstream поменял порядок в `STATUS_ORDER` / `ALL_STATUSES` / `BOARD_STATUSES` | Принять upstream, переставить `blocked` перед `done` во всех трёх массивах. |

### Патч 9 — service-account флаг на member: подавление on_comment-trigger

**Файлы:**
- `server/migrations/069_member_service_account.up.sql` (+ `.down.sql`) — `ALTER TABLE member ADD COLUMN IF NOT EXISTS is_service_account BOOLEAN NOT NULL DEFAULT FALSE`
- `server/pkg/db/queries/member.sql` — две sqlc-query: `IsMemberServiceAccount(workspace_id, user_id)`, `SetMemberServiceAccount(workspace_id, user_id, is_service_account)` — ищем по натуральному ключу (workspace_id, user_id), а не по `member.id`, потому что в `comment.go` приходит `user_id` от `resolveActor`, не membership-row id (см. fix ниже).
- `server/pkg/db/generated/*.go` — авто-сгенерировано через `sqlc generate`
- `server/internal/handler/comment.go` — в блоке on-comment-trigger (~строка 262) добавлено условие `&& !h.isServiceAccountMember(r.Context(), uuidToString(issue.WorkspaceID), authorID)` + helper `isServiceAccountMember(ctx, workspaceID, userID)`.

**Fix 2026-05-12:** изначальная версия патча искала `WHERE id = $1`, передавая `authorID` (= `user_id` от `resolveActor`). Эти два UUID разные (`member.id ≠ member.user_id`), запрос всегда возвращал ENOENT → default `false` → проверка превращалась в no-op. Симптом проявлялся редко, потому что одновременно работали другие гейты в `shouldEnqueueOnComment` (`isAgentAssigneeReady`, `hasPending`); полностью прорвался, когда Brain начал постить Teamlead-коммент в `auto_approve:needs_human` (assignee=Planner, pending=0). Поправлено переходом на `(workspace_id, user_id)` + изменением сигнатуры handler-helper'а.

**Зачем:** AITO1-Brain под учёткой Teamlead (member, role=admin) пишет в треде issue служебные комменты — `closing-comment` после рефлексии, `✅ Auto-approved` после auto-approve gate (см. `~/arcadia/taxi/ai/aito1/docs/auto-approve.md`). По умолчанию multica запускает on_comment-trigger на любой member-коммент в issue с агентом-assignee, и эти служебные комменты вызывают **дубль task-а** для уже ассайненного агента (Executor). Workaround через `@<Human-id>` mention есть, но он хрупкий — привязан к специфике mentions-парсера. Service-account флаг — чистое решение: явная семантика «этот member пишет уведомления, не запросы на работу».

**Что изменено:** новая колонка `member.is_service_account` (default false → не ломает существующие установки). Comment-handler пропускает on_comment-trigger когда автор-member помечен как service-account. Сам флаг ставится снаружи (через SQL update / sqlc `SetMemberServiceAccount`); установщик AITO1 ставит его на Teamlead member-а после создания workspace (см. соответствующие правки в `install/phases/60_workspace.sh`).

Errors при чтении флага (DB hiccup, member отсутствует) → дефолт `false`, чтобы не ломать Human-комменты на каждом транзиенте — fail-closed здесь хуже UX, чем редкий лишний task.

**Если конфликт при merge/rebase с upstream:**

| Конфликт | Что делать |
|---|---|
| Upstream поменял условие в `comment.go:260-262` | Принять upstream, добавить `&& !h.isServiceAccountMember(r.Context(), uuidToString(issue.WorkspaceID), authorID)` к итоговому условию (заметь — `workspace_id` обязателен). |
| Upstream добавил свои member-колонки и переписал `member.sql` queries | Сохранить наши `IsMemberServiceAccount` / `SetMemberServiceAccount` query (поиск по `(workspace_id, user_id)`), перегенерить через `sqlc generate`. |
| Upstream добавил миграцию с номером ≥ 069 | Передвинуть наш файл `069_*.up.sql` / `.down.sql` на следующий свободный номер (070+). |

---

### Патч 10 — скрыть ReactionBar на комментах Reflector / Auditor / Teamlead

**Файл:** `packages/views/issues/components/comment-card.tsx`

**Зачем:** AITO1-Brain больше не обрабатывает 👍 на комментах от Reflector / Auditor (agent) и Teamlead (member service-account) — `force_promote` через 👍 на `[REFLECTION]` удалён, а на ack-комменты Teamlead'а Brain никогда не реагировал. Видимый бар реакций (и старые «зависшие» 👍 на исторических REFLECTION-комментах) путал пользователя — было непонятно, что лайк означает и применяется ли действие.

**Что изменено:** в `CommentCard` через `useActorName()` достаём `getAgentName` / `getMemberName`. Считаем коммент «reactionless» если автор — `agent` с именем ∈ {`Reflector`, `Auditor`} или `member` с именем `Teamlead`. В таком случае `<ReactionBar />` вовсе не рендерится. БД не трогаем — старые реакции остаются как audit-trail.

**Расширение (Naталья 2026-05-12):** условие `!isOwn` тоже добавлено — на собственных member-комментах текущего пользователя бар реакций бессмыслен (лайкать свой коммент незачем), `isOwn = actor_type === "member" && actor_id === currentUserId` уже считалось ниже в том же компоненте.

**Расширение (Наталья 2026-05-16):** для AITO1 permission-system Teamlead иногда публикует **actionable** комменты (запрос разрешения на новую операцию в Сценарии C). Эти комменты несут sentinel-строку `<!-- aito1:action_required -->` в первой линии. На них реакции нужны — лайк/дизлайк управляют permission state machine (см. [docs/permission-system.md](https://a.yandex-team.ru/arcadia/taxi/ai/aito1/docs/permission-system.md)). Решение:
- `const isAitoActionRequired = contentText.includes("<!-- aito1:action_required -->")` — детектор по sentinel'у (невидим в markdown-рендере, но виден парсеру).
- Условие рендера ReactionBar изменено на `!isTemp && !isOwn && (!isReactionlessActor || isAitoActionRequired)` — actionable Teamlead-коммент пробивает reactionless-фильтр.
- `hideAddButton={!isLongContent && !isAitoActionRequired}` — короткие actionable-комменты тоже показывают кнопку добавления 👍.

**Если конфликт при merge/rebase с upstream:** upstream вряд ли тронет `CommentCard`-баррендер. Если тронет — сохранить условие `!isReactionlessActor || isAitoActionRequired` рядом с проверкой `!isTemp` и определение `isAitoActionRequired` через `contentText.includes`.

---

### Патч 11 — AITO1 permission-system PreToolUse hook installation

**Файлы:**
- `server/internal/daemon/execenv/execenv.go` (Prepare + новая функция `writeAITOHookSettings`)
- `server/internal/daemon/daemon.go` (agentEnv `CLAUDE_PROJECT_DIR`)
- `server/pkg/agent/claude.go` (buildClaudeArgs `--setting-sources`)

**Зачем:** AITO1 permission-системе нужен Claude Code PreToolUse hook, который перехватывает Bash-команды Executor'а и проверяет permission в Brain через HTTP. Hook регистрируется через project-scope settings.json в workdir, но multica daemon не создавал ни `.claude/settings.json`, ни `CLAUDE_PROJECT_DIR`, а в `-p` режиме Claude Code дефолтно игнорирует project-settings без явного `--setting-sources=project,local`. См. [plans/permission-system-design.md](https://a.yandex-team.ru/arcadia/taxi/ai/aito1/plans/permission-system-design.md) Слой 6 и [plans/permission-system-implementation.md](https://a.yandex-team.ru/arcadia/taxi/ai/aito1/plans/permission-system-implementation.md) Этап 0.

**Что изменено:**

1. **`execenv.go::Prepare`** после `writeContextFiles` добавлен вызов `writeAITOHookSettings(workDir, logger)` для провайдера `claude`. Функция читает `~/.aito1/hook-settings.json` (управляемый AITO1 installer'ом), создаёт `<workDir>/.claude/`, копирует туда settings.json. Если файла нет (degraded mode) — silent skip с warning.

2. **`daemon.go::launchProvider`** в формирование `agentEnv` добавлен `agentEnv["CLAUDE_PROJECT_DIR"] = env.WorkDir` для provider=`claude`. Без него hook command paths с `${CLAUDE_PROJECT_DIR}/...` не резолвятся.

3. **`claude.go::buildClaudeArgs`** в базовые args добавлен `--setting-sources` `user,project,local`. **Критично:** в `-p` (--print) режиме дефолт `user` only — project-settings (hooks) игнорируются silent. Изначально (16.05.2026) стоял `project,local` без `user`, но это отрезает Наташины глобальные allow из `~/.claude/settings.json` (`mcp__gmail__*`, `WebFetch`, `mcp__playwright__*` и т.п.) — агенты не могут пользоваться tool'ами, которые Human уже разрешил для интерактивного режима. 2026-05-18: добавлен `user` (без него Executor падал в `[BLOCKED]` на каждом MCP-tool, который Brain через aito1-hook уже allow'ал).

**Тесты:** S-0.1 ... S-0.4 в [plans/permission-system-test-plan.md](https://a.yandex-team.ru/arcadia/taxi/ai/aito1/plans/permission-system-test-plan.md). Прошли 2026-05-16.

**Если конфликт при merge/rebase с upstream:**
- `execenv.go` — упоминание AITO1-patch и название функции уникальны, конфликт маловероятен. Если upstream рефакторит `Prepare` — сохранить вызов `writeAITOHookSettings` и саму функцию.
- `daemon.go` — конфликт возможен если upstream меняет `agentEnv` structure. Сохранить `if provider == "claude" { agentEnv["CLAUDE_PROJECT_DIR"] = env.WorkDir }`.
- `claude.go` — `--setting-sources` уникален, конфликт только если upstream сам начнёт его передавать (с другим значением — оставить наше).

---

### Патч 12 — Classify-кнопки [📖 Read] [✏️ Write] для unknown-команд

**Файлы:**
- `packages/ui/components/common/classify-buttons.tsx` *(новый)*
- `packages/ui/components/common/reaction-bar.tsx` (проп `classifyMode` + `CLASSIFY_LABELS`)
- `packages/views/issues/components/comment-card.tsx` (детектор `isAitoClassifyRequest` + проброс `classifyMode`)

**Зачем:** когда Executor зовёт команду, которой нет в `aito1_command_catalog`, Brain постит grant_request и Human должен её классифицировать (read / write). Раньше это делалось текстовым комментом ровно из одного слова `read`/`write`/`destructive` — Human не знал формат, естественный ответ «это read» парсер не ловил, задача застревала (реальный кейс 2026-05-19: «tracker-cli search - это read» → 5 слов → не распознано → Planner перезапускался в цикле). Заменяем текстовый канал на две явные кнопки.

**Что изменено:**

1. **`classify-buttons.tsx`** — новый компонент `<ClassifyButtons onToggle>`. Подпись «Что делает эта команда?» + две кнопки `[📖 Read]` (read) / `[✏️ Write]` (write). `onClick` шлёт `onToggle("read")` / `onToggle("write")` — это reaction.emoji как **plain-строка** (`comment_reaction.emoji` без charset-constraint, BE валидирует только непустоту). Эмодзи живут **внутри** лейбла кнопки, не как unicode-реакция (R/W glyph'ы из emoji-каталога серые/нечитаемы на macOS).

2. **`reaction-bar.tsx`** — проп `classifyMode?: boolean`. Когда `true` → вместо `<LikeButton>` рендерится `<ClassifyButtons>` (если ещё не классифицировано — `alreadyClassified = grouped.some(g => (g.emoji==="read"||g.emoji==="write") && g.reacted)`). `CLASSIFY_LABELS` маппит сохранённые реакции `read`→`📖 Read` / `write`→`✏️ Write` в читаемый chip.

3. **`comment-card.tsx`** — `isAitoClassifyRequest = contentText.includes("<!-- aito1:classify_request -->")`, проброшен как `classifyMode={isAitoClassifyRequest}` в `<ReactionBar>`. Этот sentinel Brain ставит ТОЛЬКО для unknown-команд (известные-но-без-permission остаются на like-only 👍).

**Контракт с Brain:** клик → `comment_reaction:added` с emoji `read`/`write` → `_on_reaction_added` → `_maybe_classify_from_reaction` (см. `brain/listener/state_machine.py`): upsert в `aito1_command_catalog`, для write дополнительно append action + reassign Executor + rerun. Текстовый парсер (`_parse_kind_word`) удалён.

**Тесты:** `tests/functional/test_state_machine_classify_reaction.py` (4 теста: read / write / no-sentinel noop / foreign-comment noop). Frontend typecheck — `pnpm --filter @multica/{ui,views} typecheck && pnpm --filter web typecheck` зелёные. Build+deploy 2026-05-20.

**Если конфликт при merge/rebase с upstream:**
- `reaction-bar.tsx` — upstream вряд ли тронет AITO1-проп `classifyMode`; если рефакторит `ReactionBar` props — перенести `classifyMode` + тернарник `classifyMode ? ClassifyButtons : LikeButton`.
- `comment-card.tsx` — сохранить `isAitoClassifyRequest` рядом с `isAitoActionRequired` и проброс `classifyMode`.
- `classify-buttons.tsx` — новый файл, конфликта быть не может; восстановить если потерян.

---

### Патч 13 — Brain как единственный диспетчер pipeline-агентов (off native trigger)

**Файлы:**
- `server/internal/handler/comment.go` — helper `isBrainDispatchedConfig` + skip в `enqueueMentionedAgentTasks`
- `server/internal/handler/issue.go` — skip в `shouldEnqueueOnComment`

**Зачем:** AITO1 pipeline-агенты (Planner/Executor/Reflector/Auditor) маршрутизируются ИСКЛЮЧИТЕЛЬНО Brain'ом (state machine: assign + rerun по последнему маркеру задачи). multica нативно enqueue'ит ассайнед-агента на любой member-коммент (`on_comment`) и @mentioned агентов — это гонка с Brain-роутингом: Human пишет «продолжай», multica дёргает агента, и Brain параллельно решает что делать. Итог — двойные запуски / «греется воздух» (Planner перепланирует там, где нужен был просто Executor-rerun). Делаем Brain единственным источником решений.

**Что изменено:**
- `isBrainDispatchedConfig(runtimeConfig []byte) bool` — true если `agent.runtime_config.brain_dispatched == true`. Пустой/битый config → false (не-AITO1 агенты работают как раньше).
- `shouldEnqueueOnComment` (issue.go): после `isAgentAssigneeReady` — если assignee brain_dispatched, `return false` (нет нативного on_comment enqueue).
- `enqueueMentionedAgentTasks` (comment.go): в цикле после загрузки agent — `if isBrainDispatchedConfig(agent.RuntimeConfig) { continue }` (нет нативного @mention enqueue).

Флаг ставится инсталлятором (`install/phases/60_workspace.sh` build_agent_body → `runtime_config:{brain_dispatched:true}` на create+update) и в live БД (`UPDATE agent SET runtime_config = ... WHERE name IN (...)`).

**Не-AITO1 агенты, autopilot, chat-таски** не затронуты — у них нет флага, нативный trigger работает.

**Если конфликт при merge/rebase с upstream:**
- `comment.go` — сохранить helper `isBrainDispatchedConfig` + `continue` в mention-цикле. Если upstream рефакторит enqueue — перенести проверку после загрузки agent.
- `issue.go` — сохранить `brain_dispatched` skip в `shouldEnqueueOnComment` после ready-check.

---

### Патч 14 — нет reaction-bar на Executor `[BLOCKED]` комментах

**Файл:** `packages/views/issues/components/comment-card.tsx`

**Зачем:** 👍 на коммент `[BLOCKED]` от Executor попадал бы в reaction-branch 2 Brain'а (👍 на Executor-коммент → Reflector) и при наличии прошлого `[EXECUTOR REPORT]` в задаче **ошибочно запускал Reflector** — как будто работа одобрена, хотя задача заблокирована. Вместо усложнения Brain-логики просто убираем лайк на блок-комментах: разблокировка идёт через grant_request-карточку (permission) или текстовый коммент (availability), лайкать сам `[BLOCKED]` не нужно.

**Что изменено:**
- `isAitoBlocked` — детектор по маркеру в начале (с учётом возможного `<!-- aito1:hook_denied -->` sentinel перед ним): `/^\s*(?:<!--[^>]*-->\s*)*\[(?:PLAN\s+)?BLOCKED/im`.
- Условие рендера `<ReactionBar>` дополнено `&& !isAitoBlocked`.

grant_request-комменты (sentinel `aito1:action_required`, не `[BLOCKED]`) не затронуты — лайк/кнопки на них остаются.

**Если конфликт при merge/rebase с upstream:** сохранить `isAitoBlocked` рядом с `isAitoActionRequired`/`isAitoClassifyRequest` и `&& !isAitoBlocked` в условии ReactionBar.

---

### Патч 15 — диагностический суффикс на падениях агента

**Файл:** `server/internal/daemon/daemon.go` (+ тест `internal/daemon/helpers_test.go`)

**Зачем:** транзиентные обрывы соединения Claude Code с api.anthropic.com (undici «socket connection was closed unexpectedly») приходят одной непрозрачной строкой — нативную причину (ECONNRESET/ETIMEDOUT/HTTP-код) CLI выбрасывает. В запись о падении уходила только эта строка; контекст прогона (длительность, токены, число тулов), который у демона уже на руках, терялся. Теперь в коммент о падении дописывается компактная сводка формы прогона — чтобы отличить долгий large-context дроп от мгновенного отказа коннекта.

**Что изменено:**
- Хелпер `appendFailureDiag(msg, provider, elapsed, tools, usage)` — дописывает строку вида `⎯ failed after 2m21s · 18 tools · claude-opus-4-7 in=187.0k out=2.1k cache_r=1.2M cache_w=45.0k`.
- Хелпер `humanCount(int64)` — компактный формат токенов (`1.2k` / `1.2M`).
- В `runTask` ветка `default` (status=`failed` и прочие нештатные) оборачивает `errMsg` через `appendFailureDiag` перед возвратом `TaskResult`.

Поведение не меняется: маркеров ([PLAN]/[BLOCKED]/…) суффикс не содержит, классификация/ретрай не трогаются (обрыв по-прежнему `agent_error`, авторетрая нет — сознательно). Только обогащение видимой записи.

**Если конфликт при merge/rebase с upstream:** сохранить оба хелпера рядом с `executeAndDrain` и вызов `appendFailureDiag` в ветке `default` функции маппинга `agent.Result` → `TaskResult`.

---

### Патч 17 — карточки задач линкуются на `identifier` вместо UUID

**Файлы:** `packages/views/issues/components/board-card.tsx`, `packages/views/issues/components/list-row.tsx`, `packages/views/issues/components/issue-detail.tsx`.

**Зачем:** в AITO1 у задач есть человекочитаемый `identifier` вида `AIT-42`. Upstream строит ссылку на карточке через UUID (`/{ws}/issues/9dc669dd-…`), и URL получается мусорным. Бэкенд уже умеет резолвить и UUID, и identifier в `loadIssueForUser` через `resolveIssueByIdentifier` → можно безопасно передавать identifier в URL.

**Что изменено:**
- `board-card.tsx`, `list-row.tsx`: `href={p.issueDetail(issue.id)}` → `href={p.issueDetail(issue.identifier)}`.
- `issue-detail.tsx`: подсасывание issue делается двумя `useQuery`. Первый по `id` из URL (может быть UUID или identifier) — для первичного fetch + seed из list-cache (`i.id === id || i.identifier === id`). После того как из rawIssue получен канонический UUID, второй `useQuery` подписывается на `issueDetailOptions(wsId, canonicalUuid)`. Это нужно потому что WS-updater `onIssueUpdated` пишет в кэш **только под UUID-ключом** — без второй подписки detail-карточка, открытая по identifier, не получала бы realtime-апдейты статусов/полей.

**Если конфликт при merge/rebase с upstream:** сохранить (1) `issue.identifier` в `href` карточек, (2) двухуровневую загрузку issue в `IssueDetail` с подпиской на канонический UUID-ключ для WS-инвалидации, (3) seed initialData по `id` ИЛИ `identifier`.

---

### Патч 18 — `next.config.ts` → `next.config.mjs`

**Файл:** `apps/web/next.config.mjs` (был `next.config.ts`).

**Зачем:** под Jamf-policy native swc-darwin-arm64 не грузится (`library load disallowed by system policy`), Next падает на fallback в swc-wasm, который компилит TS-конфиг в `next.config.compiled.js` с CommonJS-семантикой (`exports`, `__dirname`), а `apps/web/package.json` объявляет `"type": "module"` — компилированный конфиг ломается в ESM-скоупе.

**Что изменено:**
- `apps/web/next.config.ts` переименован в `apps/web/next.config.mjs` — Next грузит `.mjs` напрямую, минуя SWC.
- Убрана зависимость от TypeScript-типов (`import type { NextConfig }`, `: NextConfig`, `as const`) — заменено на JSDoc `/** @type {import('next').NextConfig} */`.
- Внутри добавлен ESM-эквивалент `__dirname` через `fileURLToPath(import.meta.url)`.

**Если конфликт при merge/rebase с upstream:** если upstream переписал `next.config.ts` — перенести правки в `.mjs` заново, оставив TS-типы только в JSDoc-комментарии. Webpack/SWC основного билда работают через wasm-fallback нормально, проблема была только в конфиге.

---

### Патч 16 — лента комментов newest-first + форма ввода наверху

**Файл:** `packages/views/issues/components/issue-detail.tsx`

**Зачем:** в задачах AITO1 лента быстро растёт (Planner/Executor/Reflector/Teamlead пишут много). Upstream рендерит её ASC (старое сверху, форма «Leave a comment» внизу) — чтобы написать коммент или увидеть свежий ответ агента, приходилось пролистывать всю ленту вниз. Развернули фид: новое сверху, форма в начале секции Activity.

**Что изменено** (только слой рендера в `IssueDetail`, хук `useIssueTimeline` не трогали — он по-прежнему отдаёт ASC):
- `CommentInput` перенесён из низа секции вверх — сразу после заголовка Activity, до `AgentLiveCard` и ленты.
- Группы ленты рендерятся реверснутыми: `[...timelineView.groups].reverse().map(...)`; внутри activity-групп тоже `[...group.entries].reverse()` (копия, не мутируем мемоизированный массив).
- Контролы пагинации поменяны местами под newest-first: блок `(hasMoreNewer || !isAtLatest)` (show newer / jump to latest) теперь **над** лентой, блок `hasMoreOlder` (show older) — **под** лентой.

WS-prepend новых комментов (`prependToLatestPage` при `isAtLatest`) после реверса даёт новый коммент сверху, ровно под формой — поведение консистентно. `scrollIntoView` по `comment-<id>` (inbox jump / highlight) работает независимо от порядка.

**Если конфликт при merge/rebase с upstream:** сохранить (1) `CommentInput` вверху секции Activity, (2) `.reverse()` на группах и на entries внутри activity-групп, (3) перестановку двух блоков пагинации (newer наверху, older внизу).

---

### Патч 19 — Claude-каталог моделей: + Opus 4.8, дефолт = Opus 4.8

**Файлы:** `server/pkg/agent/models.go` (`claudeStaticModels`), `packages/views/runtimes/utils.ts` (`MODEL_PRICING`).

**Зачем:** список моделей для Claude-агентов — статический хардкод в `claudeStaticModels()` (демон отдаёт его в UI по heartbeat). Upstream-список не содержал `claude-opus-4-8` → в дропдропе настроек агента модель не выбиралась, хотя CLI её уже принимает. Заодно в таблице стоимости фронта не было тарифа 4.8.

**Что изменено:**
- `claudeStaticModels`: добавлен `{ID: "claude-opus-4-8", Label: "Claude Opus 4.8", Provider: "anthropic", Default: true}` первым элементом; `Default: true` снят с `claude-sonnet-4-6`. Single-user деплой работает на топ-модели везде (cost не ограничение) — новые Claude-агенты наследуют 4.8. Комментарий над функцией обновлён под новый дефолт.
- `MODEL_PRICING`: добавлен `claude-opus-4-8` с тем же тарифом 5/25 (cacheRead 0.50, cacheWrite 6.25), что и 4.6/4.7.

**Если конфликт при merge/rebase с upstream:** если upstream обновил `claudeStaticModels` — сохранить запись `claude-opus-4-8` и `Default: true` именно на ней (не на Sonnet); добавить тариф 4.8 в `MODEL_PRICING`, соблюдая порядок (более специфичные ключи раньше префиксов). Тест `TestStaticCatalogsHaveAtMostOneDefault` требует ровно один Default.

---

### Патч 20 — AITO1 Monitoring-секция (наблюдаемость Brain в UI)

**Файлы (новые):**
- `apps/web/app/[workspaceSlug]/(dashboard)/monitoring/page.tsx` — роут (ре-экспорт).
- `apps/web/app/bff/monitoring/[...path]/route.ts` — **BFF-прокси** на Brain `:8082`.
- `packages/views/monitoring/**` — view (вертикальные Tabs как в Settings): `monitoring-page.tsx`, `questions-tab.tsx`, `classes-tab.tsx`, `facts-tab.tsx`, `rules-tab.tsx`, `knowledges-tab.tsx`, `tab-chrome.tsx`. Все 5 подразделов реализованы.
- `packages/core/monitoring/**` — data-layer (types + react-query options к BFF).
- `packages/views/locales/{en,zh-Hans}/monitoring.json` — namespace.

**Файлы (правки):**
- `packages/views/layout/app-sidebar.tsx` — пункт `monitoring` (иконка `Activity`) в `workspaceNav` после `agents` + тип-юнионы `NavKey`/`NavLabelKey`.
- `packages/core/paths/paths.ts` — `monitoring()`; `reserved-slugs.ts` — `"monitoring"` + `"bff"`.
- `packages/core/paths/consistency.test.ts`, `packages/views/editor/utils/link-handler.ts` — `monitoring` в списках workspace-route-сегментов (иначе C4-тест падает).
- `packages/views/locales/{en,zh-Hans}/layout.json` — `nav.monitoring`.
- `packages/views/locales/index.ts`, `packages/views/i18n/resources-types.ts` — регистрация namespace.
- `packages/{core,views}/package.json` — exports `./monitoring`.

**Зачем:** раздел Monitoring — окно во внутреннее состояние Brain. 5 подразделов: Questions (`aito1_fact_queries`, newest-first, разворот → факты), Classes (`aito1_task_classes`+episode_count ↓), Facts (`aito1_facts` по usage=ref+pull ↓), Rules (`aito1_rules`+класс, status→applied ↓, do/don't), Knowledges (`aito1_knowledges` created ↓, markdown-разворот). Данные принадлежат Brain (Python) → Go-сервер не трогаем: фронт ходит в same-origin BFF, тот server-side проксирует на Brain. Контракт — `aito1` репо `docs/monitoring-section.md` + `brain/api/monitoring.py`.

**Почему BFF под `/bff/`, а не `/api/`:** `next.config.mjs` rewrite'ит весь `/api/:path*` на Go-бэкенд (`afterFiles`); catch-all под `/api` перехватывается им (динамические роуты после afterFiles) и до Brain не доходит. `/bff/*` не матчится ни одним rewrite. `AITO1_BRAIN_URL` (env, деф. `http://127.0.0.1:8082`); гейт по cookie `multica_logged_in`, allowlist подпутей.

**Поведение таблиц:** Questions — newest-first, клик по строке разворачивает резолвнутые факты (alias+value, длинные значения wrap'аются `break-all`), строки с 0 фактов подсвечены (`bg-destructive/5` + бейдж `0`). Classes — сортировка по episode_count ↓, описание переносится. Facts — сортировка по uses (`reference_count+pull_count`) ↓, alias+value wrap, invalidated приглушены (`opacity-50`). Перенос длинного текста в таблицах требует `whitespace-normal` (primitive `TableCell` зашивает `whitespace-nowrap`) + `max-w-0` + `break-words`/`break-all`. Общее правило UI: длинный текст всегда wrap, не скролл.

**Если конфликт при merge/rebase:** сохранить `/bff/*` вне `/api`-rewrite; вернуть пункт `monitoring` в workspaceNav; при коллизии слага — переименовать.


---

### Патч 21 — 8-й статус `waiting` (parent подзадач / ручная пауза)

**Файлы (правки):**
- `packages/core/types/issue.ts` — `IssueStatus` += `| "waiting"`.
- `packages/core/issues/config/status.ts` — `waiting` в `STATUS_ORDER` / `ALL_STATUSES` / `BOARD_STATUSES` (после `blocked`) + `STATUS_CONFIG` (label `Waiting`, muted-стиль как `backlog`).
- `packages/views/issues/components/status-icon.tsx` — `WaitingIcon` (кольцо + две вертикальные паузы) + запись в `STATUS_RENDERERS`.
- `server/internal/handler/issue.go` — `statusRank`: `WHEN 'waiting' THEN 5` (done→6, cancelled→7, ELSE→8); `shouldEnqueueAgentTask`: `waiting` skip наравне с `backlog` (не enqueue'ит агента).
- `packages/views/locales/{en,zh-Hans}/issues.json` — ключ `status.waiting` (En `Waiting` / Zh `等待中`). Обязателен: тип `$.status` выводится из локали, без ключа `next build` падает на `issue-actions-menu-items.tsx` (`$.status[s]` индексируется по `IssueStatus`).

**Файлы (новые):**
- `server/migrations/070_issue_waiting_status.{up,down}.sql` — `waiting` в CHECK `issue.status`. UP резолвит имя инлайн-констрейнта из 001 динамически (DO-блок) и пересоздаёт `issue_status_check` с `waiting`; DOWN переводит `waiting`→`backlog` и сужает обратно.

**Зачем:** система подзадач (`aito1` репо `plans/subtask-system-2026-06-02.md`). `waiting` — parent, припаркованный пока бегут подзадачи (и ручная пауза). Критично: статус исключён **И из enqueue, И из окна Manager** (окно — в `prompts/manager.prompt`, вне форка) — иначе дедлок parent↔Manager. `parent_issue_id` в форке уже есть (create/update + cycle-detection + `ListChildIssues`), схему issue не трогаем.

**Если конфликт при merge/rebase:** сохранить `waiting` во всех 4 местах `status.ts` (Record-тип требует записи в `STATUS_CONFIG`, иначе TS-билд падает) + `statusRank` + `shouldEnqueueAgentTask`; номер миграции сдвинуть при коллизии.

---

### Патч 22 — wrap названия проекта в свойствах задачи + кнопка перехода в проект

**Файлы (правки):**
- `packages/views/common/prop-row.tsx` — убран `truncate` с value-`div` строки свойства. Это **корень** обрезки: `truncate` = `whitespace-nowrap` + `overflow-hidden`, он резал любой wrap внутри ЛЮБОГО свойства. Теперь длинные значения (проект, лейблы) переносятся, короткие (статус/приоритет) — без изменений.
- `packages/views/projects/components/project-picker.tsx` — триггер: `truncate`→`break-words text-left`, убран `overflow-hidden`, `items-center`→`items-start` (иконка по верхней линии многострочного названия).
- `packages/views/issues/components/issue-detail.tsx` — в `PropRow` проекта рядом с `ProjectPicker` добавлена кнопка-ссылка перехода в проект (`AppLink` → `paths.projectDetail(issue.project_id)`, иконка `SquareArrowOutUpRight`); видна только когда у задачи есть проект. Иконка добавлена в lucide-импорт.
- `packages/views/issues/components/board-card.tsx` — карточка канбана переработана в 3 строки: (1) для **подзадачи** — иконка-индикатор `CornerDownRight` (↳, при `issue.parent_issue_id`) перед номером; + прогресс подзадач (`ProgressRing` + `N/M`) справа от номера; `ActorAvatar size=28` (агент, покрупнее) у правого края; (2) заголовок; (3) проект **целиком** (`break-words`, без `truncate`/`max-w`). С карточки убраны description, priority, labels, due-date; из lucide оставлен только `CornerDownRight`; неиспользуемые импорты (`CalendarDays`/`PriorityIcon`/`PriorityPicker`/`DueDatePicker`/`PRIORITY_CONFIG`/`LabelChip`) и `formatDate` вычищены.

**Зачем:** в панели свойств задачи длинное название проекта обрезалось ellipsis'ом — не видно целиком, неудобно. И не было способа перейти на страницу проекта из задачи. Правка корня (`prop-row.tsx`) чинит обрезку для всех длинных свойств разом. Карточка канбана по просьбе Наташи упрощена до «номер+агент / текст / проект целиком».

**Если конфликт при merge/rebase:** ключевое — снять `truncate` с value-`div` в `prop-row.tsx`; picker-wrap и кнопка перехода — поверх. Кнопка опирается на существующий `paths.projectDetail`.

---

### Патч 23 — новый таб Monitoring → Diary (дневник агента-странника `aito1_diary`)

**Файлы (правки):**
- `apps/web/app/bff/monitoring/[...path]/route.ts` — `"diary"` в Set `ALLOWED` (проксируется `GET /api/monitoring/diary` к Brain).
- `packages/core/monitoring/types.ts` — интерфейсы `DiaryRow` (id/session_id/kind/title/body/threads/interestingness/shared_to_tg/created_at) + `DiaryResponse`.
- `packages/core/monitoring/queries.ts` — `monitoringKeys.diary` + `diaryOptions(limit=200)` (fetch `/diary?limit=…`, staleTime 30s); импорт `DiaryResponse`.
- `packages/views/monitoring/components/monitoring-page.tsx` — `"diary"` в `TAB_KEYS`, иконка `NotebookPen` в `TAB_ICONS`, импорт+`<TabsContent value="diary"><DiaryTab/></TabsContent>`.
- `packages/views/locales/{en,zh-Hans}/monitoring.json` — ключи `nav.diary` + блок `diary.*` (title/subtitle/col_title/col_kind/col_interestingness/col_shared/col_created/untitled/shared/empty). Обязательны в ОБОИХ локалях — `parity.test.ts` требует key-parity EN⟷zh.

**Файлы (новые):**
- `packages/views/monitoring/components/diary-tab.tsx` — таб по образцу `knowledges-tab.tsx`: таблица (note/kind/interestingness 1..5 точками/shared_to_tg иконкой `Send`/created), раскрытие `body` (markdown) по клику; wrap длинного контента (`max-w-0` + `break-words`).

**Зачем:** Brain отдаёт дневник медитирующего агента Wanderer (Странник), нужна страница для просмотра. Brain уже готов (endpoint + сортировка newest-first), правка только UI.

**Если конфликт при merge/rebase:** держать `"diary"` в allowlist + `TAB_KEYS` + `TAB_ICONS` (Record-тип требует записи) и парность ключей `diary.*` в обеих локалях (иначе `parity.test.ts` и `next build` упадут на missing key).

---

### Патч 24 — новый таб Monitoring → Templates (plan-шаблоны `aito1_plan_templates`, после Rules, с удалением)

- `apps/web/app/bff/monitoring/[...path]/route.ts` — `"templates"` в Set `ALLOWED` (`GET /api/monitoring/templates`) **+ новый `export async function DELETE`**: единственная mutation в monitoring-BFF, скоуп строго `templates/<id>` (path.length===2 && path[0]==="templates"), форвард `DELETE /api/monitoring/templates/<id>` к Brain, тот же cookie-gate.
- `packages/core/monitoring/types.ts` — интерфейсы `TemplateRow` (id/class_id/class_name/content_md/status/applied_count/approved_count/source_episode_id/source_issue_id/reflection_episode_id/reflection_issue_id/created_at/last_used_at/last_confirmed_at) + `TemplatesResponse`.
- `packages/core/monitoring/queries.ts` — `monitoringKeys.templates` + `templatesOptions(limit=200)` + **`deleteTemplate(id)`** (fetch `DELETE /bff/monitoring/templates/<id>`); импорт `TemplatesResponse`.
- `packages/views/monitoring/components/monitoring-page.tsx` — `"templates"` в `TAB_KEYS` **после `"rules"`**, иконка `LayoutTemplate` в `TAB_ICONS`, импорт+`<TabsContent value="templates"><TemplatesTab/></TabsContent>`.
- `packages/views/monitoring/components/templates-tab.tsx` — таб по образцу `rules-tab.tsx`+`knowledges-tab.tsx`: таблица (class_name+`Chevron` / источник `E-<src8>`+`reflected E-<refl8>` / status-badge / applied / approved+rate%) + кнопка `Trash2` (с `e.stopPropagation()`, чтобы не тоггл) → `AlertDialog` → `useMutation(deleteTemplate)` + `invalidateQueries(monitoringKeys.all)`. **Клик по строке раскрывает полный `content_md` через `<Markdown>` (common/markdown) в colSpan-строке** (expand-state `Set<id>`, как knowledges-tab).
- `packages/views/locales/{en,zh-Hans}/monitoring.json` — ключи `nav.templates` + блок `templates.*` (title/subtitle/col_template/col_source/col_status/col_applied/col_approved/from/reflected/no_class/delete/empty + вложенный `delete_dialog.{title,description,cancel,confirm}`). Обязательны в ОБОИХ локалях — `parity.test.ts`.

**Зачем:** Наташе нужно видеть, из каких эпизодов синтезирован каждый plan-шаблон (source=exemplar, reflection=эпизод создания) и сколько раз он применён (applied), плюс уметь удалить плохой шаблон. Brain-сторона — `GET/DELETE /api/monitoring/templates` (`brain/api/monitoring.py` + `monitoring_repos.list_templates`/`count_templates` + `repos.delete_template` с Qdrant-point-cleanup). Удаление безопасно: episode/class FK указывают ОТ шаблона (`ON DELETE SET NULL`), обратных ссылок нет.

**Если конфликт при merge/rebase:** держать `"templates"` в allowlist + DELETE-handler в BFF + `TAB_KEYS`/`TAB_ICONS` + парность `templates.*` в обеих локалях.

---

### Патч 25 — возврат лейблов на карточку канбана (регрессия Патча 22)

- `packages/views/issues/components/board-card.tsx` — Патч 22 при упрощении карточки вычистил лейблы вместе с description/priority/due-date. Возвращены **только лейблы** (переключатель `cardProperties.labels` остался в `view-store`, дефолт `true`, но карточка перестала его читать): обратно добавлен импорт `LabelChip` (`../../labels/label-chip`), `const labels = issue.labels ?? []`, гейт `showLabels = storeProperties.labels && labels.length > 0` и рендер «Линии 4» — `flex flex-wrap` контейнер с `LabelChip` на каждый лейбл (chip'ы переносятся, без горизонтального скролла). 3-линейная структура Патча 22 (номер+агент / текст / проект) не тронута.

**Зачем:** при переработке карточки в 3 строки случайно пропал показ лейблов задачи на доске — Наташа просила вернуть. priority/description/due-date оставлены убранными (так и задумано Патчем 22), возвращены строго лейблы.

**Если конфликт при merge/rebase:** держать импорт `LabelChip` + `showLabels`-гейт + рендер-блок в `board-card.tsx`.

---

### Патч 26 — opencode: восстановление финального вывода из session-store (`opencode.db`)

**Файлы (правки):**
- `server/pkg/agent/opencode.go` — `opencodeDBPath()` (путь к `opencode.db`: env `MULTICA_OPENCODE_DB` → `XDG_DATA_HOME` → `~/.local/share/opencode`), `opencodeSessionIDRe` (whitelist `^ses_[A-Za-z0-9]+$` — граница против SQL-инъекции), тип `opencodeDBRow{Text,MessageTime}`, метод `readSessionOutput(ctx, sessionID)` (через `sqlite3 -json`: SELECT assistant-`text`-частей join `message` по `role`, order by message/part time), чистая `parseOpencodeDBRows(data)` (склейка всех → `full`; части последнего сообщения по max `mt` → `final`; пустой вывод = `"",""` без ошибки). В горутине `Execute` после `cmd.Wait()`: если `status=="completed"` и есть `sessionID` — читаем store, кладём `full` в `scanResult.output`, потерянный `final` (если его нет в стриме) до-эмитим в `msgCh` как `MessageText` для таймлайна. Фолбэк: ошибка/пусто → остаётся streamed output.
- `server/pkg/agent/opencode_test.go` — 7 тестов: `parseOpencodeDBRows` (single, финал=последнее сообщение, склейка частей одного сообщения, пустой вывод, `[]`, битый JSON) + `opencodeSessionIDRe` (валидные/инъекционные id).

**Зачем:** opencode 1.16.2 `run --format json` **теряет события финального шага** (итоговый `text` + закрывающий `step_finish`) из stdout при выходе процесса — flush-on-exit гонка Bun-рантайма. Каждый не-последний шаг стримится полностью, но последний эмитит только `step_start`; одношаговый ответ доходит как один `step_start` без текста. Финальный маркер агента (`[PLAN]`/`[EXECUTOR REPORT]`), который парсит Brain, живёт ровно в этом шаге → без восстановления демон видит пустой `result.Output` и метит задачу **failed «opencode returned empty output»** (боевой Wanderer-прогон qwen: 70 tools, 8 записей в дневник — но run failed из-за пустого финала).

**Почему НЕ `opencode export`:** публичный `opencode export <sid>` сразу после run спавнит свой сервер, гоняется с lingering-сервером run-процесса и отдаёт обрезанный JSON десятки секунд (settle >12с, даже retry 8×1.5с не закрыл). А **сами данные лежат в `opencode.db` мгновенно** — прямое WAL-aware чтение через `sqlite3 -json` надёжно. Минус — связанность с внутренней схемой opencode (таблицы `part`/`message`, JSON-layout); терпимо на пинованной версии + фолбэк на streamed. **Правильное решение (server-mode `opencode serve` + HTTP/SSE) — отдельный improvement-тикет** (см. `aito1` память `project-opencode-yandex-aistudio`).

**Подключение Yandex AI Studio** как opencode-provider — `~/.config/opencode/opencode.json` (вне репо), ключ `YC_SPEECHKIT_API_KEY` демон получает через `~/secrets.env` (плист `multica.daemon` сорсит его перед exec). Модель агента: qwen3-235b-a22b-fp8 (instruct — надёжный OpenAI tool_calls); deepseek-v4-flash ОТВЕРГНУТ для агентов (интермиттентно льёт tool-вызовы в родном DSML-формате вместо OpenAI tool_calls → opencode не парсит → агент обрывается).

**Если конфликт при merge/rebase:** если upstream починил флаш стрима (финальный `text` доходит сам) — патч можно снять; иначе сохранить `readSessionOutput`/`parseOpencodeDBRows` + вызов в `Execute` после `cmd.Wait()` + тесты. При апгрейде opencode — перепроверить схему `part`/`message` в `opencode.db`.

---

### Патч 27 — новый таб Monitoring → Advice (рекомендации permission-гейта `GET /api/monitoring/advice`)

**Файлы (правки):**
- `packages/core/monitoring/types.ts` — добавлены интерфейсы `AdviceRow` (id, row_type `text`/`redirect`, trigger_kind, trigger_value, recommendation, status, source, shown_count, fixed_count, fix_rate `number|null`, last_shown_at, created_at) и `AdviceResponse` — зеркало `brain/api/monitoring.py`. Вставлены перед `TemplateRow`.
- `packages/core/monitoring/queries.ts` — `monitoringKeys.advice(limit)` + `adviceOptions(limit = 200)` → `getJson<AdviceResponse>(\`/advice?limit=${limit}\`)`, staleTime 30_000. (`index.ts` ядра реэкспортит через `export *` — отдельно не правился.)
- `packages/views/monitoring/components/advice-tab.tsx` (новый) — зеркало `rules-tab.tsx`. Колонки: **Trigger** (бейдж типа correction/redirect + `trigger_kind: trigger_value` моноширинно), **Recommendation** (текст с wrap), **Status** (StatusBadge active/tentative/archived, archived-строка `opacity-50`), **Source** (бейдж human/reflector), **Shown** (shown_count), **Fixed** (fixed_count + fix_rate как %), **Last shown** (`formatWhen(last_shown_at)`, прочерк если null). Та же chrome (`tab-chrome`), те же loading/empty/error. Серверная сортировка не трогается.
- `packages/views/monitoring/components/monitoring-page.tsx` — `advice` добавлен в `TAB_KEYS` и `TAB_ICONS` (иконка `Lightbulb`) **после `rules`**, рендер `<AdviceTab/>` в `TabsContent value="advice"`, deep-link `?tab=advice` работает через общий механизм.
- `packages/views/locales/{en,zh-Hans}/monitoring.json` — блок `advice.*` (title/subtitle/col_*/type_text/type_redirect/never_shown/empty) + `nav.advice`. Ключи обязательны: тип i18n выводится из `typeof en/monitoring.json`, иначе `t($ => $.advice.*)` не пройдёт typecheck.
- `apps/web/app/bff/monitoring/[...path]/route.ts` — `"advice"` добавлен в `ALLOWED` Set (GET-прокси к Brain).

**Зачем:** показать агентам, какие рекомендации формирует им permission-гейт (self-improving advice loop): `text` = выученная коррекция, `redirect` = перенаправление устаревшего executable на его contract. Brain-эндпоинт `GET /api/monitoring/advice?limit&offset` уже живой; это чисто read-only UI-зеркало, по образцу таба Rules.

**Typecheck:** `pnpm turbo typecheck --filter=@multica/core --filter=@multica/views --filter=@multica/web` — зелёный (4/4, включая `@multica/ui` по зависимости).

**Если конфликт при merge/rebase:** держать `"advice"` в allowlist BFF + `AdviceRow`/`AdviceResponse` + `adviceOptions`/`monitoringKeys.advice` + `advice-tab.tsx` + парность `nav.advice` и блока `advice.*` в обеих локалях + регистрацию в `TAB_KEYS`/`TAB_ICONS`/`TabsContent`.

---

### Патч 28 — cancel-on-reassign скоупится на прежнего assignee (AITO-323)

**Файлы (правки):**
- `server/internal/service/task.go` — новый `CancelTasksForIssueAgent(ctx, issueID, agentID)`: обёртка над существующим sqlc-запросом `CancelAgentTasksByIssueAndAgent` + reconcile/broadcast per-row (зеркало `CancelTasksForIssue`).
- `server/internal/handler/issue.go` — в ОБОИХ путях смены assignee (`UpdateIssue` и `BatchUpdateIssues`) безусловный `CancelTasksForIssue` заменён на скоупленный: отменяются только task'и прежнего assignee, и только если он был агентом (`prevIssue.AssigneeType=="agent"`). Cancel по статусу `cancelled` и при delete остался безусловным (намеренно).
- `server/internal/handler/issue_reassign_test.go` (новый) — 4 теста: reassign не трогает task третьего агента (single + batch), reassign с member-assignee ничего не отменяет, статус `cancelled` отменяет всё.

**Зачем:** reassign A→C убивал running-task агента B на том же issue (@-mention, параллельная работа). Brain-костыли `_settle_then_assign`/`_finalize_to_human` защищают task ИМЕННО прежнего assignee и потому остаются — этот патч закрывает только collateral по третьим агентам.

**Если конфликт при merge/rebase:** держать скоуп-ветку `prevIssue.AssigneeType.String == "agent"` в обоих сайтах + метод `CancelTasksForIssueAgent` + тесты.

---

### Патч 29 — heartbeat задач: FailStaleTasks судит по молчанию, не по длительности (AITO-261)

**Файлы (правки):**
- `server/pkg/db/queries/agent.sql` — новый `TouchTaskHeartbeat :exec` (guard `status IN ('dispatched','running')`); в `FailStaleTasks` running-ветка переведена на `COALESCE(last_heartbeat_at, started_at)`. После правки — `make sqlc` (генерил sqlc v1.31.1, та же версия что у репо).
- `server/internal/handler/daemon.go` — helper `touchTaskHeartbeat` (троттлинг 30с по уже загруженной строке task, best-effort) + вызовы в `GetTaskStatus` (daemon поллит каждые 5с весь прогон — якорь живости, независимый от молчания агента) и `ReportTaskMessages`.
- `server/cmd/server/stale_heartbeat_test.go` (новый) — 4 query-теста: свежий heartbeat при 3-часовом started_at выживает, протухший фейлится, NULL → fallback к started_at, touch не пишет в терминальные строки.
- `server/internal/handler/daemon_heartbeat_touch_test.go` (новый) — 4 handler-теста: touch из status-poll и messages, троттлинг свежего heartbeat.

**Зачем:** sweeper убивал живые долгие прогоны (порог 9000с от `started_at`; 3 жертвы за 30 дней, паузы живого агента до 22 мин — эмпирика прод-БД). Семантика порога теперь «2.5ч молчания», кап на длительность остаётся на daemon-стороне (`MULTICA_AGENT_TIMEOUT`, 2ч). Колонка `last_heartbeat_at` существует с миграции 055 — новой миграции нет.

**Если конфликт при merge/rebase:** держать COALESCE в running-ветке `FailStaleTasks` + `TouchTaskHeartbeat` + оба вызова `touchTaskHeartbeat` в handler'ах.

---

### Патч 30 — классификатор startup-фейлов + circuit breaker на claim/cron (AITO-275)

**Файлы (правки):**
- `server/internal/daemon/startup_failure.go` (новый) — `classifyStartupFailure(errText, tools)`: guard `tools==0`, regex-маркеры с прод-данных → `failure_reason` `agent_auth` (Not logged in / Invalid API key / run /login / organization has disabled) или `api_unavailable` (API Error 5xx / 429 quota / ConnectionRefused / unable to connect / unexpected server error). Эти reasons НЕ добавлены в исключения `GetLastTaskSession` — auth-фейл не отравляет сессию, resume сохраняется.
- `server/internal/daemon/daemon.go` — вызов классификатора в default-ветке `runTask` ДО `appendFailureDiag`, `FailureReason` уходит в `TaskResult`.
- `server/pkg/db/queries/agent.sql` — новый `ListRecentTerminalTasksByRuntime :many` (терминальная история runtime, newest-first, LIMIT).
- `server/internal/service/startup_breaker.go` (новый) — stateless breaker: K=3 новейших терминальных задач runtime — все failed c startup-reason и новейший < 5 мин → ворота закрыты. Состояние живёт в самой истории задач (рестарты daemon — часть каскада, in-memory нельзя). После cooldown первый claim = health-проба. Fail-open на ошибке чтения.
- `server/internal/service/task.go` — гейт в `ClaimTaskForRuntime` (после empty-cache fast path).
- `server/cmd/server/autopilot_scheduler.go` — skip dispatch при открытом breaker'е (с advance next_run_at — расписание не залипает).
- `server/internal/service/task.go` (`broadcastTaskEvent`) — в payload task-событий добавлен `failure_reason` (если задан): Brain слушает `task:failed` (стрик-алерт + Reflector-retry AITO-322) и не должен делать лишний REST-запрос за классом фейла.
- Тесты: `internal/daemon/startup_failure_test.go` (12 кейсов по реальным маркерам), `internal/service/startup_breaker_test.go` (7 кейсов verdict), `internal/handler/startup_breaker_gate_test.go` (3 интеграционных: гейт закрыт/реоткрылся после cooldown/игнорирует agent_error).

**Зачем:** при протухшей auth / упавшем API каждая задача умирает за ~1с с 0 tool-calls, а autopilot-cron и рестарты daemon генерят новые прогоны часами (исторический инцидент: 4217 «task received», 400 рестартов). Queued-задачи безопасно держать в очереди (у них нет таймаута, в отличие от dispatched).

**Если конфликт при merge/rebase:** держать классификатор+вызов в runTask, гейт в `ClaimTaskForRuntime`, skip в scheduler. Литералы reasons продублированы в service по той же конвенции, что исключения `GetLastTaskSession`.

---

### Патч 31 — `POST /rerun` принимает `{"force_fresh": false}` (resume-семантика, AITO-322)

**Файлы (правки):**
- `server/internal/handler/task_lifecycle.go` — `RerunIssue` читает опциональное JSON-body `{"force_fresh": bool}`; нет body / битое body = true (историческое поведение).
- `server/internal/service/task.go` — `RerunIssue(..., forceFresh bool)` пробрасывает в `enqueueIssueTask` вместо хардкода `true`.
- `server/cmd/server/rerun_session_test.go` — существующий вызов обновлён (`true`).
- `server/internal/handler/rerun_force_fresh_test.go` (новый) — 3 теста: дефолт true, явное false → `force_fresh_session=false`, явное true.

**Зачем:** Brain'у нужен способ ретраить упавшего Reflector'а с resume прежней сессии (упавшая `agent_error`-сессия резюмируема через `GetLastTaskSession`, частичная работа рефлексии не выбрасывается). До патча rerun всегда форсил fresh — кэш терялся.

**Если конфликт при merge/rebase:** держать body-парсинг в handler + параметр `forceFresh` в сервисе.

---

### Патч 32 — новый таб Monitoring → Manners (орган манер `GET /api/manners`, AITO-326)

**Файлы (правки):**
- `packages/core/monitoring/types.ts` — интерфейсы `MannerRuleRow` (short_id `R-<id8>`, agent_name, kind, content, applicability_hint, status, applied_count=served/approved_count=cited, decay_score, last_confirmed_at, added_at, created_by user/reflection/promotion), `MannerCandidateRow` (fact_short_id `F-<id8>`, alias, reference_count, distinct_classes), `MannersEngagement` (howto_calls_7d, howto_misses_7d, pull_serves_7d), `MannersResponse` — зеркало `brain/api/manners.py`. После `AdviceResponse`.
- `packages/core/monitoring/queries.ts` — `monitoringKeys.manners()` + `mannersOptions()` → `getJson<MannersResponse>('/manners')` (без пагинации: пул global-правил мал по построению), staleTime 30_000.
- `packages/views/monitoring/components/manners-tab.tsx` (новый) — три блока: (1) engagement-карточки за 7 дней (how-to calls / misses-gap / fact pulls), (2) таблица конвенций (Convention с wrap `max-w-0 whitespace-normal break-words`, бейдж kind=negative, short_id+hint моноширинно; Agent; StatusBadge active/tentative/archived c `opacity-50` у archived; Served/Cited; Born by бейдж; Added `formatWhen`), (3) таблица miner-кандидатов (Fact alias+`F-…`, References, Classes). Серверная сортировка не трогается. Никакого горизонтального скролла.
- `packages/views/monitoring/components/monitoring-page.tsx` — `manners` в `TAB_KEYS` и `TAB_ICONS` (иконка `Handshake`) **между `rules` и `advice`**, рендер `<MannersTab/>`, deep-link `?tab=manners`.
- `packages/views/locales/{en,zh-Hans}/monitoring.json` — `nav.manners` + блок `manners.*` (title/subtitle/col_*/engagement_*/candidates_*/empty). Парность ключей обязательна (vitest `locales/parity.test.ts`).
- `apps/web/app/bff/monitoring/[...path]/route.ts` — `"manners"` в `ALLOWED` + хелпер `brainTarget(sub, search)`: для `manners` таргет `${BRAIN_URL}/api/manners` (топ-уровневый эндпоинт органа манер, НЕ `/api/monitoring/manners`), для остальных — прежний `/api/monitoring/<sub>`.

**Зачем:** Monitoring-поверхность органа манер (plans/memory-redesign-2026-06-12.md, решение №10): global-правила (class_id IS NULL — конвенции мастерской из recall-секции manners) со счётчиками lifecycle, кандидаты майнера конвенций (read-only зеркало выборки следующего часового прохода, GET правил не рождает) и engagement петли знаний. Brain-эндпоинт `GET /api/manners?candidates_limit` — `brain/api/manners.py`.

**Typecheck:** `pnpm turbo typecheck --filter=@multica/core --filter=@multica/views --filter=@multica/web` — зелёный; `pnpm vitest run locales/parity.test.ts` (packages/views) — зелёный.

**Если конфликт при merge/rebase:** держать `"manners"` в ALLOWED + `brainTarget` (manners → `/api/manners`) в BFF, типы `Manner*` + `mannersOptions`/`monitoringKeys.manners`, `manners-tab.tsx`, регистрацию в `TAB_KEYS`/`TAB_ICONS`/`TabsContent`, парность `nav.manners` и блока `manners.*` в обеих локалях.

---

### Патч 19 — pull-режим: очередь `routine_task_queue` + флаг `pull_scheduled`

**Файлы:**
- `server/migrations/071_routine_task_queue.{up,down}.sql` — новая таблица очереди заданий для агентов-на-рутинах.
- `server/pkg/db/queries/routine_task_queue.sql` — sqlc-запросы (enqueue ON CONFLICT, claim CAS, reclaim, complete-by-issue, backlog-count, list).
- `server/internal/handler/routine_task.go` — 8 HTTP-эндпоинтов.
- `server/cmd/server/router.go` — роуты `/api/routine-tasks` в workspace-scoped группе.
- `server/internal/handler/issue.go` — `isPullScheduledConfig`-skip в `shouldEnqueueAgentTask`.
- `server/internal/handler/comment.go` — helper `isPullScheduledConfig`.

**Зачем:** перевод pipeline-агентов с push (multica-daemon + API, платим за токены) на pull через рутины Claude Desktop (flat-подписка). Brain пишет задание в `routine_task_queue`; рутина по cron читает pending, claim'ит (CAS + lease), исполняет роль, постит `[PLAN]` от имени агента (X-Agent-ID), Brain закрывает задание по факту маркера. Старт — Planner. plans/planner-routine-experiment-2026-06-13.md (arc-репо aito1).

**Что изменено:**
- Таблица `routine_task_queue` с partial-UNIQUE `(agent_id, issue_id, action) WHERE status IN ('pending','claimed')` — идемпотентный enqueue (дедуп, который push получал бесплатно от assignee-diff gate).
- `claim` — атомарный CAS `UPDATE ... WHERE id=$1 AND status='pending' RETURNING` + lease (`lease_expires_at`) + `attempt++`; 409 на проигрыш CAS.
- `reclaim` — stale `claimed` (lease истёк) → `pending` (retry) или `failed` (после `max_attempts`, dead-letter). Зовёт Brain в recovery_loop (второй канал, инвариант 5).
- `isPullScheduledConfig(runtimeConfig) bool` — true если `agent.runtime_config.pull_scheduled == true`. В `shouldEnqueueAgentTask`: после ready-check, если assignee pull_scheduled → `return false` (нет on-assign push). Пустой/битый config → false.

Флаг `pull_scheduled` ставится в live БД на Planner (`UPDATE agent SET runtime_config = runtime_config || '{"pull_scheduled":true}' WHERE name='Planner'`) ВМЕСТЕ с settings `planner.pull_mode=true` (иначе partial-state: push подавлен, очередь не пишется).

**Не-pull агенты** (Executor/Reflector/Junior/autopilot) не затронуты — нет флага. `rerun` минует `shouldEnqueueAgentTask`, поэтому re-trigger pull-агентов подавляется НЕ флагом, а Brain-кодом (замена `_rerun_safe` на routine_enqueue в brain/listener).

**Если конфликт при merge/rebase:** сохранить `isPullScheduledConfig`-skip в `shouldEnqueueAgentTask` (issue.go) и helper рядом с `isBrainDispatchedConfig` (comment.go). Миграция 071 + queries + handler + роуты аддитивны — конфликтов с upstream не ожидается.

---

## Классификация transient API-падений на error-пути + retry api_unavailable (AITO1 reliability, 2026-06-23)

**Файлы:**
- `server/internal/daemon/daemon.go` — `handleTask` error-путь: `classifyStartupFailure(err.Error(), 0)` вместо хардкода `"agent_error"` в `FailTask`.
- `server/internal/service/task.go` — `retryableReasons += "api_unavailable"`.

**Зачем:** агент упал с «API Error: 529 Overloaded» (временный overload LLM). Падение пошло error-путём `executeAndDrain` → `handleTask` хардкодил `failure_reason="agent_error"`, минуя `classifyStartupFailure` (тот распознаёт 529 → `api_unavailable`, но висел только на result.Status-ветке). Из-за этого сервер-ретрай не срабатывал (`api_unavailable` не был в `retryableReasons`), а Brain видел `agent_error` вместо `api_unavailable` (ломало alert agents_down + watchdog-классификацию). Задача застревала в `todo`, окно WIP=1 вставало. (AIT-790; arc-репо aito1.)

**Что изменено:**
- error-путь `handleTask` классифицирует `err.Error()` через `classifyStartupFailure(…, tools=0)` (execute не вернул result → tool-call не было); неизвестная сигнатура → прежний `"agent_error"`.
- `api_unavailable` добавлен в `retryableReasons` — ОДИН немедленный resume-retry (CreateRetryTask несёт session_id/work_dir). Колонки `not_before` нет → backoff в Go не делаем; повторные попытки с задержкой (~10 мин) делает Brain agent-watchdog (arc-репо aito1, `brain/listener/dispatch.py`). `agent_auth` НЕ retryable (нужен Human /login → Brain алертит).

**Если конфликт при merge/rebase:** сохранить классификацию на error-пути `handleTask` (не возвращать к хардкоду `"agent_error"`) и `api_unavailable` в `retryableReasons`. Аддитивно, конфликтов с upstream не ожидается.

---

### Патч 19 — Cognitive-PM кокпит (read-only вкладка + BFF)

Аддитивная вкладка продуктового интеллекта (цифровой двойник): read-only окно в разум PM, который Brain держит
в `aito1_pm_*` (личная цель / граф обязательств / лог решений). Исполнительная истина (вехи PDLC, задачи) — в
Яндекс.Трекере, не здесь.

**Что добавлено (всё аддитивно, upstream не трогает):**
- BFF-прокси `apps/web/app/bff/pm/[...path]/route.ts` — same-origin, гейт по cookie `multica_logged_in`, форвард
  на Brain `/api/pm/*` (read-only GET, allowlist `goal|commitments|decisions|lessons|error-metric`). Зеркало `bff/monitoring`.
- `packages/core/cognitive-pm/{types,queries,index}.ts` + export `./cognitive-pm` в `packages/core/package.json`.
- `packages/views/cognitive-pm/...` (view `CognitivePmPage`: 3 секции) + export `./cognitive-pm` в `packages/views/package.json`.
- Страница `apps/web/app/[workspaceSlug]/(dashboard)/cognitive-pm/page.tsx` — реэкспорт. Доступна по URL
  `/<ws>/cognitive-pm`; в nav-сайдбар (`packages/views/layout/app-sidebar.tsx`) ПОКА не добавлена (минимизация
  риска ночной сборки — добавить отдельно). `project_id` захардкожен (единственный dogfood-проект).

**Сборка/деплой:** `./scripts/aito1-deploy.sh frontend`. Проверено: build чистый (роуты `/[ws]/cognitive-pm` +
`/bff/pm/[...path]`), homepage 200, `/bff/pm/*` 401 без cookie (гейт), страница 200.

**Если конфликт при merge/rebase:** всё аддитивно (новые файлы + по одной строке в двух `package.json` exports);
конфликтов с upstream не ожидается.

---

### Патч 20 — Cognitive-PM HITL: панель «задачи на владельца + вердикт» + nav-вкладка

Достройка кокпита под новый механизм HITL (когнитивный PM/CR ставит задачи НА владельца в multica; его триаж —
сигнал обучения). Бэкенд — в arc-репо AITO1 (`aito1_pm_owner_tasks` + `/api/pm/owner-task[s]`); здесь — форк-часть.

**Что добавлено (аддитивно):**
- BFF allowlist (`apps/web/app/bff/pm/[...path]/route.ts`): +`owner-tasks` в `ALLOWED`.
- `packages/core/cognitive-pm/{types,queries}.ts`: тип `OwnerTaskTriage` + `ownerTasksOptions` → `/bff/pm/owner-tasks/{pid}`.
- `packages/views/cognitive-pm/.../cognitive-pm-page.tsx`: секция `OwnerTasksSection` (кто PM/CR · задача · твои
  комментарии · вердикт badge). Вставлена после «Личная цель».
- **Nav-вкладка** (ранее отложенная): `paths.ts` (+`cognitivePm()`), `reserved-slugs.ts` (+`cognitive-pm`),
  `locales/{en,zh-Hans}/layout.json` (+`nav.cognitive_pm`), `app-sidebar.tsx` (иконка `Brain`, `NavKey`/`NavLabelKey`
  +`cognitivePm`, пункт в `workspaceNav`).

**Сборка/деплой:** `STANDALONE=true pnpm --filter web build` чистый → `./scripts/aito1-deploy.sh frontend`. Проверено:
страница `/<ws>/cognitive-pm` 200, homepage 200, `/bff/pm/owner-tasks/*` 401 без cookie (гейт).

**Если конфликт:** аддитивно; единственная точка касания upstream — `app-sidebar.tsx` (один пункт + иконка) и
`paths.ts`/`reserved-slugs.ts`/`layout.json` (по одной строке).

---

### Патч 21 — Cognitive-PM кокпит v2: чекпоинты вместо личной цели + тип поручения

Перестройка концепта (личной цели у двойника нет → цель = закрыть вехи Трекера; недельная декомпозиция = чекпоинты
у нас; поручения несут `kind`). Бэкенд — в arc-репо AITO1; здесь форк-часть кокпита.

**Что изменено (аддитивно к Патч 19/20):**
- `packages/core/cognitive-pm/types.ts`: `Goal` → `Checkpoint` (milestone_key/title/target_date/status);
  `OwnerTaskTriage` +`kind`.
- `packages/core/cognitive-pm/queries.ts`: `goalOptions` → `checkpointsOptions` (`/bff/pm/checkpoints/{pid}`).
- `packages/views/cognitive-pm/.../cognitive-pm-page.tsx`: `GoalSection` → `CheckpointsSection` (миницель/веха/
  срок/статус); в `OwnerTasksSection` — `KIND_LABEL` (тип поручения под заголовком).
- `apps/web/app/bff/pm/[...path]/route.ts`: allowlist `goal` → `checkpoints`.

**Сборка/деплой:** build чистый (нет ссылок на `Goal`), `./scripts/aito1-deploy.sh frontend`. Проверено: страница
`/<ws>/cognitive-pm` 200, `/bff/pm/checkpoints/*` 401 без cookie (гейт).

**Если конфликт:** аддитивно, всё в `packages/{core,views}/cognitive-pm` + одна строка allowlist; upstream не трогает.

---

### Патч 33 — Cognitive-PM: колонка «Записано» (дата решения) в логе решений

В панели «Лог решений (открытые)» не было видно, когда решение занесено в журнал. Бэк уже отдавал `decided_at`
(`DecisionOut` в `brain/api/pm.py`, `ORDER BY decided_at`), фронт-тип `Decision.decided_at` тоже был — поле просто
не выводилось в таблицу.

**Что изменено (аддитивно к Патч 19/20/21):**
- `packages/views/cognitive-pm/.../cognitive-pm-page.tsx`, `DecisionsSection`: добавлена колонка «Записано»
  (`w-28`, между «Контур» и «Обоснование») с `fmtDate(d.decided_at)` — по образцу колонки «Срок» в других секциях.

Типы/queries/BFF/бэк не трогались (поле уже было в контракте).

**Сборка/деплой:** `./scripts/aito1-deploy.sh frontend`.

**Если конфликт:** аддитивно, одна секция в `cognitive-pm-page.tsx`; upstream не трогает.

---

## Cron-парсер автопилотов: robfig/cron → gronx (2026-06-28)

**Зачем:** автопилот-расписания нужны для процессов, привязанных к ДНЯМ НЕДЕЛИ (напр. месячный контур
Cognitive PM — каждую 4-ю пятницу 17:00). `robfig/cron/v3` не умеет nth-weekday: `5#4` даёт ошибку парсинга, а
both-set day-of-month + day-of-week трактуется как OR (нельзя выразить «4-я пятница»).

**Что:** `server/internal/service/cron.go` — `ComputeNextRun` переписан с `robfig/cron/v3` на
`github.com/adhocore/gronx` (валидация `gronx.New().IsValid`, расчёт `gronx.NextTickAfter(expr, now.In(loc), false)`).
gronx поддерживает `#` (nth weekday), `L` (last), `W` (nearest). `go.mod`/`go.sum`: + gronx v1.20.0, − robfig/cron
(больше нигде не использовался). Сигнатура `ComputeNextRun`/`ValidateTimezone` не менялась — все вызовы
(`autopilot_scheduler.go`, `handler/autopilot.go`) работают как раньше; стандартные 5-полевые выражения совместимы.

**Проверено:** `0 17 * * 5#4` @ Europe/Moscow → 24.07 / 28.08 / 25.09 (все 4-е пятницы); `0 11 1 * *` → 1-е число
(обратная совместимость); `5L` → последняя пятница. Триггер месячного автопилота переведён на `0 17 * * 5#4`.

**Сборка/деплой:** `./scripts/aito1-deploy.sh backend`. **Если конфликт:** правка изолирована в одном файле
`service/cron.go` + go.mod/sum; upstream cron-логику не трогает.

---

## Sticky-поле комментария на странице задачи (2026-07-01)

**Зачем:** при чтении длинного комментария агента поле «Leave a comment» уезжало вверх за экран —
чтобы дописать правку по ходу чтения, приходилось скроллить туда-обратно.

**Что:** `packages/views/issues/components/issue-detail.tsx` — обёртка `<CommentInput>` (в секции
«Activity / Comments», перед лентой newest-first): классы `mt-4 mb-4` → `sticky top-0 z-20 bg-background pt-4 pb-3`.
Поле уже стояло вверху ленты; теперь оно залипает у верха скролл-контейнера (`scrollContainerRef`,
`overflow-y-auto`). `z-20` выше, чем `sticky top-4 z-10` у `AgentLiveCard` — при одновременном залипании
(агент активно работает) поле ложится поверх live-баннера; баннер вне активной задачи рендерит `null`, так что
в обычном чтении отчёта конфликта нет.

**Проверено:** визуально на AIT-862 (kimi-webbridge) — поле остаётся у верха при прокрутке длинного комментария.

**Сборка/деплой:** `./scripts/aito1-deploy.sh frontend`. **Если конфликт:** одна строка className в
`issue-detail.tsx`; upstream раскладку страницы задачи не трогает.

---

### Патч 34 — Cognitive-PM кокпит v3: закрытые решения, уроки, калибровка

Фаза 3 плана `junior-pm-system-2026-07-02.md` §3/§8 (arc-репо AITO1) — «тренер проверяет решение за ≤5 минут».
Read-only витрина; кнопки approve/retire уроков сознательно НЕ делаются (вопрос №3 владельцу про POST в BFF открыт).

**Файлы:**
- `packages/core/cognitive-pm/types.ts` — `Decision` += `decision_type`/`task_id`/`info_basis_refs`/`alternatives`;
  новые `InfoBasisRef`, `DecisionAlternative`, `ResolvedDecision`, `Lesson`, `LessonEvent`, `CalibrationRow`
  (зеркала Out-моделей `brain/api/pm.py`).
- `packages/core/cognitive-pm/queries.ts` — `resolvedDecisionsOptions` (`/decisions/{pid}/resolved`),
  `lessonsOptions`, `lessonEventsOptions` (лениво, на разворот карточки), `calibrationOptions`.
- `packages/views/cognitive-pm/components/cognitive-pm-page.tsx`:
  - секция «Закрытые решения» — карточки: outcome_kind-бейдж цветом (correct зелёный / partial жёлтый /
    error красный / no_response серый), rationale → expected + confidence → outcome, Brier/severity/
    process_verdict/resolved_by, даты decided→resolved;
  - чипы `info_basis_refs` (source_type + укороченный ref, title=excerpt, клик копирует полный ref в буфер)
    и список `alternatives` (option — why_rejected) — в открытых И закрытых решениях;
  - «трейс прогона» по `task_id` — `TranscriptButton` с синтетическим `AgentTask` (приём autopilot-detail-page);
  - секция «Уроки» — статус-бейдж (active/quarantined/retired), тип, trigger_condition, scope_in/out,
    счётчики помог/вредил, укороченный external_id; разворачиваемый таймлайн `lesson_events`
    (op → actor → embedded_into → detail кратко → дата) — витрина «какой урок, что изменил, куда встроено»;
  - секция «Калибровка» — таблица bucket («80–90%») × n × hit_rate × Brier, группировка по decision_type
    (NULL — «без типа» в конце). Все длинные тексты — break-words (wrap, не горизонтальный скролл).
- `apps/web/app/bff/pm/[...path]/route.ts` — GET-allowlist += `lesson-events`, `calibration`
  (`/decisions/{pid}/resolved` и `/overdue` проходят через уже разрешённый сегмент `decisions` — гейт по `path[0]`).

**Проверки:** `pnpm --filter @multica/core --filter @multica/views --filter web typecheck` — чисто;
eslint по изменённым каталогам — чисто (единственный error полного прогона — pre-existing в
`monitoring/knowledges-tab.tsx`, не из этого патча). Сборка/деплой в этом патче не выполнялись.

**Если конфликт:** аддитивно в `packages/{core,views}/cognitive-pm` + 2 строки allowlist; upstream не трогает.

---

### Патч 35 — ложный failed прогона: completion демона бьёт вердикт runtime_offline

Живой кейс 2026-07-02 (task `9e616824`, autopilot run `3b14aba4`, daily-контур Cognitive PM): демон 4 минуты не
хартбитил (10:53–10:57), runtime sweeper пометил runtime offline и через `FailTasksForOfflineRuntimes` уронил
задачу в `failed / 'runtime went offline'` → autopilot-listener уронил ран. Демон при этом был жив (status-poll
через 100 мс после вердикта), агент доработал ещё 15 минут и в 11:12:19 отправил `POST /complete` —
`CompleteAgentTask` (guard `status='running'`) вернул 0 строк, и completion молча ушёл в
«already finalized» no-op. И задача, и ран остались лживо failed при полностью сделанной работе.

**Фикс:** completion демона — доказательство, что процесс выжил и доделал; оно выигрывает у догадки sweeper'а.

**Файлы:**
- `server/pkg/db/queries/agent.sql` — новый query `ReviveRuntimeOfflineTask`: guarded UPDATE
  `WHERE status='failed' AND failure_reason='runtime_offline'` → `completed`, чистит error/failure_reason,
  COALESCE-ит session_id/work_dir. Настоящие фейлы (agent_error/timeout/iteration_limit/…) не оживают —
  guard по failure_reason.
- `server/internal/service/task.go` — `CompleteTask`: в ErrNoRows-ветке ПЕРЕД «already finalized» —
  revive-попытка; при успехе выполняется штатный completion-flow (коммент-fallback, reconcile,
  `EventTaskCompleted`) → autopilot-listener → `SyncRunFromTask` видит completed-задачу → ран completed
  (сверка финального статуса задачи в agent_task_queue: задача completed → ран completed).
- `server/pkg/db/queries/autopilot.sql` — `UpdateAutopilotRunCompleted` += `failure_reason = NULL`
  (у completed-рана не бывает причины фейла; иначе оживший ран показывал бы зелёный статус с красным текстом).
- `server/pkg/db/generated/{agent,autopilot}.sql.go` — `sqlc generate` (v1.31.1, совпадает с checked-in).
- `server/internal/service/task_complete_race_test.go` — `TestCompleteTask_RevivesFalseRuntimeOfflineFailure`
  (mock: CompleteAgentTask мимо, revive попадает → задача возвращается completed).

**Проверки:** `go build ./...` OK; `go test ./internal/service/ ./pkg/agent/... -count=1` OK.
Бинарь не пересобран и не задеплоен — для прод-эффекта нужен `./scripts/aito1-deploy.sh backend`.

**Если конфликт:** upstream активно правит `task.go` — сохранить семантику «в ErrNoRows-ветке CompleteTask
сначала guarded revive по failure_reason='runtime_offline', и только потом idempotent no-op». Если upstream
сам начнёт различать false-fail — принять upstream, наш query удалить.

---

### Патч 36 — Cognitive-PM: кнопки approve/retire уроков (гейт тренера, первые POST в BFF)

Владелец одобрила вариант (а) вопроса №3 плана `junior-pm-system-2026-07-02.md`: активация урока — кнопкой в
кокпите. Это ПЕРВЫЕ и единственные мутации из UI кокпита; всё остальное остаётся read-only.

**Файлы:**
- `apps/web/app/bff/pm/[...path]/route.ts` — POST-хэндлер с shape-based allowlist ровно двух путей:
  `lesson/{uuid}/approve` и `lesson/{uuid}/status` (3 сегмента, литералы + UUID-regex — не префикс, расширение
  в open relay невозможно). Body проксируется как есть; гейт по той же session cookie; 10s timeout / 502 как в GET.
- `packages/core/cognitive-pm/mutations.ts` *(новый)* — `useApproveLesson` (POST approve БЕЗ body — контракт
  `brain/api/pm.py`: approve actor не принимает, owner зашит в Brain) и `useSetLessonStatus`
  (`{"status":"retired"|"quarantined","actor":"owner"}`); onSettled — invalidate `lessons(pid)` +
  `lessonEvents(lessonId)` (таймлайн, если раскрыт, перечитывается). `index.ts` — экспорт.
- `packages/views/cognitive-pm/components/cognitive-pm-page.tsx`, `LessonCard`: на quarantined — «Одобрить»
  (один клик, без подтверждений — ритуал субботнего разбора) + «В retired»; на active — только «В retired»;
  retired — без кнопок. Retire — через AlertDialog-подтверждение (в тексте: tombstone, ключ external_id
  освобождается). Кнопки disabled на время мутации; success/error — toast.

**Контракт Brain (сверен по `brain/api/pm.py`, не менялся):** POST `/pm/lesson/{id}/approve` без body → `{ok}`;
POST `/pm/lesson/{id}/status` c `LessonStatusRequest` → `{ok}`, 404 если урок не найден (пробрасывается через BFF).

**Проверки:** typecheck core/views/web — чисто; eslint изменённых каталогов — чисто. Сборка/деплой не выполнялись.

**Если конфликт:** аддитивно (новый POST-хэндлер + mutations.ts + один компонент); upstream не трогает.

---

### Патч 37 — Cognitive-PM: фикс схлопывания колонок + вводный блок «Как читать эту страницу»

UX-фидбек владельца по живой странице `/cognitive-pm`. Один файл:
`packages/views/cognitive-pm/components/cognitive-pm-page.tsx`.

**1. Баг вёрстки «Ожидаемые обязательства»:** в авто-раскладке таблицы колонка «Кто → кому» (без
ширины/`max-w-0`) забирала всю ширину, а «Что» (`max-w-0`) схлопывалась в вертикальный столбец по одной букве.
Фикс: `table-fixed` на `<Table>` + явные ширины («Кто → кому» `w-[35%]`, «Что» — остаток, Срок `w-28` /
Статус `w-24`, даты `whitespace-nowrap`), текстовые ячейки — `break-words` (правило владельца: длинный контент
wrap, не сжатие). Тот же паттерн превентивно закрыт во ВСЕХ таблицах страницы: чекпоинты, открытые решения
(2 гибкие колонки), задачи-на-тебе (2 гибкие колонки) — всем `table-fixed`, костыль `max-w-0` с ячеек снят
(при fixed-раскладке ширины держат TH). «Уроки»/«Закрытые решения» — карточки, не таблицы; «Калибровка» —
все колонки узкие фиксированные с коротким числовым контентом, паттерна риска нет, оставлена auto.

**2. Вводный блок `IntroSection`** — первый на странице, «открыл и сразу всё вспомнил»:
- легенда 7 слоёв (чекпоинты / лог решений / закрытые / поручения / обязательства / уроки / калибровка) —
  1-2 строки на слой, заголовки кликабельны (scrollIntoView к секции);
- схема связей 4 строками flex-чипов без новых зависимостей: SENSE → РЕШЕНИЯ → ПОРУЧЕНИЯ → вердикты → в исходы;
  РЕШЕНИЯ —(проверка ожидания: Трекер/таймаут)→ ЗАКРЫТЫЕ → КАЛИБРОВКА; ЗАКРЫТЫЕ → CR (суббота) → УРОКИ
  (карантин → «Одобрить» → active → в поведение PM); ОБЯЗАТЕЛЬСТВА → АЛГЕДОНИКА → Telegram. Узлы с секцией —
  кликабельные кнопки-якоря; контекстные (SENSE, CR, алгедоника…) — пунктирные, некликабельные;
- сворачиваемый, по умолчанию развёрнут; состояние в `localStorage` (`aito1-pm-cockpit-intro-collapsed`),
  читается в `useEffect` — без SSR hydration-рассинхрона. Секциям страницы добавлены id `pm-*` (якоря).

**Проверки:** `pnpm --filter @multica/views typecheck` — чисто; eslint `cognitive-pm/` — чисто.
Сборка/деплой не выполнялись.

**Если конфликт:** один файл в `packages/views/cognitive-pm`; upstream не трогает.

---

### Патч 38 — Cognitive-PM: развёрнутое объяснение калибровки

Запрос владельца («калибровка — сложная штука»). Один файл:
`packages/views/cognitive-pm/components/cognitive-pm-page.tsx`. Тексты владельца дословно
(типографика кавычек приведена к «…» файла; опечатка «系статически» → «систематически»).

**Что изменено:**
- Подзаголовок-описание под заголовком секции «Калибровка» (muted, 2-3 строки): сверка заявленной
  уверенности с фактической сбываемостью по типам; вход субботнего CR; позже сводка поедет в контекст PM
  («на 0.9 ты сбываешься в 0.62 — занижай»).
- Новый helper `HeadHint` (пунктирное подчёркивание + `Tooltip`/`TooltipContent` дизайн-системы,
  готового паттерна подсказок в таблицах в репо не было) + словарь `CAL_HINTS`. Tooltip'ы: заголовок
  группы = тип решения (трезв в сроках / переуверен в качестве; «без типа» = до словаря типов),
  «Уверенность» = бакет-дециль, «n» (= n<~10 — анекдот, не статистика), «hit rate» (сбылось 1 /
  частично 0.5 / ошибка 0, читать в паре с бакетом), «Brier» (квадрат промаха; 0 идеал, 0.25 = «всегда
  50/50», 1 = уверенно ошибался; ненахакиваем — PM не видит его как цель).
- Пункт «Калибровка» вводного блока расширен: хорошо калиброванный PM на «90%» прав в ~9 из 10;
  LLM систематически переуверены — меряем по данным, не спрашиваем модель; перекос → урок CR.

**Проверки:** `pnpm --filter @multica/views typecheck` — чисто; eslint `cognitive-pm/` — чисто.
Сборка/деплой не выполнялись.

**Если конфликт:** один файл в `packages/views/cognitive-pm`; upstream не трогает.

---

### Патч 39 — шире центральная колонка страницы задачи (тело + комментарии)

Запрос владельца («сделать рабочую область в задаче ~на 20% шире»). Один файл:
`packages/views/issues/components/issue-detail.tsx`. Центральная скролл-колонка (тело задачи,
sticky-composer, лента комментариев) была ограничена `max-w-4xl` (56rem / 896px) и центрировалась
`mx-auto`, оставляя широкие поля; правая панель Properties (`w-80`) не трогается.

**Что изменено:**
- `max-w-4xl` → `max-w-[74rem]` (56rem/896px → 74rem/1184px, +32%; подбирали итеративно по ощущению
  владельца: сначала +20%, затем ещё +10%) в двух местах: реальный контент (строка ~728) и
  skeleton-состояние загрузки (строка ~431) — оба меняются синхронно, чтобы не было прыжка ширины
  при загрузке.
- `rem` вместо px — уважает масштабирование шрифта пользователя; `w-full` остаётся потолком, поэтому
  на узких экранах колонка не вылезает за пределы flex-1 области.

**Если конфликт:** один файл в `packages/views/issues`; upstream может переверстать issue-detail —
искать контейнер `mx-auto w-full max-w-* px-8 py-8` вокруг `TitleEditor`/`CommentInput`.

---

### Патч 40 — выпил страницы логина + переключатель identity (single-user форк)

Запрос владельца: «уничтожить страницу логина как сущность, чтобы интерфейс
открывался сразу без проверки»; при этом сохранить переключение между member-
учётками (Human / Louis / Teamlead / Remote Human). Форк single-user, localhost.

Ключевой инвариант backend'а (НЕ трогали): identity резолвится сервером из токена
в заголовок `X-User-ID` (`server/internal/middleware/auth.go`) — либо JWT-cookie
`multica_auth`, либо PAT `mul_…` в `Authorization: Bearer`. Клиент identity не
задаёт. Решение: вместо логина фронт кладёт PAT нужного члена в `localStorage`
(`multica_token`) → api-client уходит в Bearer-режим (`hasLegacyToken`) → сервер
резолвит члена. Это ровно паттерн, которым уже ходят Brain и CLI. Backend без правок.

**Что изменено (всё — фронт):**
- NEW `packages/core/auth/identity-registry.ts` (+ `.test.ts`, 6 кейсов) — реестр
  учёток в localStorage (`multica_identities`), `readIdentities/activeToken/
  activeIdentity/switchIdentity` (пишет токен + reload). Реэкспорт в `auth/index.ts`.
- `packages/views/layout/app-sidebar.tsx` — группа «Act as» в user-dropdown: 4 учётки
  с ролью, галка на активной, клик → `switchIdentity`.
- `apps/web/proxy.ts` — убрана вся ветка редиректа на `/login`; корень и легаси-пути
  всегда ведут в `/{slug}/issues`, slug = `NEXT_PUBLIC_DEFAULT_WORKSPACE_SLUG` (деф.
  `aito1`). Зависимость от cookie `multica_logged_in` убрана (в token-режиме её нет).
- `apps/web/app/(auth)/login/page.tsx` — email-OTP + Google OAuth + CLI/desktop
  handoff заменены на dev identity-picker (кнопки из реестра + ручная вставка PAT).
  Показывается ТОЛЬКО при пустом localStorage (fresh/cleared) — graceful fallback,
  не стена. CLI browser-login выпилен (CLI ходит по своему PAT из конфига).
- Guard'ы `[workspaceSlug]/layout.tsx` и `use-dashboard-guard.ts` НЕ трогали: при
  наличии токена `user` есть → молчат; без токена ведут на picker (не стену).

**Seed (вне репо, разово):** реестр 4 PAT кладётся в localStorage браузера. Токены
берутся из `~/.multica/profiles/aito1/config.json` (Human), `~/.multica/config.json`
(Louis), `~/.aito1/config.env` (Teamlead), `~/.aito1/remote_human.env` (Remote Human).
Сниппет — `~/.aito1/seed-identities.js`. Секреты НЕ в git и НЕ в бандле (те же PAT уже
лежат plaintext в этих файлах — модель угроз single-user не меняется).

**Проверки:** `vitest` identity-registry 6/6; typecheck core+views+web чисто; живьём
через Kimi — интерфейс открывается сразу на `/aito1/issues` под Human без логина,
switcher показывает 4 учётки, переключение Human↔Louis подтверждено на всех уровнях
(UI, localStorage, backend `GET /api/me` → louis@aito1.local).

**Если конфликт при merge с upstream:** upstream развивает cookie-login (auth.go,
login/page.tsx, proxy.ts) — наши правки его снимают. При апстриме заново снять три
редиректа (`proxy.ts`, оба guard'а ведут на picker) и заменить login/page на picker;
identity-registry и switcher — аддитивны, конфликтов не дают.

---

### Патч 41 — live-индикатор активной работы агента на карточке доски

Запрос владельца: при параллельной работе нескольких агентов на доске не видно, над
какой задачей агент работает ПРЯМО СЕЙЧАС. Один файл:
`packages/views/issues/components/board-card.tsx`.

**Что изменено:**
- В шапке карточки (линия 1) порядок: ключ → счётчик подзадач (`ProgressRing`) →
  **spinner** → иконка assignee. Assignee обёрнут в правый flex-кластер, spinner
  (`Loader2 animate-spin text-info`, тот же визуал, что у in-issue баннера
  `AgentLiveCard`) — слева от иконки агента.
- Сигнал «агент работает» — из общего workspace-снапшота тасков
  (`agentTaskSnapshotOptions(wsId)`, один fetch на всю доску, React Query дедуплицирует
  по queryKey). `hasActiveAgent` = в снапшоте есть таск с `issue_id == issue.id` и
  `status ∈ {queued, dispatched, running}` (тот же active-набор, что у `AgentLiveCard`).
- **Live** без перезагрузки: снапшот инвалидируется по WS-событиям тасков → spinner
  появляется/исчезает сам (self-heal при `task:completed/failed/cancelled`).
- **Status-agnostic**: показывается на карточке в любой колонке, где агент реально
  активен (in_progress ≠ «сейчас работает»; напр. агент бежит на in_review-задаче →
  spinner там).

**Проверки:** `pnpm --filter @multica/views typecheck` чисто; живьём через Kimi — при
активном прогоне на AIT-870 spinner появился на её карточке (live, без reload), при
завершении сам исчез; на карточках без активного таска spinner'а нет.

**Если конфликт:** один файл в `packages/views/issues`; upstream может переверстать
шапку board-card — искать flex-строку с `issue.identifier` + `ActorAvatar`, вставить
spinner в правый кластер перед assignee.

---

### Патч 42 — выбор проекта у create_issue-автопилотов

Запрос владельца: у автопилота в режиме Create Issue не было выбора проекта —
`dispatchCreateIssue` хардкодил `ProjectID: NULL`, и каждый create_issue-автопилот
(Prospector/Wanderer/Worker и будущий Curator) ронял issue в no-project scope, где
`status='todo'` занимает no-project dispatch-окно AITO1 (`_BUSY_STATES`) и блокирует
intake. «Если я выбираю Create Issue — нужно выбирать проект» → чиним в форке. Это
ВОЗВРАТ колонки: `autopilot.project_id` был в 042, снят 058 («не было в UI»);
возвращаем вместе с UI-селектором.

**Что изменено (вертикальный срез):**
- Миграция `server/migrations/072_autopilot_project_id.{up,down}.sql` — `ALTER TABLE
  autopilot ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES project(id) ON DELETE
  SET NULL` (зеркало 058.down). Опциональна, NULL для существующих и для run_only.
- sqlc: `server/pkg/db/queries/autopilot.sql` — `project_id` в `CreateAutopilot`
  (`sqlc.narg('project_id')`) и `UpdateAutopilot` (бэре `project_id =
  sqlc.narg('project_id')`, как `issue_title_template` — допускает очистку в NULL).
  `Get/List/SystemPause` — `SELECT */RETURNING *`, подхватилось само. Регенерация:
  `cd server && sqlc generate` (v1.31.1) → `db.Autopilot.ProjectID` + Create/Update
  Params + все Scan.
- Backend: `server/internal/service/autopilot.go:129` — `ProjectID: ap.ProjectID`
  вместо `pgtype.UUID{}` (issue штампуется проектом автопилота). Handler
  `server/internal/handler/autopilot.go` — `project_id` в `AutopilotResponse` +
  `autopilotToResponse` (`uuidToPtr`), в `Create/UpdateAutopilotRequest`; в Create —
  парс + валидация `GetProjectInWorkspace` (зеркало assignee-проверки); в Update —
  префилл `prev.ProjectID` + rawFields-блок (значение → validate+set; null/"" →
  очистка). Проект опционален, воркспейс-скоуп enforced.
- UI: `packages/core/types/autopilot.ts` — `project_id` в `Autopilot`/`Create`/`Update`.
  `packages/views/autopilots/components/autopilot-dialog.tsx` — state `projectId`,
  секция `ProjectSection` (переиспользует общий `ProjectPicker` + `ProjectIcon`),
  показывается ТОЛЬКО при `execution_mode=create_issue` (run_only issue не создаёт);
  payload шлёт `project_id` при create_issue, иначе `null` (сброс). `autopilot-detail-page.tsx`
  — `project_id` в initial для edit-режима. i18n `en/zh-Hans/autopilots.json` —
  `section_project`/`no_project`. Мутации/API-клиент не трогались (payload идёт насквозь).

**Проверки:** `go build ./...` чисто; `sqlc generate` без диффа-ошибок;
`pnpm --filter @multica/{views,core} typecheck` = 0; миграция применена на prod-БД
(5433), `\d autopilot` показывает `project_id`; live через Kimi — у create_issue-автопилота
выбран проект `tests`, ручной триггер → созданный issue лёг в `tests` (не в no-project).

**Если конфликт:** upstream может переверстать autopilot-форму — секция вставляется в
правую колонку (`<aside>`) после `OutputModeSection`, гейт `executionMode ===
"create_issue"`. Backend — единственная точка хардкода была `autopilot.go:129`
`ProjectID`. Миграция может столкнуться по номеру (072) — перенумеровать на следующий
свободный. sqlc-код (`pkg/db/generated/*`) — регенерируемый, руками не мержить.

---

### Патч 43 — Monitoring под memory-v2 + Curator: расширенные Facts/Knowledges + новые Episodes/Maintenance (memory-v2 08)

Только фронт (Brain-сторона — в arc-репо `aito1`, эндпоинты `/api/monitoring/*`). Наблюдаемость под новую семантику памяти после Curator-петли.

- BFF `apps/web/app/bff/monitoring/[...path]/route.ts` — в allowlist добавлены
  `episodes`, `maintenance`; GET теперь пропускает и 2-сегментный `maintenance/<id>`
  (detail), прокидывая на `/api/monitoring/maintenance/<id>`.
- `packages/core/monitoring/{types,queries}.ts` — типы `EpisodeRow`/`MaintenanceProposalRow`/
  `MaintenanceProposalDetail`/`LayerHealth`/`DeliverySummary` + расширены `FactRow`
  (`invalidation_reason`/`invalidated_by_fact_id`) и `FactsResponse` (`golden_inbox`),
  `KnowledgeRow` (`served_count`/`cited_count`); options с параметрами
  (`factsOptions(source)`, `knowledgesOptions(skillOnly, sort)`, `episodesOptions`,
  `maintenanceOptions`, `maintenanceDetailOptions` с `enabled`).
- `packages/views/monitoring/components/` — новые `episodes-tab.tsx`, `maintenance-tab.tsx`
  (health-бар + delivery-блок + лента предложений с ленивым разворотом detail: ops с
  rationale/lens/refs + per-op decision + reviewed-but-untouched + lens_counts); Facts-таб
  — source-чипы + golden-бейдж + `invalidation_reason` на инвалидированных строках;
  Knowledges-таб — колонка served/cited + чип «skill lessons» + sort newest/cited.
  `monitoring-page.tsx` — регистрация двух вкладок (иконки `History`/`Recycle`).
- i18n `en/zh-Hans/monitoring.json` — секции `episodes`/`maintenance` + ключи
  facts.`{source_all,golden_badge}` / knowledges.`{col_usage,usage_hint,skill_only,
  sort_created,sort_cited}` (parity-тест зелёный).

**Проверки:** `pnpm typecheck` = 0 (6 пакетов); `locales/parity.test.ts` 47/47;
новых lint/vitest-падений нет (app-sidebar-фейл предсуществующий); live через Kimi —
все 4 вкладки на реальных данных: Facts (48 golden, curator-merge trail), Knowledges
(skill:-уроки + served/cited), Episodes (AIT-N + lessons + outcome), Maintenance
(health 842/136/240 + delivery 17 recalls + лента AIT-884/883/882 + разворот ops/refs).

**Если конфликт:** upstream может переверстать Monitoring sub-nav — вкладки добавляются
в `TAB_KEYS`/`TAB_ICONS`/`TabsContent` в `monitoring-page.tsx`. BFF-detail-ветка —
единственное отступление от «1 сегмент = 1 подпуть» (иначе как Manners). Компоненты
изолированы (по файлу на вкладку), общий chrome — `tab-chrome.tsx`.

---

### Патч 44 — Cognitive-PM: кнопка «Отклонить» урок (мягкий reject в кокпите)

Утверждение/отклонение уроков собрано в одну точку — вкладку Cognitive PM. Раньше
approve был в кокпите, а reject — только косвенно, через отмену тикета (свипер ловил →
harmful). Теперь reject — явная кнопка рядом с «Одобрить»; отмена тикета больше не канал
reject (эффект переехал в Brain-endpoint). Тикет CR остаётся уведомлением, ведущим в
раздел. Семантика мягкая (решение тренера 2026-07-05): урок остаётся в карантине +
harmful+1, CR может переформулировать и вынести снова. Бэкенд — arc-репо AITO1
(`POST /api/pm/lesson/{id}/reject`, `pm_repos.reject_lesson`, enforcement перестал
бампать harmful у lesson-тикетов). Здесь — форк-часть.

**Что изменено (аддитивно к Патч 36):**
- `apps/web/app/bff/pm/[...path]/route.ts` — `isAllowedPost` += `reject` (3-й shape:
  `lesson/{uuid}/reject`, тот же shape-based гейт, не префикс).
- `packages/core/cognitive-pm/mutations.ts` — `useRejectLesson` (POST reject БЕЗ body,
  идемпотентно на повтор — контракт `brain/api/pm.py`); onSettled invalidate
  `lessons(pid)` + `lessonEvents(lessonId)`.
- `packages/views/cognitive-pm/.../cognitive-pm-page.tsx` — кнопка «Отклонить» (amber)
  на quarantined рядом с «Одобрить»; AlertDialog-подтверждение (текст: мягко, остаётся
  в карантине, harmful, CR может вернуться, не удаление); hint-тексты секции и схемы.

**Контракт Brain:** POST `/pm/lesson/{id}/reject` без body → `{ok}`; 404 если урока нет;
повтор — no-op 200 (guard по последнему `lesson_events.op`).

**Сборка/деплой:** `STANDALONE=true pnpm --filter web build` → `./scripts/aito1-deploy.sh frontend`.

**Если конфликт:** аддитивно; точки касания — `isAllowedPost` (+одна ветка) и LessonCard
(кнопка + диалог, зеркало retire-диалога Патча 36).

---

### Патч 45 — Cognitive-PM кокпит: селектор проектов (мультипроектный PM, Ф3)

Кокпит больше не прибит к dogfood-проекту: PM ведёт N проектов, выбор — из реестра Brain
(`aito1_pm_projects`, arc-репо AITO1; дизайн `plans/pm-multiproject-2026-07-07.md`).

**Что изменено (аддитивно к Патч 19/20/21/36/44):**
- `apps/web/app/bff/pm/[...path]/route.ts` — GET-allowlist += `projects`
  (`/bff/pm/projects` → Brain `GET /api/pm/projects`, реестр с display_name из `project.title`).
- `packages/core/cognitive-pm/types.ts` — тип `PmProject`; `queries.ts` —
  `pmProjectsOptions()` (ключ `cognitivePmKeys.projects()`).
- `packages/core/cognitive-pm/mutations.ts` — onSettled инвалидирует по префиксу
  `cognitivePmKeys.all` (закрывает stale-кэш при переключении проектов).
- `packages/views/cognitive-pm/.../cognitive-pm-page.tsx` — удалена константа `PROJECT_ID`;
  дропдаун `PmProjectPicker` в шапке; выбор живёт в `?project=<uuid>` (конвенция
  `?tab=` monitoring) + localStorage `aito1-pm-cockpit-project`; резолв значения строго
  против списка ручки (не найден → баннер + первый проект); пустой реестр → пустое
  состояние; секции получают `projectId` через props, LessonCard замыкает pid в своих
  mutation-хуках (переключение проекта при открытом confirm-диалоге безопасно).

**Контракт Brain:** GET `/pm/projects` → `[{project_id, display_name, nid, tracker_queue,
tracker_project_stid, bm_space, created_at}]`, порядок по created_at.

**Сборка/деплой:** `./scripts/aito1-deploy.sh frontend`.

**Если конфликт:** всё в наших файлах cognitive-pm (аддитивные патчи 19/20) + одна строка
BFF-allowlist; upstream не затронут.

---

### Патч 46 — свёртывание/развёртывание блока проекта на доске

**Зачем:** на доске много проектов = длинный скролл; сворачивание неактуальных
блоков-проектов (swimlane) убирает шум и даёт фокус.

**Файлы:**
- `packages/views/issues/components/board-view.tsx` — хук `useCollapsedLanes` (Set
  свёрнутых `lane.id` в localStorage `board:collapsed-project-lanes`, чтение после mount
  ради SSR/hydration); в `ProjectLaneHeader` слева добавлен chevron-тоггл (ChevronDown ⇄
  ChevronRight), в `ProjectSwimlane` колонки статусов рендерятся только при `!collapsed`.
  Дефолт — развёрнуто, состояние per-project переживает reload.
- `packages/views/locales/{en,zh-Hans}/issues.json` — ключи `board.collapse_project` /
  `board.expand_project` (aria-label кнопки; типы i18n авто-выводятся из en JSON, паритет
  локалей — `locales/parity.test.ts`).

**Сборка/деплой:** `./scripts/aito1-deploy.sh frontend`.

**Если конфликт:** всё аддитивно в `board-view.tsx` (новый хук + пропсы
`collapsed`/`onToggleCollapse` у `ProjectSwimlane`/`ProjectLaneHeader`) + 2 i18n-ключа;
upstream не затронут.

---

### Патч 47 — тумблер «Telegram Notifications» в Settings (вкл/выкл ТГ brain'а)

**Зачем:** отключать TG-уведомления AITO1 brain'а из UI (жить на Inbox'е), без правки
кода brain — флаг `notifications.telegram.enabled` уже гейтит нотифайер.

**Файлы (multica):**
- `apps/web/app/bff/notification-settings/route.ts` — новый same-origin BFF (GET/PUT),
  cookie-gate `multica_logged_in`, форвардит на Brain `GET/PUT /api/settings/notifications`
  (по образцу `/bff/monitoring`; brain — auth-free localhost:8082).
- `packages/views/settings/components/notifications-tab.tsx` — секция «Telegram
  Notifications», `Switch` читает/пишет через BFF (useQuery + useMutation, optimistic).
- `packages/views/locales/{en,zh-Hans}/settings.json` — ключи `notifications.telegram.*`.

**Правки вне репо (brain, arcadia `taxi/ai/aito1`):** `brain/api/admin.py` —
`GET/PUT /api/settings/notifications` (read/`set_setting` флага `notifications.telegram.enabled`);
doc `docs/notifications.md`. Go-бэкенд/CLI НЕ трогали (чисто фронт + Python + brain restart).

**Сборка/деплой:** `./scripts/aito1-deploy.sh frontend` + рестарт brain. Без Go/codesign.

**Если конфликт:** новый файл BFF + аддитивная секция Settings + 4 i18n-ключа;
upstream не затронут.

---

### Патч 48 — peek-сайдбар задачи (оверлей вместо перехода на страницу)

**Зачем:** клик по задаче в списке/на доске открывал отдельную страницу — чтобы
прощёлкать пачку задач (прочитать, прокомментировать, сменить статус), приходилось
ходить «назад-вперёд». Теперь клик открывает ту же `IssueDetail` в правом оверлей-`Sheet`
поверх списка; позиция в списке не теряется. Референс — Inbox уже встраивает `IssueDetail`
в master-detail. План: `plans/issue-peek-sidebar-2026-07-10.md`.

**Файлы (multica):**
- `packages/core/issues/stores/peek-store.ts` (нов.) + `stores/index.ts` — zustand-стор
  `useIssuePeekStore { openId, open(id), close() }`. `openId` = id ИЛИ identifier (AIT-42).
- `packages/views/navigation/app-link.tsx` — новый проп `onActivate?: () => void`: обычный
  (немодифицированный) клик вызывает его вместо `push(href)`; модификатор-клик (meta/ctrl/shift)
  не тронут → нативная новая вкладка/полная страница; `href` остаётся на `<a>` (middle-click, a11y).
- `packages/views/issues/components/list-row.tsx` + `board-card.tsx` — на существующем `AppLink`
  добавлен `onActivate={() => open(issue.identifier)}`. Перехват в самой строке/карточке →
  работает на списке, доске, my-issues и досках проектов.
- `packages/views/issues/components/issue-peek-sheet.tsx` (нов.) + `components/index.ts` —
  `Sheet side=right`, `showCloseButton={false}`, ширина через inline-`style`
  `{width:62vw, minWidth:560, maxWidth:1040}` (перебивает базовый `data-[side=right]:sm:max-w-sm`,
  который twMerge НЕ склеивает из-за variant-префикса). Рендерит `IssueDetail` с
  `defaultSidebarOpen={false}` (панель свойств скрыта; раскрывается тумблером `PanelRight` в шапке),
  `layoutId="multica_issue_peek_layout"`, `onDone/onDelete={close}`. Закрытие — Esc / клик по фону.
- `apps/web/app/[workspaceSlug]/(dashboard)/layout.tsx` — `<IssuePeekSheet/>` смонтирован один раз
  в слоте `extra` (глобальный стор → одна панель на все поверхности).

**Тесты:** `peek-store.test.ts` (4), `navigation/app-link.test.tsx` (3, вкл. модификатор-клик).
Живой QA (kimi): board+list клик → панель, URL не меняется, Esc закрывает, ширина-клэмп,
тумблер свойств, пикер статуса (base-ui поповер внутри Dialog), ввод комментария — ОК.
Известный нюанс: Escape при открытом пикере закрывает всю панель (приоритет Dialog), не блокер.

**Сборка/деплой:** `./scripts/aito1-deploy.sh frontend`. Чисто фронт, Go/codesign не трогали.

**Если конфликт при merge/rebase:** держать (1) проп `onActivate` в `AppLink` + ветку
`if (onActivate) { onActivate(); return; }` перед `push(href)`; (2) `onActivate` на `AppLink`
в `list-row.tsx`/`board-card.tsx`; (3) новые файлы `peek-store.ts`/`issue-peek-sheet.tsx` +
их экспорты; (4) монтаж `<IssuePeekSheet/>` в dashboard layout.

---

## Связанные правки **вне** этого репо (для полноты картины)

Эти правки лежат в других репо/файлах, но без них наш форк работает не полностью. Они описаны отдельно — здесь только указатели:

- **`~/.claude/settings.json permissions.allow`** — список Bash/MCP-правил для localhost-allowlist'а. Описано в [permission-management.md](https://github.yandex-team.ru/...) (вне arc, лежит в `aito1` репозитории).
- **`~/.claude/skills/wiki-patched/scripts/wiki-cli.sh`** — `curl -sf` → `curl -sSf` (локальный патч, описан в `permission-management.md`).
- **`~/secrets.env`** — `ELIZA_TOKEN` копией `AITO1_API_KEY` для работы `private-llm.sh`.
- **`/Users/wwax/arcadia/taxi/ai/aito1/install/phases/{40_multica,50_multica_daemon}.sh`** + `install/templates/config.env.template` — параметризация `AITO1_MULTICA_GIT_REPO`/`AITO1_MULTICA_GIT_REF` + сборка `cmd/multica` локально вместо brew tap. Закоммичено в arc (PR https://a.yandex-team.ru/review/13274199).
- **`~/.aito1/multica.env` → `CORS_ALLOWED_ORIGINS`** — WS origin-allowlist. Бэк заходит и через hosts-алиас `http://aito1.ai:3010` (кликабельные TG-ссылки), а не только `localhost:3010`. Каждый рабочий origin ДОЛЖЕН быть в `CORS_ALLOWED_ORIGINS` (CSV) — именно её читает `allowedOrigins()` в `router.go`, которая через `realtime.SetAllowedOrigins` перетирает WS-список из `hub.go:init()` (т.е. `ALLOWED_ORIGINS` в одиночку не работает). Без нужного origin: `ws: rejected origin` → `websocket upgrade failed` → фронт-loop `disconnected, reconnecting in 3s`, realtime мёртв (HTTP работает — он same-origin через Next-прокси). Текущее: `CORS_ALLOWED_ORIGINS=http://localhost:3010,http://aito1.ai:3010`. NB: `localStorage` (в т.ч. реестр identity Патча 40) origin-scoped — сеять на КАЖДОМ origin, где открываешь UI.

### Патч 49 — пропуск CLAUDE_CODE_OAUTH_TOKEN в env агентов (Linux VM)

Файл: `server/pkg/agent/claude.go`, `isFilteredChildEnvKey`.

Проблема: фильтр дочернего env вырезает все `CLAUDE_CODE_*` родителя (введён для контроля
auto-memory). На macOS это скрывал Keychain (claude сам находил креды подписки), на Linux VM
креды передаются только через env `CLAUDE_CODE_OAUTH_TOKEN` из systemd EnvironmentFile
(`~/.aito1/claude.env`) — фильтр отрезал токен, агенты падали «Not logged in · Please run /login»
(наблюдалось на смок-issue 6a8a2f15, 2026-07-11).

Фикс: исключение в фильтре — `CLAUDE_CODE_OAUTH_TOKEN` пропускается к спавнутому claude.
Остальные `CLAUDE_CODE_*` по-прежнему фильтруются и переустанавливаются демоном.
