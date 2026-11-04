import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Copy,
  Download,
  FolderOpen,
  GitBranch,
  Loader2,
  Moon,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  Sun,
  Terminal,
  Trash2,
  Users,
  X,
  Play,
} from "lucide-react";
import type { AppSettings, Project, Workflow } from "../shared/types";
import Editor from "./Editor";
import {
  AssetsModal,
  BroadcastsPage,
  ConsolePage,
  UsersPage,
} from "./Management";
import { Busy, Field, IconButton, Modal, Notice, formatDate } from "./ui";

type Tab = "editor" | "users" | "broadcasts" | "console";
const tabs = [
  { id: "editor" as const, title: "Сценарий", icon: GitBranch },
  { id: "users" as const, title: "Пользователи", icon: Users },
  { id: "broadcasts" as const, title: "Рассылки", icon: Send },
  { id: "console" as const, title: "Консоль", icon: Terminal },
];

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("editor");
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<AppSettings>({ theme: "system" });
  const [systemDark, setSystemDark] = useState(
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [deleteProject, setDeleteProject] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const projectRef = useRef(project);
  const searchRef = useRef<HTMLInputElement>(null);
  projectRef.current = project;
  const dark =
    settings.theme === "dark" || (settings.theme === "system" && systemDark);
  const onError = useCallback(
    (text: string) =>
      setToast({
        text: text.replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          "",
        ),
        error: true,
      }),
    [],
  );
  const onNotice = useCallback(
    (text: string) => setToast({ text, error: false }),
    [],
  );
  async function refresh() {
    const list = await window.flowra.listProjects();
    setProjects(list);
    const current = projectRef.current;
    if (current) {
      const updated = list.find((item) => item.id === current.id);
      if (updated)
        setProject((old) =>
          old ? { ...updated, workflow: old.workflow } : null,
        );
    }
  }

  useEffect(() => {
    if (!window.flowra) {
      setLoading(false);
      onError(
        "Откройте Flowra как desktop-приложение: npm run dev. Интерфейс в обычном браузере не имеет доступа к локальной базе.",
      );
      return;
    }
    Promise.all([window.flowra.listProjects(), window.flowra.getSettings()])
      .then(([list, preferences]) => {
        setProjects(list);
        setSettings(preferences);
      })
      .catch((error) => onError(error.message))
      .finally(() => setLoading(false));
    const unsubscribeEvents = window.flowra.onEvent((event) => {
      if (event.type === "status" || event.type === "users")
        refresh().catch((error) => onError(error.message));
    });
    const unsubscribeClose = window.flowra.onBeforeClose(async () => {
      const current = projectRef.current;
      if (current)
        await window.flowra.saveWorkflow({
          id: current.id,
          workflow: current.workflow,
        });
    });
    return () => {
      unsubscribeEvents();
      unsubscribeClose();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 12000 : 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyK") {
        event.preventDefault();
        if (project)
          document
            .querySelector<HTMLInputElement>('input[aria-label="Найти блок"]')
            ?.focus();
        else searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [project]);

  async function changeTheme(theme: AppSettings["theme"]) {
    try {
      await window.flowra.setSettings({ theme });
      setSettings({ theme });
    } catch (error: any) {
      onError(error.message);
    }
  }
  function open(item: Project) {
    setProject(item);
    setTab("editor");
  }
  async function run() {
    if (!project) return;
    setBusy(true);
    try {
      if (project.status === "running") await window.flowra.stopBot(project.id);
      else {
        await window.flowra.saveWorkflow({
          id: project.id,
          workflow: project.workflow,
        });
        await window.flowra.startBot(project.id);
      }
      await refresh();
    } catch (error: any) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function duplicate(item: Project) {
    setBusy(true);
    try {
      const copy = await window.flowra.duplicateProject(item.id);
      await refresh();
      onNotice(`Создана копия «${copy.name}».`);
    } catch (error: any) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`app ${project ? "workspace" : "dashboard"}`}>
      <header className="app-header">
        <div className="header-left">
          {project ? (
            <>
              <IconButton
                title="Все боты"
                onClick={async () => {
                  try {
                    await window.flowra.saveWorkflow({
                      id: project.id,
                      workflow: project.workflow,
                    });
                    setProject(null);
                    await refresh();
                  } catch (error: any) {
                    onError(error.message);
                  }
                }}
              >
                <ArrowLeft size={19} />
              </IconButton>
              <span className="header-divider" />
              <button
                className="brand small-brand"
                onClick={() => setAboutOpen(true)}
              >
                <span className="brand-mark" />
                <span>Flowra</span>
              </button>
              <span className="header-slash">/</span>
              <button
                className="project-name"
                onClick={() => setSettingsOpen(true)}
              >
                {project.name}
                <ChevronDown size={13} />
              </button>
              <span
                className={`status-dot ${project.status}`}
                title={
                  project.status === "running"
                    ? "Бот работает"
                    : project.status === "error"
                      ? "Ошибка запуска"
                      : "Бот остановлен"
                }
              />
            </>
          ) : (
            <button className="brand" onClick={() => setAboutOpen(true)}>
              <span className="brand-mark" />
              <span>Flowra</span>
            </button>
          )}
        </div>
        <div className="header-right">
          {!project && (
            <span className="local-pill">
              <ShieldCheck size={13} />
              Локально и без аккаунта
            </span>
          )}
          <IconButton
            title={dark ? "Светлая тема" : "Тёмная тема"}
            onClick={() => changeTheme(dark ? "light" : "dark")}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </IconButton>
          <IconButton title="Настройки" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={18} />
          </IconButton>
          {project && (
            <>
              <span className="header-divider" />
              <button
                className="button secondary compact-button"
                onClick={() => setExportOpen(true)}
              >
                <Download size={15} />
                Скачать
              </button>
              <button
                className={`button ${project.status === "running" ? "secondary" : "primary"} compact-button`}
                disabled={busy}
                onClick={run}
              >
                {busy ? (
                  <Loader2 size={14} className="spin" />
                ) : project.status === "running" ? (
                  <Square size={13} />
                ) : (
                  <Play size={14} />
                )}
                {project.status === "running" ? "Остановить" : "Запустить"}
              </button>
            </>
          )}
        </div>
      </header>
      {project ? (
        <>
          <div className="workspace-navigation">
            <nav aria-label="Разделы проекта">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  className={tab === item.id ? "active" : ""}
                  onClick={() => setTab(item.id)}
                >
                  <item.icon size={15} />
                  {item.title}
                  {item.id === "users" && project.userCount > 0 && (
                    <span>{project.userCount}</span>
                  )}
                </button>
              ))}
            </nav>
            <button
              className="text-button files-button"
              onClick={() => setAssetsOpen(true)}
            >
              <FolderOpen size={15} />
              Файлы проекта
            </button>
          </div>
          <main className="workspace-main">
            {tab === "editor" ? (
              <Editor
                key={project.id}
                project={project}
                dark={dark}
                onWorkflow={(workflow: Workflow) =>
                  setProject((current) =>
                    current ? { ...current, workflow } : null,
                  )
                }
                onError={onError}
              />
            ) : tab === "users" ? (
              <UsersPage
                project={project}
                onError={onError}
                onNotice={onNotice}
              />
            ) : tab === "broadcasts" ? (
              <BroadcastsPage
                project={project}
                onError={onError}
                onNotice={onNotice}
              />
            ) : (
              <ConsolePage
                project={project}
                onError={onError}
                onNotice={onNotice}
              />
            )}
          </main>
        </>
      ) : (
        <main className="dashboard-main">
          <section className="dashboard-intro">
            <div className="intro-kicker">
              <span className="tiny-orb" />
              Конструктор Telegram-ботов
            </div>
            <h1>
              Создавайте Telegram-ботов
              <br />
              <em>без кода.</em>
            </h1>
            <p>
              Соединяйте блоки, запускайте сценарий и экспортируйте код
              <br className="desktop-br" /> на JavaScript или Python.
            </p>
            <button
              className="button primary create-main"
              onClick={() => setCreateOpen(true)}
            >
              <Plus size={18} />
              Создать бота
              <ArrowRight size={16} />
            </button>
            <span className="intro-note">
              Ваши проекты и данные остаются на компьютере.
            </span>
          </section>
          <section className="projects-section">
            <div className="projects-heading">
              <div>
                <h2>
                  Мои боты<span>{projects.length}</span>
                </h2>
                <p>Сценарии на этом компьютере.</p>
              </div>
              <div className="projects-tools">
                <div className="search project-search">
                  <Search size={16} />
                  <input
                    ref={searchRef}
                    placeholder="Найти бота…"
                    aria-label="Найти бота"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <kbd>Ctrl K</kbd>
                </div>
                {projects.length > 0 && (
                  <button
                    className="button secondary"
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus size={16} />
                    Новый бот
                  </button>
                )}
              </div>
            </div>
            {loading ? (
              <Busy text="Открываем проекты…" />
            ) : !projects.length ? (
              <div className="dashboard-empty">
                <div className="mini-workflow" aria-hidden="true">
                  <div className="mini-node">
                    <span>
                      <Play size={13} />
                    </span>
                    Начало
                    <span className="mini-handle" />
                  </div>
                  <div className="mini-edge" />
                  <div className="mini-node">
                    <span>
                      <Send size={13} />
                    </span>
                    Сообщение
                    <span className="mini-handle left" />
                  </div>
                </div>
                <h3>Здесь будут ваши боты</h3>
                <p>
                  Создайте первый проект. Добавьте команду, сообщение
                  <br className="desktop-br" /> и соедините их — ваш сценарий
                  готов к запуску.
                </p>
                <button
                  className="text-button purple"
                  onClick={() => setCreateOpen(true)}
                >
                  Создать первого бота
                  <ArrowRight size={15} />
                </button>
              </div>
            ) : (
              <div className="project-grid">
                {projects
                  .filter((item) =>
                    `${item.name} ${item.username || ""}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((item) => (
                    <article className="project-card" key={item.id}>
                      <div className="project-card-heading">
                        <button
                          className="project-card-open"
                          onClick={() => open(item)}
                        >
                          <span className="project-icon">
                            <Bot size={22} />
                          </span>
                          <div>
                            <h3>{item.name}</h3>
                            <span>
                              {item.username
                                ? `@${item.username}`
                                : "Telegram-бот"}
                            </span>
                          </div>
                        </button>
                        <span
                          className={`status-pill ${item.status === "running" ? "running" : ""}`}
                        >
                          <span className="status-dot" />
                          {item.status === "running"
                            ? "Работает"
                            : !item.hasToken
                              ? "Черновик"
                              : item.status === "error"
                                ? "Ошибка"
                                : "Остановлен"}
                        </span>
                      </div>
                      <button
                        className="project-card-body"
                        onClick={() => open(item)}
                      >
                        <div
                          className="project-graph-preview"
                          aria-hidden="true"
                        >
                          <span />
                          <i />
                          <span />
                          <i />
                          <span />
                        </div>
                        <span>
                          {item.workflow.nodes.length} блоков<span>·</span>
                          <Users size={13} />
                          {item.userCount} пользователей
                        </span>
                      </button>
                      <div className="project-card-footer">
                        <small>Изменён {formatDate(item.updatedAt)}</small>
                        <div>
                          <IconButton
                            title={`Дублировать «${item.name}»`}
                            disabled={busy}
                            onClick={() => duplicate(item)}
                          >
                            <Copy size={14} />
                          </IconButton>
                          <IconButton
                            title={`Удалить «${item.name}»`}
                            onClick={() => setDeleteProject(item)}
                          >
                            <Trash2 size={14} />
                          </IconButton>
                          <IconButton
                            title={`Открыть «${item.name}»`}
                            onClick={() => open(item)}
                          >
                            <ArrowRight size={16} />
                          </IconButton>
                        </div>
                      </div>
                    </article>
                  ))}
                {!projects.some((item) =>
                  `${item.name} ${item.username || ""}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                ) && (
                  <div className="no-projects">
                    <Search size={23} />
                    <h3>Такого бота нет</h3>
                    <p>Попробуйте другое название.</p>
                  </div>
                )}
              </div>
            )}
          </section>
          <footer className="dashboard-footer">
            <span>
              <span className="brand-mark miniature" />
              Flowra
            </span>
            <p>Данные хранятся на этом компьютере · GNU GPL v3+</p>
            <button className="text-button" onClick={() => setAboutOpen(true)}>
              О проекте
              <ArrowRight size={12} />
            </button>
          </footer>
        </main>
      )}
      {toast && (
        <div className="toast-wrap">
          <Notice text={toast.text} error={toast.error} />
          <IconButton
            title="Закрыть уведомление"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </IconButton>
        </div>
      )}
      {createOpen && (
        <CreateModal
          onClose={() => setCreateOpen(false)}
          onCreated={async (item) => {
            setCreateOpen(false);
            open(item);
            await refresh();
          }}
          onError={onError}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          project={project}
          onTheme={changeTheme}
          onClose={() => setSettingsOpen(false)}
          onSaved={async (item) => {
            if (item)
              setProject((current) =>
                current?.id === item.id
                  ? { ...item, workflow: current.workflow }
                  : item,
              );
            await refresh();
            setSettingsOpen(false);
            onNotice("Настройки сохранены.");
          }}
          onError={onError}
        />
      )}
      {exportOpen && project && (
        <ExportModal
          project={project}
          onClose={() => setExportOpen(false)}
          onError={onError}
          onNotice={onNotice}
        />
      )}
      {assetsOpen && project && (
        <AssetsModal
          projectId={project.id}
          onClose={() => setAssetsOpen(false)}
          onError={onError}
          onNotice={onNotice}
        />
      )}
      {deleteProject && (
        <Modal
          title={`Удалить «${deleteProject.name}»?`}
          subtitle="Проект будет удалён с этого компьютера."
          onClose={() => setDeleteProject(null)}
        >
          <p className="field-note">
            Будут удалены сценарий, локальные файлы, пользователи и история
            рассылок. Сам бот в Telegram останется у вас.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDeleteProject(null)}
            >
              Отмена
            </button>
            <button
              className="button danger-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await window.flowra.deleteProject(deleteProject.id);
                  setDeleteProject(null);
                  await refresh();
                } catch (error: any) {
                  onError(error.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Удалить проект
            </button>
          </div>
        </Modal>
      )}
      {aboutOpen && (
        <Modal
          title="Flowra"
          subtitle="Локальный конструктор Telegram-ботов"
          onClose={() => setAboutOpen(false)}
        >
          <div className="about-content">
            <span className="brand-mark about-mark" />
            <p>
              Собирайте сценарии из блоков, запускайте бота на своём компьютере
              и экспортируйте проект на JavaScript или Python.
            </p>
            <p>
              Flowra не требует аккаунта и не отправляет проекты в облако. Для
              работы бота нужен доступ к Telegram API.
            </p>
            <div className="about-license">
              <ShieldCheck size={17} />
              <div>
                <strong>Свободное программное обеспечение</strong>
                <span>GNU General Public License v3.0</span>
              </div>
            </div>
            <p className="fine-print">
              Инструкции по установке, сборке и работе с проектом находятся в
              README.md.
            </p>
          </div>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setAboutOpen(false)}
            >
              Понятно
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const project = await window.flowra.createProject({
        name: name.trim(),
        token: token.trim(),
      });
      await onCreated(project);
    } catch (error: any) {
      setError(
        error.message.replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          "",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Новый бот"
      subtitle="Начните с названия. Логику соберём в редакторе."
      onClose={onClose}
    >
      <form onSubmit={create}>
        <Field label="Название проекта">
          <input
            autoFocus
            placeholder="Например, бот для записи"
            value={name}
            maxLength={100}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Telegram Bot Token"
          hint="Получите токен у @BotFather в Telegram. Можно добавить позже в настройках проекта."
        >
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder="Необязательно для черновика"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>
        <div className="form-security">
          <ShieldCheck size={15} />
          <span>Токен хранится локально и не попадает в экспорт.</span>
        </div>
        {error && <Notice text={error} error />}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !name.trim()}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
            {busy
              ? token
                ? "Проверяем токен…"
                : "Создаём проект…"
              : "Создать бота"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsModal({
  settings,
  project,
  onTheme,
  onClose,
  onSaved,
}: {
  settings: AppSettings;
  project: Project | null;
  onTheme: (theme: AppSettings["theme"]) => Promise<void>;
  onClose: () => void;
  onSaved: (project?: Project) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [name, setName] = useState(project?.name || "");
  const [token, setToken] = useState("");
  const [replaceToken, setReplaceToken] = useState(!project?.hasToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={project ? "Настройки проекта" : "Настройки"}
      onClose={onClose}
    >
      <Field label="Оформление">
        <div className="theme-choices">
          {[
            ["light", "Светлое"],
            ["dark", "Тёмное"],
            ["system", "Как в системе"],
          ].map(([theme, title]) => (
            <button
              className={settings.theme === theme ? "selected" : ""}
              key={theme}
              onClick={() => onTheme(theme as AppSettings["theme"])}
            >
              {title}
              {settings.theme === theme && <Check size={13} />}
            </button>
          ))}
        </div>
      </Field>
      {project && (
        <>
          <div className="form-divider" />
          <Field label="Название проекта">
            <input
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {project.hasToken && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={replaceToken}
                onChange={(e) => setReplaceToken(e.target.checked)}
              />
              Заменить Telegram Bot Token
            </label>
          )}
          {replaceToken && (
            <Field
              label="Telegram Bot Token"
              hint="Токен проверяется через Telegram API. Оставьте пустым, чтобы сохранить черновик без токена."
            >
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Токен от @BotFather"
              />
            </Field>
          )}
          {project.status === "running" && (
            <p className="field-note">Перед заменой токена остановите бота.</p>
          )}
        </>
      )}
      {error && <Notice text={error} error />}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Закрыть
        </button>
        {project && (
          <button
            className="button primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const updated = await window.flowra.updateProject({
                  id: project.id,
                  name: name.trim(),
                  ...(replaceToken ? { token: token.trim() } : {}),
                });
                await onSaved(updated);
              } catch (error: any) {
                setError(
                  error.message.replace(
                    /^Error invoking remote method '[^']+': (Error: )?/,
                    "",
                  ),
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Сохранение…" : "Сохранить"}
          </button>
        )}
      </div>
    </Modal>
  );
}

