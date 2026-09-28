# Блокер выпуска: ScreenInfo в отдельном процессе iframe

## Воспроизведение

Electron 44.4.5, Windows, sandbox и site isolation включены. Тест создаёт только
временный каталог и loopback-сервер. В нём нет пользовательских cookies, прокси
или реальных значений экрана в логах.

```powershell
$env:UMBRA_REQUIRE_NATIVE = "1"
node --test desktop/test/runtime-screen-coherence.test.cjs
```

Фиктивный экран: 1733×977, DPR 1. Основная страница открывается на 127.0.0.1,
iframe — на localhost. Разные renderer processId проверяются assert-ом.
Проверяется и JS, и CSS `@media`, устанавливающий custom property:

| Контекст/способ | JS совпал | Настоящая stylesheet совпала |
| --- | --- | --- |
| Основная страница | да | да |
| OOPIF | да | нет |
| Повторный CDP override основной страницы | да | нет |
| Electron enableDeviceEmulation | да | нет |

Прямой CDP override OOPIF отклонён с ограничением `top-level-only`.
Это измеренный результат на установленном движке, не предположение из документации.
Существующие 126 desktop tests проходили до добавления нового блокирующего теста.
Их успех не означает устранение CSS-канала.

## Причина и границы вывода

В рассмотренных исходниках Chromium `MediaValues::CalculateDeviceWidth/Height`
читают нативный ScreenInfo через ChromeClient. Переопределение Screen.prototype
не влияет на CSS. Device emulation применяется к main-frame widgets;
WebFrameWidgetImpl::EnableDeviceEmulation содержит ограничение ForMainFrame.
Обёртка Electron enableDeviceEmulation также адресует primary main frame.

Источники (текущий upstream; это не побайтовая сверка исходников бинарника):

- https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/emulation_handler.cc
- https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/css/media_values.cc
- https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/frame/web_frame_widget_impl.cc
- https://raw.githubusercontent.com/electron/electron/main/shell/browser/api/electron_api_web_contents.cc
- https://raw.githubusercontent.com/electron/electron/v44.4.5/DEPS

Проверенные публичные API текущей сборки не закрывают канал. Не предлагается
подменять только matchMedia, отключать site isolation/sandbox, переписывать
стили сайтов или изменять системное разрешение монитора.

## Следующий этап — требует отдельного согласования

Подготовить патч нативного движка внутри Electron, не менять оболочку и облачную
БД Umbra и не переходить молча на сторонний антидетект-движок. Пока патч не
реализован и не собран, он не является готовым исправлением.

1. Зафиксировать исходники точно той версии Chromium, которую использует Electron.
2. Определить отдельную политику виртуального экрана на профиль/BrowserContext.
3. Передавать её всем текущим и новым renderer frames, включая OOPIF, до CSS/JS.
4. Согласовать нативные CSS media values, Screen API и DPR, не подменяя физический
   масштаб compositor: иначе сломаются координаты ввода и отрисовка.
5. Проверить два разных профиля одновременно, вложенные iframe, навигации между
   процессами, перезапуск renderer, resize/zoom и перемещение между мониторами.
6. Получить зелёный нативный экранный тест на Windows и Linux, затем полный CI,
   проверку установки/обновления и только после этого обсуждать выпуск.

Это вводит сборку и сопровождение своего патча Electron. Не начинать скачивание
всего дерева Chromium, платные CI-машины или изменение pipeline автообновления
без отдельного согласования ресурсов и архитектуры с владельцем.
