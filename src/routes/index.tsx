import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Umbra — свой антидетект без абонплаты" },
      {
        name: "description",
        content:
          "Профили с отпечатками Windows, прокси, доступы для команды и настольный клиент для Windows и macOS.",
      },
      { property: "og:title", content: "Umbra — свой антидетект без абонплаты" },
      {
        property: "og:description",
        content: "Профили, отпечатки, прокси и команда в одной защищённой системе.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const FEATURES = [
  {
    title: "Профили без лимитов",
    text: "Сколько нужно профилей — столько и создаёте. Массовое создание, папки, теги и заметки.",
  },
  {
    title: "Правдоподобные отпечатки",
    text: "Сгенерированные наборы параметров Windows: экран, видеокарта, шрифты, язык и часовой пояс под страну прокси.",
  },
  {
    title: "Прокси под контролем",
    text: "HTTP, HTTPS и SOCKS5, массовый импорт списком, проверка и привязка к профилю.",
  },
  {
    title: "Команда и доступы",
    text: "Приглашайте сотрудников по ссылке и открывайте им только нужные профили. Каждое действие видно в журнале.",
  },
  {
    title: "Всё зашифровано",
    text: "Пароли прокси и cookies хранятся в зашифрованном виде и расшифровываются только при запуске профиля.",
  },
  {
    title: "Отдельное приложение",
    text: "Рабочая программа для Windows и macOS запускает изолированный браузер — ваш основной браузер не задействован.",
  },
];

function Landing() {
  return (
    <div className="min-h-screen grid-bg">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <span className="mono text-lg font-semibold tracking-tight">
          UMBRA<span className="text-primary">.</span>
        </span>
        <Button asChild variant="outline" size="sm">
          <Link to="/auth">Войти</Link>
        </Button>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <section className="py-16 md:py-24">
          <p className="mono mb-5 inline-block rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs text-primary">
            своя система, а не подписка
          </p>
          <h1 className="max-w-3xl text-4xl font-bold leading-tight md:text-6xl">
            Мультиаккаунтинг, за который вы больше никому не платите
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
            Umbra хранит ваши профили, отпечатки и прокси, раздаёт доступы сотрудникам и запускает
            всё это в отдельном приложении для Windows и macOS.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/auth">Создать аккаунт</Link>
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link to="/auth">У меня уже есть доступ</Link>
            </Button>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <article
              key={f.title}
              className="rounded-lg border border-border bg-card/70 p-6 backdrop-blur transition-colors hover:border-primary/40"
            >
              <h2 className="text-base font-semibold">{f.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.text}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
