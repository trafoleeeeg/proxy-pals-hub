# Нативный экран: эксперимент, не готовый движок

Владелец согласовал разработку отдельной сборки Electron и установку Microsoft
Build Tools / Windows SDK на D:. Выпуск по-прежнему запрещён до проверки.
Версия приложения остаётся 0.4.30. Production, cookies и база не затрагиваются.

## Состояние

Написан **не собранный** прототип. Синтаксическая проверка JS и отрицательный
контроль на стандартном Electron пройдены; это НЕ подтверждение исправления.
Компиляция C++, положительные нативные тесты и интеграция с клиентом ещё нужны.
Существующий `desktop/test/runtime-screen-coherence.test.cjs` не ослаблен.

Исходники и временные файлы находятся отдельно в `D:\umbra-engine`. Ревизии —
в `source-lock.json`. Chromium закреплён по DEPS Electron, не по текущему main.
GitHub mirror — официальный `chromium/chromium`, не сторонняя сборка.

### Локальная подготовка 29 сентября 2026

- Build Tools 2026 18.10.2 установлены в
  `D:\umbra-engine\toolchain\BuildTools`; MSVC — `14.51.36231`, ATL/MFC присутствует.
- Windows SDK находится в стандартном системном каталоге
  `C:\Program Files (x86)\Windows Kits\10`, Include `10.0.26100.0`,
  установленный `rc.exe` имеет версию `10.0.26100.8249`.
- Основные компоненты и кэш Visual Studio размещены на D:, но SDK и часть
  служебных компонентов заняли C:, как было согласовано с владельцем.
- **Финальный код установки 3010: нужна перезагрузка Windows.** Промежуточный
  ответ vswhere показывал `isRebootRequired: false`; окончательный код
  установщика имеет приоритет. Автоматическая перезагрузка не выполнялась.
- `depot_tools` и его Python инициализированы локально на D:. Запросы gclient
  используют временные переменные окружения, не системный PATH.
- Полная синхронизация Chromium пока не завершена; чтение отдельных исходных
  файлов и подготовка патча не означают готовность всего дерева к сборке.
- Перед перезагрузкой остановлено только дерево нашего процесса `gclient sync`.
  Исходники и кэши сохранены; после перезапуска повторить sync. Незавершённый
  Git fetch может скачать часть pack заново. Пользовательские приложения не закрывались.

В `.gclient` локального дерева указан официальный mirror Chromium с закреплённым
SHA из lock-файла, `managed: False` для Electron, `use_mtime_cache: False` и
цель win/x64. Продолжать `gclient sync --nohooks --no-history -j 4` только из
этого каталога. Для hooks/build потребуются `DEPOT_TOOLS_WIN_TOOLCHAIN=0`,
`vs2026_install=D:\umbra-engine\toolchain\BuildTools`, а также локальные
TEMP/TMP, CIPD/VPYTHON/UV caches в `D:\umbra-engine`. Сначала закончить sync,
затем проверить штатные патчи Electron, потом применять прототип Chromium.
В локальном `src/electron` изменения прототипа уже есть: повторно его патч
не применять, прежде проверить `git diff` и `git apply --reverse --check`.

## Прототип политики

- Main process вызывает `session.setUmbraScreenMetrics` **до** создания страниц.
- Шесть числовых полей: `width`, `height`, `availableWidth`, `availableHeight`,
  `colorDepth`, `deviceScaleFactor`. Некорректные значения отвергаются.
- Настройки хранятся на BrowserContext. После первого использования запрещено
  менять политику; повторная передача идентичных параметров разрешена.
- Настройки передаются через WebPreferences/Mojo в Blink Settings каждой view,
  включая OOPIF. Значения дополнительно проверяются на границе IPC.
- Прототип меняет web-visible Screen getters, CSS device dimensions и DPR.
  Физические VisualProperties, compositor и масштаб ввода не подменяются.
- CSS resolution и JS DPR должны учитывать page zoom одинаково, сохраняя
  заданный профильный DPR вместо host DPR. Это требует проверки на сборке.
- Без политики сохраняется стандартное поведение движка.

Это не утверждение о защите всех экранных/аппаратных API. В частности,
Screen Orientation, Window Management/ScreenDetails, HDR/color gamut,
OffscreenCanvas/worker media evaluation и события при смене монитора требуют
отдельной проверки; существующие запреты разрешений не заменяют такой аудит.
Прототип также НЕ эмулирует GPU, Canvas, аудио или шрифты.

## Порядок применения

1. Синхронизировать точные исходники и зависимости без запуска сборки.
2. Применить штатные патчи Electron его штатным механизмом.
3. Проверить и применить `chromium-screen.patch` относительно корня Chromium;
   `electron-screen.patch` — относительно каталога Electron.
   Патч Chromium подготовлен на выбранных исходных файлах тега; совместимость
   со всеми штатными патчами Electron должна быть проверена на полном дереве.
4. Собрать тестовый Electron x64 с sandbox и site isolation. Не отключать
   защиту ради прохождения теста. Не подменять установленное приложение.
5. Запустить из репозитория Umbra:

   ```powershell
   $env:TEMP = 'D:\umbra-engine\temp'
   $env:TMP = $env:TEMP
   node desktop/engine/run-screen-native.cjs D:\umbra-engine\src\out\UmbraTesting\electron.exe
   ```

Тест использует временные синтетические профили и loopback HTTP-сервер,
проверяет первые inline scripts и настоящие CSS rules без preload/CDP.
Проверяются две разные сессии, вложенные iframe с подтверждённым OOPIF,
resize, page zoom, навигации и два запуска браузера. Стандартный Electron
должен завершиться ошибкой `native screen API missing`.

До выпуска ещё нужны renderer crash/recreation, popup/new-window наследование,
перемещение между мониторами с разным DPI, перечисление экранов, согласование
с текущим preload/CDP Umbra и полные нативные тесты на Windows/Linux.
Не подключать этот прототип к автообновлению до завершения проверок.