function ExportModal({
  project,
  onClose,
  onError,
  onNotice,
}: {
  project: Project;
  onClose: () => void;
  onError: (text: string) => void;
  onNotice: (text: string) => void;
}) {
  const [language, setLanguage] = useState<"javascript" | "python">(
    "javascript",
  );
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      await window.flowra.saveWorkflow({
        id: project.id,
        workflow: project.workflow,
      });
      const path = await window.flowra.exportBot({
        projectId: project.id,
        language,
      });
      if (path) {
        onNotice(`Проект экспортирован: ${path}`);
        onClose();
      }
    } catch (error: any) {
      onError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Скачать бота"
      subtitle="Самостоятельный проект, который можно запустить без Flowra."
      onClose={onClose}
    >
      <div className="export-options">
        {[
          [
            "javascript",
            "JS",
            "JavaScript / Node.js",
            "Node.js 22.18+ · npm install · npm start",
          ],
          [
            "python",
            "Py",
            "Python",
            "Python 3.11+ · pip install · python index.py",
          ],
        ].map(([value, mark, title, hint]) => (
          <button
            key={value}
            className={language === value ? "selected" : ""}
            onClick={() => setLanguage(value as "javascript" | "python")}
          >
            <span className="language-mark">{mark}</span>
            <span>
              <strong>{title}</strong>
              <small>{hint}</small>
            </span>
            <span className="radio-indicator">
              {language === value && <span />}
            </span>
          </button>
        ))}
      </div>
      <div className="export-includes">
        <h3>В ZIP-архив войдут</h3>
        <p>
          <Check size={14} />
          Сценарий и полноценный runtime
        </p>
        <p>
          <Check size={14} />
          Используемые файлы из assets
        </p>
        <p>
          <Check size={14} />
          Зависимости и инструкция по запуску
        </p>
      </div>
      <p className="field-note">
        Токен и база пользователей остаются в Flowra. Укажите свой токен в .env
        после распаковки. Рассылки управляются из desktop-приложения.
      </p>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Отмена
        </button>
        <button className="button primary" disabled={busy} onClick={download}>
          {busy ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <Download size={15} />
          )}
          {busy ? "Собираем архив…" : "Скачать ZIP"}
        </button>
      </div>
    </Modal>
  );
}
