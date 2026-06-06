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

## Связанные правки **вне** этого репо (для полноты картины)

Эти правки лежат в других репо/файлах, но без них наш форк работает не полностью. Они описаны отдельно — здесь только указатели:

- **`~/.claude/settings.json permissions.allow`** — список Bash/MCP-правил для localhost-allowlist'а. Описано в [permission-management.md](https://github.yandex-team.ru/...) (вне arc, лежит в `aito1` репозитории).
- **`~/.claude/skills/wiki-patched/scripts/wiki-cli.sh`** — `curl -sf` → `curl -sSf` (локальный патч, описан в `permission-management.md`).
- **`~/secrets.env`** — `ELIZA_TOKEN` копией `AITO1_API_KEY` для работы `private-llm.sh`.
- **`/Users/wwax/arcadia/taxi/ai/aito1/install/phases/{40_multica,50_multica_daemon}.sh`** + `install/templates/config.env.template` — параметризация `AITO1_MULTICA_GIT_REPO`/`AITO1_MULTICA_GIT_REF` + сборка `cmd/multica` локально вместо brew tap. Закоммичено в arc (PR https://a.yandex-team.ru/review/13274199).
