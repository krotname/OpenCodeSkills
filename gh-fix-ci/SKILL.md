---
name: "gh-fix-ci"
description: "Use when a user asks to debug or fix failing GitHub PR checks that run in GitHub Actions; use `gh` to inspect checks and logs, identify the cause, and complete authorized fixes through tests, PR, required CI and merge. Respect requests limited to analysis or drafts. Treat external providers (for example Buildkite) as out of scope and report only the details URL."
---

# Fix failing GitHub Actions checks

Применяй навык только к его предметной операции. До действия прочитай [порядок и ограничения](references/procedure.md): общие правила и раздел выбранного режима. Большую справку читай адресными фрагментами по оглавлению, без повторного чтения уже проверенного неизменного раздела.

Справка сохраняет предметные гейты, проверки результата и проверенные приёмы; её рекомендации не отменяют прямое разрешение владельца и общие правила. Навык сам не разрешает новую внешнюю отправку, расход денег, изменение аккаунта или удаление данных.

Разделы: Overview; Inputs; Quick start; Workflow; Bundled Resources; scripts/inspect_pr_checks.py.

Пути `scripts/`, `references/` и ресурсов в командах относятся к корню этого навыка, а не к каталогу открытой справки. Выбирай только нужные текущему действию helpers.
