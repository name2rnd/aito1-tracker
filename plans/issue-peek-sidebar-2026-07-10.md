# Issue Peek Sidebar

Клик по задаче в списке/на доске открывает оверлей-панель справа (`Sheet`) с полной задачей —
вместо перехода на отдельную страницу. Цель: прощёлкать пачку задач, комментировать, не теряя
позицию в списке. Правая панель свойств внутри детали скрыта по умолчанию (`defaultSidebarOpen={false}`).

## Решения (Наташа)
- Поведение: оверлей поверх списка (не сплит).
- Объём: только открыть/закрыть. Без стрелок ↑/↓, без URL-синхронизации (v1).
- cmd/ctrl/shift-клик по-прежнему открывает полную страницу / новую вкладку.

## Как
Референс — Inbox уже встраивает `<IssueDetail>` в master-detail. Переиспользуем тот же компонент.

1. `peek-store` (zustand): `{ openId: string|null, open(id), close() }`.
2. `AppLink` — новый проп `onActivate?`: обычный клик вызывает его вместо `push(href)`;
   модифицированный клик (meta/ctrl/shift) не трогаем → new tab / полная страница.
3. `list-row` + `board-card`: `onActivate={() => open(issue.identifier)}` на существующем `AppLink`.
4. `IssuePeekSheet`: `Sheet side=right`, широкий, рендерит `<IssueDetail issueId={openId}
   defaultSidebarOpen={false} onDone/onDelete={close} />`. Закрытие — Esc / клик по фону.
5. Монтируем `<IssuePeekSheet/>` один раз в dashboard layout (`extra`) → работает на списке,
   доске, my-issues и досках проектов (перехват в самой строке/карточке).

## Тесты (до кода)
- `peek-store.test.ts` — open/close/openId.
- `app-link.test.tsx` — обычный клик → onActivate (не push); cmd-клик → openInNewTab; без onActivate → push.
- UI (Sheet, ширина, высота, комментирование) — живой прогон через kimi-webbridge.

## Файлы
- `packages/core/issues/stores/peek-store.ts` (+ index)
- `packages/views/navigation/app-link.tsx`
- `packages/views/issues/components/list-row.tsx`
- `packages/views/issues/components/board-card.tsx`
- `packages/views/issues/components/issue-peek-sheet.tsx` (+ components/index)
- `apps/web/app/[workspaceSlug]/(dashboard)/layout.tsx`
- `patch.md` — новый патч форка
